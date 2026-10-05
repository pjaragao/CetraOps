begin;
create extension if not exists pgtap with schema extensions;
select plan(59);

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

-- ---------- Preparação (dono do banco) ----------
insert into omni.channel_accounts (id, org_id, channel, provider_account_id, display_name, store_id, default_ai_mode) values
  ('00000000-0000-4000-8000-0000000009e5', '00000000-0000-4000-8000-000000000001', 'WHATSAPP', 'PN-AUTO', 'WhatsApp automações', '00000000-0000-4000-8000-0000000000a1', 'AI_COPILOT'),
  ('00000000-0000-4000-8000-0000000009e6', '00000000-0000-4000-8000-000000000001', 'INSTAGRAM', 'IG-AUTO', 'Instagram automações', '00000000-0000-4000-8000-0000000000a1', 'AI_COPILOT');
create function pg_temp.wa(p_n int, p_body text, p_referral jsonb default null) returns jsonb language sql as $$
  select omni.ingest_event(jsonb_build_object('kind', 'MESSAGE', 'channel', 'WHATSAPP', 'provider_account_id', 'PN-AUTO', 'external_id', '554896666000' || p_n, 'phone', '554896666000' || p_n, 'display_name', 'Cliente Auto ' || p_n,
    'provider_message_id', 'wamid.AUTO.' || p_n || '.' || md5(p_body), 'type', 'TEXT', 'body', p_body) || case when p_referral is null then '{}'::jsonb else jsonb_build_object('referral', p_referral) end)
$$;
create function pg_temp.ig(p_n int, p_type text, p_body text, p_payload jsonb default '{}') returns jsonb language sql as $$
  select omni.ingest_event(jsonb_build_object('kind', 'MESSAGE', 'channel', 'INSTAGRAM', 'provider_account_id', 'IG-AUTO', 'external_id', 'igsid-auto-' || p_n, 'handle', 'auto' || p_n, 'display_name', 'Insta Auto ' || p_n,
    'provider_message_id', 'mid.AUTO.' || p_n || '.' || md5(p_body || p_type), 'type', p_type, 'body', p_body, 'payload', p_payload))
$$;
create temp table q0 as select (select queue_length from pgmq.metrics('outbound_messages')) as o;

