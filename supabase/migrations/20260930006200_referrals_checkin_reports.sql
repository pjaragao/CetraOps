-- =====================================================================
-- Fase 5 do plano de marketing e atendimento: indique uma amiga, check-in de evento por QR e relatórios de aquisição, recompra e réguas.
-- • Indique uma amiga: cada cliente tem um link pessoal (o mesmo mecanismo dos links rastreados). Quando a amiga manda a primeira mensagem
--   pelo link, nasce uma indicação PENDENTE; depois da 1ª compra dela e do prazo de troca (7 dias) quem indicou ganha um vale-troca
--   (contabilizado como cortesia). Regras: amiga nova (sem compra), uma indicação por amiga, teto mensal por cliente e sem devolução.
-- • Check-in: cada convidada tem um QR; a equipe escaneia e confirma a presença; quem chega sem convite é cadastrada na hora, com aceite.
-- Códigos de erro: P0410 dado inválido · P0411 situação não permite · P0412 não encontrado.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Indicação
-- ---------------------------------------------------------------------
alter table mkt.tracking_links add column if not exists referrer_party_id uuid references crm.parties(id) on delete cascade;
alter table mkt.tracking_links drop constraint if exists tracking_links_kind_check;
alter table mkt.tracking_links add constraint tracking_links_kind_check check (kind in ('QR', 'BIO', 'STORY', 'TIKTOK', 'TRAINER', 'EVENT', 'CAMPAIGN', 'PRINT', 'REFERRAL', 'OTHER'));

create table crm.referrals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  referrer_party uuid not null references crm.parties(id) on delete cascade,
  friend_party uuid not null references crm.parties(id) on delete cascade,
  link_id uuid references mkt.tracking_links(id) on delete set null,
  order_id uuid references sales.orders(id) on delete set null,
  status text not null default 'PENDING' check (status in ('PENDING', 'REWARDED', 'REJECTED')),
  reject_reason text check (reject_reason is null or reject_reason in ('RETURNED', 'CAP', 'NO_PURCHASE', 'MANUAL')),
  reward_ledger_id bigint references sales.store_credit_ledger(id) on delete set null,
  reward_amount numeric(14, 2),
  created_at timestamptz not null default now(),
  rewarded_at timestamptz,
  unique (friend_party)
);
create index referrals_referrer_idx on crm.referrals (referrer_party, created_at desc);
select private.apply_rls('crm', array['referrals'], 'crm.read', 'crm.write');
select private.rpc_only('crm', array['referrals']);

