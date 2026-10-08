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

create or replace function pg_temp.paid(p_party uuid, p_n text, p_at timestamptz) returns uuid language plpgsql as $$
declare v uuid;
begin
  insert into sales.orders (org_id, legal_entity_id, store_id, location_id, number, channel, status, party_id, subtotal, discount_total, total, cost_total, idempotency_key, created_at)
  values ('00000000-0000-4000-8000-000000000001', (select id from core.legal_entities limit 1), '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1',
          'JRN-' || p_n, 'POS', 'PAID', p_party, 300, 0, 300, 120, 'jrn-' || p_n, p_at) returning id into v;
  return v;
end $$;

insert into omni.templates (id, org_id, channel_account_id, name, language, category, status, components) values
  ('00000000-0000-4000-8000-0000000009b8', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000601', 'novidades_regua', 'pt_BR', 'MARKETING', 'APPROVED',
   '[{"type":"BODY","text":"Oi, {{1}}! Novidades no seu tamanho."}]');
-- só esta régua ligada no teste
update mkt.journeys set active = false where org_id = '00000000-0000-4000-8000-000000000001';
select is((select count(*)::int from mkt.journeys where org_id = '00000000-0000-4000-8000-000000000001' and key in ('pos-compra', 'segunda-compra', 'aniversario', 'em-risco', 'inativa', 'inativa-longa', 'perdida-sem-retorno')), 7, 'réguas padrão do plano criadas');

-- ---------- Cadastro ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');
select throws_ok($$ select mkt.save_journey('{"name":"Teste","trigger":"QUALQUER"}') $$, 'P0350', null, 'gatilho inválido');
select lives_ok($$ insert into ids select 'j', (mkt.save_journey('{"name":"Teste em risco","trigger":"AT_RISK","holdout_pct":0}')).id $$, 'cria régua');
select throws_ok($$ select mkt.set_journey_active((select v from ids where k = 'j'), true) $$, 'P0351', null, 'sem passos não liga');
select throws_ok($$ select mkt.save_journey_step(jsonb_build_object('journey_id', (select v from ids where k = 'j'), 'position', 1, 'wait_days', 0, 'action', 'TASK', 'title', 'Oi')) $$, 'P0350', null, 'passo precisa de título e mensagem');
select lives_ok($$ select mkt.save_journey_step(jsonb_build_object('journey_id', (select v from ids where k = 'j'), 'position', 1, 'wait_days', 0, 'action', 'TASK',
  'title', 'Novidade para {nome}', 'message', 'Oi, {nome}! Chegou novidade no {tamanho}.')) $$, 'passo 1: tarefa');
select lives_ok($$ select mkt.save_journey_step(jsonb_build_object('journey_id', (select v from ids where k = 'j'), 'position', 2, 'wait_days', 3, 'action', 'MARKETING_TEMPLATE',
  'title', 'Template', 'template_id', '00000000-0000-4000-8000-0000000009b8')) $$, 'passo 2: template de marketing (3 dias depois)');
select lives_ok($$ select mkt.set_journey_active((select v from ids where k = 'j'), true) $$, 'liga a régua');
reset role;

-- ---------- Inscrição e passo ----------
insert into ids select 'ana', crm.resolve_identity('00000000-0000-4000-8000-000000000001', 'WHATSAPP', '+55 48 93333-0001', 'Ana Régua', 'TEST');
update crm.parties set sizes = '{"bottom":"M"}' where id = (select v from ids where k = 'ana');
select pg_temp.paid((select v from ids where k = 'ana'), 'a1', now() - interval '80 days');
select pg_temp.paid((select v from ids where k = 'ana'), 'a2', now() - interval '50 days');
select ok((select at_risk from crm.customer_metrics where party_id = (select v from ids where k = 'ana')), 'Ana está em risco');
select is((private.run_journeys() ->> 'enrolled')::int >= 1, true, 'motor inscreve quem entrou em risco');
select is((select grp || '/' || status from mkt.journey_enrollments where journey_id = (select v from ids where k = 'j') and party_id = (select v from ids where k = 'ana')), 'TREATMENT/ACTIVE', 'inscrita no tratamento (controle 0%)');
select is((select title || ' | ' || suggested_message from crm.tasks where source_rule like 'journey:%' and party_id = (select v from ids where k = 'ana')),
          'Novidade para Ana | Oi, Ana! Chegou novidade no M.', 'tarefa com nome e tamanho');