-- ---------- Cadastro: validações ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');   -- vendedora (omni.write)
select throws_ok($$ select omni.save_automation('{"name":"x","trigger":"KEYWORD"}') $$, 'P0200', null, 'nome curto');
select throws_ok($$ select omni.save_automation('{"name":"Regra","trigger":"VOAR","actions":[{"type":"ADD_TAG","tag":"x1"}]}') $$, 'P0200', null, 'gatilho inválido');
select throws_ok($$ select omni.save_automation('{"name":"Regra","trigger":"KEYWORD","conditions":{"keywords":[]},"actions":[{"type":"ADD_TAG","tag":"aa"}]}') $$, 'P0200', null, 'palavra-chave obrigatória');
select throws_ok($$ select omni.save_automation('{"name":"Regra","trigger":"KEYWORD","conditions":{"keywords":["a"]},"actions":[{"type":"ADD_TAG","tag":"aa"}]}') $$, 'P0200', null, 'palavra-chave curta');
select throws_ok($$ select omni.save_automation('{"name":"Regra","trigger":"KEYWORD","conditions":{"keywords":["preço"]},"actions":[]}') $$, 'P0200', null, 'sem ações');
select throws_ok($$ select omni.save_automation('{"name":"Regra","trigger":"KEYWORD","conditions":{"keywords":["preço"]},"actions":[{"type":"PRIVATE_REPLY","text":"Olá, tudo bem?"}]}') $$, 'P0200', null, 'resposta privada só vale para comentário');
select throws_ok($$ select omni.save_automation('{"name":"Regra","trigger":"BIRTHDAY","actions":[{"type":"SEND_TEXT","text":"Parabéns!"}]}') $$, 'P0200', null, 'rotina diária não manda mensagem');
select throws_ok($$ select omni.save_automation('{"name":"Regra","trigger":"KEYWORD","conditions":{"keywords":["preço"]},"actions":[{"type":"SEND_TEXT","text":"Olá!!"},{"type":"SEND_TEXT","text":"Outra resposta"}]}') $$, 'P0200', null, 'no máximo uma resposta');
select throws_ok($$ select omni.save_automation('{"name":"Regra","trigger":"KEYWORD","conditions":{"keywords":["preço"]},"actions":[{"type":"ADD_TAG","tag":"Tag Ruim"}]}') $$, 'P0200', null, 'etiqueta inválida');
select throws_ok($$ select omni.save_automation('{"name":"Regra","trigger":"KEYWORD","conditions":{"keywords":["preço"]},"actions":[{"type":"CREATE_TASK","title":"x"}]}') $$, 'P0200', null, 'título da tarefa curto');
select throws_ok($$ select omni.save_automation('{"name":"Regra","trigger":"KEYWORD","conditions":{"keywords":["preço"]},"actions":[{"type":"SEND_TEXT","text":"x"}]}') $$, 'P0200', null, 'texto curto');
select throws_ok($$ select omni.save_automation('{"name":"Regra","trigger":"CTWA_REFERRAL","channel_account_id":"00000000-0000-4000-8000-0000000009e6","actions":[{"type":"ADD_TAG","tag":"aa"}]}') $$, 'P0200', null, 'anúncio do WhatsApp não existe no Instagram');
select throws_ok($$ select omni.save_automation('{"name":"Regra","trigger":"BIRTHDAY","conditions":{"days_before":31},"actions":[{"type":"ADD_TAG","tag":"aa"}]}') $$, 'P0200', null, 'aniversário: até 30 dias antes');
select throws_ok($$ select omni.save_automation('{"name":"Regra","trigger":"INACTIVITY","conditions":{"days":10},"actions":[{"type":"ADD_TAG","tag":"aa"}]}') $$, 'P0200', null, 'inatividade: mínimo de 15 dias');
select throws_ok($$ select omni.save_automation('{"name":"Regra","trigger":"KEYWORD","conditions":{"keywords":["preço"]},"cooldown_days":400,"actions":[{"type":"ADD_TAG","tag":"aa"}]}') $$, 'P0200', null, 'intervalo acima de 365 dias');

-- ---------- Palavra-chave: a regra nasce desligada ----------
insert into ids select 'kw', (omni.save_automation('{"name":"Horário e endereço","trigger":"KEYWORD","conditions":{"keywords":["horário","endereço"]},"actions":[{"type":"SEND_TEXT","text":"Oi {nome}! Funcionamos das 7h às 20h."},{"type":"ADD_TAG","tag":"perguntou-horario"}]}')).id::text;
select is((select active from omni.automations where id = (select v from ids where k = 'kw')::uuid), false, 'nasce desligada');
select is(omni.test_automation((select v from ids where k = 'kw')::uuid, 'Qual o HORARIO de vocês?'), true, 'teste: acento e caixa não importam');
select is(omni.test_automation((select v from ids where k = 'kw')::uuid, 'Quero um look novo'), false, 'teste: não combina');
select is(omni.test_automation((select v from ids where k = 'kw')::uuid, 'Vocês estão no endereco antigo?'), true, 'teste: outra palavra');
reset role;
insert into ids select 'm1', (pg_temp.wa(1, 'Qual o horário de vocês?') ->> 'message_id');
select is(omni.run_automations((select v from ids where k = 'm1')::uuid) ->> 'ran', '0', 'desligada não roda');
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');
select is((omni.set_automation_active((select v from ids where k = 'kw')::uuid, true)).active, true, 'liga');
reset role;
select is(omni.run_automations((select v from ids where k = 'm1')::uuid) ->> 'replied', 'true', 'ligada: responde');
select is((select body from omni.messages where conversation_id = (select conversation_id from omni.messages where id = (select v from ids where k = 'm1')::uuid) and direction = 'OUT'), 'Oi Cliente! Funcionamos das 7h às 20h.', 'resposta com o primeiro nome da pessoa');
select is((select author_type from omni.messages where conversation_id = (select conversation_id from omni.messages where id = (select v from ids where k = 'm1')::uuid) and direction = 'OUT'), 'SYSTEM', 'enviada como sistema');
select is((select queue_length from pgmq.metrics('outbound_messages')) - (select o from q0), 1::bigint, 'na fila de envio');
select ok((select 'perguntou-horario' = any (tags) from omni.conversations where id = (select conversation_id from omni.messages where id = (select v from ids where k = 'm1')::uuid)), 'etiqueta na conversa');
select ok((select 'perguntou-horario' = any (tags) from crm.parties where id = (select party_id from omni.conversations where id = (select conversation_id from omni.messages where id = (select v from ids where k = 'm1')::uuid))), 'e na pessoa');
select is((select payload ->> 'automation_handled' from omni.messages where id = (select v from ids where k = 'm1')::uuid), 'true', 'a mensagem fica marcada: a IA não responde de novo');
select is((select status from omni.automation_runs where message_id = (select v from ids where k = 'm1')::uuid), 'DONE', 'execução registrada');
-- mesma pessoa de novo dentro do intervalo
insert into ids select 'm2', (pg_temp.wa(1, 'E o endereço, qual é?') ->> 'message_id');
select is(omni.run_automations((select v from ids where k = 'm2')::uuid) ->> 'ran', '0', 'dentro do intervalo de 1 dia: não repete');
select is((select reason from omni.automation_runs where message_id = (select v from ids where k = 'm2')::uuid), 'COOLDOWN', 'motivo registrado');
insert into ids select 'm3', (pg_temp.wa(2, 'Bom dia! Que horas abre?') ->> 'message_id');
select is(omni.run_automations((select v from ids where k = 'm3')::uuid) ->> 'ran', '0', 'sem a palavra-chave: não dispara');
insert into ids select 'm4', (pg_temp.wa(3, 'ENDEREÇO da loja?') ->> 'message_id');
select is(omni.run_automations((select v from ids where k = 'm4')::uuid) ->> 'replied', 'true', 'outra pessoa, palavra em maiúsculas e com acento');

