-- =====================================================================
-- Marketing › Anúncios Meta: resultados diários por anúncio (gasto, alcance, cliques, conversas e compras que a Meta conta) lidos da Marketing API,
-- cruzados com o que o SIÉ sabe de verdade: quem chegou por aquele anúncio (Click-to-WhatsApp) e quanto comprou. O ROAS "real" usa a venda do sistema.
-- Códigos de erro: P0270 situação não permite.
-- =====================================================================

create table mkt.ad_insights_daily (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  ad_account text not null,
  ad_id text not null,
  ad_name text,
  adset_name text,
  campaign_id text,
  campaign_name text,
  day date not null,
  spend numeric(14, 2) not null default 0,
  impressions integer not null default 0,
  reach integer not null default 0,
  clicks integer not null default 0,
  leads integer not null default 0,
  conversations integer not null default 0,                         -- conversas iniciadas (mensagens) segundo a Meta
  purchases integer not null default 0,
  purchase_value numeric(14, 2) not null default 0,
  updated_at timestamptz not null default now(),
  unique (org_id, ad_account, ad_id, day)
);
create index on mkt.ad_insights_daily (org_id, day);

create table mkt.ad_sync_state (
  org_id uuid not null references core.orgs(id),
  ad_account text not null,
  last_day date,
  last_run_at timestamptz,
  last_rows integer not null default 0,
  last_error text,
  primary key (org_id, ad_account)
);

select private.apply_rls('mkt', array['ad_insights_daily', 'ad_sync_state'], 'crm.read', 'crm.write');
select private.rpc_only('mkt', array['ad_insights_daily', 'ad_sync_state']);

-- Servidor (worker): grava o dia de cada anúncio (reler o mesmo dia atualiza, nunca duplica)
create or replace function mkt.ad_insights_upsert(p_org uuid, p_account text, p_rows jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare r jsonb; n int := 0;
begin
  for r in select * from jsonb_array_elements(coalesce(p_rows, '[]')) loop
    if nullif(r ->> 'ad_id', '') is null or nullif(r ->> 'day', '') is null then continue; end if;
    insert into mkt.ad_insights_daily (org_id, ad_account, ad_id, ad_name, adset_name, campaign_id, campaign_name, day, spend, impressions, reach, clicks, leads, conversations, purchases, purchase_value)
    values (p_org, p_account, r ->> 'ad_id', r ->> 'ad_name', r ->> 'adset_name', r ->> 'campaign_id', r ->> 'campaign_name', (r ->> 'day')::date,
            coalesce((r ->> 'spend')::numeric, 0), coalesce((r ->> 'impressions')::int, 0), coalesce((r ->> 'reach')::int, 0), coalesce((r ->> 'clicks')::int, 0),
            coalesce((r ->> 'leads')::int, 0), coalesce((r ->> 'conversations')::int, 0), coalesce((r ->> 'purchases')::int, 0), coalesce((r ->> 'purchase_value')::numeric, 0))
    on conflict (org_id, ad_account, ad_id, day) do update set
      ad_name = excluded.ad_name, adset_name = excluded.adset_name, campaign_id = excluded.campaign_id, campaign_name = excluded.campaign_name, spend = excluded.spend,
      impressions = excluded.impressions, reach = excluded.reach, clicks = excluded.clicks, leads = excluded.leads, conversations = excluded.conversations,
      purchases = excluded.purchases, purchase_value = excluded.purchase_value, updated_at = now();
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function mkt.ad_sync_set(p_org uuid, p_account text, p_last_day date, p_rows integer, p_error text default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into mkt.ad_sync_state (org_id, ad_account, last_day, last_run_at, last_rows, last_error) values (p_org, p_account, p_last_day, now(), coalesce(p_rows, 0), p_error)
  on conflict (org_id, ad_account) do update set last_day = coalesce(excluded.last_day, mkt.ad_sync_state.last_day), last_run_at = now(), last_rows = coalesce(p_rows, 0), last_error = p_error;
end $$;

-- Tela: "Atualizar agora"
create or replace function mkt.request_ads_sync() returns integer
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('crm.write');
  if not exists (select 1 from core.integration_connections where org_id = private.org_id() and provider = 'META_ADS' and status <> 'DISABLED' and secret_ref is not null) then
    raise exception 'Conecte a Meta (Anúncios) em Configurações › Integrações para trazer os resultados' using errcode = 'P0270';
  end if;
  perform private.enqueue('campaign_tasks', jsonb_build_object('action', 'AD_INSIGHTS_SYNC', 'org_id', private.org_id()));
  return 1;
end $$;

-- Todo dia às 06:00 (Brasília), uma tarefa por organização conectada
create or replace function private.enqueue_ad_sync() returns integer
language plpgsql security definer set search_path = '' as $$
declare r record; n int := 0;
begin
  for r in select distinct org_id from core.integration_connections where provider = 'META_ADS' and status <> 'DISABLED' and secret_ref is not null loop
    perform private.enqueue('campaign_tasks', jsonb_build_object('action', 'AD_INSIGHTS_SYNC', 'org_id', r.org_id));
    n := n + 1;
  end loop;
  return n;
end $$;
select cron.schedule('sie-ad-insights', '0 9 * * *', $$ select private.enqueue_ad_sync() $$);

-- ---------------------------------------------------------------------
-- Visão por anúncio: o que a Meta mediu + o que o sistema confirma (quem chegou por ele e quanto comprou)
-- ---------------------------------------------------------------------
create or replace function mkt.ads_overview(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); v_paid text[] := array['PAID', 'COMPLETED', 'FULFILLING', 'READY_FOR_PICKUP', 'SHIPPED', 'PARTIALLY_RETURNED'];
begin
  perform private.require_perm('crm.read');
  return coalesce((
    select jsonb_agg(row_to_json(x)::jsonb order by x.spend desc) from (
      select a.ad_id, max(a.ad_name) as ad_name, max(a.campaign_name) as campaign_name, max(a.adset_name) as adset_name,
             sum(a.spend) as spend, sum(a.impressions) as impressions, sum(a.reach) as reach, sum(a.clicks) as clicks, sum(a.leads) as leads, sum(a.conversations) as conversations,
             coalesce((select count(distinct t.party_id) from crm.timeline_events t where t.org_id = v_org and t.kind = 'AD_REFERRAL' and t.payload ->> 'source_id' = a.ad_id
                        and (t.occurred_at at time zone 'America/Sao_Paulo')::date between p_from and p_to), 0) as leads_system,
             coalesce((select count(*) from sales.orders o where o.org_id = v_org and o.status::text = any (v_paid) and o.attribution #>> '{referral,source_id}' = a.ad_id
                        and (o.created_at at time zone 'America/Sao_Paulo')::date between p_from and p_to), 0) as orders_system,
             coalesce((select sum(o.total) from sales.orders o where o.org_id = v_org and o.status::text = any (v_paid) and o.attribution #>> '{referral,source_id}' = a.ad_id
                        and (o.created_at at time zone 'America/Sao_Paulo')::date between p_from and p_to), 0) as revenue_system
      from mkt.ad_insights_daily a where a.org_id = v_org and a.day between p_from and p_to group by a.ad_id) x), '[]'::jsonb);
end $$;

insert into private.internal_functions (fqname) values ('mkt.ad_insights_upsert'), ('mkt.ad_sync_set'), ('private.enqueue_ad_sync') on conflict do nothing;
select private.lock_functions();
