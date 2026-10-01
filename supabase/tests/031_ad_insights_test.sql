begin;
create extension if not exists pgtap with schema extensions;
select plan(16);

create or replace function pg_temp.login(p_user uuid) returns void language plpgsql as $$
declare m record;
begin
  select id, org_id into m from core.members where user_id = p_user;
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated',
    'app_metadata', json_build_object('org_id', m.org_id, 'member_id', m.id))::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
grant execute on function pg_temp.login(uuid) to authenticated, anon;

-- ---------- Gravação pelo servidor ----------
select is(mkt.ad_insights_upsert('00000000-0000-4000-8000-000000000001', 'act_9',
  jsonb_build_array(
    jsonb_build_object('ad_id', 'AD-1', 'ad_name', 'Reels legging', 'campaign_name', 'Drop 01', 'day', private.today_sp(), 'spend', 100, 'impressions', 5000, 'reach', 4000, 'clicks', 200, 'conversations', 10, 'leads', 4),
    jsonb_build_object('ad_id', 'AD-2', 'ad_name', 'Story top', 'campaign_name', 'Drop 01', 'day', private.today_sp(), 'spend', 50, 'impressions', 2000, 'clicks', 30),
    jsonb_build_object('ad_id', '', 'day', private.today_sp()))), 2, 'grava os anúncios com id e ignora o resto');
select is(mkt.ad_insights_upsert('00000000-0000-4000-8000-000000000001', 'act_9', jsonb_build_array(jsonb_build_object('ad_id', 'AD-2', 'ad_name', 'Story top', 'campaign_name', 'Drop 01', 'day', private.today_sp(), 'spend', 55, 'clicks', 31))), 1, 'reler o mesmo dia atualiza');
select is((select spend from mkt.ad_insights_daily where ad_id = 'AD-2'), 55.00, 'o valor revisado pela Meta vale');
select is((select count(*)::int from mkt.ad_insights_daily where ad_id = 'AD-2'), 1, 'sem duplicar');
select mkt.ad_sync_set('00000000-0000-4000-8000-000000000001', 'act_9', private.today_sp(), 2, null);
select is((select last_rows from mkt.ad_sync_state where ad_account = 'act_9'), 2, 'estado da sincronização guardado');

-- ---------- O que o sistema confirma: quem chegou pelo anúncio e quanto comprou ----------
insert into crm.parties (id, org_id, kind, display_name) values ('00000000-0000-4000-8000-0000000009c1', '00000000-0000-4000-8000-000000000001', 'PERSON', 'Lead de anúncio (teste)');
insert into crm.timeline_events (org_id, party_id, kind, source_type, summary, payload)
values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000009c1', 'AD_REFERRAL', 'omni.channel_accounts', 'Chegou por anúncio', '{"source_id":"AD-1","source_type":"ad","ctwa_clid":"abc"}');
insert into sales.orders (org_id, legal_entity_id, store_id, location_id, number, channel, status, party_id, subtotal, total, idempotency_key, attribution)
values ('00000000-0000-4000-8000-000000000001', (select id from core.legal_entities limit 1), '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1', 'ADS-1', 'WHATSAPP', 'PAID',
        '00000000-0000-4000-8000-0000000009c1', 430, 430, 'ads-1', '{"referral":{"source_id":"AD-1","ctwa_clid":"abc"}}'),
       ('00000000-0000-4000-8000-000000000001', (select id from core.legal_entities limit 1), '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1', 'ADS-2', 'WHATSAPP', 'CANCELLED',
        '00000000-0000-4000-8000-0000000009c1', 300, 300, 'ads-2', '{"referral":{"source_id":"AD-1"}}');

select pg_temp.login('00000000-0000-4000-8000-0000000000f2');   -- vendedora: lê o marketing (crm.read), não pede atualização (crm.write)
select is(jsonb_array_length(mkt.ads_overview(private.today_sp() - 1, private.today_sp() + 1)), 2, 'quem pode ler vê os dois anúncios');
select is((mkt.ads_overview(private.today_sp() - 1, private.today_sp() + 1) -> 0 ->> 'ad_id'), 'AD-1', 'ordenados pelo gasto');
select is((select (x ->> 'leads_system')::int from jsonb_array_elements(mkt.ads_overview(private.today_sp() - 1, private.today_sp() + 1)) x where x ->> 'ad_id' = 'AD-1'), 1, 'lead confirmado pelo sistema (chegou por aquele anúncio)');
select is((select (x ->> 'revenue_system')::numeric from jsonb_array_elements(mkt.ads_overview(private.today_sp() - 1, private.today_sp() + 1)) x where x ->> 'ad_id' = 'AD-1'), 430.00, 'receita real: só pedido pago, o cancelado não conta');
select is((select (x ->> 'orders_system')::int from jsonb_array_elements(mkt.ads_overview(private.today_sp() - 1, private.today_sp() + 1)) x where x ->> 'ad_id' = 'AD-2'), 0, 'anúncio sem venda atribuída');
select is(jsonb_array_length(mkt.ads_overview(private.today_sp() + 10, private.today_sp() + 11)), 0, 'fora do período, nada');

-- ---------- Atualização sob demanda e agendamento ----------
select throws_ok($$ select mkt.request_ads_sync() $$, 'P0270', null, 'sem a Meta conectada, orienta a conectar');
reset role;
insert into core.integration_connections (org_id, provider, capability, secret_ref, status, config) values ('00000000-0000-4000-8000-000000000001', 'META_ADS', 'ADS', 'segredo-teste', 'ACTIVE', '{"ad_account_id":"9"}');
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');
select is(mkt.request_ads_sync(), 1, 'com a Meta conectada, pede a atualização');
reset role;
select is((select count(*)::int from pgmq.q_campaign_tasks where message ->> 'action' = 'AD_INSIGHTS_SYNC'), 1, 'o worker recebe a tarefa');
select is(private.enqueue_ad_sync(), 1, 'a rotina diária também enfileira uma tarefa por organização conectada');
select is((select count(*)::int from cron.job where jobname = 'sie-ad-insights'), 1, 'atualização agendada todo dia às 06:00 (Brasília)');

select * from finish();
rollback;
