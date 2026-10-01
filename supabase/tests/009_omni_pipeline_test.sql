begin;
create extension if not exists pgtap with schema extensions;
select plan(52);

create temp table ids (k text primary key, v uuid);
create temp table q0 (name text primary key, n bigint);
insert into q0 select 'inbound_events', queue_length from pgmq.metrics('inbound_events');
insert into q0 select 'conversation_router', queue_length from pgmq.metrics('conversation_router');
insert into q0 select 'outbound_messages', queue_length from pgmq.metrics('outbound_messages');

insert into omni.channel_accounts (id, org_id, channel, provider_account_id, display_name, store_id, default_ai_mode) values
  ('00000000-0000-4000-8000-0000000009a1', '00000000-0000-4000-8000-000000000001', 'WHATSAPP', 'PNID-TEST', 'WhatsApp da loja (teste)', '00000000-0000-4000-8000-0000000000a1', 'AI_COPILOT'),
  ('00000000-0000-4000-8000-0000000009a2', '00000000-0000-4000-8000-000000000001', 'INSTAGRAM', 'IGID-TEST', 'Instagram (teste)', '00000000-0000-4000-8000-0000000000a1', 'AI_COPILOT');

-- ---------- Ingresso do webhook ----------
select is((omni.ingest_webhook('META_WA', 'wamid.AAA:message', '{"x":1}'))->>'duplicate', 'false', 'webhook novo é gravado');
select is((omni.ingest_webhook('META_WA', 'wamid.AAA:message', '{"x":1}'))->>'duplicate', 'true', 'mesmo evento de novo é ignorado');
select is((select queue_length from pgmq.metrics('inbound_events')) - (select n from q0 where name = 'inbound_events'), 1::bigint, 'enfileirado uma vez só');

-- ---------- Mensagem de cliente nova (WhatsApp) ----------
select lives_ok($$ insert into ids select 'conv', ((omni.ingest_event(jsonb_build_object('kind', 'MESSAGE', 'channel', 'WHATSAPP', 'provider_account_id', 'PNID-TEST',
  'external_id', '5548999998888', 'phone', '5548999998888', 'display_name', 'Fernanda (teste)', 'provider_message_id', 'wamid.M1', 'type', 'TEXT', 'body', 'Oi! Tem a legging preta no M?')))->>'conversation_id')::uuid $$,
  'primeira mensagem abre conversa');
select is((select mode::text from omni.conversations where id = (select v from ids where k = 'conv')), 'AI_COPILOT', 'conversa nasce no modo padrão do canal');
select is((select count(*)::int from crm.party_contact_points where value_normalized = '+5548999998888'), 1, 'telefone vira contato único (E.164)');
select is((select count(*)::int from crm.party_roles pr join crm.party_contact_points c on c.party_id = pr.party_id where c.value_normalized = '+5548999998888' and pr.role = 'CUSTOMER'), 1, 'pessoa criada com papel de cliente');
select is((omni.ingest_event(jsonb_build_object('kind', 'MESSAGE', 'channel', 'WHATSAPP', 'provider_account_id', 'PNID-TEST', 'external_id', '5548999998888',
  'provider_message_id', 'wamid.M1', 'body', 'Oi! Tem a legging preta no M?')))->>'duplicate', 'true', 'mensagem repetida não duplica');
select is((select count(*)::int from omni.messages where conversation_id = (select v from ids where k = 'conv')), 1, 'uma mensagem gravada');
select lives_ok($$ select omni.ingest_event(jsonb_build_object('kind', 'MESSAGE', 'channel', 'WHATSAPP', 'provider_account_id', 'PNID-TEST', 'external_id', '5548999998888',
  'provider_message_id', 'wamid.M2', 'body', 'E o preço?')) $$, 'segunda mensagem do mesmo cliente');
select is((select count(*)::int from omni.conversations where channel_identity_id = (select channel_identity_id from omni.conversations where id = (select v from ids where k = 'conv'))), 1, 'continua a mesma conversa');
select is((select unread_count from omni.conversations where id = (select v from ids where k = 'conv')), 2, 'não lidas = 2');
select is((select queue_length from pgmq.metrics('conversation_router')) - (select n from q0 where name = 'conversation_router'), 2::bigint, 'roteador enfileirado por mensagem (com debounce)');
select is((select service_window_expires_at > now() + interval '23 hours' from omni.conversations where id = (select v from ids where k = 'conv')), true, 'janela de 24 h aberta');