-- janela fechada: não manda e registra
update omni.conversations set service_window_expires_at = now() - interval '1 hour', last_inbound_at = now() - interval '30 hours' where id = (select conversation_id from omni.messages where id = (select v from ids where k = 'm4')::uuid);
update omni.automation_runs set created_at = now() - interval '3 days' where automation_id = (select v from ids where k = 'kw')::uuid;
insert into ids select 'm5', (pg_temp.wa(3, 'Qual horário hoje?') ->> 'message_id');
update omni.conversations set service_window_expires_at = now() - interval '1 hour', last_inbound_at = now() - interval '30 hours' where id = (select conversation_id from omni.messages where id = (select v from ids where k = 'm5')::uuid);
select is(omni.run_automations((select v from ids where k = 'm5')::uuid) ->> 'replied', 'false', 'com a janela fechada não responde');
select is((select detail -> 'actions' -> 0 ->> 'skipped' from omni.automation_runs where message_id = (select v from ids where k = 'm5')::uuid), 'WINDOW_CLOSED', 'e diz por quê');

-- ---------- Uma resposta só por mensagem ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');
insert into ids select 'kw2', (omni.save_automation('{"name":"Preço","trigger":"KEYWORD","priority":50,"conditions":{"keywords":["preço","valor"]},"actions":[{"type":"SEND_TEXT","text":"Os preços estão no catálogo."}]}')).id::text;
insert into ids select 'kw3', (omni.save_automation('{"name":"Preço 2","trigger":"KEYWORD","priority":60,"conditions":{"keywords":["preço"]},"actions":[{"type":"SEND_TEXT","text":"Segunda resposta"}]}')).id::text;
select omni.set_automation_active((select v from ids where k = 'kw2')::uuid, true);
select omni.set_automation_active((select v from ids where k = 'kw3')::uuid, true);
reset role;
insert into ids select 'm6', (pg_temp.wa(4, 'Qual o preço da legging?') ->> 'message_id');
select is(omni.run_automations((select v from ids where k = 'm6')::uuid) ->> 'ran', '1', 'duas regras combinam, só a de maior prioridade responde');
select is((select reason from omni.automation_runs where message_id = (select v from ids where k = 'm6')::uuid and status = 'SKIPPED'), 'ALREADY_REPLIED', 'a outra fica registrada como pulada');

