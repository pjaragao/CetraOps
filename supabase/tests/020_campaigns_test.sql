begin;
create extension if not exists pgtap with schema extensions;
select plan(50);

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
  ('00000000-0000-4000-8000-0000000009f8', '00000000-0000-4000-8000-000000000001', 'WHATSAPP', 'PN-CMP-1', 'WhatsApp campanhas', '00000000-0000-4000-8000-0000000000a1', 'AI_COPILOT'),
  ('00000000-0000-4000-8000-0000000009f9', '00000000-0000-4000-8000-000000000001', 'WHATSAPP', 'PN-CMP-2', 'Outro número', '00000000-0000-4000-8000-0000000000a1', 'AI_COPILOT');
insert into omni.templates (id, org_id, channel_account_id, name, language, category, components, status) values
  ('00000000-0000-4000-8000-0000000009f1', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000009f8', 'novidades_outono', 'pt_BR', 'MARKETING', '[{"type":"BODY","text":"Oi {{1}}! A coleção de outono chegou. Quer ver?"}]', 'APPROVED'),
  ('00000000-0000-4000-8000-0000000009f2', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000009f8', 'rascunho_cmp', 'pt_BR', 'MARKETING', '[{"type":"BODY","text":"Olá"}]', 'PENDING'),
  ('00000000-0000-4000-8000-0000000009f3', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000009f9', 'outro_numero', 'pt_BR', 'MARKETING', '[{"type":"BODY","text":"Olá"}]', 'APPROVED');
insert into crm.parties (id, org_id, kind, display_name, lifecycle_stage, tags, lead_score) values
  ('00000000-0000-4000-8000-0000000009c1', '00000000-0000-4000-8000-000000000001', 'PERSON', 'Cami Um (teste)', 'CUSTOMER', '{cmp-test}', 90),
  ('00000000-0000-4000-8000-0000000009c2', '00000000-0000-4000-8000-000000000001', 'PERSON', 'Dani Dois (teste)', 'CUSTOMER', '{cmp-test}', 80),
  ('00000000-0000-4000-8000-0000000009c3', '00000000-0000-4000-8000-000000000001', 'PERSON', 'Eva Sem Aceite (teste)', 'CUSTOMER', '{cmp-test}', 70),
  ('00000000-0000-4000-8000-0000000009c4', '00000000-0000-4000-8000-000000000001', 'PERSON', 'Fafa Recusou (teste)', 'CUSTOMER', '{cmp-test}', 60),
  ('00000000-0000-4000-8000-0000000009c5', '00000000-0000-4000-8000-000000000001', 'PERSON', 'Gigi Sem Telefone (teste)', 'CUSTOMER', '{cmp-test}', 50),
  ('00000000-0000-4000-8000-0000000009c6', '00000000-0000-4000-8000-000000000001', 'PERSON', 'Hana Recebeu Ontem (teste)', 'CUSTOMER', '{cmp-test}', 40),
  ('00000000-0000-4000-8000-0000000009c7', '00000000-0000-4000-8000-000000000001', 'COMPANY', 'Fornecedor (teste)', 'CUSTOMER', '{cmp-test}', 95),
  ('00000000-0000-4000-8000-0000000009c8', '00000000-0000-4000-8000-000000000001', 'PERSON', 'Iris Lead (teste)', 'LEAD', '{cmp-test}', 30);
insert into crm.party_roles (org_id, party_id, role) values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000009c7', 'SUPPLIER');
insert into crm.party_contact_points (org_id, party_id, type, value_normalized, value_display, is_primary)
  select '00000000-0000-4000-8000-000000000001', ('00000000-0000-4000-8000-0000000009c' || n)::uuid, 'WHATSAPP', '554890000000' || n, '+55 48 9000-000' || n, true from unnest(array[1, 2, 3, 4, 6, 7, 8]) n;
insert into crm.consents (org_id, party_id, purpose, granted, legal_basis, created_at) values
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000009c1', 'MARKETING_WHATSAPP', true, 'CONSENT', now() - interval '10 days'),
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000009c2', 'MARKETING_WHATSAPP', true, 'CONSENT', now() - interval '10 days'),
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000009c4', 'MARKETING_WHATSAPP', true, 'CONSENT', now() - interval '10 days'),
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000009c4', 'MARKETING_WHATSAPP', false, 'CONSENT', now() - interval '1 day'),
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000009c5', 'MARKETING_WHATSAPP', true, 'CONSENT', now() - interval '10 days'),
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000009c6', 'MARKETING_WHATSAPP', true, 'CONSENT', now() - interval '10 days'),
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000009c7', 'MARKETING_WHATSAPP', true, 'CONSENT', now() - interval '10 days'),
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000009c8', 'MARKETING_WHATSAPP', true, 'CONSENT', now() - interval '10 days');
-- a Hana recebeu um template de marketing há 2 dias (vale o intervalo entre mensagens)
insert into omni.channel_identities (id, org_id, channel_account_id, external_id, party_id) values ('00000000-0000-4000-8000-0000000009a8', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000009f8', '5548900000006', '00000000-0000-4000-8000-0000000009c6');
insert into omni.conversations (id, org_id, party_id, channel_account_id, channel_identity_id, mode) values ('00000000-0000-4000-8000-0000000009a9', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000009c6', '00000000-0000-4000-8000-0000000009f8', '00000000-0000-4000-8000-0000000009a8', 'HUMAN');
insert into omni.messages (org_id, conversation_id, channel_account_id, direction, author_type, type, body, template_name, status, client_dedupe_key, payload, created_at)
values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000009a9', '00000000-0000-4000-8000-0000000009f8', 'OUT', 'HUMAN', 'TEMPLATE', 'Promo', 'novidades_outono', 'DELIVERED', 'cmp-old', '{"template_id":"00000000-0000-4000-8000-0000000009f1"}', now() - interval '2 days');
create temp table q0 as select (select queue_length from pgmq.metrics('campaign_tasks')) as t, (select queue_length from pgmq.metrics('outbound_messages')) as o;

-- ---------- Público ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');   -- vendedora (crm.write)
select is((select count(*)::int from crm.audience('{"tags":["cmp-test"],"lifecycle":["CUSTOMER"]}')), 6, 'público por tag e etapa; fornecedora (papel interno) nunca entra');
select is((select count(*)::int from crm.audience('{"tags":["cmp-test"]}') a where a.party_id = '00000000-0000-4000-8000-0000000009c7'), 0, 'papel interno fora mesmo sem filtro de etapa');
select is((select count(*)::int from crm.audience('{"tags":["cmp-test"],"min_score":75}')), 2, 'pontuação mínima');
select is((select count(*)::int from crm.audience('{"tags":["cmp-test"],"lifecycle":["LEAD"]}')), 1, 'etapa lead');
select throws_ok($$ select * from crm.audience('[1]') $$, 'P0190', null, 'definição inválida');

-- ---------- Campanha: validações ----------
select throws_ok($$ select mkt.save_campaign('{"name":"x"}') $$, 'P0190', null, 'nome curto');
select throws_ok($$ select mkt.save_campaign('{"name":"Outono","channel_account_id":"00000000-0000-4000-8000-0000000009f8","template_id":"00000000-0000-4000-8000-0000000009f3","variables":[{"source":"FIRST_NAME"}]}') $$, 'P0190', null, 'template de outro número');
select throws_ok($$ select mkt.save_campaign('{"name":"Outono","channel_account_id":"00000000-0000-4000-8000-0000000009f8","template_id":"00000000-0000-4000-8000-0000000009f2","variables":[]}') $$, 'P0190', null, 'template não aprovado');
select throws_ok($$ select mkt.save_campaign('{"name":"Outono","channel_account_id":"00000000-0000-4000-8000-0000000009f8","template_id":"00000000-0000-4000-8000-0000000009f1","variables":[]}') $$, 'P0190', null, 'faltam variáveis');
select throws_ok($$ select mkt.save_campaign('{"name":"Outono","channel_account_id":"00000000-0000-4000-8000-0000000009f8","template_id":"00000000-0000-4000-8000-0000000009f1","variables":[{"source":"CPF"}]}') $$, 'P0190', null, 'origem de variável inválida');
select throws_ok($$ select mkt.save_campaign('{"name":"Outono","channel_account_id":"00000000-0000-4000-8000-0000000009f8","template_id":"00000000-0000-4000-8000-0000000009f1","variables":[{"source":"TEXT","text":"a\nb"}]}') $$, 'P0190', null, 'texto fixo com quebra de linha');
select throws_ok($$ select mkt.save_campaign('{"name":"Outono","channel_account_id":"00000000-0000-4000-8000-0000000009f8","template_id":"00000000-0000-4000-8000-0000000009f1","variables":[{"source":"FIRST_NAME"}],"frequency_cap_days":120}') $$, 'P0190', null, 'intervalo acima de 90 dias');
select throws_ok($$ select mkt.save_campaign('{"name":"Outono","channel_account_id":"00000000-0000-4000-8000-0000000009f8","template_id":"00000000-0000-4000-8000-0000000009f1","variables":[{"source":"FIRST_NAME"}],"daily_limit":0}') $$, 'P0190', null, 'limite diário inválido');
insert into ids select 'camp', (mkt.save_campaign('{"name":"Coleção de outono","channel_account_id":"00000000-0000-4000-8000-0000000009f8","template_id":"00000000-0000-4000-8000-0000000009f1","variables":[{"source":"FIRST_NAME"}],
  "audience":{"tags":["cmp-test"],"lifecycle":["CUSTOMER"]},"frequency_cap_days":7,"daily_limit":1}')).id::text;
select is((select status || '/' || daily_limit from mkt.campaigns where id = (select v from ids where k = 'camp')::uuid), 'DRAFT/1', 'rascunho salvo');

-- ---------- Prévia ----------
select is((mkt.campaign_preview((select v from ids where k = 'camp')::uuid) ->> 'audience')::int, 6, 'público de 6');
select is((mkt.campaign_preview((select v from ids where k = 'camp')::uuid) ->> 'eligible')::int, 2, 'só 2 podem receber');
select is((mkt.campaign_preview((select v from ids where k = 'camp')::uuid) -> 'excluded')::text::jsonb, '{"NO_PHONE": 1, "NO_CONSENT": 2, "FREQUENCY_CAP": 1}'::jsonb, 'quem fica de fora e por quê (sem aceite, recusou, sem telefone, recebeu há pouco)');
select is((mkt.campaign_preview((select v from ids where k = 'camp')::uuid) ->> 'days_needed')::int, 2, 'com limite de 1 por dia levaria 2 dias');

-- ---------- Lançar ----------
select is((mkt.launch_campaign((select v from ids where k = 'camp')::uuid)).status, 'SENDING', 'lança e começa a enviar');
select is((select count(*)::int from mkt.campaign_recipients where campaign_id = (select v from ids where k = 'camp')::uuid and status = 'PENDING'), 2, 'dois pendentes');
select is((select string_agg(distinct skip_reason, ',' order by skip_reason) from mkt.campaign_recipients where campaign_id = (select v from ids where k = 'camp')::uuid and status = 'SKIPPED'), 'FREQUENCY_CAP,NO_CONSENT,NO_PHONE', 'os demais ficam registrados como pulados, com o motivo');
select throws_ok($$ select mkt.launch_campaign((select v from ids where k = 'camp')::uuid) $$, 'P0191', null, 'não lança duas vezes');
select throws_ok($$ select mkt.save_campaign(jsonb_build_object('id', (select v from ids where k = 'camp'), 'name', 'Outro nome', 'channel_account_id', '00000000-0000-4000-8000-0000000009f8', 'template_id', '00000000-0000-4000-8000-0000000009f1', 'variables', '[{"source":"FIRST_NAME"}]'::jsonb)) $$, 'P0192', null, 'depois de lançada não se edita');
reset role;
select is((select queue_length from pgmq.metrics('campaign_tasks')) - (select t from q0), 1::bigint, 'o envio vai para a fila do worker');

-- ---------- Envio (worker) ----------
select is((mkt.campaign_send_batch((select v from ids where k = 'camp')::uuid, 50) ->> 'sent')::int, 1, 'envia só 1: o limite diário do número é 1');
select is((mkt.campaign_send_batch((select v from ids where k = 'camp')::uuid, 50) ->> 'blocked_by_daily_limit')::boolean, true, 'na segunda rodada o limite diário segura');
select is((select count(*)::int from mkt.campaign_recipients where campaign_id = (select v from ids where k = 'camp')::uuid and status = 'QUEUED'), 1, 'um na fila de envio');
select is((select m.type || '/' || m.author_type || '/' || m.status || '/' || m.body from omni.messages m join mkt.campaign_recipients r on r.message_id = m.id where r.campaign_id = (select v from ids where k = 'camp')::uuid),
  'TEMPLATE/SYSTEM/QUEUED/Oi Cami! A coleção de outono chegou. Quer ver?', 'mensagem de template com o primeiro nome, como sistema');
select is((select m.payload ->> 'campaign_id' from omni.messages m join mkt.campaign_recipients r on r.message_id = m.id where r.campaign_id = (select v from ids where k = 'camp')::uuid), (select v from ids where k = 'camp'), 'a mensagem guarda a campanha (para atribuir vendas)');
select is((select queue_length from pgmq.metrics('outbound_messages')) - (select o from q0), 1::bigint, 'enfileirada para o sender');
select is((select count(*)::int from omni.channel_identities where channel_account_id = '00000000-0000-4000-8000-0000000009f8' and external_id = (select regexp_replace(value_normalized, '\D', '', 'g') from crm.party_contact_points where party_id = '00000000-0000-4000-8000-0000000009c1' and type = 'WHATSAPP')), 1, 'cria a conversa da pessoa no número');
-- a Dani retira o consentimento antes do envio dela
insert into crm.consents (org_id, party_id, purpose, granted, legal_basis) values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000009c2', 'MARKETING_WHATSAPP', false, 'CONSENT');
update mkt.campaign_recipients set sent_at = now() - interval '25 hours' where campaign_id = (select v from ids where k = 'camp')::uuid and status = 'QUEUED';
select is((mkt.campaign_send_batch((select v from ids where k = 'camp')::uuid, 50) ->> 'sent')::int, 0, 'recusa no meio do disparo: não envia');
select is((select skip_reason from mkt.campaign_recipients where campaign_id = (select v from ids where k = 'camp')::uuid and party_id = '00000000-0000-4000-8000-0000000009c2'), 'NO_CONSENT', 'e registra o motivo');
select is((select status from mkt.campaigns where id = (select v from ids where k = 'camp')::uuid), 'DONE', 'sem pendentes a campanha termina');
select is((mkt.campaign_send_batch((select v from ids where k = 'camp')::uuid, 50) ->> 'done')::boolean, true, 'rodar de novo depois de concluída não faz nada');

-- ---------- Acompanhamento ----------
update omni.messages set status = 'DELIVERED' where id = (select message_id from mkt.campaign_recipients where campaign_id = (select v from ids where k = 'camp')::uuid and message_id is not null);
select is((select status from mkt.campaign_recipients where campaign_id = (select v from ids where k = 'camp')::uuid and message_id is not null), 'SENT', 'entregue: destinatária fica como enviada');
update omni.messages set status = 'READ' where id = (select message_id from mkt.campaign_recipients where campaign_id = (select v from ids where k = 'camp')::uuid and message_id is not null);
insert into omni.messages (org_id, conversation_id, channel_account_id, direction, author_type, type, body, status, provider_message_id)
  select '00000000-0000-4000-8000-000000000001', m.conversation_id, m.channel_account_id, 'IN', 'CUSTOMER', 'TEXT', 'Quero ver sim!', 'RECEIVED', 'wamid.cmp.reply' from omni.messages m where m.payload ->> 'campaign_id' = (select v from ids where k = 'camp');
insert into sales.orders (org_id, legal_entity_id, store_id, location_id, number, channel, status, party_id, subtotal, total, cost_total, idempotency_key)
  values ('00000000-0000-4000-8000-000000000001', (select id from core.legal_entities limit 1), '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1', 'CMP-1', 'POS', 'PAID', '00000000-0000-4000-8000-0000000009c1', 450, 450, 150, 'cmp-1');
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');
select is((mkt.campaign_results((select v from ids where k = 'camp')::uuid) ->> 'read')::int, 1, 'lida');
select is((mkt.campaign_results((select v from ids where k = 'camp')::uuid) ->> 'replied')::int, 1, 'respondeu em 72 h');
select is((mkt.campaign_results((select v from ids where k = 'camp')::uuid) ->> 'revenue')::numeric, 450.00, 'vendas em 7 dias depois do envio');
select is((mkt.campaign_results((select v from ids where k = 'camp')::uuid) -> 'skipped')::text::jsonb ->> 'NO_CONSENT', '3', 'pulados por falta de consentimento (2 no lançamento + 1 retirado no meio)');

-- ---------- Cancelar e excluir ----------
insert into ids select 'camp2', (mkt.save_campaign('{"name":"Segunda campanha","channel_account_id":"00000000-0000-4000-8000-0000000009f8","template_id":"00000000-0000-4000-8000-0000000009f1","variables":[{"source":"TEXT","text":"cliente"}],"audience":{"tags":["cmp-test"]}}')).id::text;
select is((mkt.cancel_campaign((select v from ids where k = 'camp2')::uuid)).status, 'CANCELLED', 'cancela rascunho');
select throws_ok($$ select mkt.cancel_campaign((select v from ids where k = 'camp')::uuid) $$, 'P0191', null, 'concluída não cancela');
insert into ids select 'camp3', (mkt.save_campaign('{"name":"Terceira campanha","channel_account_id":"00000000-0000-4000-8000-0000000009f8","template_id":"00000000-0000-4000-8000-0000000009f1","variables":[{"source":"FULL_NAME"}]}')).id::text;
select lives_ok($$ select mkt.delete_campaign((select v from ids where k = 'camp3')::uuid) $$, 'exclui rascunho');
select throws_ok($$ select mkt.delete_campaign((select v from ids where k = 'camp')::uuid) $$, 'P0191', null, 'só rascunho se exclui');
select throws_ok($$ select mkt.launch_campaign((select v from ids where k = 'camp2')::uuid) $$, 'P0191', null, 'cancelada não lança');

-- ---------- Convidar público para evento e prospecção sem papéis internos ----------
insert into ids select 'ev', (mkt.save_event(jsonb_build_object('kind', 'DROP', 'name', 'Drop do público', 'starts_at', now() + interval '10 days'))).id::text;
select is(mkt.invite_audience((select v from ids where k = 'ev')::uuid, '{"tags":["cmp-test"],"lifecycle":["CUSTOMER"]}'), 6, 'convida o público (sem a fornecedora)');
select throws_ok($$ select mkt.invite_audience((select v from ids where k = 'ev')::uuid, '{"tags":["nenhuma-tag-assim"]}') $$, 'P0190', null, 'público vazio');
reset role;
update crm.parties set instagram_handle = null where org_id = '00000000-0000-4000-8000-000000000001';
update crm.parties set instagram_handle = 'fornecedor_teste', lifecycle_stage = 'LEAD' where id = '00000000-0000-4000-8000-0000000009c7';
update crm.parties set instagram_handle = 'iris_lead' where id = '00000000-0000-4000-8000-0000000009c8';
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');
select is(crm.generate_outreach(), 1, 'prospecção: a fornecedora com @ não entra na lista do dia (só a lead)');

-- ---------- Privilégios ----------
select ok(not has_function_privilege('authenticated', 'mkt.campaign_send_batch(uuid,integer)', 'execute') and not has_function_privilege('authenticated', 'private.campaign_skip_reason(uuid,integer)', 'execute')
  and not has_function_privilege('authenticated', 'private.ensure_wa_conversation(uuid,uuid,text)', 'execute') and not has_function_privilege('authenticated', 'mkt.sync_recipient_status()', 'execute'), 'funções do worker e internas não são chamáveis pela tela');
select ok(has_function_privilege('authenticated', 'mkt.launch_campaign(uuid)', 'execute') and has_function_privilege('authenticated', 'crm.audience(jsonb)', 'execute'), 'funções da tela chamáveis');

select * from finish();
rollback;