-- ---------- Roteador: só a última mensagem vale ----------
select is((omni.claim_router((select v from ids where k = 'conv'), (select id from omni.messages where provider_message_id = 'wamid.M1')))->>'reason', 'newer_message', 'mensagem antiga é descartada (debounce)');
select is((omni.claim_router((select v from ids where k = 'conv'), (select id from omni.messages where provider_message_id = 'wamid.M2')))->>'mode', 'AI_COPILOT', 'a última mensagem segue para decidir');
select is((omni.claim_router((select v from ids where k = 'conv'), (select id from omni.messages where provider_message_id = 'wamid.M2')))->>'window_allowed', 'true', 'com janela aberta');

-- ---------- Resposta da IA ----------
insert into ai.runs (id, org_id, route_task, conversation_id) values ('00000000-0000-4000-8000-0000000009b1', '00000000-0000-4000-8000-000000000001', 'conversation', (select v from ids where k = 'conv'));
insert into ai.runs (id, org_id, route_task, conversation_id) values ('00000000-0000-4000-8000-0000000009b2', '00000000-0000-4000-8000-000000000001', 'conversation', (select v from ids where k = 'conv'));
insert into ai.runs (id, org_id, route_task, conversation_id) values ('00000000-0000-4000-8000-0000000009b3', '00000000-0000-4000-8000-000000000001', 'conversation', (select v from ids where k = 'conv'));
select is((omni.apply_ai_result((select v from ids where k = 'conv'), (select version from omni.conversations where id = (select v from ids where k = 'conv')), '00000000-0000-4000-8000-0000000009b1',
  jsonb_build_object('action', 'DRAFT', 'messages', jsonb_build_array('Oi, Fernanda! Temos sim no M.', 'Quer que eu separe?'), 'intent', 'STOCK', 'confidence', 0.82)))->>'applied', 'true', 'rascunho da IA gravado');
select is((select count(*)::int from omni.message_drafts where conversation_id = (select v from ids where k = 'conv') and status = 'PENDING'), 1, 'um rascunho pendente');
select is((omni.apply_ai_result((select v from ids where k = 'conv'), (select version from omni.conversations where id = (select v from ids where k = 'conv')), '00000000-0000-4000-8000-0000000009b2',
  jsonb_build_object('action', 'DRAFT', 'messages', jsonb_build_array('Segunda versão'), 'confidence', 0.9)))->>'applied', 'true', 'novo rascunho');
select is((select count(*)::int from omni.message_drafts where conversation_id = (select v from ids where k = 'conv') and status = 'PENDING'), 1, 'o anterior foi substituído');
select is((omni.apply_ai_result((select v from ids where k = 'conv'), (select version from omni.conversations where id = (select v from ids where k = 'conv')), '00000000-0000-4000-8000-0000000009b3',
  jsonb_build_object('action', 'SEND', 'messages', jsonb_build_array('oi'))))->>'reason', 'not_autopilot', 'no copiloto a IA não envia sozinha');

update omni.conversations set mode = 'AI_AUTOPILOT' where id = (select v from ids where k = 'conv');
select is((select count(*)::int from omni.mode_events where conversation_id = (select v from ids where k = 'conv') and to_mode = 'AI_AUTOPILOT'), 1, 'troca de modo registrada');
select is((omni.apply_ai_result((select v from ids where k = 'conv'), (select version from omni.conversations where id = (select v from ids where k = 'conv')) - 1, '00000000-0000-4000-8000-0000000009b3',
  jsonb_build_object('action', 'SEND', 'messages', jsonb_build_array('oi'))))->>'reason', 'conversation_changed', 'execução de IA velha (versão mudou) é descartada');