create or replace function private.referral_cfg(p_org uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('enabled', false, 'reward_amount', 50, 'wait_days', 7, 'monthly_cap', 5, 'pending_days', 90, 'credit_months', 12)
         || coalesce((select value from core.settings where org_id = p_org and key = 'referral'), '{}')
$$;

create or replace function crm.save_referral_settings(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); c jsonb;
begin
  perform private.require_perm('core.admin');
  c := private.referral_cfg(v_org) || jsonb_strip_nulls(jsonb_build_object('enabled', (p ->> 'enabled')::boolean, 'reward_amount', (p ->> 'reward_amount')::numeric,
        'wait_days', (p ->> 'wait_days')::int, 'monthly_cap', (p ->> 'monthly_cap')::int));
  if (c ->> 'reward_amount')::numeric not between 0 and 1000 then raise exception 'Vale de indicação: de R$ 0 a R$ 1.000' using errcode = 'P0410'; end if;
  if (c ->> 'wait_days')::int not between 0 and 60 then raise exception 'Prazo: de 0 a 60 dias' using errcode = 'P0410'; end if;
  if (c ->> 'monthly_cap')::int not between 1 and 100 then raise exception 'Teto mensal: de 1 a 100 indicações' using errcode = 'P0410'; end if;
  insert into core.settings (org_id, key, value) values (v_org, 'referral', c) on conflict (org_id, key) do update set value = excluded.value;
  return c;
end $$;

-- Link pessoal de indicação (cria na primeira vez; o canal é o primeiro WhatsApp ativo)
create or replace function crm.ensure_referral_link(p_party uuid) returns mkt.tracking_links
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); l mkt.tracking_links; p crm.parties; v_acc uuid; v_first text; v_code text;
begin
  perform private.require_perm('crm.write');
  select * into p from crm.parties where id = p_party and org_id = v_org and kind = 'PERSON' and merged_into_id is null and anonymized_at is null;
  if p.id is null then raise exception 'Cliente não encontrada' using errcode = 'P0412'; end if;
  select * into l from mkt.tracking_links where referrer_party_id = p_party and active order by created_at limit 1;
  if l.id is not null then return l; end if;
  select id into v_acc from omni.channel_accounts where org_id = v_org and channel = 'WHATSAPP' and status = 'ACTIVE' order by created_at limit 1;
  if v_acc is null then raise exception 'Cadastre um número de WhatsApp ativo antes' using errcode = 'P0411'; end if;
  v_first := split_part(p.display_name, ' ', 1);
  v_code := 'ind-' || left(coalesce(nullif(regexp_replace(lower(private.norm(v_first)), '[^a-z0-9]', '', 'g'), ''), 'amiga'), 8) || substr(md5(gen_random_uuid()::text), 1, 4);
  insert into mkt.tracking_links (org_id, code, name, kind, channel_account_id, prefill_text, referrer_party_id, created_by)
  values (v_org, v_code, 'Indicação de ' || p.display_name, 'REFERRAL', v_acc, 'Oi, SIÉ! Fui indicada por ' || v_first || '.', p_party, private.member_id()) returning * into l;
  return l;
end $$;

