begin;
create extension if not exists pgtap with schema extensions;
select plan(53);

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

-- ---------- Preparação (dono do banco): dois números de WhatsApp, um Instagram e uma cliente ----------
insert into core.integration_connections (org_id, provider, capability, config, status) values ('00000000-0000-4000-8000-000000000001', 'META_WA', 'TPL_TEST', '{"waba_id":"WABA-TPL"}', 'ACTIVE');
insert into omni.channel_accounts (id, org_id, channel, provider_account_id, display_name, store_id, default_ai_mode, connection_id) values
  ('00000000-0000-4000-8000-0000000009f1', '00000000-0000-4000-8000-000000000001', 'WHATSAPP', 'PN-TPL-1', 'WhatsApp templates 1', '00000000-0000-4000-8000-0000000000a1', 'AI_COPILOT',
   (select id from core.integration_connections where capability = 'TPL_TEST')),
  ('00000000-0000-4000-8000-0000000009f2', '00000000-0000-4000-8000-000000000001', 'WHATSAPP', 'PN-TPL-2', 'WhatsApp templates 2', '00000000-0000-4000-8000-0000000000a1', 'AI_COPILOT', null),
  ('00000000-0000-4000-8000-0000000009f3', '00000000-0000-4000-8000-000000000001', 'INSTAGRAM', 'IG-TPL-1', 'Instagram templates', '00000000-0000-4000-8000-0000000000a1', 'AI_COPILOT', null);
insert into ids select 'conv', (omni.ingest_event(jsonb_build_object('kind', 'MESSAGE', 'channel', 'WHATSAPP', 'provider_account_id', 'PN-TPL-1', 'external_id', '5548977770001', 'phone', '5548977770001',
  'display_name', 'Bia Templates (teste)', 'provider_message_id', 'wamid.TPL1', 'body', 'Oi')))->>'conversation_id';
insert into ids select 'party', party_id::text from omni.conversations where id = (select v from ids where k = 'conv')::uuid;
create temp table q0 as select (select queue_length from pgmq.metrics('template_tasks')) as t, (select queue_length from pgmq.metrics('outbound_messages')) as o;

select pg_temp.login('00000000-0000-4000-8000-0000000000f1');   -- sócio

-- ---------- Validações ----------
select throws_ok($$ select omni.save_template('{"channel_account_id":"00000000-0000-4000-8000-0000000009f3","name":"ola","category":"UTILITY","body":"Olá"}') $$, 'P0130', null, 'só WhatsApp tem template');
select throws_ok($$ select omni.save_template('{"channel_account_id":"00000000-0000-4000-8000-0000000009f1","name":"Olá Mundo","category":"UTILITY","body":"Olá"}') $$, 'P0130', null, 'nome inválido (maiúscula, acento e espaço)');
select throws_ok($$ select omni.save_template('{"channel_account_id":"00000000-0000-4000-8000-0000000009f1","name":"ola","category":"AUTHENTICATION","body":"Olá"}') $$, 'P0130', null, 'categoria inválida');
select throws_ok($$ select omni.save_template('{"channel_account_id":"00000000-0000-4000-8000-0000000009f1","name":"ola","category":"UTILITY","body":""}') $$, 'P0130', null, 'texto vazio');
select throws_ok($$ select omni.save_template(jsonb_build_object('channel_account_id', '00000000-0000-4000-8000-0000000009f1', 'name', 'ola', 'category', 'UTILITY', 'body', repeat('a', 1025))) $$, 'P0130', null, 'texto acima de 1024');
select throws_ok($$ select omni.save_template('{"channel_account_id":"00000000-0000-4000-8000-0000000009f1","name":"ola","category":"UTILITY","body":"Oi","buttons":["a","b","c","d"]}') $$, 'P0130', null, 'no máximo 3 botões');
select throws_ok($$ select omni.save_template('{"channel_account_id":"00000000-0000-4000-8000-0000000009f1","name":"ola","category":"UTILITY","body":"Oi {{2}}, tudo bem?","examples":["x"]}') $$, 'P0130', null, 'variáveis precisam começar em {{1}}');
select throws_ok($$ select omni.save_template('{"channel_account_id":"00000000-0000-4000-8000-0000000009f1","name":"ola","category":"UTILITY","body":"Oi {{1}}, tudo bem?","examples":[]}') $$, 'P0130', null, 'falta exemplo da variável');
select throws_ok($$ select omni.save_template('{"channel_account_id":"00000000-0000-4000-8000-0000000009f1","name":"ola","category":"UTILITY","body":"{{1}}, tudo bem?","examples":["Ana"]}') $$, 'P0130', null, 'não começa com variável');