select is((select status from ai.runs where id = '00000000-0000-4000-8000-0000000009b3'), 'DISCARDED', 'execução marcada como descartada');
insert into ai.runs (id, org_id, route_task, conversation_id) values ('00000000-0000-4000-8000-0000000009b4', '00000000-0000-4000-8000-000000000001', 'conversation', (select v from ids where k = 'conv'));
select is((omni.apply_ai_result((select v from ids where k = 'conv'), (select version from omni.conversations where id = (select v from ids where k = 'conv')), '00000000-0000-4000-8000-0000000009b4',
  jsonb_build_object('action', 'SEND', 'messages', jsonb_build_array('Temos sim no M!', 'Separo para você?'))))->>'applied', 'true', 'autopiloto envia (2 bolhas)');
select is((select count(*)::int from omni.messages where ai_run_id = '00000000-0000-4000-8000-0000000009b4' and status = 'QUEUED' and author_type = 'AI'), 2, 'duas mensagens na fila de envio');
select is((select queue_length from pgmq.metrics('outbound_messages')) - (select n from q0 where name = 'outbound_messages'), 2::bigint, 'enfileiradas para o sender');
select is((select array_agg(body order by created_at, seq) from omni.messages where ai_run_id = '00000000-0000-4000-8000-0000000009b4'), array['Temos sim no M!', 'Separo para você?'], 'balões da IA mantêm a ordem mesmo com o mesmo created_at (seq desempata)');
select is(jsonb_array_length((omni.apply_ai_result((select v from ids where k = 'conv'), (select version from omni.conversations where id = (select v from ids where k = 'conv')), '00000000-0000-4000-8000-0000000009b4',
  jsonb_build_object('action', 'SEND', 'messages', jsonb_build_array('Temos sim no M!', 'Separo para você?'))))->'message_ids'), 0, 'reexecução da mesma execução é idempotente (chave por bolha)');
select throws_ok($$ select omni.apply_ai_result((select v from ids where k = 'conv'), (select version from omni.conversations where id = (select v from ids where k = 'conv')), '00000000-0000-4000-8000-0000000009b4',
  jsonb_build_object('action', 'SEND', 'messages', jsonb_build_array('a', 'b', 'c', 'd'))) $$, 'P0102', null, 'no máximo 3 bolhas');

-- janela fechada
update omni.conversations set last_inbound_at = now() - interval '30 hours' where id = (select v from ids where k = 'conv');
select is((omni.apply_ai_result((select v from ids where k = 'conv'), (select version from omni.conversations where id = (select v from ids where k = 'conv')), '00000000-0000-4000-8000-0000000009b4',
  jsonb_build_object('action', 'SEND', 'messages', jsonb_build_array('x'))))->>'reason', 'window_closed', 'fora da janela de 24 h a IA não envia');
update omni.conversations set last_inbound_at = now() where id = (select v from ids where k = 'conv');

-- transferência para humano
insert into ai.runs (id, org_id, route_task, conversation_id) values ('00000000-0000-4000-8000-0000000009b5', '00000000-0000-4000-8000-000000000001', 'conversation', (select v from ids where k = 'conv'));
select is((omni.apply_ai_result((select v from ids where k = 'conv'), (select version from omni.conversations where id = (select v from ids where k = 'conv')), '00000000-0000-4000-8000-0000000009b5',
  jsonb_build_object('action', 'HANDOFF', 'reason', 'cliente pediu a Luisa', 'trigger', 'KEYWORD')))->>'action', 'HANDOFF', 'IA transfere para humano');
select is((select mode::text from omni.conversations where id = (select v from ids where k = 'conv')), 'WAITING_HUMAN', 'conversa aguardando humano');
select isnt((select sla_due_at from omni.conversations where id = (select v from ids where k = 'conv')), null, 'SLA ligado');
select is((select trigger || ':' || reason from omni.mode_events where conversation_id = (select v from ids where k = 'conv') order by id desc limit 1), 'KEYWORD:cliente pediu a Luisa', 'motivo registrado no histórico de modos');

-- ---------- Resposta pelo app do celular (eco) ----------
select lives_ok($$ select omni.ingest_event(jsonb_build_object('kind', 'ECHO', 'channel', 'WHATSAPP', 'provider_account_id', 'PNID-TEST', 'external_id', '5548999998888',
  'provider_message_id', 'wamid.ECHO1', 'body', 'Oi Fernanda, é a Luisa!')) $$, 'eco de resposta enviada pelo aplicativo');