-- Quando a mensagem chega pelo link de indicação nasce a indicação (amiga nova, sem compra, sem indicação anterior)
create or replace function private.register_referral(p_org uuid, p_referrer uuid, p_friend uuid, p_link uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_paid text[] := array['PAID', 'COMPLETED', 'FULFILLING', 'READY_FOR_PICKUP', 'SHIPPED', 'PARTIALLY_RETURNED']; v_rn text; v_fn text;
begin
  if p_referrer = p_friend or exists (select 1 from crm.referrals where friend_party = p_friend) then return; end if;
  if exists (select 1 from sales.orders o where o.party_id = p_friend and o.status::text = any (v_paid)) then return; end if;           -- amiga já era cliente
  insert into crm.referrals (org_id, referrer_party, friend_party, link_id) values (p_org, p_referrer, p_friend, p_link);
  update crm.parties set tags = array(select distinct unnest(tags || array['indicacao'])) where id = p_friend;
  select display_name into v_rn from crm.parties where id = p_referrer;
  select display_name into v_fn from crm.parties where id = p_friend;
  perform private.timeline(p_org, p_friend, 'REFERRAL', 'crm.referrals', null, 'Indicada por ' || v_rn);
  perform private.timeline(p_org, p_referrer, 'REFERRAL', 'crm.referrals', null, 'Indicou ' || v_fn);
end $$;

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
  if l.referrer_party_id is not null then perform private.register_referral(new.org_id, l.referrer_party_id, v_party, l.id); end if;
  return null;
end $$;

-- Primeira compra paga da amiga indicada: guarda o pedido e avisa a vendedora do mimo de boas-vindas
create or replace function private.referral_on_order() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r crm.referrals; v_rn text; v_fn text; v_paid text[] := array['PAID', 'COMPLETED', 'FULFILLING', 'READY_FOR_PICKUP', 'SHIPPED', 'PARTIALLY_RETURNED'];
begin
  if new.party_id is null or new.status::text <> all (v_paid) or (tg_op = 'UPDATE' and old.status::text = any (v_paid)) then return null; end if;
  select * into r from crm.referrals where friend_party = new.party_id and status = 'PENDING' and order_id is null;
  if r.id is null then return null; end if;
  update crm.referrals set order_id = new.id where id = r.id;
  select display_name into v_rn from crm.parties where id = r.referrer_party;
  select display_name into v_fn from crm.parties where id = r.friend_party;
  insert into crm.tasks (org_id, party_id, type, title, body, due_at, source_rule)
  values (r.org_id, r.friend_party, 'FOLLOW_UP', 'Mimo de boas-vindas para ' || split_part(v_fn, ' ', 1) || ' (indicada por ' || split_part(v_rn, ' ', 1) || ')',
          'Primeira compra de uma indicação: entregue o mimo e agradeça. Quem indicou ganha o vale depois do prazo de troca.', now(), 'referral-welcome:' || r.id);
  return null;
end $$;
create trigger trg_referral_on_order after insert or update of status on sales.orders for each row execute function private.referral_on_order();

-- Todo dia: recompensa quem indicou (depois do prazo de troca, respeitando o teto) e encerra indicações sem compra
create or replace function private.sweep_referrals() returns integer
language plpgsql security definer set search_path = '' as $$
declare r record; c jsonb; n int := 0; v_ledger bigint; v_rewarded int; v_paid text[] := array['PAID', 'COMPLETED', 'FULFILLING', 'READY_FOR_PICKUP', 'SHIPPED', 'PARTIALLY_RETURNED'];
begin
  for r in select rf.*, o.status::text as ost, o.created_at as ocreated from crm.referrals rf left join sales.orders o on o.id = rf.order_id where rf.status = 'PENDING' order by rf.created_at loop
    c := private.referral_cfg(r.org_id);
    continue when not coalesce((c ->> 'enabled')::boolean, false);
    if r.order_id is null then
      if r.created_at < now() - make_interval(days => (c ->> 'pending_days')::int) then update crm.referrals set status = 'REJECTED', reject_reason = 'NO_PURCHASE' where id = r.id; n := n + 1; end if;
      continue;
    end if;
    if r.ost not in (select unnest(v_paid)) or exists (select 1 from sales.returns rt where rt.order_id = r.order_id) then
      update crm.referrals set status = 'REJECTED', reject_reason = 'RETURNED' where id = r.id; n := n + 1; continue;
    end if;
    continue when r.ocreated > now() - make_interval(days => (c ->> 'wait_days')::int);
    select count(*)::int into v_rewarded from crm.referrals x where x.referrer_party = r.referrer_party and x.status = 'REWARDED' and x.rewarded_at > now() - interval '30 days';
    if v_rewarded >= (c ->> 'monthly_cap')::int then update crm.referrals set status = 'REJECTED', reject_reason = 'CAP' where id = r.id; n := n + 1; continue; end if;
    if (c ->> 'reward_amount')::numeric <= 0 then update crm.referrals set status = 'REWARDED', rewarded_at = now(), reward_amount = 0 where id = r.id; n := n + 1; continue; end if;
    begin
      v_ledger := private.issue_credit(r.org_id, r.referrer_party, (c ->> 'reward_amount')::numeric, 'crm.referrals', r.id, 'Indicação de amiga', (c ->> 'credit_months')::int);
      update crm.referrals set status = 'REWARDED', rewarded_at = now(), reward_ledger_id = v_ledger, reward_amount = (c ->> 'reward_amount')::numeric where id = r.id;
      perform private.timeline(r.org_id, r.referrer_party, 'REFERRAL', 'crm.referrals', r.id, 'Vale de indicação de R$ ' || to_char((c ->> 'reward_amount')::numeric, 'FM999990.00') || ' emitido');
      n := n + 1;
    exception when others then raise warning 'recompensa da indicação % falhou: %', r.id, sqlerrm; end;
  end loop;
  return n;
end $$;
select cron.schedule('sie-sweep-referrals', '20 6 * * *', $$ select private.sweep_referrals() $$);

-- ---------------------------------------------------------------------
-- 2) Check-in por QR
-- ---------------------------------------------------------------------
alter table mkt.event_guests add column if not exists checkin_token text not null default replace(gen_random_uuid()::text, '-', '');
create unique index if not exists event_guests_token_uq on mkt.event_guests (checkin_token);