-- ---------- Anúncio, story, comentário e transferência ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');
insert into ids select 'ad', (omni.save_automation('{"name":"Boas-vindas do anúncio","trigger":"CTWA_REFERRAL","actions":[{"type":"SEND_TEXT","text":"Oi {nome}! Que bom que você veio pelo anúncio."},{"type":"ADD_TAG","tag":"veio-do-anuncio"}]}')).id::text;
insert into ids select 'st', (omni.save_automation('{"name":"Menção no story","trigger":"STORY_MENTION","channel_account_id":"00000000-0000-4000-8000-0000000009e6","actions":[{"type":"CREATE_TASK","title":"Agradecer a menção de {nome}","due_in_hours":2,"suggested_message":"Obrigada por marcar a gente!"}]}')).id::text;
insert into ids select 'cm', (omni.save_automation('{"name":"Comentário quero","trigger":"COMMENT_KEYWORD","conditions":{"keywords":["quero","link"]},"actions":[{"type":"PRIVATE_REPLY","text":"Oi {nome}! Te mandei os detalhes por aqui."}]}')).id::text;
insert into ids select 'ho', (omni.save_automation('{"name":"Reclamação","trigger":"KEYWORD","priority":10,"conditions":{"keywords":["reclamação","defeito"]},"actions":[{"type":"HANDOFF"}]}')).id::text;
select omni.set_automation_active((select v from ids where k = k2.k)::uuid, true) from (values ('ad'), ('st'), ('cm'), ('ho')) k2(k);
reset role;
insert into ids select 'm7', (pg_temp.wa(5, 'Oi, vim pelo anúncio', '{"ctwa_clid":"CLID-1","source_id":"123"}') ->> 'message_id');
select is(omni.run_automations((select v from ids where k = 'm7')::uuid, '{"ctwa_clid":"CLID-1"}') ->> 'replied', 'true', 'chegou por anúncio: boas-vindas');
insert into ids select 'm8', (pg_temp.wa(6, 'Oi, vim pelo anúncio') ->> 'message_id');
select is(omni.run_automations((select v from ids where k = 'm8')::uuid) ->> 'ran', '0', 'sem dados do anúncio não dispara');
insert into ids select 'm9', (pg_temp.ig(1, 'STORY_MENTION', '[menção no story]') ->> 'message_id');
select is(omni.run_automations((select v from ids where k = 'm9')::uuid) ->> 'ran', '1', 'menção em story cria a tarefa');
select is((select title || '/' || source_rule from crm.tasks where source_rule = 'automation:' || (select v from ids where k = 'st')), 'Agradecer a menção de Insta/automation:' || (select v from ids where k = 'st'), 'tarefa com o nome e a origem');
insert into ids select 'm10', (pg_temp.ig(2, 'COMMENT', 'Quero esse look!', '{"comment_id":"17900001","media_id":"555"}') ->> 'message_id');
select is(omni.run_automations((select v from ids where k = 'm10')::uuid) ->> 'replied', 'true', 'comentário com a palavra: resposta privada');
select is((select payload ->> 'reply_to_comment_id' from omni.messages where conversation_id = (select conversation_id from omni.messages where id = (select v from ids where k = 'm10')::uuid) and direction = 'OUT'), '17900001', 'a resposta aponta para o comentário');
select is(omni.run_automations((select v from ids where k = 'm10')::uuid) ->> 'replied', 'false', 'o mesmo comentário não recebe duas respostas privadas');
insert into ids select 'm11', (pg_temp.ig(3, 'COMMENT', 'Quero ver mais', '{"comment_id":"17900002","media_id":"555"}') ->> 'message_id');
update omni.messages set created_at = now() - interval '8 days' where id = (select v from ids where k = 'm11')::uuid;
select is((omni.run_automations((select v from ids where k = 'm11')::uuid) ->> 'replied'), 'false', 'comentário com mais de 7 dias: fora do prazo da resposta privada');
insert into ids select 'm12', (pg_temp.wa(7, 'Tive um defeito na peça, quero fazer uma reclamação') ->> 'message_id');
select is(omni.run_automations((select v from ids where k = 'm12')::uuid) ->> 'ran', '1', 'reclamação chama uma pessoa');
select is((select mode::text from omni.conversations where id = (select conversation_id from omni.messages where id = (select v from ids where k = 'm12')::uuid)), 'WAITING_HUMAN', 'conversa passa para aguardando pessoa');
select is((select reason from omni.mode_events where conversation_id = (select conversation_id from omni.messages where id = (select v from ids where k = 'm12')::uuid) order by id desc limit 1), 'Automação: Reclamação', 'motivo na troca de modo');

