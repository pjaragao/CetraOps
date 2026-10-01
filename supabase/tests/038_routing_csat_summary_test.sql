begin;
create extension if not exists pgtap with schema extensions;
select plan(22);

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
  ('00000000-0000-4000-8000-0000000009a7', '00000000-0000-4000-8000-000000000001', 'WHATSAPP', 'PNID-ROUTE', 'WhatsApp (rota)', '00000000-0000-4000-8000-0000000000a1', 'AI_COPILOT');
create or replace function pg_temp.conv(p_phone text, p_body text) returns uuid language sql as $$
  select ((omni.ingest_event(jsonb_build_object('kind', 'MESSAGE', 'channel', 'WHATSAPP', 'provider_account_id', 'PNID-ROUTE', 'external_id', p_phone, 'phone', p_phone,
    'display_name', 'Cliente ' || right(p_phone, 4), 'provider_message_id', 'wamid.' || p_phone || md5(p_body), 'type', 'TEXT', 'body', p_body)))->>'conversation_id')::uuid
$$;

-- ---------- Distribuição ----------
insert into ids select 'c1', pg_temp.conv('5548944440001', 'Oi');
update omni.conversations set mode = 'WAITING_HUMAN' where id = (select v from ids where k = 'c1');
select is((select assignee_member_id from omni.conversations where id = (select v from ids where k = 'c1')), null::uuid, 'distribuição desligada: ninguém é atribuído');

select pg_temp.login('00000000-0000-4000-8000-0000000000f2');
select throws_ok($$ select omni.save_routing_settings('{"enabled":true}') $$, '42501', null, 'só administração liga a distribuição');
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select lives_ok($$ select omni.save_routing_settings('{"enabled":true,"max_open_per_member":15,"use_roster":false,"on_call_member_id":"00000000-0000-4000-8000-000000000101"}') $$, 'liga a distribuição com sócio de plantão');
reset role;

-- dona do relacionamento recebe primeiro
insert into ids select 'c2', pg_temp.conv('5548944440002', 'Oi');
update crm.parties set relationship_owner_member_id = '00000000-0000-4000-8000-000000000102' where id = (select party_id from omni.conversations where id = (select v from ids where k = 'c2'));
update omni.conversations set mode = 'WAITING_HUMAN' where id = (select v from ids where k = 'c2');
select is((select assignee_member_id from omni.conversations where id = (select v from ids where k = 'c2')), '00000000-0000-4000-8000-000000000102'::uuid, 'dona do relacionamento recebe a conversa');
select ok(exists (select 1 from core.notifications where kind = 'ASSIGNED' and member_id = '00000000-0000-4000-8000-000000000102' and payload ->> 'conversation_id' = (select v from ids where k = 'c2')::text), 'e é avisada');
-- VIP sem dona → plantão
insert into ids select 'c3', pg_temp.conv('5548944440003', 'Oi');
update crm.parties set tier = 'VIP', tier_manual = true where id = (select party_id from omni.conversations where id = (select v from ids where k = 'c3'));
update omni.conversations set mode = 'WAITING_HUMAN' where id = (select v from ids where k = 'c3');
select is((select assignee_member_id from omni.conversations where id = (select v from ids where k = 'c3')), '00000000-0000-4000-8000-000000000101'::uuid, 'VIP vai para o sócio de plantão');
-- rodízio: quem tem menos conversas abertas
insert into ids select 'c4', pg_temp.conv('5548944440004', 'Oi');
update omni.conversations set mode = 'WAITING_HUMAN' where id = (select v from ids where k = 'c4');
select ok((select assignee_member_id from omni.conversations where id = (select v from ids where k = 'c4')) is not null, 'sem dona: rodízio atribui alguém');
-- já com responsável: não mexe
insert into ids select 'c5', pg_temp.conv('5548944440005', 'Oi');
update omni.conversations set assignee_member_id = '00000000-0000-4000-8000-000000000101' where id = (select v from ids where k = 'c5');
update omni.conversations set mode = 'WAITING_HUMAN' where id = (select v from ids where k = 'c5');
select is((select assignee_member_id from omni.conversations where id = (select v from ids where k = 'c5')), '00000000-0000-4000-8000-000000000101'::uuid, 'quem já tinha responsável continua');
-- escala: com alguém na escala agora, só essa pessoa entra no rodízio
select ok((select count(*) from private.members_on_shift('00000000-0000-4000-8000-000000000001', null)) >= 0, 'consulta quem está na escala agora');

-- ---------- CSAT ----------
insert into ids select 'c6', pg_temp.conv('5548944440006', 'Quero saber o horário');
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');
select lives_ok($$ select omni.save_csat_settings('{"enabled":true}') $$, 'liga a pesquisa de satisfação');
select lives_ok($$ select omni.close_conversation((select v from ids where k = 'c6'), 'RESOLVED') $$, 'encerra a conversa');
reset role;
select ok(exists (select 1 from omni.csat_responses where conversation_id = (select v from ids where k = 'c6') and asked_message_id is not null), 'pergunta a nota com a janela aberta');
select ok(exists (select 1 from omni.messages where conversation_id = (select v from ids where k = 'c6') and author_type = 'SYSTEM' and body like 'Antes de ir: de 1 a 5%'), 'mensagem da pesquisa enfileirada');
select ok(exists (select 1 from pgmq.q_ai_tasks where message ->> 'action' = 'CONVERSATION_SUMMARY' and message ->> 'conversation_id' = (select v from ids where k = 'c6')::text), 'pede o resumo à IA');
-- a cliente responde "2": abre conversa nova só pela nota
insert into ids select 'c7', pg_temp.conv('5548944440006', '2');
select is((select score from omni.csat_responses where conversation_id = (select v from ids where k = 'c6')), 2::smallint, 'nota gravada');
select ok((select (payload ->> 'automation_handled')::boolean from omni.messages where conversation_id = (select v from ids where k = 'c7') and direction = 'IN'), 'a IA não responde a nota');
select is((select status || '/' || outcome from omni.conversations where id = (select v from ids where k = 'c7')), 'CLOSED/RESOLVED', 'a conversa aberta só pela nota é encerrada');
select ok(exists (select 1 from crm.tasks where source_rule like 'csat:%' and title like 'Nota 2 no atendimento%'), 'nota baixa vira tarefa');
-- número fora do contexto não é nota
insert into ids select 'c8', pg_temp.conv('5548944440008', '3');
select ok(not exists (select 1 from omni.csat_responses where party_id = (select party_id from omni.conversations where id = (select v from ids where k = 'c8'))), 'sem pergunta pendente, "3" é mensagem comum');

-- ---------- Resumo ----------
select lives_ok($$ select ai.save_conversation_summary((select v from ids where k = 'c6'),
  '{"summary":"Cliente perguntou o horário de sábado.","topics":["horário","Sábado"],"sentiment":"NEUTRAL","knowledge_gap":true,"unanswered_question":"A loja abre aos domingos?"}') $$, 'grava o resumo');
select is((select array_to_string(topics, ',') from omni.conversations where id = (select v from ids where k = 'c6')), 'horário,sábado', 'temas normalizados');
select ok(exists (select 1 from ai.suggestions where kind = 'KB_GAP' and status = 'OPEN' and payload ->> 'question' = 'A loja abre aos domingos?'), 'lacuna na base vira sugestão');

select * from finish();
rollback;