create or replace function mkt.guest_by_token(p_token text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare g mkt.event_guests; e mkt.events; v_name text;
begin
  perform private.require_perm('crm.read');
  select * into g from mkt.event_guests where checkin_token = p_token and org_id = private.org_id();
  if g.id is null then raise exception 'QR não reconhecido' using errcode = 'P0412'; end if;
  select * into e from mkt.events where id = g.event_id;
  select display_name into v_name from crm.parties where id = g.party_id;
  return jsonb_build_object('guest_id', g.id, 'event_id', e.id, 'event', e.name, 'name', v_name, 'party_id', g.party_id, 'rsvp', g.rsvp_status, 'plus_ones', g.plus_ones, 'checked_in_at', g.checked_in_at, 'starts_at', e.starts_at);
end $$;

-- Confirma a presença pelo QR (idempotente). Acompanhantes opcionais.
create or replace function mkt.checkin_by_token(p_token text, p_plus_ones int default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare g mkt.event_guests; e mkt.events;
begin
  perform private.require_perm('crm.write');
  select * into g from mkt.event_guests where checkin_token = p_token and org_id = private.org_id();
  if g.id is null then raise exception 'QR não reconhecido' using errcode = 'P0412'; end if;
  select * into e from mkt.events where id = g.event_id;
  if e.status = 'CANCELLED' then raise exception 'Este evento foi cancelado' using errcode = 'P0411'; end if;
  if g.rsvp_status in ('ATTENDED') then return mkt.guest_by_token(p_token) || jsonb_build_object('already', true); end if;
  g := private.apply_rsvp(g.org_id, g.id, 'ATTENDED', coalesce(p_plus_ones, g.plus_ones));
  return mkt.guest_by_token(p_token) || jsonb_build_object('already', false);
end $$;

-- Quem chega sem convite: cadastra, convida e confirma a presença; o aceite de marketing é registrado se ela der
-- p = {event_id, name, phone, accept_marketing, plus_ones?}
create or replace function mkt.checkin_walkin(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); e mkt.events; v_phone text := trim(coalesce(p ->> 'phone', '')); v_party uuid; g mkt.event_guests; v_norm text;
begin
  perform private.require_perm('crm.write');
  select * into e from mkt.events where id = nullif(p ->> 'event_id', '')::uuid and org_id = v_org and status in ('PLANNED', 'CONFIRMED', 'DONE');
  if e.id is null then raise exception 'Evento não encontrado ou cancelado' using errcode = 'P0412'; end if;
  if length(trim(coalesce(p ->> 'name', ''))) < 2 then raise exception 'Informe o nome' using errcode = 'P0410'; end if;
  if v_phone <> '' then
    v_norm := private.normalize_phone(v_phone);
    select party_id into v_party from crm.party_contact_points where org_id = v_org and type in ('WHATSAPP', 'PHONE') and value_normalized = v_norm limit 1;
  end if;
  if v_party is null then
    v_party := (crm.create_party(jsonb_build_object('display_name', trim(p ->> 'name'), 'phones', case when v_phone <> '' then jsonb_build_array(v_phone) else '[]'::jsonb end, 'source', 'EVENTO:' || left(e.name, 40)))).id;
  end if;
  if coalesce((p ->> 'accept_marketing')::boolean, false) then perform crm.set_consent(v_party, 'MARKETING_WHATSAPP', true, 'EVENTO'); end if;
  select * into g from mkt.event_guests where event_id = e.id and party_id = v_party;
  if g.id is null then
    insert into mkt.event_guests (org_id, event_id, party_id, invited_by, source, rsvp_status, plus_ones) values (v_org, e.id, v_party, private.member_id(), 'MANUAL', 'INVITED', coalesce((p ->> 'plus_ones')::int, 0)) returning * into g;
  end if;
  if g.rsvp_status <> 'ATTENDED' then g := private.apply_rsvp(v_org, g.id, 'ATTENDED', coalesce((p ->> 'plus_ones')::int, g.plus_ones)); end if;
  return jsonb_build_object('party_id', v_party, 'guest_id', g.id, 'token', g.checkin_token);
end $$;

-- ---------------------------------------------------------------------
-- 3) Relatórios
-- ---------------------------------------------------------------------
-- Aquisição por origem: leads novas, quantas compraram (até 30 dias), conversão, receita e tempo até a 1ª compra
create or replace function crm.report_acquisition(p_from date, p_to date) returns table (source text, leads int, buyers int, conversion_pct numeric, revenue numeric, avg_days_to_buy numeric, ad_spend numeric, cost_per_customer numeric)
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); v_f timestamptz; v_t timestamptz; v_paid text[] := array['PAID', 'COMPLETED', 'FULFILLING', 'READY_FOR_PICKUP', 'SHIPPED', 'PARTIALLY_RETURNED'];
begin
  perform private.require_perm('crm.read');
  if p_from is null or p_to is null or p_to < p_from then raise exception 'Período inválido' using errcode = 'P0410'; end if;
  v_f := (p_from::timestamp at time zone 'America/Sao_Paulo'); v_t := ((p_to + 1)::timestamp at time zone 'America/Sao_Paulo');
  return query
    with leads as (
      select p.id, case when coalesce(p.source, '') like 'LINK:%' then 'Link: ' || substr(p.source, 6) else coalesce(nullif(p.source, ''), 'Sem origem') end as src, p.created_at
      from crm.parties p where p.org_id = v_org and p.created_at >= v_f and p.created_at < v_t and p.merged_into_id is null and p.anonymized_at is null
        and not exists (select 1 from crm.party_roles rl where rl.party_id = p.id and rl.role in ('EMPLOYEE', 'SUPPLIER', 'SERVICE_PROVIDER', 'CARRIER', 'ACQUIRER', 'BANK'))
    ), first as (
      select l.id, l.src, min(o.created_at) as at, (array_agg(o.total order by o.created_at))[1] as total
      from leads l join sales.orders o on o.party_id = l.id and o.status::text = any (v_paid) and o.created_at >= l.created_at and o.created_at < l.created_at + interval '30 days' group by l.id, l.src
    ), agg as (
      select l.src, count(*)::int as leads, count(f.id)::int as buyers, coalesce(sum(f.total), 0) as revenue, avg(extract(epoch from (f.at - l.created_at)) / 86400) as days
      from leads l left join first f on f.id = l.id group by l.src
    ), spend as (select coalesce(sum(i.spend), 0) as total from mkt.ad_insights_daily i where i.org_id = v_org and i.day between p_from and p_to)
    select a.src, a.leads, a.buyers, round(100.0 * a.buyers / nullif(a.leads, 0), 1), a.revenue, round(a.days::numeric, 1),
           case when a.src = 'CTWA' then (select total from spend) end, case when a.src = 'CTWA' and a.buyers > 0 then round((select total from spend) / a.buyers, 2) end
    from agg a order by a.leads desc;