-- ---------- Rotinas diárias ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');
insert into ids select 'bd', (omni.save_automation('{"name":"Aniversário","trigger":"BIRTHDAY","conditions":{"days_before":0},"actions":[{"type":"CREATE_TASK","title":"Parabenizar {nome}","suggested_message":"Parabéns, {nome}! 🎉"}]}')).id::text;
insert into ids select 'in', (omni.save_automation('{"name":"Cliente parada","trigger":"INACTIVITY","conditions":{"days":60},"actions":[{"type":"CREATE_TASK","title":"Reativar {nome}"}]}')).id::text;
select omni.set_automation_active((select v from ids where k = 'bd')::uuid, true);
select omni.set_automation_active((select v from ids where k = 'in')::uuid, true);
reset role;
insert into crm.parties (id, org_id, kind, display_name, lifecycle_stage, birth_date, last_purchase_at) values
  ('00000000-0000-4000-8000-0000000009d1', '00000000-0000-4000-8000-000000000001', 'PERSON', 'Aniversariante Hoje', 'CUSTOMER', ((now() at time zone 'America/Sao_Paulo')::date - interval '30 years')::date, null),
  ('00000000-0000-4000-8000-0000000009d2', '00000000-0000-4000-8000-000000000001', 'PERSON', 'Parada Há 70 Dias', 'CUSTOMER', null, now() - interval '70 days'),
  ('00000000-0000-4000-8000-0000000009d3', '00000000-0000-4000-8000-000000000001', 'PERSON', 'Parada Há 200 Dias', 'CUSTOMER', null, now() - interval '200 days'),
  ('00000000-0000-4000-8000-0000000009d4', '00000000-0000-4000-8000-000000000001', 'PERSON', 'Fornecedora Parada', 'CUSTOMER', null, now() - interval '70 days');
insert into crm.party_roles (org_id, party_id, role) values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000009d4', 'SUPPLIER');
select cmp_ok(private.run_scheduled_automations(), '>=', 2, 'a rotina diária cria tarefas');
select is((select count(*)::int from crm.tasks where title = 'Parabenizar Aniversariante' and type = 'BIRTHDAY'), 1, 'tarefa de aniversário (tipo próprio)');
select is((select suggested_message from crm.tasks where title = 'Parabenizar Aniversariante'), 'Parabéns, Aniversariante! 🎉', 'com mensagem pronta');
select is((select count(*)::int from crm.tasks where title = 'Reativar Parada' and type = 'REACTIVATION'), 1, 'cliente parada há 70 dias (só a que está na faixa de 60 a 90)');
select is((select count(*)::int from crm.tasks where title like 'Reativar Fornecedora%'), 0, 'fornecedora nunca entra');
select is(private.run_scheduled_automations(), 0, 'rodar de novo no mesmo dia não duplica (intervalo por pessoa)');
select is((select count(*)::int from cron.job where jobname = 'centralops-automations-daily'), 1, 'agendada todo dia às 08:00');

-- ---------- Desligar, excluir e privilégios ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');
select lives_ok($$ select omni.delete_automation((select v from ids where k = 'kw3')::uuid) $$, 'exclui a regra (o histórico dela vai junto)');
select throws_ok($$ select omni.delete_automation((select v from ids where k = 'kw3')::uuid) $$, 'P0202', null, 'já excluída');
select throws_ok($$ select omni.set_automation_active(gen_random_uuid(), true) $$, 'P0202', null, 'inexistente');
select ok(not has_function_privilege('authenticated', 'omni.run_automations(uuid,jsonb)', 'execute') and not has_function_privilege('authenticated', 'private.run_scheduled_automations()', 'execute')
  and has_function_privilege('authenticated', 'omni.save_automation(jsonb)', 'execute'), 'execução só pelo worker/rotina; cadastro pela tela');

select * from finish();
rollback;