-- ---------- Criar ----------
insert into ids select 'tpl', (omni.save_template('{"channel_account_id":"00000000-0000-4000-8000-0000000009f1","name":"pedido_pronto","category":"UTILITY","header":"Seu pedido","body":"Oi {{1}}! Seu pedido {{2}} está pronto para retirada.","footer":"Loja Demo","buttons":["Retirar hoje","Outro dia"],"examples":["Ana","VEN-2026-000123"]}')).id::text;
select is((select status from omni.templates where id = (select v from ids where k = 'tpl')::uuid), 'DRAFT', 'nasce como rascunho');
select is((select jsonb_array_length(components) from omni.templates where id = (select v from ids where k = 'tpl')::uuid), 4, 'cabeçalho, corpo, rodapé e botões montados');
select is((select components -> 1 -> 'example' -> 'body_text' from omni.templates where id = (select v from ids where k = 'tpl')::uuid), '[["Ana", "VEN-2026-000123"]]'::jsonb, 'exemplos no formato da Meta');
select throws_ok($$ select omni.save_template('{"channel_account_id":"00000000-0000-4000-8000-0000000009f1","name":"pedido_pronto","category":"UTILITY","body":"Outro texto"}') $$, 'P0130', null, 'mesmo nome e idioma no canal não duplica');
select lives_ok($$ select omni.save_template(jsonb_build_object('id', (select v from ids where k = 'tpl'), 'channel_account_id', '00000000-0000-4000-8000-0000000009f1', 'name', 'pedido_pronto', 'category', 'UTILITY',
  'body', 'Oi {{1}}! Seu pedido {{2}} já pode ser retirado.', 'examples', jsonb_build_array('Ana', 'VEN-2026-000123'))) $$, 'edita o rascunho');

-- ---------- Enviar para aprovação ----------
select throws_ok($$ select omni.send_template((select v from ids where k = 'conv')::uuid, (select v from ids where k = 'tpl')::uuid, '["Bia","VEN-1"]') $$, 'P0133', null, 'rascunho não pode ser enviado à cliente');
select lives_ok($$ select omni.submit_template((select v from ids where k = 'tpl')::uuid) $$, 'envia para aprovação');
select is((select status from omni.templates where id = (select v from ids where k = 'tpl')::uuid), 'PENDING', 'fica pendente até a Meta responder');
select throws_ok($$ select omni.submit_template((select v from ids where k = 'tpl')::uuid) $$, 'P0131', null, 'não envia duas vezes');
select throws_ok($$ select omni.save_template(jsonb_build_object('id', (select v from ids where k = 'tpl'), 'channel_account_id', '00000000-0000-4000-8000-0000000009f1', 'name', 'pedido_pronto', 'category', 'UTILITY', 'body', 'x')) $$, 'P0131', null, 'pendente não se edita');
select throws_ok($$ select omni.delete_template((select v from ids where k = 'tpl')::uuid) $$, 'P0131', null, 'pendente não se exclui');
reset role;
select is((select queue_length from pgmq.metrics('template_tasks')) - (select t from q0), 1::bigint, 'a submissão vai para a fila do worker');
select is((select message ->> 'action' from pgmq.q_template_tasks order by msg_id desc limit 1), 'SUBMIT', 'ação SUBMIT');