end $$;

-- Recompra por coorte: mês da 1ª compra × quantas voltaram em 30, 60, 90 e 180 dias (só conta coorte que já amadureceu)
create or replace function sales.report_cohorts(p_months int default 12) returns table (cohort text, customers int, back_30 numeric, back_60 numeric, back_90 numeric, back_180 numeric)
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); v_paid text[] := array['PAID', 'COMPLETED', 'FULFILLING', 'READY_FOR_PICKUP', 'SHIPPED', 'PARTIALLY_RETURNED'];
begin
  perform private.require_perm('sales.read');
  return query
    with o as (select x.party_id, x.created_at, row_number() over (partition by x.party_id order by x.created_at) as n from sales.orders x where x.org_id = v_org and x.party_id is not null and x.status::text = any (v_paid)),
    f as (select party_id, created_at as first_at, date_trunc('month', created_at at time zone 'America/Sao_Paulo')::date as m from o where n = 1),
    s as (select party_id, created_at as second_at from o where n = 2)
    select to_char(f.m, 'MM/YYYY'), count(*)::int,
           case when max(f.first_at) < now() - interval '30 days' then round(100.0 * count(*) filter (where s.second_at <= f.first_at + interval '30 days') / count(*), 1) end,
           case when max(f.first_at) < now() - interval '60 days' then round(100.0 * count(*) filter (where s.second_at <= f.first_at + interval '60 days') / count(*), 1) end,
           case when max(f.first_at) < now() - interval '90 days' then round(100.0 * count(*) filter (where s.second_at <= f.first_at + interval '90 days') / count(*), 1) end,
           case when max(f.first_at) < now() - interval '180 days' then round(100.0 * count(*) filter (where s.second_at <= f.first_at + interval '180 days') / count(*), 1) end
    from f left join s on s.party_id = f.party_id
    where f.m >= (date_trunc('month', private.today_sp()) - make_interval(months => least(greatest(p_months, 1), 36)))::date
    group by f.m order by f.m desc;
