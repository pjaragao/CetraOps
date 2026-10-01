begin;
create extension if not exists pgtap with schema extensions;
select plan(24);

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

insert into omni.channel_accounts (id, org_id, channel, provider_account_id, display_name, store_id, default_ai_mode) values
  ('00000000-0000-4000-8000-0000000009d1', '00000000-0000-4000-8000-000000000001', 'WHATSAPP', 'PNID-HOURS', 'WhatsApp (horário)', '00000000-0000-4000-8000-0000000000a1', 'AI_COPILOT');

-- ---------- Horário ----------
select ok(private.channel_is_open('00000000-0000-4000-8000-0000000009d1', now()), 'sem horário cadastrado = sempre aberto');
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');   -- vendedora
select throws_ok($$ select omni.set_business_hours('00000000-0000-4000-8000-0000000009d1', '{"days":{"1":[["09:00","18:00"]]}}') $$, '42501', null, 'só administração define o horário');
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');   -- sócio
select throws_ok($$ select omni.set_business_hours('00000000-0000-4000-8000-0000000009d1', '{"days":{"1":[["18:00","09:00"]]}}') $$, 'P0320', null, 'faixa que termina antes de começar é recusada');
select throws_ok($$ select omni.set_business_hours('00000000-0000-4000-8000-0000000009d1', '{"days":{"1":[["09:00","12:00"],["11:00","18:00"]]}}') $$, 'P0320', null, 'faixas sobrepostas são recusadas');
select throws_ok($$ select omni.set_business_hours('00000000-0000-4000-8000-0000000009d1', '{"days":{"8":[["09:00","12:00"]]}}') $$, 'P0320', null, 'dia da semana inválido');
-- segunda a sábado, 9h–12h e 14h–20h
select lives_ok($$ select omni.set_business_hours('00000000-0000-4000-8000-0000000009d1',
  '{"after_hours_ai":"SAFE_AUTOPILOT","days":{"1":[["09:00","12:00"],["14:00","20:00"]],"2":[["09:00","12:00"],["14:00","20:00"]],"3":[["09:00","12:00"],["14:00","20:00"]],"4":[["09:00","12:00"],["14:00","20:00"]],"5":[["09:00","12:00"],["14:00","20:00"]],"6":[["09:00","12:00"],["14:00","20:00"]]}}') $$, 'grava o horário');
reset role;

-- 2030-03-04 é segunda-feira
select ok(private.channel_is_open('00000000-0000-4000-8000-0000000009d1', '2030-03-04 10:00-03'), 'aberta na segunda às 10h');
select ok(not private.channel_is_open('00000000-0000-4000-8000-0000000009d1', '2030-03-04 13:00-03'), 'fechada no almoço');
select ok(not private.channel_is_open('00000000-0000-4000-8000-0000000009d1', '2030-03-03 10:00-03'), 'fechada no domingo');
select is(private.channel_next_open('00000000-0000-4000-8000-0000000009d1', '2030-03-04 22:00-03'), '2030-03-05 09:00-03'::timestamptz, 'à noite, abre amanhã às 9h');
select is(private.channel_next_open('00000000-0000-4000-8000-0000000009d1', '2030-03-09 21:00-03'), '2030-03-11 09:00-03'::timestamptz, 'sábado à noite: abre segunda às 9h');
select is(private.business_add('00000000-0000-4000-8000-0000000009d1', '2030-03-04 11:50-03', 15), '2030-03-04 14:05-03'::timestamptz, 'prazo de 15 min pula o almoço');
select is(private.business_add('00000000-0000-4000-8000-0000000009d1', '2030-03-04 23:00-03', 15), '2030-03-05 09:15-03'::timestamptz, 'prazo à noite começa a contar na abertura');

-- conversa de teste
insert into ids select 'conv', ((omni.ingest_event(jsonb_build_object('kind', 'MESSAGE', 'channel', 'WHATSAPP', 'provider_account_id', 'PNID-HOURS',
  'external_id', '5548966660001', 'phone', '5548966660001', 'display_name', 'Nina (teste)', 'provider_message_id', 'wamid.H1', 'type', 'TEXT', 'body', 'Oi! Vocês abrem amanhã?')))->>'conversation_id')::uuid;
