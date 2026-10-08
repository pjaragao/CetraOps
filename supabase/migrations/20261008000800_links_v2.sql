-- =====================================================================
-- Marketing › Links v2: link curto (/r/código) que registra o clique e leva a cliente ao WhatsApp, ao Telegram ou a uma página do site (com UTM);
-- o link pode pertencer a uma campanha. O banco só devolve o destino; quem monta o endereço final é a rota pública da aplicação.
-- Códigos de erro: P0310 dado inválido · P0311 situação não permite · P0312 não encontrado.
-- =====================================================================

alter table mkt.tracking_links add column campaign_id uuid;                         -- FK entra na migration da campanha (a tabela de campanhas já existe, mas o vínculo nasce lá)
alter table mkt.tracking_links add column target text not null default 'WHATSAPP' check (target in ('WHATSAPP', 'TELEGRAM', 'WEB'));
alter table mkt.tracking_links add column target_url text check (target_url is null or target_url ~* '^https?://[^\s]+$');
alter table mkt.tracking_links add column utm jsonb not null default '{}';
alter table mkt.tracking_links alter column channel_account_id drop not null;
alter table mkt.tracking_links add constraint tracking_links_target_ck check ((target = 'WEB' and target_url is not null) or (target <> 'WEB' and channel_account_id is not null));
alter table mkt.tracking_links add constraint tracking_links_campaign_fk foreign key (campaign_id) references mkt.campaigns(id) on delete set null;
create index tracking_links_campaign_idx on mkt.tracking_links (campaign_id) where campaign_id is not null;

update mkt.tracking_links l set target = 'TELEGRAM' from omni.channel_accounts ca where ca.id = l.channel_account_id and ca.channel = 'TELEGRAM';

create table mkt.link_clicks (
  id bigint generated always as identity primary key,
  org_id uuid not null references core.orgs(id),
  tracking_link_id uuid not null references mkt.tracking_links(id) on delete cascade,
  clicked_at timestamptz not null default now(),
  device text check (device in ('MOBILE', 'DESKTOP', 'OTHER')),
  referrer_host text,
  from_ad boolean not null default false,                         -- veio com fbclid (anúncio da Meta)
  utm jsonb not null default '{}'
);
create index link_clicks_link_idx on mkt.link_clicks (tracking_link_id, clicked_at);
select private.apply_rls('mkt', array['link_clicks'], 'crm.read', 'crm.write');
select private.rpc_only('mkt', array['link_clicks']);

-- Endereço público do sistema (para montar o link curto): core.settings 'public_url' = {"base": "https://..."}
create or replace function mkt.set_public_url(p_base text) returns text
language plpgsql security definer set search_path = '' as $$
declare v text := regexp_replace(trim(coalesce(p_base, '')), '/+$', '');
begin
  perform private.require_perm('core.admin');
  if v !~* '^https?://[^\s/]+(:[0-9]+)?(/[^\s]*)?$' then raise exception 'Informe o endereço completo do sistema (ex.: https://app.minhaloja.com.br)' using errcode = 'P0310'; end if;
  insert into core.settings (org_id, key, value) values (private.org_id(), 'public_url', jsonb_build_object('base', v)) on conflict (org_id, key) do update set value = excluded.value;
  return v;
end $$;

create or replace function private.public_url(p_org uuid) returns text
language sql stable security definer set search_path = '' as $$
  select value ->> 'base' from core.settings where org_id = p_org and key = 'public_url'
$$;

-- ---------------------------------------------------------------------
-- Cadastro (v2)
-- p = {id?, code, name, kind, target?, channel_account_id?, target_url?, utm?, prefill_text?, affiliate_party_id?, event_id?, campaign_id?}
-- ---------------------------------------------------------------------
create or replace function mkt.save_tracking_link(p jsonb) returns mkt.tracking_links
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id(); v_id uuid := nullif(p ->> 'id', '')::uuid; v_code text := lower(trim(coalesce(p ->> 'code', '')));
  v_name text := trim(coalesce(p ->> 'name', '')); v_kind text := upper(coalesce(nullif(p ->> 'kind', ''), 'QR'));
  v_acc uuid := nullif(p ->> 'channel_account_id', '')::uuid; ca omni.channel_accounts; v_text text := nullif(trim(coalesce(p ->> 'prefill_text', '')), '');
  v_aff uuid := nullif(p ->> 'affiliate_party_id', '')::uuid; v_event uuid := nullif(p ->> 'event_id', '')::uuid; v_camp uuid := nullif(p ->> 'campaign_id', '')::uuid;
  v_target text := upper(nullif(p ->> 'target', '')); v_url text := nullif(trim(coalesce(p ->> 'target_url', '')), ''); v_utm jsonb := coalesce(p -> 'utm', '{}'); l mkt.tracking_links;