end $$;

-- Réguas: tratamento × controle por régua no período de inscrição
create or replace function mkt.report_journeys(p_from date, p_to date) returns table (journey text, enrolled int, treatment int, holdout int, treatment_rate numeric, holdout_rate numeric, lift_pp numeric, revenue numeric)
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); v_f timestamptz; v_t timestamptz; v_paid text[] := array['PAID', 'COMPLETED', 'FULFILLING', 'READY_FOR_PICKUP', 'SHIPPED', 'PARTIALLY_RETURNED'];
begin
  perform private.require_perm('crm.read');
  if p_from is null or p_to is null or p_to < p_from then raise exception 'Período inválido' using errcode = 'P0410'; end if;
  v_f := (p_from::timestamp at time zone 'America/Sao_Paulo'); v_t := ((p_to + 1)::timestamp at time zone 'America/Sao_Paulo');
  return query
    with en as (
      select e.journey_id, e.grp, (select o.total from sales.orders o where o.party_id = e.party_id and o.status::text = any (v_paid) and o.created_at > e.enrolled_at and o.created_at <= e.enrolled_at + interval '30 days'
                                   and o.id::text <> e.source_key order by o.created_at limit 1) as total
      from mkt.journey_enrollments e where e.org_id = v_org and e.enrolled_at >= v_f and e.enrolled_at < v_t
    )
    select j.name, count(*)::int, count(*) filter (where en.grp = 'TREATMENT')::int, count(*) filter (where en.grp = 'HOLDOUT')::int,
           round(100.0 * count(en.total) filter (where en.grp = 'TREATMENT') / nullif(count(*) filter (where en.grp = 'TREATMENT'), 0), 1),
           round(100.0 * count(en.total) filter (where en.grp = 'HOLDOUT') / nullif(count(*) filter (where en.grp = 'HOLDOUT'), 0), 1),
           round(100.0 * count(en.total) filter (where en.grp = 'TREATMENT') / nullif(count(*) filter (where en.grp = 'TREATMENT'), 0)
               - 100.0 * count(en.total) filter (where en.grp = 'HOLDOUT') / nullif(count(*) filter (where en.grp = 'HOLDOUT'), 0), 1),
           coalesce(sum(en.total) filter (where en.grp = 'TREATMENT'), 0)
    from en join mkt.journeys j on j.id = en.journey_id group by j.name order by 2 desc;
end $$;