select is((select count(*)::int from mkt.journey_events ev join mkt.journey_enrollments en on en.id = ev.enrollment_id where en.party_id = (select v from ids where k = 'ana') and ev.result = 'TASK'), 1, 'evento do passo registrado');
select ok((select next_run_at > now() + interval '2 days' and next_step = 2 from mkt.journey_enrollments where journey_id = (select v from ids where k = 'j') and party_id = (select v from ids where k = 'ana')), 'próximo passo em 3 dias');
select private.run_journeys();
select is((select count(*)::int from mkt.journey_enrollments where journey_id = (select v from ids where k = 'j') and party_id = (select v from ids where k = 'ana')), 1, 'não inscreve duas vezes');
-- passo 2 sem aceite de marketing: pulado
update mkt.journey_enrollments set next_run_at = now() - interval '1 minute' where journey_id = (select v from ids where k = 'j') and party_id = (select v from ids where k = 'ana');
update core.settings set value = value || '{"quiet_start":"23:59:59.999999","quiet_end":"00:00","no_sunday":false}' where key = 'contact_policy';
insert into core.settings (org_id, key, value) values ('00000000-0000-4000-8000-000000000001', 'contact_policy', '{"quiet_start":"23:59:59.999999","quiet_end":"00:00","no_sunday":false}') on conflict do nothing;
select private.run_journeys();
select is((select reason from mkt.journey_events ev join mkt.journey_enrollments en on en.id = ev.enrollment_id where en.party_id = (select v from ids where k = 'ana') and ev.step_position = 2), 'NO_CONSENT', 'template de marketing sem aceite é pulado');
select is((select status from mkt.journey_enrollments where journey_id = (select v from ids where k = 'j') and party_id = (select v from ids where k = 'ana')), 'COMPLETED', 'régua termina no último passo');

-- ---------- Grupo de controle ----------
insert into ids select 'bia', crm.resolve_identity('00000000-0000-4000-8000-000000000001', 'WHATSAPP', '+55 48 93333-0002', 'Bia Régua', 'TEST');
insert into mkt.journey_enrollments (org_id, journey_id, party_id, source_key, grp, next_run_at)
values ('00000000-0000-4000-8000-000000000001', (select v from ids where k = 'j'), (select v from ids where k = 'bia'), 'manual', 'HOLDOUT', now() - interval '1 minute');
select private.run_journeys();
select is((select count(*)::int from crm.tasks where party_id = (select v from ids where k = 'bia') and source_rule like 'journey:%'), 0, 'controle não recebe nada');
select ok(exists (select 1 from mkt.journey_events ev join mkt.journey_enrollments en on en.id = ev.enrollment_id where en.party_id = (select v from ids where k = 'bia') and ev.result = 'HOLDOUT'), 'mas o passo fica registrado');
-- compra depois da inscrição: sai como convertida
select pg_temp.paid((select v from ids where k = 'bia'), 'b1', now() + interval '1 hour');
select private.run_journeys();
select is((select status || '/' || exit_reason from mkt.journey_enrollments where party_id = (select v from ids where k = 'bia') and journey_id = (select v from ids where k = 'j')), 'COMPLETED/PURCHASED', 'compra encerra a régua como convertida');

-- ---------- Regras de contato ----------
insert into ids select 'cai', crm.resolve_identity('00000000-0000-4000-8000-000000000001', 'WHATSAPP', '+55 48 93333-0003', 'Cai Régua', 'TEST');
insert into crm.consents (org_id, party_id, purpose, granted, legal_basis) values ('00000000-0000-4000-8000-000000000001', (select v from ids where k = 'cai'), 'MARKETING_WHATSAPP', false, 'CONSENT');
select is(private.contact_block((select v from ids where k = 'cai'), 'RELATIONSHIP'), 'OPTED_OUT', 'quem pediu para parar não recebe nada proativo');
select is(private.contact_block((select v from ids where k = 'ana'), 'RELATIONSHIP'), null, 'uma tarefa da régua em 14 dias ainda deixa contato pessoal');
delete from core.settings where key = 'contact_policy' and org_id = '00000000-0000-4000-8000-000000000001';
select is(private.next_send_time('00000000-0000-4000-8000-000000000001', '2030-03-04 22:00-03'), '2030-03-05 09:00-03'::timestamptz, 'horário de silêncio: às 22h espera até 9h');
select is(private.next_send_time('00000000-0000-4000-8000-000000000001', '2030-03-09 21:00-03'), '2030-03-11 09:00-03'::timestamptz, 'sábado à noite: espera até segunda (sem domingo)');

-- ---------- Resultado ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select is((mkt.journey_report((select v from ids where k = 'j')) #>> '{groups,HOLDOUT,converted}')::int, 1, 'relatório separa tratamento e controle');

select * from finish();
rollback;
