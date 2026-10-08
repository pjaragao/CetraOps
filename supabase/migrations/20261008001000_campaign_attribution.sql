-- =====================================================================
-- Marketing › Resultado único da campanha: de qual campanha veio cada venda, quanto custou e quanto sobrou.
-- Uma venda paga dentro da janela da campanha conta para UMA campanha só, pela regra mais forte primeiro:
--   1) COUPON  usou o cupom da campanha (ou o de uma afiliada, quando a oferta é de afiliadas)
--   2) LINK    tocou num link da campanha antes de comprar
--   3) AD      veio de um anúncio da Meta ligado à campanha
--   4) MESSAGE recebeu a mensagem da campanha e comprou dentro da janela de atribuição
-- O efeito "de verdade" da mensagem é o lift: taxa de compra de quem recebeu menos a de quem ficou no grupo de controle.
-- Códigos de erro: P0192 não encontrado · P0190 dado inválido.
-- =====================================================================

-- Campanha do sistema ↔ campanha da Meta (manual ou pela tag [c:código] no nome da campanha da Meta)
create table mkt.campaign_ad_links (
  campaign_id uuid not null references mkt.campaigns(id) on delete cascade,
  org_id uuid not null references core.orgs(id),
  meta_campaign_id text not null,
  meta_campaign_name text,
  source text not null default 'MANUAL' check (source in ('MANUAL', 'TAG')),
  created_at timestamptz not null default now(),
  primary key (campaign_id, meta_campaign_id)
);
create index campaign_ad_links_meta_idx on mkt.campaign_ad_links (org_id, meta_campaign_id);
select private.apply_rls('mkt', array['campaign_ad_links'], 'crm.read', 'crm.write');
select private.rpc_only('mkt', array['campaign_ad_links']);

-- Campanhas da Meta já sincronizadas (para escolher o vínculo)
create or replace function mkt.ad_campaigns() returns table (meta_campaign_id text, meta_campaign_name text, spend numeric, last_day date, linked_to uuid)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_perm('crm.read');
  return query
    select a.campaign_id, max(a.campaign_name), sum(a.spend), max(a.day),
           (select l.campaign_id from mkt.campaign_ad_links l where l.org_id = a.org_id and l.meta_campaign_id = a.campaign_id limit 1)
    from mkt.ad_insights_daily a where a.org_id = private.org_id() and a.campaign_id is not null group by a.org_id, a.campaign_id order by max(a.day) desc, 2;
end $$;

-- Define quais campanhas da Meta pertencem à campanha do sistema (manual; as de tag continuam)
create or replace function mkt.link_campaign_ads(p_campaign uuid, p_meta_ids text[]) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); n int;
begin
  perform private.require_perm('crm.write');
  if not exists (select 1 from mkt.campaigns where id = p_campaign and org_id = v_org) then raise exception 'Campanha não encontrada' using errcode = 'P0192'; end if;
  delete from mkt.campaign_ad_links where campaign_id = p_campaign and source = 'MANUAL';
  insert into mkt.campaign_ad_links (campaign_id, org_id, meta_campaign_id, meta_campaign_name, source)
  select p_campaign, v_org, x.id, (select max(a.campaign_name) from mkt.ad_insights_daily a where a.org_id = v_org and a.campaign_id = x.id), 'MANUAL'
  from unnest(coalesce(p_meta_ids, '{}')) as x(id) where exists (select 1 from mkt.ad_insights_daily a where a.org_id = v_org and a.campaign_id = x.id)
  on conflict do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