select ok((omni.claim_router((select v from ids where k = 'conv'), (select id from omni.messages where provider_message_id = 'wamid.H1'))) ? 'is_open', 'o roteador sabe se a loja está aberta');
select is((omni.claim_router((select v from ids where k = 'conv'), (select id from omni.messages where provider_message_id = 'wamid.H1'))) ->> 'after_hours_ai', 'SAFE_AUTOPILOT', 'e o que a IA pode fazer fora do horário');

-- ---------- Fora do horário: o banco só deixa sair sozinha resposta informativa ----------
update omni.channel_accounts set business_hours = jsonb_build_object('after_hours_ai', 'SAFE_AUTOPILOT',
  'days', jsonb_build_object(((extract(dow from now() at time zone 'America/Sao_Paulo')::int + 3) % 7)::text, jsonb_build_array(jsonb_build_array('09:00', '10:00'))))
where id = '00000000-0000-4000-8000-0000000009d1';   -- só abre num dia que não é hoje: agora está fechada
insert into ai.runs (id, org_id, route_task, conversation_id, status) values
  ('00000000-0000-4000-8000-0000000009e1', '00000000-0000-4000-8000-000000000001', 'conversation', (select v from ids where k = 'conv'), 'RUNNING'),
  ('00000000-0000-4000-8000-0000000009e2', '00000000-0000-4000-8000-000000000001', 'conversation', (select v from ids where k = 'conv'), 'RUNNING');
select is((omni.apply_ai_result((select v from ids where k = 'conv'), (select version from omni.conversations where id = (select v from ids where k = 'conv')),
  '00000000-0000-4000-8000-0000000009e2', '{"action":"SEND","intent":"RESERVATION","messages":["Separei para você!"]}')) ->> 'reason', 'not_autopilot', 'fora do horário, reserva não sai sozinha');
select is((omni.apply_ai_result((select v from ids where k = 'conv'), (select version from omni.conversations where id = (select v from ids where k = 'conv')),
  '00000000-0000-4000-8000-0000000009e1', '{"action":"SEND","intent":"STORE_INFO","messages":["Abrimos amanhã às 9h!"]}')) ->> 'applied', 'true', 'fora do horário, informação sai sozinha');

-- ---------- Desfecho ----------
select is(omni.suggest_outcome((select v from ids where k = 'conv')), 'RESOLVED', 'sem venda nem reserva: dúvida resolvida');
insert into sales.orders (org_id, legal_entity_id, store_id, location_id, number, channel, status, party_id, subtotal, discount_total, total, cost_total, idempotency_key)
select '00000000-0000-4000-8000-000000000001', (select id from core.legal_entities limit 1), '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1',
       'OUT-1', 'WHATSAPP', 'PAID', party_id, 300, 0, 300, 120, 'out-1' from omni.conversations where id = (select v from ids where k = 'conv');
select is(omni.suggest_outcome((select v from ids where k = 'conv')), 'PURCHASED', 'com venda paga depois da conversa: comprou');

select pg_temp.login('00000000-0000-4000-8000-0000000000f2');   -- vendedora
select throws_ok($$ select omni.close_conversation((select v from ids where k = 'conv'), 'TALVEZ') $$, 'P0320', null, 'desfecho inválido é recusado');
select is((omni.close_conversation((select v from ids where k = 'conv'), 'PURCHASED', 'levou a legging M')).status, 'CLOSED', 'encerra com desfecho');
select throws_ok($$ select omni.close_conversation((select v from ids where k = 'conv'), 'RESOLVED') $$, 'P0321', null, 'não encerra duas vezes');
reset role;
select ok(exists (select 1 from crm.timeline_events where kind = 'CONVERSATION_CLOSED' and source_id = (select v from ids where k = 'conv') and summary like '%comprou%levou a legging M%'), 'desfecho na linha do tempo');
-- mensagem nova depois de encerrada abre outra conversa
select isnt(((omni.ingest_event(jsonb_build_object('kind', 'MESSAGE', 'channel', 'WHATSAPP', 'provider_account_id', 'PNID-HOURS', 'external_id', '5548966660001',
  'provider_message_id', 'wamid.H2', 'type', 'TEXT', 'body', 'Oi de novo')))->>'conversation_id')::uuid, (select v from ids where k = 'conv'), 'nova mensagem abre outra conversa');

select * from finish();
rollback;