begin
  perform private.require_perm('crm.write');
  if v_code !~ '^[a-z0-9][a-z0-9-]{2,22}$' then raise exception 'Código: 3 a 23 letras minúsculas, números ou hífen (ex.: qr-recepcao)' using errcode = 'P0310'; end if;
  if length(v_name) not between 3 and 80 then raise exception 'Nome: 3 a 80 caracteres' using errcode = 'P0310'; end if;
  if v_kind not in ('QR', 'BIO', 'STORY', 'TIKTOK', 'TRAINER', 'EVENT', 'CAMPAIGN', 'PRINT', 'OTHER') then raise exception 'Tipo inválido' using errcode = 'P0310'; end if;
  if jsonb_typeof(v_utm) <> 'object' then raise exception 'UTM inválido' using errcode = 'P0310'; end if;
  if v_target is null then v_target := case when v_acc is null and v_url is not null then 'WEB' else null end; end if;
  if v_target = 'WEB' then
    if v_url is null or v_url !~* '^https?://[^\s]+$' then raise exception 'Informe o endereço completo da página (começando com https://)' using errcode = 'P0310'; end if;
    v_acc := null; v_text := null;
  else
    select * into ca from omni.channel_accounts where id = v_acc and org_id = v_org;
    if ca.id is null or ca.channel not in ('WHATSAPP', 'TELEGRAM') then raise exception 'Escolha um canal de WhatsApp ou Telegram' using errcode = 'P0310'; end if;
    v_target := ca.channel; v_url := null;
  end if;
  if v_text is not null and length(v_text) > 200 then raise exception 'Texto pronto: até 200 caracteres' using errcode = 'P0310'; end if;
  if v_aff is not null and not exists (select 1 from crm.parties where id = v_aff and org_id = v_org) then raise exception 'Afiliada inválida' using errcode = 'P0310'; end if;
  if v_event is not null and not exists (select 1 from mkt.events where id = v_event and org_id = v_org) then raise exception 'Evento inválido' using errcode = 'P0310'; end if;
  if v_camp is not null and not exists (select 1 from mkt.campaigns where id = v_camp and org_id = v_org) then raise exception 'Campanha inválida' using errcode = 'P0310'; end if;

  if v_id is null then
    insert into mkt.tracking_links (org_id, code, name, kind, channel_account_id, prefill_text, affiliate_party_id, event_id, campaign_id, target, target_url, utm, created_by)
    values (v_org, v_code, v_name, v_kind, v_acc, v_text, v_aff, v_event, v_camp, v_target, v_url, v_utm, private.member_id()) returning * into l;
  else
    update mkt.tracking_links set code = v_code, name = v_name, kind = v_kind, channel_account_id = v_acc, prefill_text = v_text, affiliate_party_id = v_aff, event_id = v_event,
           campaign_id = v_camp, target = v_target, target_url = v_url, utm = v_utm
    where id = v_id and org_id = v_org returning * into l;
    if l.id is null then raise exception 'Link não encontrado' using errcode = 'P0312'; end if;
  end if;
  return l;
exception when unique_violation then
  raise exception 'Já existe um link com o código %', v_code using errcode = 'P0310';
end $$;