-- Liga sozinho as campanhas da Meta que levam [c:código] no nome
create or replace function private.autolink_campaign_ads(p_org uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  insert into mkt.campaign_ad_links (campaign_id, org_id, meta_campaign_id, meta_campaign_name, source)
  select distinct c.id, p_org, a.campaign_id, a.campaign_name, 'TAG'
  from mkt.ad_insights_daily a join mkt.campaigns c on c.org_id = p_org and c.code is not null and lower(a.campaign_name) like '%[c:' || c.code || ']%'
  where a.org_id = p_org and a.campaign_id is not null on conflict do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

do $x$
declare v_def text;
begin
  select pg_get_functiondef('mkt.ad_insights_upsert(uuid,text,jsonb)'::regprocedure) into v_def;
  if position($y$  return n;
end $function$$y$ in v_def) = 0 then raise exception 'ad_insights_upsert mudou: ajuste este patch'; end if;
  v_def := replace(v_def, $y$  return n;
end $function$$y$, $y$  perform private.autolink_campaign_ads(p_org);
  return n;
end $function$$y$);
  execute v_def;
end $x$;

-- Visão por anúncio ganha a campanha do sistema
create or replace function mkt.ads_overview(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); v_paid text[] := private.paid_order_statuses();
begin
  perform private.require_perm('crm.read');
  return coalesce((
    select jsonb_agg(row_to_json(x)::jsonb order by x.spend desc) from (
      select a.ad_id, max(a.ad_name) as ad_name, max(a.campaign_name) as campaign_name, max(a.adset_name) as adset_name, max(a.campaign_id) as meta_campaign_id,
             (select c.name from mkt.campaign_ad_links l join mkt.campaigns c on c.id = l.campaign_id where l.org_id = v_org and l.meta_campaign_id = max(a.campaign_id) limit 1) as system_campaign,
             (select c.id from mkt.campaign_ad_links l join mkt.campaigns c on c.id = l.campaign_id where l.org_id = v_org and l.meta_campaign_id = max(a.campaign_id) limit 1) as system_campaign_id,
             sum(a.spend) as spend, sum(a.impressions) as impressions, sum(a.reach) as reach, sum(a.clicks) as clicks, sum(a.leads) as leads, sum(a.conversations) as conversations,
             coalesce((select count(distinct t.party_id) from crm.timeline_events t where t.org_id = v_org and t.kind = 'AD_REFERRAL' and t.payload ->> 'source_id' = a.ad_id
                        and (t.occurred_at at time zone 'America/Sao_Paulo')::date between p_from and p_to), 0) as leads_system,
             coalesce((select count(*) from sales.orders o where o.org_id = v_org and o.status::text = any (v_paid) and o.attribution #>> '{referral,source_id}' = a.ad_id
                        and (o.created_at at time zone 'America/Sao_Paulo')::date between p_from and p_to), 0) as orders_system,
             coalesce((select sum(o.total) from sales.orders o where o.org_id = v_org and o.status::text = any (v_paid) and o.attribution #>> '{referral,source_id}' = a.ad_id
                        and (o.created_at at time zone 'America/Sao_Paulo')::date between p_from and p_to), 0) as revenue_system
      from mkt.ad_insights_daily a where a.org_id = v_org and a.day between p_from and p_to group by a.ad_id) x), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------------
-- Atribuição das vendas (núcleo)
-- ---------------------------------------------------------------------
create or replace function private.campaign_orders_q(c mkt.campaigns) returns table (order_id uuid, party_id uuid, total numeric, kind text, grp text, created_at timestamptz, discount numeric)
language plpgsql stable security definer set search_path = '' as $$
declare v_from timestamptz := c.starts_at; v_to timestamptz; v_off mkt.campaign_offers; v_paid text[] := private.paid_order_statuses();
begin
  if c.starts_at is null then return; end if;
  v_to := coalesce(c.ends_at, c.finished_at, now()) + make_interval(days => c.attribution_days);
  select * into v_off from mkt.campaign_offers where campaign_id = c.id;
  return query
    with ads as (
      select distinct a.ad_id from mkt.ad_insights_daily a join mkt.campaign_ad_links l on l.meta_campaign_id = a.campaign_id and l.campaign_id = c.id where a.org_id = c.org_id),
    o as (
      select so.id, so.party_id as pid, so.total as tot, so.created_at as at, so.coupon_id, so.attribution from sales.orders so
      where so.org_id = c.org_id and so.status::text = any (v_paid) and so.party_id is not null and so.created_at >= v_from and so.created_at < v_to),
    k as (
      select o.*,
        case
          when o.coupon_id in (select cp.id from sales.coupons cp where cp.campaign_id = c.id) then 'COUPON'
          when v_off.mode = 'AFFILIATE' and exists (select 1 from sales.coupons cc where cc.id = o.coupon_id and cc.affiliate_party_id is not null) then 'COUPON'
          when exists (select 1 from mkt.attribution_touches t join mkt.tracking_links l on l.id = t.tracking_link_id
                       where t.party_id = o.pid and l.campaign_id = c.id and t.touched_at >= v_from and t.touched_at <= o.at) then 'LINK'
          when o.attribution #>> '{referral,source_id}' in (select ad_id from ads)
               or exists (select 1 from mkt.attribution_touches t where t.party_id = o.pid and t.kind = 'AD' and t.touched_at >= v_from and t.touched_at <= o.at and t.ad_id in (select ad_id from ads)) then 'AD'
          when exists (select 1 from mkt.campaign_recipients r where r.campaign_id = c.id and r.party_id = o.pid and r.status in ('QUEUED', 'SENT') and r.sent_at <= o.at
                       and o.at < r.sent_at + make_interval(days => c.attribution_days)) then 'MESSAGE'
        end as kind
      from o)
    select k.id, k.pid, k.tot, k.kind, (select m.grp from mkt.campaign_members m where m.campaign_id = c.id and m.party_id = k.pid), k.at,
           coalesce((select sum(cr.amount) from sales.coupon_redemptions cr where cr.order_id = k.id
                     and (cr.coupon_id in (select cp.id from sales.coupons cp where cp.campaign_id = c.id) or (v_off.mode = 'AFFILIATE' and k.kind = 'COUPON'))), 0)
    from k where k.kind is not null;
end $$;

create or replace function mkt.set_campaign_costs(p_template_cost numeric) returns numeric
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('core.admin');
  if p_template_cost is null or p_template_cost < 0 or p_template_cost > 50 then raise exception 'Custo por mensagem: de R$ 0 a R$ 50' using errcode = 'P0190'; end if;
  insert into core.settings (org_id, key, value) values (private.org_id(), 'campaign_costs', jsonb_build_object('marketing_template', p_template_cost))
  on conflict (org_id, key) do update set value = excluded.value;
  return p_template_cost;
end $$;

-- ---------------------------------------------------------------------
-- Resultado completo
-- ---------------------------------------------------------------------
create or replace function mkt.campaign_results(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  c mkt.campaigns; v_status jsonb; v_skips jsonb; v_delivered int; v_read int; v_replied int; v_reached int; v_clicks int; v_ord jsonb; v_kinds jsonb; v_daily jsonb;
  v_orders int; v_buyers int; v_rev numeric; v_disc numeric; v_comm numeric := 0; v_spend numeric := 0; v_msgs int; v_unit numeric; v_cost numeric;
  v_tn int; v_hn int; v_tb int; v_hb int; v_issued int; v_used int; v_lift jsonb; v_to timestamptz; v_paid text[] := private.paid_order_statuses();
begin
  perform private.require_perm('crm.read');
  select * into c from mkt.campaigns where id = p_id and org_id = private.org_id();
  if c.id is null then raise exception 'Campanha não encontrada' using errcode = 'P0192'; end if;
  v_to := coalesce(c.ends_at, c.finished_at, now()) + make_interval(days => c.attribution_days);
  select coalesce(jsonb_object_agg(status, n), '{}') into v_status from (select status, count(*) n from mkt.campaign_recipients where campaign_id = c.id group by 1) x;
  select coalesce(jsonb_object_agg(skip_reason, n), '{}') into v_skips from (select skip_reason, count(*) n from mkt.campaign_recipients where campaign_id = c.id and status = 'SKIPPED' group by 1) x;
  select count(*) filter (where m.status in ('DELIVERED', 'READ')), count(*) filter (where m.status = 'READ'), count(distinct cr.party_id) into v_delivered, v_read, v_reached
  from mkt.campaign_recipients cr join omni.messages m on m.id = cr.message_id where cr.campaign_id = c.id;
  select count(distinct cr.party_id) into v_replied from mkt.campaign_recipients cr join omni.messages m on m.id = cr.message_id
  join omni.messages rep on rep.conversation_id = m.conversation_id and rep.direction = 'IN' and rep.created_at > cr.sent_at and rep.created_at < cr.sent_at + interval '72 hours' where cr.campaign_id = c.id;
  select count(*) into v_msgs from mkt.campaign_recipients where campaign_id = c.id and status in ('QUEUED', 'SENT');
  select count(*) into v_clicks from mkt.link_clicks k join mkt.tracking_links l on l.id = k.tracking_link_id where l.campaign_id = c.id;

  select coalesce(jsonb_agg(to_jsonb(x)), '[]') into v_ord from private.campaign_orders_q(c) x;
  select count(*), count(distinct party_id), coalesce(sum(total), 0), coalesce(sum(discount), 0) into v_orders, v_buyers, v_rev, v_disc
  from jsonb_to_recordset(v_ord) as o(order_id uuid, party_id uuid, total numeric, kind text, grp text, created_at timestamptz, discount numeric);
  select coalesce(jsonb_object_agg(kind, jsonb_build_object('orders', n, 'revenue', rev)), '{}') into v_kinds
  from (select kind, count(*) n, round(sum(total), 2) rev from jsonb_to_recordset(v_ord) as o(order_id uuid, party_id uuid, total numeric, kind text, grp text, created_at timestamptz, discount numeric) group by 1) x;
  select coalesce(jsonb_agg(jsonb_build_object('day', d, 'orders', n, 'revenue', rev) order by d), '[]') into v_daily
  from (select (created_at at time zone 'America/Sao_Paulo')::date d, count(*) n, round(sum(total), 2) rev
        from jsonb_to_recordset(v_ord) as o(order_id uuid, party_id uuid, total numeric, kind text, grp text, created_at timestamptz, discount numeric) group by 1) x;
  -- comissão de afiliada sobre as vendas atribuídas pelo cupom da afiliada
  select coalesce(sum(round(o.total * af.commission_pct / 100, 2)), 0) into v_comm
  from jsonb_to_recordset(v_ord) as k(order_id uuid, party_id uuid, total numeric, kind text, grp text, created_at timestamptz, discount numeric)
  join sales.orders o on o.id = k.order_id join aff.affiliates af on af.coupon_id = o.coupon_id where k.kind = 'COUPON';
  select coalesce(sum(a.spend), 0) into v_spend from mkt.ad_insights_daily a join mkt.campaign_ad_links l on l.meta_campaign_id = a.campaign_id and l.campaign_id = c.id
  where a.org_id = c.org_id and a.day >= (c.starts_at at time zone 'America/Sao_Paulo')::date and a.day <= (coalesce(c.ends_at, c.finished_at, now()) at time zone 'America/Sao_Paulo')::date;
  select coalesce((value ->> 'marketing_template')::numeric, 0) into v_unit from core.settings where org_id = c.org_id and key = 'campaign_costs';
  v_unit := coalesce(v_unit, 0);
  v_cost := v_disc + v_comm + v_spend + v_msgs * v_unit;

  -- lift: quem recebeu × grupo de controle (qualquer compra paga na janela, não só as atribuídas)
  select count(*) filter (where grp = 'TREATMENT'), count(*) filter (where grp = 'HOLDOUT') into v_tn, v_hn from mkt.campaign_members where campaign_id = c.id;
  select count(distinct m.party_id) filter (where m.grp = 'TREATMENT'), count(distinct m.party_id) filter (where m.grp = 'HOLDOUT') into v_tb, v_hb
  from mkt.campaign_members m join sales.orders so on so.party_id = m.party_id and so.org_id = c.org_id and so.status::text = any (v_paid)
    and so.created_at >= coalesce(c.starts_at, c.created_at) and so.created_at < v_to where m.campaign_id = c.id;
  v_lift := jsonb_build_object('treatment_n', v_tn, 'holdout_n', v_hn, 'treatment_buyers', v_tb, 'holdout_buyers', v_hb,
    'treatment_rate', case when v_tn > 0 then round(v_tb::numeric / v_tn * 100, 2) end, 'holdout_rate', case when v_hn > 0 then round(v_hb::numeric / v_hn * 100, 2) end,
    'lift_pp', case when v_tn > 0 and v_hn > 0 then round((v_tb::numeric / v_tn - v_hb::numeric / v_hn) * 100, 2) end);

  select count(*), count(distinct r.coupon_id) into v_issued, v_used from sales.coupons cp left join lateral
    (select cr.coupon_id from sales.coupon_redemptions cr join sales.orders o on o.id = cr.order_id where cr.coupon_id = cp.id and o.status <> 'CANCELLED' limit 1) r on true where cp.campaign_id = c.id;

  return jsonb_build_object(
    'recipients', v_status, 'skipped', v_skips, 'delivered', v_delivered, 'read', v_read, 'replied', v_replied, 'buyers', v_buyers, 'orders', v_orders, 'revenue', round(v_rev, 2),
    'reached', v_reached, 'clicks', v_clicks, 'members', v_tn + v_hn, 'by_kind', v_kinds, 'daily', v_daily, 'lift', v_lift,
    'coupons', jsonb_build_object('issued', v_issued, 'used', v_used),
    'cost', jsonb_build_object('discount', round(v_disc, 2), 'commission', round(v_comm, 2), 'ads', round(v_spend, 2), 'messages', round(v_msgs * v_unit, 2), 'total', round(v_cost, 2)),
    'roi', case when v_cost > 0 then round((v_rev - v_cost) / v_cost, 2) end, 'budget', c.budget);
end $$;

-- Campanhas que a pessoa recebeu ou usou (ficha da cliente)
create or replace function mkt.party_campaigns(p_party uuid) returns table (campaign_id uuid, name text, status text, grp text, received_at timestamptz, coupon_code text, coupon_used boolean, bought boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_perm('crm.read');
  return query
    select c.id, c.name, c.status, m.grp, (select min(r.sent_at) from mkt.campaign_recipients r where r.campaign_id = c.id and r.party_id = m.party_id and r.status in ('QUEUED', 'SENT')),
           (select cp.code from sales.coupons cp where cp.id = m.coupon_id),
           exists (select 1 from sales.coupon_redemptions cr join sales.orders o on o.id = cr.order_id where cr.coupon_id = m.coupon_id and o.status <> 'CANCELLED'),
           exists (select 1 from sales.orders o where o.party_id = m.party_id and o.status::text = any (private.paid_order_statuses()) and o.created_at >= m.joined_at)
    from mkt.campaign_members m join mkt.campaigns c on c.id = m.campaign_id where m.party_id = p_party and c.org_id = private.org_id() order by c.created_at desc;
end $$;

insert into private.internal_functions (fqname) values ('private.autolink_campaign_ads'), ('private.campaign_orders_q'), ('mkt.ad_insights_upsert') on conflict do nothing;
select private.lock_functions();
