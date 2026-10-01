begin;
create extension if not exists pgtap with schema extensions;
select plan(28);

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

insert into ids select 'ana', crm.resolve_identity('00000000-0000-4000-8000-000000000001', 'WHATSAPP', '+55 48 90000-0001', 'Ana Caso', 'TEST');
insert into ids select 'bia', crm.resolve_identity('00000000-0000-4000-8000-000000000001', 'WHATSAPP', '+55 48 90000-0002', 'Bia Caso', 'TEST');
insert into omni.channel_accounts (id, org_id, channel, provider_account_id, display_name, store_id, default_ai_mode) values
  ('00000000-0000-4000-8000-0000000009c9', '00000000-0000-4000-8000-000000000001', 'WHATSAPP', 'PNID-CASES', 'WhatsApp (casos)', '00000000-0000-4000-8000-0000000000a1', 'AI_COPILOT');

-- ---------- Casos ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');   -- vendedora
select throws_ok($$ select crm.open_case('{"party_id":"00000000-0000-4000-8000-000000000999","kind":"COMPLAINT","title":"Legging furou"}') $$, 'P0402', null, 'cliente inexistente');
select throws_ok($$ select crm.open_case(jsonb_build_object('party_id', (select v from ids where k = 'ana'), 'kind', 'COMPLAINT', 'title', 'x')) $$, 'P0400', null, 'título curto demais');
select lives_ok($$ insert into ids select 'caso', (crm.open_case(jsonb_build_object('party_id', (select v from ids where k = 'ana'), 'kind', 'DEFECT', 'title', 'Legging com a costura aberta', 'description', 'Abriu no primeiro uso'))).id $$, 'abre um caso de defeito');
select ok((select number from crm.cases where id = (select v from ids where k = 'caso')) like 'CAS-%', 'número legível do caso');
select ok((select first_response_due < now() + interval '2 hours' and resolve_due > now() + interval '40 hours' from crm.cases where id = (select v from ids where k = 'caso')), 'prazos: 1ª resposta em 1 h e solução em 48 h');
select ok(exists (select 1 from crm.tasks where source_rule = 'case:' || (select v from ids where k = 'caso') and type = 'RECOVERY' and status = 'OPEN'), 'o caso cria a tarefa de resposta');
reset role;
select is(private.contact_block((select v from ids where k = 'ana'), 'RELATIONSHIP'), 'OPEN_COMPLAINT', 'caso aberto tira a cliente das réguas');
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');
select lives_ok($$ select crm.case_responded((select v from ids where k = 'caso')) $$, 'registra a 1ª resposta');
select is((select status from crm.cases where id = (select v from ids where k = 'caso')), 'IN_PROGRESS', 'caso em andamento');
select throws_ok($$ select crm.resolve_case((select v from ids where k = 'caso'), 'ok') $$, 'P0400', null, 'solução precisa ser descrita');
select throws_ok($$ select crm.resolve_case((select v from ids where k = 'caso'), 'Troca por peça nova', 500) $$, '42501', null, 'cortesia acima do limite só com sócio');
select lives_ok($$ select crm.resolve_case((select v from ids where k = 'caso'), 'Troca por peça nova e vale de cortesia', 80) $$, 'resolve com cortesia dentro do limite');
select is((select status || '/' || courtesy_amount from crm.cases where id = (select v from ids where k = 'caso')), 'RESOLVED/80.00', 'caso resolvido com a cortesia registrada');
select is((select amount::text || '/' || reason from sales.store_credit_ledger where id = (select courtesy_ledger_id from crm.cases where id = (select v from ids where k = 'caso'))), '80.00/GOODWILL', 'vale de cortesia emitido');
reset role;
select is((select sum(l.debit)::text from fin.journal_lines l join fin.journal_entries e on e.id = l.entry_id where e.source_type = 'crm.cases' and e.source_id = (select v from ids where k = 'caso')), '80.00', 'cortesia contabilizada (despesa × passivo de vale)');
select ok(exists (select 1 from crm.tasks where source_rule = 'case-followup:' || (select v from ids where k = 'caso') and status = 'OPEN' and due_at > now() + interval '6 days'), 'retorno agendado para 7 dias depois');
select is(private.contact_block((select v from ids where k = 'ana'), 'RELATIONSHIP'), null, 'resolvido: a cliente volta às réguas');
-- atraso
insert into crm.cases (org_id, number, party_id, kind, title, first_response_due, resolve_due) values
  ('00000000-0000-4000-8000-000000000001', 'CAS-TEST-1', (select v from ids where k = 'bia'), 'COMPLAINT', 'Atrasado', now() - interval '2 hours', now() + interval '40 hours');
select ok(private.sweep_cases() >= 1, 'a varredura avisa caso sem 1ª resposta no prazo');
select is((select count(*)::int from core.notifications where kind = 'CASE_LATE' and title like 'Caso CAS-TEST-1 atrasado%' and payload ->> 'party_id' = (select v from ids where k = 'bia')::text), 3, 'aviso chega a quem atende (uma vez por pessoa da equipe)');
select is(private.sweep_cases(), 0, 'e não repete o aviso');

-- ---------- NPS ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');
select throws_ok($$ select crm.record_nps((select v from ids where k = 'bia'), 11) $$, 'P0400', null, 'nota de 0 a 10');
select lives_ok($$ select crm.record_nps((select v from ids where k = 'bia'), 3, 'chegou atrasado') $$, 'registra nota 3 (detratora)');
select ok(exists (select 1 from crm.cases where party_id = (select v from ids where k = 'bia') and source = 'NPS' and title like 'NPS 3:%'), 'detratora abre caso');
select lives_ok($$ select crm.record_nps((select v from ids where k = 'ana'), 10, 'amei') $$, 'registra nota 10');
select ok(exists (select 1 from crm.tasks where party_id = (select v from ids where k = 'ana') and source_rule like 'nps-promoter:%'), 'promotora vira tarefa de convite para indicar');
select is((omni.nps_summary(now() - interval '1 day', now() + interval '1 day') ->> 'nps')::int, 0, 'NPS = promotoras − detratoras (1 − 1)');

-- resposta pelo WhatsApp
reset role;
insert into ids select 'conv', ((omni.ingest_event(jsonb_build_object('kind', 'MESSAGE', 'channel', 'WHATSAPP', 'provider_account_id', 'PNID-CASES',
  'external_id', '5548900000003', 'phone', '5548900000003', 'display_name', 'Cris Caso', 'provider_message_id', 'wamid.NP1', 'type', 'TEXT', 'body', 'Oi')))->>'conversation_id')::uuid;
insert into omni.nps_responses (org_id, party_id, channel_account_id) select '00000000-0000-4000-8000-000000000001', party_id, '00000000-0000-4000-8000-0000000009c9' from omni.conversations where id = (select v from ids where k = 'conv');
select omni.ingest_event(jsonb_build_object('kind', 'MESSAGE', 'channel', 'WHATSAPP', 'provider_account_id', 'PNID-CASES', 'external_id', '5548900000003', 'provider_message_id', 'wamid.NP2', 'type', 'TEXT', 'body', '9'));
select is((select score::int from omni.nps_responses where party_id = (select party_id from omni.conversations where id = (select v from ids where k = 'conv'))), 9, 'a resposta "9" pelo WhatsApp vira a nota');
select ok((select (payload ->> 'automation_handled')::boolean from omni.messages where provider_message_id = 'wamid.NP2'), 'a IA não responde à nota');

select * from finish();
rollback;