select is((select mode::text from omni.conversations where id = (select v from ids where k = 'conv')), 'HUMAN', 'eco passa a conversa para humano');
select is((select trigger from omni.mode_events where conversation_id = (select v from ids where k = 'conv') order by id desc limit 1), 'HUMAN_REPLIED_FROM_APP', 'gatilho: respondeu pelo app');

-- ---------- Status do envio: só avança ----------
select is((omni.ingest_event(jsonb_build_object('kind', 'STATUS', 'channel', 'WHATSAPP', 'provider_account_id', 'PNID-TEST', 'provider_message_id', 'wamid.ECHO1', 'status', 'READ')))->>'updated', 'true', 'lida');
select is((omni.ingest_event(jsonb_build_object('kind', 'STATUS', 'channel', 'WHATSAPP', 'provider_account_id', 'PNID-TEST', 'provider_message_id', 'wamid.ECHO1', 'status', 'DELIVERED')))->>'updated', 'false', 'entregue depois de lida não volta');
select is((select status from omni.messages where provider_message_id = 'wamid.ECHO1'), 'READ', 'continua lida');

-- ---------- Instagram e canais desconhecidos ----------
select lives_ok($$ select omni.ingest_event(jsonb_build_object('kind', 'MESSAGE', 'channel', 'INSTAGRAM', 'provider_account_id', 'IGID-TEST', 'external_id', '17841400000001',
  'provider_message_id', 'mid.IG1', 'body', 'oi!')) $$, 'mensagem do Instagram');
select is((select instagram_handle from crm.parties p join crm.party_contact_points c on c.party_id = p.id where c.value_normalized = 'ig:17841400000001'), null, 'IGSID não vira @ falso');
select throws_ok($$ select omni.ingest_event(jsonb_build_object('kind', 'MESSAGE', 'channel', 'WHATSAPP', 'provider_account_id', 'NAO-EXISTE', 'external_id', '1', 'provider_message_id', 'x')) $$, 'P0100', null, 'canal não cadastrado é recusado');

-- ---------- Envio ----------
select is((omni.outbound_context((select id from omni.messages where ai_run_id = '00000000-0000-4000-8000-0000000009b4' and client_dedupe_key like '%:0')))->>'external_id', '5548999998888', 'contexto do envio traz o destinatário');
select lives_ok($$ select omni.mark_outbound((select id from omni.messages where ai_run_id = '00000000-0000-4000-8000-0000000009b4' and client_dedupe_key like '%:0'), 'SENT', 'wamid.OUT1') $$, 'marca enviado');
select is((select provider_message_id from omni.messages where ai_run_id = '00000000-0000-4000-8000-0000000009b4' and client_dedupe_key like '%:0'), 'wamid.OUT1', 'guarda o ID do provedor');

-- ---------- Opt-out, segredos e privilégios ----------
select lives_ok($$ select omni.record_opt_out((select party_id from omni.conversations where id = (select v from ids where k = 'conv')), (select id from omni.messages where provider_message_id = 'wamid.M2')) $$, 'registra o pedido de parar');
select is((select count(*)::int from crm.consents where party_id = (select party_id from omni.conversations where id = (select v from ids where k = 'conv')) and granted = false), 3, 'marketing revogado nos 3 canais');
select vault.create_secret('{"token":"abc123","app_secret":"s3"}', 'test-conn-secret');
insert into core.integration_connections (id, org_id, provider, capability, secret_ref) values ('00000000-0000-4000-8000-0000000009c1', '00000000-0000-4000-8000-000000000001', 'META', 'WHATSAPP_TEST', 'test-conn-secret');
select is((core.integration_secret('00000000-0000-4000-8000-0000000009c1'))->>'token', 'abc123', 'segredo lido do Vault');
select is(has_function_privilege('authenticated', 'omni.ingest_event(jsonb)', 'execute') or has_function_privilege('authenticated', 'core.integration_secret(uuid)', 'execute'), false, 'usuário não chama o pipeline nem lê segredos');

select * from finish();
rollback;
