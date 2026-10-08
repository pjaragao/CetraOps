begin;
create extension if not exists pgtap with schema extensions;
select plan(19);

create or replace function pg_temp.login(p_user uuid) returns void language plpgsql as $$
declare m record;
begin
  select id, org_id into m from core.members where user_id = p_user;
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated',
    'app_metadata', json_build_object('org_id', m.org_id, 'member_id', m.id))::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
grant execute on function pg_temp.login(uuid) to authenticated, anon;
create temp table ids (k text primary key, v text);
grant all on ids to authenticated;

-- ---------- Preparação ----------
insert into omni.channel_accounts (id, org_id, channel, provider_account_id, display_name, store_id, default_ai_mode, public_address) values
  ('00000000-0000-4000-8000-0000000063f8', '00000000-0000-4000-8000-000000000001', 'WHATSAPP', 'PN-ATT-1', 'WhatsApp atribuição', '00000000-0000-4000-8000-0000000000a1', 'AI_COPILOT', '5548900000063');
insert into omni.templates (id, org_id, channel_account_id, name, language, category, components, status) values
  ('00000000-0000-4000-8000-0000000063f1', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000063f8', 'att_simples', 'pt_BR', 'MARKETING', '[{"type":"BODY","text":"Oi {{1}}! Oferta."}]', 'APPROVED');
insert into crm.parties (id, org_id, kind, display_name, lifecycle_stage, tags, lead_score)
select ('00000000-0000-4000-8000-00000063' || lpad(n::text, 4, '0'))::uuid, '00000000-0000-4000-8000-000000000001', 'PERSON', 'Pessoa ' || lpad(n::text, 2, '0') || ' Atrib (teste)', 'CUSTOMER', case when n <= 6 then '{att-test,att-grp}'::text[] else '{att-test}'::text[] end, 100 - n from generate_series(1, 10) n;
insert into crm.party_contact_points (org_id, party_id, type, value_normalized, value_display, is_primary)
select '00000000-0000-4000-8000-000000000001', id, 'WHATSAPP', '+55489' || lpad((80000000 + row_number() over (order by id))::text, 8, '0'), '+55489' || lpad((80000000 + row_number() over (order by id))::text, 8, '0'), true from crm.parties where tags @> '{att-test}';
insert into crm.consents (org_id, party_id, purpose, granted, legal_basis) select '00000000-0000-4000-8000-000000000001', id, 'MARKETING_WHATSAPP', true, 'CONSENT' from crm.parties where tags @> '{att-test}';
create or replace function pg_temp.order(p_n int, p_party int, p_total numeric, p_at interval, p_status text default 'PAID', p_coupon uuid default null) returns uuid language plpgsql as $$
declare v uuid;
begin
  insert into sales.orders (org_id, legal_entity_id, store_id, location_id, number, channel, status, party_id, subtotal, total, cost_total, idempotency_key, created_at, coupon_id)
  values ('00000000-0000-4000-8000-000000000001', (select id from core.legal_entities limit 1), '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1', 'ATT-' || p_n, 'POS', p_status::sales.order_status,
          ('00000000-0000-4000-8000-00000063' || lpad(p_party::text, 4, '0'))::uuid, p_total, p_total, p_total / 2, 'att-' || p_n, now() + p_at, p_coupon) returning id into v;
  return v;
end $$;

select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
insert into ids select 'c', (mkt.save_campaign('{"name":"Atribuição teste","objective":"LAUNCH","audience":{"tags":["att-grp"]}}')).id::text;
select mkt.save_campaign_offer(jsonb_build_object('campaign_id', (select v from ids where k = 'c'), 'mode', 'SHARED', 'kind', 'PERCENT', 'value', 10, 'code', 'ATT10'));
select mkt.save_dispatch(jsonb_build_object('campaign_id', (select v from ids where k = 'c'), 'channel_account_id', '00000000-0000-4000-8000-0000000063f8', 'template_id', '00000000-0000-4000-8000-0000000063f1', 'variables', '[{"source":"FIRST_NAME"}]'::jsonb, 'daily_limit', 1000));
select mkt.launch_campaign((select v from ids where k = 'c')::uuid);
select mkt.set_campaign_costs(0.5);
reset role;

-- cenário: pessoas 1 a 4 recebem (tratamento), 5 e 6 ficam no controle
update mkt.campaign_members set grp = 'HOLDOUT' where campaign_id = (select v from ids where k = 'c')::uuid and party_id in ('00000000-0000-4000-8000-000000630005', '00000000-0000-4000-8000-000000630006');
delete from mkt.campaign_recipients where campaign_id = (select v from ids where k = 'c')::uuid and party_id in ('00000000-0000-4000-8000-000000630005', '00000000-0000-4000-8000-000000630006');
update mkt.campaign_recipients set status = 'SENT', sent_at = now() where campaign_id = (select v from ids where k = 'c')::uuid;
insert into mkt.attribution_touches (org_id, party_id, kind, tracking_link_id, touched_at) select '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000630003', 'LINK', l.id, now() + interval '30 seconds'
  from mkt.tracking_links l where l.campaign_id = (select v from ids where k = 'c')::uuid and l.code like '%-story';
-- anúncio ligado pela tag [c:código]
select mkt.ad_insights_upsert('00000000-0000-4000-8000-000000000001', 'act_att', jsonb_build_array(jsonb_build_object('ad_id', 'ad-att-1', 'ad_name', 'Anúncio 1', 'campaign_id', '999001', 'campaign_name', 'Conversas [c:' || (select code from mkt.campaigns where id = (select v from ids where k = 'c')::uuid) || ']',
  'day', (now() at time zone 'America/Sao_Paulo')::date, 'spend', 30)));
insert into mkt.attribution_touches (org_id, party_id, kind, ad_id, touched_at) values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000630007', 'AD', 'ad-att-1', now() + interval '20 seconds');

-- vendas
select pg_temp.order(0, 1, 999, interval '-10 days');                                                               -- antes da campanha: não conta
select pg_temp.order(1, 1, 200, interval '1 minute', 'PAID', (select id from sales.coupons where code = 'ATT10'));     -- cupom
insert into sales.coupon_redemptions (org_id, coupon_id, order_id, party_id, amount) select '00000000-0000-4000-8000-000000000001', c.id, o.id, o.party_id, 20 from sales.coupons c, sales.orders o where c.code = 'ATT10' and o.number = 'ATT-1';
select pg_temp.order(2, 2, 100, interval '1 minute');                                                               -- recebeu a mensagem
select pg_temp.order(3, 3, 50, interval '2 minutes');                                                               -- tocou no link (e recebeu: o link vence)
select pg_temp.order(4, 5, 80, interval '1 minute');                                                                -- controle comprou sem a campanha
select pg_temp.order(5, 9, 70, interval '1 minute');                                                                -- fora do público
select pg_temp.order(6, 7, 60, interval '1 minute');                                                                -- veio do anúncio ligado
select pg_temp.order(7, 2, 500, interval '1 minute', 'CANCELLED');                                                  -- cancelada não conta
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');

select is((select count(*)::int from mkt.campaign_ad_links where campaign_id = (select v from ids where k = 'c')::uuid and source = 'TAG'), 1, 'a campanha da Meta com [c:código] no nome é ligada sozinha');
select is((mkt.campaign_results((select v from ids where k = 'c')::uuid) -> 'by_kind' -> 'COUPON' ->> 'revenue')::numeric, 200.00, 'venda com o cupom da campanha = COUPON');
select is((mkt.campaign_results((select v from ids where k = 'c')::uuid) -> 'by_kind' -> 'MESSAGE' ->> 'revenue')::numeric, 100.00, 'quem recebeu a mensagem e comprou = MESSAGE');
select is((mkt.campaign_results((select v from ids where k = 'c')::uuid) -> 'by_kind' -> 'LINK' ->> 'revenue')::numeric, 50.00, 'quem tocou no link da campanha = LINK (vence a mensagem)');
select is((mkt.campaign_results((select v from ids where k = 'c')::uuid) -> 'by_kind' -> 'AD' ->> 'revenue')::numeric, 60.00, 'quem veio do anúncio ligado = AD (mesmo fora do público)');
select is((mkt.campaign_results((select v from ids where k = 'c')::uuid) ->> 'revenue')::numeric, 410.00, 'receita atribuída soma só o que é da campanha');
select is((mkt.campaign_results((select v from ids where k = 'c')::uuid) ->> 'orders')::int, 4, 'cada venda conta para uma campanha só (cancelada, antiga e de fora ficam de fora)');
select is((mkt.campaign_results((select v from ids where k = 'c')::uuid) -> 'lift' ->> 'treatment_rate')::numeric, 75.00, 'compraram 3 de 4 que receberam');
select is((mkt.campaign_results((select v from ids where k = 'c')::uuid) -> 'lift' ->> 'holdout_rate')::numeric, 50.00, 'compraram 1 de 2 no controle');
select is((mkt.campaign_results((select v from ids where k = 'c')::uuid) -> 'lift' ->> 'lift_pp')::numeric, 25.00, 'efeito da mensagem: 25 pontos a mais');
select is((mkt.campaign_results((select v from ids where k = 'c')::uuid) -> 'cost')::text::jsonb, '{"ads": 30.00, "total": 52.00, "discount": 20.00, "messages": 2.00, "commission": 0.00}'::jsonb, 'custo = desconto + anúncio + mensagens');
select is((mkt.campaign_results((select v from ids where k = 'c')::uuid) ->> 'roi')::numeric, 6.88, 'retorno = (receita − custo) ÷ custo');
select is((mkt.campaign_results((select v from ids where k = 'c')::uuid) -> 'coupons')::text::jsonb, '{"used": 1, "issued": 1}'::jsonb, 'cupom emitido e usado');
select is((select count(*)::int from jsonb_array_elements(mkt.campaign_results((select v from ids where k = 'c')::uuid) -> 'daily')), 1, 'série diária');
select is((select system_campaign from jsonb_to_recordset(mkt.ads_overview(current_date - 1, current_date + 1)) as x(ad_id text, system_campaign text) where ad_id = 'ad-att-1'), 'Atribuição teste', 'a tela de anúncios mostra a campanha do sistema');
select is((select name || '/' || grp from mkt.party_campaigns('00000000-0000-4000-8000-000000630005')), 'Atribuição teste/HOLDOUT', 'a ficha da cliente mostra a campanha e o grupo');
select ok((select bought from mkt.party_campaigns('00000000-0000-4000-8000-000000630002')), 'e se ela comprou depois de entrar');
select is(mkt.link_campaign_ads((select v from ids where k = 'c')::uuid, array['999001', 'inexistente']), 0, 'vínculo manual só aceita campanha da Meta já sincronizada (e a de tag não duplica)');
select throws_ok($$ select mkt.set_campaign_costs(-1) $$, 'P0190', null, 'custo por mensagem inválido');

select * from finish();
rollback;
