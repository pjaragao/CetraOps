-- =====================================================================
-- Marketing › Links rastreados e origem da cliente (plano de marketing e atendimento, Fase 1).
-- Cada QR/link (recepção da JOY, vestiário, bio, trainer, evento…) abre o WhatsApp com um texto pronto que termina em "(ref: código)"
-- ou o Telegram com /start código. Quando a mensagem chega, o banco reconhece o código e grava o TOQUE (primeiro e últimos),
-- a origem da pessoa (se ainda não tinha) e a etiqueta origem-<código>. O anúncio que abre o WhatsApp (CTWA) também vira toque.
-- Códigos de erro: P0310 dado inválido · P0311 situação não permite · P0312 não encontrado.
-- =====================================================================

alter table omni.channel_accounts add column if not exists public_address text;   -- número do WhatsApp (só dígitos, com DDI) ou @ do bot do Telegram

create table mkt.tracking_links (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  code text not null check (code ~ '^[a-z0-9][a-z0-9-]{2,22}$'),
  name text not null,
  kind text not null default 'QR' check (kind in ('QR', 'BIO', 'STORY', 'TIKTOK', 'TRAINER', 'EVENT', 'CAMPAIGN', 'PRINT', 'OTHER')),
  channel_account_id uuid not null references omni.channel_accounts(id),
  prefill_text text,
  affiliate_party_id uuid references crm.parties(id),
  event_id uuid references mkt.events(id) on delete set null,
  active boolean not null default true,
  created_by uuid references core.members(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, code)
);

create table mkt.attribution_touches (
  id bigint generated always as identity primary key,
  org_id uuid not null references core.orgs(id),
  party_id uuid not null references crm.parties(id) on delete cascade,
  touched_at timestamptz not null default now(),
  kind text not null check (kind in ('LINK', 'AD')),
  tracking_link_id uuid references mkt.tracking_links(id) on delete set null,
  ad_id text,
  conversation_id uuid references omni.conversations(id) on delete set null,
  message_id uuid references omni.messages(id) on delete set null,
  is_first boolean not null default false,
  detail jsonb not null default '{}'
);
create index attribution_party_idx on mkt.attribution_touches (party_id, touched_at);
create index attribution_link_idx on mkt.attribution_touches (tracking_link_id, touched_at);

select private.attach_updated_at('mkt');
select private.apply_rls('mkt', array['tracking_links', 'attribution_touches'], 'crm.read', 'crm.write');
select private.rpc_only('mkt', array['tracking_links', 'attribution_touches']);

-- ---------------------------------------------------------------------
-- Cadastro
-- p = {id?, code, name, kind, channel_account_id, prefill_text?, affiliate_party_id?, event_id?}
-- ---------------------------------------------------------------------
create or replace function mkt.save_tracking_link(p jsonb) returns mkt.tracking_links
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id(); v_id uuid := nullif(p ->> 'id', '')::uuid; v_code text := lower(trim(coalesce(p ->> 'code', '')));
  v_name text := trim(coalesce(p ->> 'name', '')); v_kind text := upper(coalesce(nullif(p ->> 'kind', ''), 'QR'));
  v_acc uuid := nullif(p ->> 'channel_account_id', '')::uuid; ca omni.channel_accounts; v_text text := nullif(trim(coalesce(p ->> 'prefill_text', '')), '');
  v_aff uuid := nullif(p ->> 'affiliate_party_id', '')::uuid; v_event uuid := nullif(p ->> 'event_id', '')::uuid; l mkt.tracking_links;
begin
  perform private.require_perm('crm.write');
  if v_code !~ '^[a-z0-9][a-z0-9-]{2,22}$' then raise exception 'Código: 3 a 23 letras minúsculas, números ou hífen (ex.: qr-recepcao)' using errcode = 'P0310'; end if;
  if length(v_name) not between 3 and 80 then raise exception 'Nome: 3 a 80 caracteres' using errcode = 'P0310'; end if;
  if v_kind not in ('QR', 'BIO', 'STORY', 'TIKTOK', 'TRAINER', 'EVENT', 'CAMPAIGN', 'PRINT', 'OTHER') then raise exception 'Tipo inválido' using errcode = 'P0310'; end if;
  select * into ca from omni.channel_accounts where id = v_acc and org_id = v_org;
  if ca.id is null or ca.channel not in ('WHATSAPP', 'TELEGRAM') then raise exception 'Escolha um canal de WhatsApp ou Telegram' using errcode = 'P0310'; end if;
  if v_text is not null and length(v_text) > 200 then raise exception 'Texto pronto: até 200 caracteres' using errcode = 'P0310'; end if;
  if v_aff is not null and not exists (select 1 from crm.parties where id = v_aff and org_id = v_org) then raise exception 'Afiliada inválida' using errcode = 'P0310'; end if;
  if v_event is not null and not exists (select 1 from mkt.events where id = v_event and org_id = v_org) then raise exception 'Evento inválido' using errcode = 'P0310'; end if;

  if v_id is null then
    insert into mkt.tracking_links (org_id, code, name, kind, channel_account_id, prefill_text, affiliate_party_id, event_id, created_by)
    values (v_org, v_code, v_name, v_kind, ca.id, v_text, v_aff, v_event, private.member_id()) returning * into l;
  else
    update mkt.tracking_links set code = v_code, name = v_name, kind = v_kind, channel_account_id = ca.id, prefill_text = v_text, affiliate_party_id = v_aff, event_id = v_event
    where id = v_id and org_id = v_org returning * into l;
    if l.id is null then raise exception 'Link não encontrado' using errcode = 'P0312'; end if;
  end if;
  return l;
