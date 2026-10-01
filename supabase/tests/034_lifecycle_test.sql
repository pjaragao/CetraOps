begin;
create extension if not exists pgtap with schema extensions;
select plan(25);

create or replace function pg_temp.login(p_user uuid) returns void language plpgsql as $$
declare m record;
begin
  select id, org_id into m from core.members where user_id = p_user;
  perform set_config('request.jwt.claims', json_build_object(
    'sub', p_user, 'role', 'authenticated',
    'app_metadata', json_build_object('org_id', m.org_id, 'member_id', m.id))::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
grant execute on function pg_temp.login(uuid) to authenticated, anon;

create temp table ids (k text primary key, v uuid);
grant all on ids to authenticated;

-- pessoas de teste (criadas como superusuário, como faz o normalizador)
insert into ids select 'ana', crm.resolve_identity('00000000-0000-4000-8000-000000000001', 'WHATSAPP', '+55 48 98888-0001', 'Ana Ciclo', 'TEST');
insert into ids select 'bia', crm.resolve_identity('00000000-0000-4000-8000-000000000001', 'WHATSAPP', '+55 48 98888-0002', 'Bia Ciclo', 'TEST');
insert into ids select 'cris', crm.resolve_identity('00000000-0000-4000-8000-000000000001', 'WHATSAPP', '+55 48 98888-0003', 'Cris Ciclo', 'TEST');
insert into ids select 'lead', crm.resolve_identity('00000000-0000-4000-8000-000000000001', 'WHATSAPP', '+55 48 98888-0004', 'Lead Ciclo', 'TEST');

create or replace function pg_temp.paid(p_party uuid, p_n text, p_total numeric, p_at timestamptz) returns void language plpgsql as $$
begin
  insert into sales.orders (org_id, legal_entity_id, store_id, location_id, number, channel, status, party_id, subtotal, discount_total, total, cost_total, idempotency_key, created_at)
  values ('00000000-0000-4000-8000-000000000001', (select id from core.legal_entities limit 1), '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1',
          'CIC-' || p_n, 'POS', 'PAID', p_party, p_total, 0, p_total, p_total * 0.4, 'cic-' || p_n, p_at);
end $$;

-- Ana: 4 compras no ano, a última há 10 dias → VIP, Campeã
select pg_temp.paid((select v from ids where k = 'ana'), 'a1', 500, now() - interval '200 days');
select pg_temp.paid((select v from ids where k = 'ana'), 'a2', 500, now() - interval '120 days');
select pg_temp.paid((select v from ids where k = 'ana'), 'a3', 500, now() - interval '60 days');
select pg_temp.paid((select v from ids where k = 'ana'), 'a4', 500, now() - interval '10 days');
-- Bia: 1 compra há 130 dias → Inativa
select pg_temp.paid((select v from ids where k = 'bia'), 'b1', 300, now() - interval '130 days');
-- Cris: 2 compras com 30 dias de intervalo, a última há 50 dias → em risco (50 ≥ 1,5 × 30)
select pg_temp.paid((select v from ids where k = 'cris'), 'c1', 400, now() - interval '80 days');
select pg_temp.paid((select v from ids where k = 'cris'), 'c2', 400, now() - interval '50 days');

-- o gatilho da venda já recalcula cada pessoa
select is((select lifecycle_stage::text || '/' || tier::text from crm.parties where id = (select v from ids where k = 'ana')), 'VIP/VIP', 'Ana vira VIP (4 compras em 12 meses)');
select is((select rfm_segment from crm.customer_metrics where party_id = (select v from ids where k = 'ana')), 'CHAMPION', 'Ana é campeã');
select is((select orders_12m || '/' || revenue_12m from crm.customer_metrics where party_id = (select v from ids where k = 'ana')), '4/2000.00', 'métricas de 12 meses');
select is((select lifecycle_stage::text from crm.parties where id = (select v from ids where k = 'bia')), 'INACTIVE', 'Bia, 130 dias sem comprar, fica inativa');
select is((select rfm_segment from crm.customer_metrics where party_id = (select v from ids where k = 'bia')), 'HIBERNATING', 'Bia está hibernando');
select ok((select at_risk from crm.customer_metrics where party_id = (select v from ids where k = 'cris')), 'Cris entra em risco: 50 dias, o normal dela é a cada 30');
select is((select avg_interval_days from crm.customer_metrics where party_id = (select v from ids where k = 'cris')), 30.0, 'intervalo médio entre compras');
select ok(not (select at_risk from crm.customer_metrics where party_id = (select v from ids where k = 'ana')), 'Ana não está em risco');
select ok(exists (select 1 from crm.timeline_events where party_id = (select v from ids where k = 'ana') and kind = 'LIFECYCLE' and summary like '%VIP%'), 'a mudança vai para a linha do tempo');
select ok(exists (select 1 from crm.timeline_events where party_id = (select v from ids where k = 'cris') and kind = 'LIFECYCLE' and summary like 'Em risco%'), 'o risco vai para a linha do tempo');
select is((select count(*)::int from crm.customer_metrics where party_id = (select v from ids where k = 'lead')), 0, 'lead sem compra não tem métricas');

-- nova compra reativa a Bia
select pg_temp.paid((select v from ids where k = 'bia'), 'b2', 300, now());
select is((select lifecycle_stage::text from crm.parties where id = (select v from ids where k = 'bia')), 'CUSTOMER', 'compra nova reativa a cliente');

-- ---------- Ficha editável e score ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');   -- vendedora
select lives_ok($$ select crm.update_profile((select v from ids where k = 'lead'), '{"profession":"Arquiteta","city":"Florianópolis","activities":["Pilates","corrida"],"sizes":{"top":"m","bottom":"p"},"birth_date":"1990-04-12","joy_member_status":"SELF_DECLARED","email":"lead.ciclo@example.com"}') $$, 'vendedora edita a ficha');
select is((select sizes ->> 'top' from crm.parties where id = (select v from ids where k = 'lead')), 'M', 'tamanho normalizado');
select ok((select lead_score from crm.parties where id = (select v from ids where k = 'lead')) >= 75, 'score recalculado com profissão, esporte, cidade, contato e JOY');
select ok((select score_breakdown -> 'items' @> '[{"key":"sports"}]' from crm.parties where id = (select v from ids where k = 'lead')), 'explicação do score lista o esporte');
select is((select lifecycle_stage::text from crm.parties where id = (select v from ids where k = 'lead')), 'PROSPECT', 'lead com score alto vira prospect');
select is((select count(*)::int from crm.party_contact_points where party_id = (select v from ids where k = 'lead') and type = 'EMAIL'), 1, 'e-mail entra nos contatos');
select throws_ok($$ select crm.update_profile((select v from ids where k = 'lead'), '{"tier":"VIP_BLACK"}') $$, '42501', null, 'vendedora não muda o nível à mão');
select throws_ok($$ select crm.update_profile((select v from ids where k = 'lead'), '{"birth_date":"2030-01-01"}') $$, 'P0300', null, 'data de nascimento impossível é recusada');
select lives_ok($$ select crm.set_consent((select v from ids where k = 'lead'), 'MARKETING_WHATSAPP', true, 'BALCAO') $$, 'equipe registra aceite no balcão');
select is((select granted::text || '/' || (evidence ->> 'channel') from crm.v_current_consents where party_id = (select v from ids where k = 'lead') and purpose = 'MARKETING_WHATSAPP'), 'true/BALCAO', 'aceite com evidência');

select pg_temp.login('00000000-0000-4000-8000-0000000000f1');   -- sócio
select lives_ok($$ select crm.update_profile((select v from ids where k = 'cris'), '{"tier":"VIP_BLACK"}') $$, 'sócio define VIP Black');
select is((select tier::text || '/' || tier_manual from crm.parties where id = (select v from ids where k = 'cris')), 'VIP_BLACK/true', 'nível manual fica travado no recálculo');
select ok((crm.lifecycle_overview(current_date - 30, current_date) -> 'funnel' ->> 'repeat_orders')::int >= 1, 'painel do ciclo de vida responde');

select * from finish();
rollback;