-- ---------------------------------------------------------------------
-- Rota pública /r/código: devolve o destino e grava o clique. Só dados que já são públicos (para onde o link leva).
-- p_meta = {device?, referrer_host?, from_ad?, utm?}; link pausado ou inexistente devolve null.
-- ---------------------------------------------------------------------
create or replace function public.resolve_link(p_code text, p_meta jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare l mkt.tracking_links; ca omni.channel_accounts; cp mkt.campaigns; v_dev text := upper(coalesce(p_meta ->> 'device', 'OTHER'));
begin
  if p_code is null or lower(p_code) !~ '^[a-z0-9][a-z0-9-]{2,22}$' then return null; end if;
  select * into l from mkt.tracking_links where code = lower(p_code) and active order by created_at limit 1;
  if l.id is null then return null; end if;
  if l.campaign_id is not null then
    select * into cp from mkt.campaigns where id = l.campaign_id;
    if cp.id is not null and cp.status in ('ENDED', 'CANCELLED') then return null; end if;
  end if;
  if v_dev not in ('MOBILE', 'DESKTOP', 'OTHER') then v_dev := 'OTHER'; end if;
  insert into mkt.link_clicks (org_id, tracking_link_id, device, referrer_host, from_ad, utm)
  values (l.org_id, l.id, v_dev, left(p_meta ->> 'referrer_host', 120), coalesce((p_meta ->> 'from_ad')::boolean, false),
          case when jsonb_typeof(p_meta -> 'utm') = 'object' then p_meta -> 'utm' else '{}' end);
  if l.channel_account_id is not null then select * into ca from omni.channel_accounts where id = l.channel_account_id; end if;
  return jsonb_build_object('target', l.target, 'code', l.code, 'kind', l.kind, 'channel', ca.channel, 'address', ca.public_address, 'prefill_text', l.prefill_text,
                            'target_url', l.target_url, 'utm', l.utm, 'campaign_code', cp.code);
end $$;
grant execute on function public.resolve_link(text, jsonb) to anon, authenticated, service_role;

-- Cliques por link no período
create or replace function mkt.link_click_stats(p_from date, p_to date) returns table (link_id uuid, clicks int, clicks_ad int, last_click timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare v_f timestamptz; v_t timestamptz;
begin
  perform private.require_perm('crm.read');
  if p_from is null or p_to is null or p_to < p_from then raise exception 'Período inválido' using errcode = 'P0310'; end if;
  v_f := (p_from::timestamp at time zone 'America/Sao_Paulo'); v_t := ((p_to + 1)::timestamp at time zone 'America/Sao_Paulo');
  return query select c.tracking_link_id, count(*)::int, count(*) filter (where c.from_ad)::int, max(c.clicked_at)
               from mkt.link_clicks c where c.org_id = private.org_id() and c.clicked_at >= v_f and c.clicked_at < v_t group by 1;
end $$;

-- Limpeza: cliques de mais de 2 anos
create or replace function private.purge_link_clicks() returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  delete from mkt.link_clicks where clicked_at < now() - interval '2 years';
  get diagnostics n = row_count;
  return n;
end $$;
select cron.schedule('centralops-purge-link-clicks', '20 6 * * 0', $$ select private.purge_link_clicks() $$);

-- ---------------------------------------------------------------------
-- Afiliada: o cadastro cria também o link/QR dela (código = cupom em minúsculas)
-- ---------------------------------------------------------------------
create or replace function private.ensure_affiliate_link(p_affiliate uuid) returns mkt.tracking_links
language plpgsql security definer set search_path = '' as $$
declare a aff.affiliates; l mkt.tracking_links; v_acc uuid; v_code text; v_name text; v_coupon text;
begin
  select * into a from aff.affiliates where id = p_affiliate;
  if a.id is null then return null; end if;
  select * into l from mkt.tracking_links where org_id = a.org_id and affiliate_party_id = a.party_id and kind = 'TRAINER' and campaign_id is null order by created_at limit 1;
  if l.id is not null then return l; end if;
  select id into v_acc from omni.channel_accounts where org_id = a.org_id and channel = 'WHATSAPP' and status = 'ACTIVE' order by created_at limit 1;
  if v_acc is null then return null; end if;                                   -- sem número ativo ainda: o link nasce quando houver (veja mkt.ensure_affiliate_links)
  select upper(code) into v_coupon from sales.coupons where id = a.coupon_id;
  v_code := lower(regexp_replace(v_coupon, '[^A-Za-z0-9]', '', 'g'));
  if length(v_code) < 3 then v_code := v_code || 'trn'; end if;
  v_code := left(v_code, 23);
  select display_name into v_name from crm.parties where id = a.party_id;
  insert into mkt.tracking_links (org_id, code, name, kind, target, channel_account_id, prefill_text, affiliate_party_id, created_by)
  values (a.org_id, v_code, 'Trainer ' || v_name, 'TRAINER', 'WHATSAPP', v_acc, 'Oi! Vim pela indicação da ' || split_part(v_name, ' ', 1) || '.', a.party_id, private.member_id())
  on conflict (org_id, code) do nothing returning * into l;
  if l.id is null then select * into l from mkt.tracking_links where org_id = a.org_id and code = v_code; end if;
  return l;
end $$;

-- Cria o link de toda afiliada que ainda não tem (botão da tela e primeiro uso)
create or replace function mkt.ensure_affiliate_links() returns integer
language plpgsql security definer set search_path = '' as $$
declare a record; n integer := 0; l mkt.tracking_links;
begin
  perform private.require_perm('crm.write');
  for a in select id from aff.affiliates where org_id = private.org_id() and status = 'ACTIVE' loop
    if not exists (select 1 from mkt.tracking_links t join aff.affiliates f on f.party_id = t.affiliate_party_id where f.id = a.id and t.kind = 'TRAINER' and t.campaign_id is null) then
      l := private.ensure_affiliate_link(a.id);
      if l.id is not null then n := n + 1; end if;
    end if;
  end loop;
  return n;
end $$;

do $x$
declare v_def text;
begin
  select pg_get_functiondef('aff.save_affiliate(jsonb)'::regprocedure) into v_def;
  if position($y$  return a;
end $function$$y$ in v_def) = 0 then raise exception 'save_affiliate mudou: ajuste este patch'; end if;
  v_def := replace(v_def, $y$  return a;
end $function$$y$, $y$  perform private.ensure_affiliate_link(a.id);
  return a;
end $function$$y$);
  execute v_def;
end $x$;

insert into private.internal_functions (fqname) values ('private.public_url'), ('private.ensure_affiliate_link'), ('private.purge_link_clicks') on conflict do nothing;
select private.lock_functions();
grant execute on function public.resolve_link(text, jsonb) to anon, authenticated, service_role;