exception when unique_violation then
  raise exception 'Já existe um link com o código %', v_code using errcode = 'P0310';
end $$;

create or replace function mkt.set_tracking_link_active(p_id uuid, p_active boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('crm.write');
  update mkt.tracking_links set active = p_active where id = p_id and org_id = private.org_id();
  if not found then raise exception 'Link não encontrado' using errcode = 'P0312'; end if;
end $$;

-- Endereço público do canal (para montar o link): WhatsApp = número com DDI; Telegram = @ do bot
create or replace function omni.set_channel_public_address(p_id uuid, p_address text) returns omni.channel_accounts
language plpgsql security definer set search_path = '' as $$
declare ca omni.channel_accounts; v text := trim(coalesce(p_address, ''));
begin
  perform private.require_perm('core.admin');
  select * into ca from omni.channel_accounts where id = p_id and org_id = private.org_id();
  if ca.id is null then raise exception 'Canal não encontrado' using errcode = 'P0312'; end if;
  if ca.channel = 'WHATSAPP' then
    v := regexp_replace(v, '\D', '', 'g');
    if length(v) not between 12 and 15 then raise exception 'Informe o número com DDI e DDD (ex.: 55 48 99999-0000)' using errcode = 'P0310'; end if;
  elsif ca.channel = 'TELEGRAM' then
    v := ltrim(v, '@');
    if v !~* '^[a-z0-9_]{5,32}$' then raise exception 'Informe o @ do bot (ex.: siejoybot)' using errcode = 'P0310'; end if;
  else
    raise exception 'Só WhatsApp e Telegram usam link direto' using errcode = 'P0311';
  end if;
  update omni.channel_accounts set public_address = v where id = ca.id returning * into ca;
  return ca;
end $$;

-- ---------------------------------------------------------------------
-- Toque: registra e, no primeiro, marca a origem da pessoa
-- ---------------------------------------------------------------------
create or replace function private.record_touch(p_org uuid, p_party uuid, p_kind text, p_link uuid, p_ad text, p_conv uuid, p_msg uuid, p_detail jsonb default '{}') returns void
language plpgsql security definer set search_path = '' as $$
declare v_first boolean; l mkt.tracking_links;
begin
  -- o mesmo link/anúncio para a mesma pessoa conta uma vez por dia
  if exists (select 1 from mkt.attribution_touches t where t.party_id = p_party and t.touched_at > now() - interval '1 day'
             and ((p_link is not null and t.tracking_link_id = p_link) or (p_ad is not null and t.ad_id = p_ad))) then
    return;
  end if;
  v_first := not exists (select 1 from mkt.attribution_touches t where t.party_id = p_party);
  insert into mkt.attribution_touches (org_id, party_id, kind, tracking_link_id, ad_id, conversation_id, message_id, is_first, detail)
  values (p_org, p_party, p_kind, p_link, p_ad, p_conv, p_msg, v_first, coalesce(p_detail, '{}'));
  if p_link is not null then
    select * into l from mkt.tracking_links where id = p_link;
    update crm.parties set tags = array(select distinct unnest(tags || array['origem-' || l.code])),
           source = case when v_first and (source is null or source like '%\_INBOUND' or source in ('WHATSAPP', 'TELEGRAM')) then 'LINK:' || l.code else source end
    where id = p_party;
    if l.affiliate_party_id is not null then
      update crm.parties set tags = array(select distinct unnest(tags || array['indicacao'])) where id = p_party;
    end if;
    perform private.timeline(p_org, p_party, 'ATTRIBUTION', 'mkt.tracking_links', l.id, format('Chegou pelo link "%s"%s', l.name, case when v_first then ' (primeiro contato)' else '' end));
  end if;
end $$;

-- Mensagem recebida: procura "(ref: código)" no WhatsApp ou "/start código" no Telegram
create or replace function private.capture_link_touch() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_code text; l mkt.tracking_links; v_party uuid;
begin
  if new.direction <> 'IN' or new.author_type <> 'CUSTOMER' or coalesce(new.body, '') = '' then return null; end if;
  v_code := coalesce(substring(lower(new.body) from 'ref:\s*([a-z0-9][a-z0-9-]{2,22})'), substring(lower(new.body) from '^/start\s+([a-z0-9][a-z0-9-]{2,22})'));
  if v_code is null then return null; end if;
  select * into l from mkt.tracking_links where org_id = new.org_id and code = v_code and active;
  if l.id is null then return null; end if;
  select party_id into v_party from omni.conversations where id = new.conversation_id;
  perform private.record_touch(new.org_id, v_party, 'LINK', l.id, null, new.conversation_id, new.id, jsonb_build_object('code', l.code));
  return null;
end $$;
create trigger trg_capture_link_touch after insert on omni.messages for each row execute function private.capture_link_touch();

-- Anúncio que abre o WhatsApp (o normalizador grava AD_REFERRAL na linha do tempo)
create or replace function private.capture_ad_touch() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.kind = 'AD_REFERRAL' then
    perform private.record_touch(new.org_id, new.party_id, 'AD', null, coalesce(new.payload ->> 'source_id', new.payload ->> 'ad_id', 'desconhecido'), null, null,
                                 jsonb_build_object('headline', new.payload ->> 'headline', 'ctwa_clid', new.payload ->> 'ctwa_clid'));
  end if;
  return null;
end $$;
create trigger trg_capture_ad_touch after insert on crm.timeline_events for each row execute function private.capture_ad_touch();

-- ---------------------------------------------------------------------
-- Resultado por link no período: conversas, leads novas, clientes e receita das vendas depois do toque
-- ---------------------------------------------------------------------
create or replace function mkt.tracking_link_stats(p_from date, p_to date) returns table (
  link_id uuid, code text, name text, kind text, active boolean, touches int, new_leads int, buyers int, orders int, revenue numeric)
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); v_f timestamptz; v_t timestamptz;
  v_paid text[] := array['PAID', 'COMPLETED', 'FULFILLING', 'READY_FOR_PICKUP', 'SHIPPED', 'PARTIALLY_RETURNED'];