-- ---------- Situação vinda da Meta ----------
select is(omni.record_template_status(jsonb_build_object('template_id', (select v from ids where k = 'tpl'), 'status', 'APPROVED', 'external_id', 'META-123', 'quality', 'GREEN')), (select v from ids where k = 'tpl')::uuid, 'aprovado pelo id local');
select is((select status || '/' || external_id || '/' || quality from omni.templates where id = (select v from ids where k = 'tpl')::uuid), 'APPROVED/META-123/GREEN', 'status, id da Meta e qualidade');
select is(omni.record_template_status('{"external_id":"META-123","status":"PAUSED","reason":"baixa qualidade"}'), (select v from ids where k = 'tpl')::uuid, 'resolve pelo id da Meta');
select is((select status from omni.templates where id = (select v from ids where k = 'tpl')::uuid), 'PAUSED', 'pausado');
select ok((select count(*) from core.notifications where kind = 'TEMPLATE_STATUS' and payload ->> 'template_id' = (select v from ids where k = 'tpl')) >= 1, 'equipe é avisada quando a Meta pausa/rejeita');
select is(omni.record_template_status('{"waba_id":"WABA-TPL","name":"pedido_pronto","language":"pt_BR","status":"APPROVED"}'), (select v from ids where k = 'tpl')::uuid, 'resolve por WABA + nome + idioma (webhook)');
select is(omni.record_template_status('{"waba_id":"OUTRA-WABA","name":"pedido_pronto","language":"pt_BR","status":"APPROVED"}'), null, 'outra conta WABA não atualiza este template');
select is(omni.record_template_status('{"external_id":"META-123","status":"ALGO_NOVO"}'), null, 'situação desconhecida é ignorada');
select is(omni.record_template_status('{"external_id":"META-123","quality":"YELLOW"}'), (select v from ids where k = 'tpl')::uuid, 'atualização só de qualidade (webhook de qualidade)');
select is((select status || '/' || quality from omni.templates where id = (select v from ids where k = 'tpl')::uuid), 'APPROVED/YELLOW', 'a qualidade muda sem mexer na situação');
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');

-- ---------- Enviar à cliente ----------
select throws_ok($$ select omni.send_template((select v from ids where k = 'conv')::uuid, (select v from ids where k = 'tpl')::uuid, '["Bia"]') $$, 'P0130', null, 'faltou variável');
select throws_ok($$ select omni.send_template((select v from ids where k = 'conv')::uuid, (select v from ids where k = 'tpl')::uuid, '["Bia","VEN-1\nVEN-2"]') $$, 'P0130', null, 'quebra de linha na variável é recusada');
insert into ids select 'msg', (omni.send_template((select v from ids where k = 'conv')::uuid, (select v from ids where k = 'tpl')::uuid, '["Bia","VEN-2026-000123"]')).id::text;
select is((select body from omni.messages where id = (select v from ids where k = 'msg')::uuid), 'Oi Bia! Seu pedido VEN-2026-000123 já pode ser retirado.', 'texto renderizado aparece na conversa');
select is((select type || '/' || template_name || '/' || status from omni.messages where id = (select v from ids where k = 'msg')::uuid), 'TEMPLATE/pedido_pronto/QUEUED', 'mensagem do tipo template, na fila de envio');
select is((select payload -> 'components' -> 0 -> 'parameters' from omni.messages where id = (select v from ids where k = 'msg')::uuid), '[{"text": "Bia", "type": "text"}, {"text": "VEN-2026-000123", "type": "text"}]'::jsonb, 'parâmetros no formato da Cloud API');
reset role;
select is((select queue_length from pgmq.metrics('outbound_messages')) - (select o from q0), 1::bigint, 'enfileirado para o sender');
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select is((select mode::text from omni.conversations where id = (select v from ids where k = 'conv')::uuid), 'HUMAN', 'enviar um template assume a conversa (modo humano)');