-- Satisfação por mês: CSAT e NPS
create or replace function omni.report_satisfaction(p_from date, p_to date) returns table (month text, csat_asked int, csat_answered int, csat_avg numeric, nps_asked int, nps_answered int, nps integer)
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); v_f timestamptz; v_t timestamptz;
begin
  perform private.require_perm('omni.read');
  if p_from is null or p_to is null or p_to < p_from then raise exception 'Período inválido' using errcode = 'P0410'; end if;
  v_f := (p_from::timestamp at time zone 'America/Sao_Paulo'); v_t := ((p_to + 1)::timestamp at time zone 'America/Sao_Paulo');
  return query
    with m as (select date_trunc('month', g at time zone 'America/Sao_Paulo')::date as d from generate_series(v_f, v_t - interval '1 second', interval '1 month') g union select date_trunc('month', p_from)::date)
    select to_char(m.d, 'MM/YYYY'),
      (select count(*)::int from omni.csat_responses c where c.org_id = v_org and date_trunc('month', c.asked_at at time zone 'America/Sao_Paulo')::date = m.d and c.asked_at >= v_f and c.asked_at < v_t),
      (select count(score)::int from omni.csat_responses c where c.org_id = v_org and date_trunc('month', c.asked_at at time zone 'America/Sao_Paulo')::date = m.d and c.asked_at >= v_f and c.asked_at < v_t),
      (select round(avg(score), 2) from omni.csat_responses c where c.org_id = v_org and date_trunc('month', c.asked_at at time zone 'America/Sao_Paulo')::date = m.d and c.asked_at >= v_f and c.asked_at < v_t),
      (select count(*)::int from omni.nps_responses n where n.org_id = v_org and date_trunc('month', n.asked_at at time zone 'America/Sao_Paulo')::date = m.d and n.asked_at >= v_f and n.asked_at < v_t),
      (select count(score)::int from omni.nps_responses n where n.org_id = v_org and date_trunc('month', n.asked_at at time zone 'America/Sao_Paulo')::date = m.d and n.asked_at >= v_f and n.asked_at < v_t),
      (select case when count(score) > 0 then round(100.0 * (count(*) filter (where score >= 9) - count(*) filter (where score <= 6)) / count(score))::int end
         from omni.nps_responses n where n.org_id = v_org and date_trunc('month', n.asked_at at time zone 'America/Sao_Paulo')::date = m.d and n.asked_at >= v_f and n.asked_at < v_t)
    from m order by m.d desc;
end $$;

-- Motivos de perda das oportunidades e quantas voltaram a comprar depois
create or replace function crm.report_lost_reasons(p_from date, p_to date) returns table (reason text, lost int, bought_later int, recovered_pct numeric)
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); v_f timestamptz; v_t timestamptz; v_paid text[] := array['PAID', 'COMPLETED', 'FULFILLING', 'READY_FOR_PICKUP', 'SHIPPED', 'PARTIALLY_RETURNED'];
begin
  perform private.require_perm('crm.read');
  if p_from is null or p_to is null or p_to < p_from then raise exception 'Período inválido' using errcode = 'P0410'; end if;
  v_f := (p_from::timestamp at time zone 'America/Sao_Paulo'); v_t := ((p_to + 1)::timestamp at time zone 'America/Sao_Paulo');
  return query
    select coalesce(nullif(trim(d.lost_reason), ''), 'Sem motivo'), count(*)::int,
           count(*) filter (where exists (select 1 from sales.orders o where o.party_id = d.party_id and o.status::text = any (v_paid) and o.created_at > d.updated_at))::int,
           round(100.0 * count(*) filter (where exists (select 1 from sales.orders o where o.party_id = d.party_id and o.status::text = any (v_paid) and o.created_at > d.updated_at)) / count(*), 1)
    from crm.deals d where d.org_id = v_org and d.status = 'LOST' and d.updated_at >= v_f and d.updated_at < v_t group by 1 order by 2 desc;
end $$;

-- Correção: o id do livro de vales é bigint e o aviso de vale emitido espera uuid (o aviso nunca saía); usa um uuid derivado do id
create or replace function private.notice_on_credit() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.amount > 0 and new.reason in ('RETURN', 'GOODWILL', 'AFFILIATE_COMMISSION') then
    begin
      perform private.dispatch_notice(new.org_id, 'STORE_CREDIT_ISSUED', new.party_id, md5('store_credit:' || new.id)::uuid, jsonb_build_object('valor', 'R$ ' || to_char(new.amount, 'FM999G990D00')));
    exception when others then raise warning 'aviso de vale-troca falhou: %', sqlerrm; end;
  end if;
  return null;
end $$;

insert into private.internal_functions (fqname) values ('private.referral_cfg'), ('private.register_referral'), ('private.referral_on_order'), ('private.sweep_referrals') on conflict do nothing;
select private.lock_functions();