begin
  perform private.require_perm('crm.read');
  if p_from is null or p_to is null or p_to < p_from then raise exception 'Período inválido' using errcode = 'P0310'; end if;
  v_f := (p_from::timestamp at time zone 'America/Sao_Paulo'); v_t := ((p_to + 1)::timestamp at time zone 'America/Sao_Paulo');
  return query
    with t as (
      select a.tracking_link_id, a.party_id, a.is_first, min(a.touched_at) over (partition by a.tracking_link_id, a.party_id) as first_at
      from mkt.attribution_touches a where a.org_id = v_org and a.kind = 'LINK' and a.touched_at >= v_f and a.touched_at < v_t
    ), o as (
      select distinct t2.tracking_link_id, so.id as order_id, so.party_id, so.total
      from (select distinct tracking_link_id, party_id, first_at from t) t2
      join sales.orders so on so.party_id = t2.party_id and so.created_at >= t2.first_at and so.created_at < v_t + interval '30 days' and so.status::text = any (v_paid)
    )
    select l.id, l.code, l.name, l.kind, l.active,
           (select count(*)::int from t where t.tracking_link_id = l.id),
           (select count(*)::int from t where t.tracking_link_id = l.id and t.is_first),
           (select count(distinct o.party_id)::int from o where o.tracking_link_id = l.id),
           (select count(*)::int from o where o.tracking_link_id = l.id),
           (select coalesce(sum(o.total), 0) from o where o.tracking_link_id = l.id)
    from mkt.tracking_links l where l.org_id = v_org
    order by l.active desc, 7 desc, l.created_at;
end $$;

-- Origem das leads novas no período (todas as fontes, não só links)
create or replace function crm.lead_sources(p_from date, p_to date) returns table (source text, leads int, buyers int)
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); v_f timestamptz; v_t timestamptz;
  v_paid text[] := array['PAID', 'COMPLETED', 'FULFILLING', 'READY_FOR_PICKUP', 'SHIPPED', 'PARTIALLY_RETURNED'];
begin
  perform private.require_perm('crm.read');
  v_f := (p_from::timestamp at time zone 'America/Sao_Paulo'); v_t := ((p_to + 1)::timestamp at time zone 'America/Sao_Paulo');
  return query
    select coalesce(p.source, 'Sem origem') as source, count(*)::int,
           count(*) filter (where exists (select 1 from sales.orders o where o.party_id = p.id and o.status::text = any (v_paid)))::int
    from crm.parties p
    where p.org_id = v_org and p.created_at >= v_f and p.created_at < v_t and p.merged_into_id is null and p.anonymized_at is null
      and not exists (select 1 from crm.party_roles rl where rl.party_id = p.id and rl.role in ('EMPLOYEE', 'SUPPLIER', 'SERVICE_PROVIDER', 'CARRIER', 'ACQUIRER', 'BANK'))
    group by 1 order by 2 desc;
end $$;

insert into private.internal_functions (fqname) values ('private.record_touch'), ('private.capture_link_touch'), ('private.capture_ad_touch') on conflict do nothing;
select private.lock_functions();