-- template de outro número
insert into ids select 'tpl2', (omni.save_template('{"channel_account_id":"00000000-0000-4000-8000-0000000009f2","name":"so_no_numero_2","category":"UTILITY","body":"Olá"}')).id::text;
reset role;
update omni.templates set status = 'APPROVED' where id = (select v from ids where k = 'tpl2')::uuid;
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select throws_ok($$ select omni.send_template((select v from ids where k = 'conv')::uuid, (select v from ids where k = 'tpl2')::uuid, '[]') $$, 'P0133', null, 'template de outro número não serve');

-- marketing exige consentimento
insert into ids select 'mkt', (omni.save_template('{"channel_account_id":"00000000-0000-4000-8000-0000000009f1","name":"novidades_outono","category":"MARKETING","body":"Chegou a coleção nova!"}')).id::text;
reset role;
update omni.templates set status = 'APPROVED' where id = (select v from ids where k = 'mkt')::uuid;
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select throws_ok($$ select omni.send_template((select v from ids where k = 'conv')::uuid, (select v from ids where k = 'mkt')::uuid, '[]') $$, 'P0133', null, 'marketing sem consentimento é recusado');
reset role;
insert into crm.consents (org_id, party_id, purpose, granted, legal_basis) values ('00000000-0000-4000-8000-000000000001', (select v from ids where k = 'party')::uuid, 'MARKETING_WHATSAPP', true, 'CONSENT');
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select lives_ok($$ select omni.send_template((select v from ids where k = 'conv')::uuid, (select v from ids where k = 'mkt')::uuid, '[]') $$, 'com consentimento, marketing é enviado');

-- ---------- Sincronização ----------
select lives_ok($$ select omni.request_template_sync('00000000-0000-4000-8000-0000000009f1') $$, 'pede sincronização com a Meta');
select throws_ok($$ select omni.request_template_sync('00000000-0000-4000-8000-0000000009f3') $$, 'P0132', null, 'só canal de WhatsApp sincroniza');
reset role;
select is(omni.upsert_remote_template(jsonb_build_object('channel_account_id', '00000000-0000-4000-8000-0000000009f1', 'name', 'criado_na_meta', 'language', 'pt_BR', 'category', 'utility',
  'components', '[{"type":"BODY","text":"Olá"}]'::jsonb, 'status', 'APPROVED', 'external_id', 'META-999', 'quality', 'GREEN')) is not null, true, 'template criado direto na Meta entra por sincronização');
select is((select status from omni.templates where external_id = 'META-999'), 'APPROVED', 'com a situação da Meta');
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');

-- ---------- Excluir e respostas rápidas ----------
insert into ids select 'qr', (omni.save_quick_reply('/Obrigada', 'Eu que agradeço, linda! Qualquer coisa é só chamar.')).id::text;
select is((select shortcut from omni.quick_replies where id = (select v from ids where k = 'qr')::uuid), 'obrigada', 'atalho normalizado (sem a barra, minúsculo)');
select throws_ok($$ select omni.save_quick_reply('obrigada', 'outra') $$, 'P0130', null, 'atalho repetido');
select throws_ok($$ select omni.save_quick_reply('a', 'curto demais o atalho') $$, 'P0130', null, 'atalho curto demais');
select throws_ok($$ select omni.save_quick_reply('horario', '') $$, 'P0130', null, 'texto vazio');
select is((omni.save_quick_reply('obrigada', 'Nada, linda!', (select v from ids where k = 'qr')::uuid)).body, 'Nada, linda!', 'atualiza pelo id');
select lives_ok($$ select omni.delete_quick_reply((select v from ids where k = 'qr')::uuid) $$, 'exclui resposta rápida');

-- ---------- Privilégios ----------
select ok(not has_function_privilege('authenticated', 'omni.record_template_status(jsonb)', 'execute') and not has_function_privilege('authenticated', 'omni.upsert_remote_template(jsonb)', 'execute'), 'situação/sincronização só pelo servidor');

select * from finish();
rollback;
