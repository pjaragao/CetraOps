begin;
create extension if not exists pgtap with schema extensions;
select plan(72);

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
  ('00000000-0000-4000-8000-0000000009f4', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000009f8', 'cupom_pessoal', 'pt_BR', 'MARKETING', '[{"type":"BODY","text":"Oi {{1}}! Seu cupom {{2}} vale {{3}} até {{4}}."}]', 'APPROVED'),
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

update omni.channel_accounts set public_address = '5548900000099' where id = '00000000-0000-4000-8000-0000000009f8';
create or replace function pg_temp.did(p_camp text, p_seq int default 1) returns uuid language sql as $$
  select id from mkt.campaign_dispatches where campaign_id = (select v from ids where k = p_camp)::uuid and seq = p_seq $$;
grant execute on function pg_temp.did(text, int) to authenticated;

-- ---------- Público ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');   -- vendedora (crm.write)
select is((select count(*)::int from crm.audience('{"tags":["cmp-test"],"lifecycle":["CUSTOMER"]}')), 6, 'público por tag e etapa; fornecedora (papel interno) nunca entra');
select is((select count(*)::int from crm.audience('{"tags":["cmp-test"]}') a where a.party_id = '00000000-0000-4000-8000-0000000009c7'), 0, 'papel interno fora mesmo sem filtro de etapa');
select is((select count(*)::int from crm.audience('{"tags":["cmp-test"],"min_score":75}')), 2, 'pontuação mínima');
select is((select count(*)::int from crm.audience('{"tags":["cmp-test"],"lifecycle":["LEAD"]}')), 1, 'etapa lead');
select throws_ok($$ select * from crm.audience('[1]') $$, 'P0190', null, 'definição inválida');

-- ---------- Campanha: validações ----------
select throws_ok($$ select mkt.save_campaign('{"name":"x"}') $$, 'P0190', null, 'nome curto');
select throws_ok($$ select mkt.save_campaign('{"name":"Outono","objective":"QUALQUER"}') $$, 'P0190', null, 'objetivo inválido');
select throws_ok($$ select mkt.save_campaign('{"name":"Outono","audience_scope":"TODOS"}') $$, 'P0190', null, 'tipo de público inválido');
select throws_ok($$ select mkt.save_campaign('{"name":"Outono","holdout_pct":80}') $$, 'P0190', null, 'grupo de controle acima de 50%');
select throws_ok($$ select mkt.save_campaign('{"name":"Outono","starts_at":"2030-01-10T00:00:00Z","ends_at":"2030-01-05T00:00:00Z"}') $$, 'P0190', null, 'fim antes do início');
select throws_ok($$ select mkt.save_campaign('{"name":"Outono","audience":{"filtro_inexistente":1}}') $$, 'P0190', null, 'filtro de público desconhecido');
insert into ids select 'camp', (mkt.save_campaign('{"name":"Coleção de outono","objective":"LAUNCH","audience":{"tags":["cmp-test"],"lifecycle":["CUSTOMER"]}}')).id::text;
select is((select status || '/' || objective from mkt.campaigns where id = (select v from ids where k = 'camp')::uuid), 'DRAFT/LAUNCH', 'rascunho salvo');
select ok((select code ~ '^[a-z0-9]{3,10}$' from mkt.campaigns where id = (select v from ids where k = 'camp')::uuid), 'a campanha ganha um código curto');

-- ---------- Disparo: validações ----------
select throws_ok($$ select mkt.save_dispatch(jsonb_build_object('campaign_id', (select v from ids where k = 'camp'), 'channel_account_id', '00000000-0000-4000-8000-0000000009f8', 'template_id', '00000000-0000-4000-8000-0000000009f3', 'variables', '[{"source":"FIRST_NAME"}]'::jsonb)) $$, 'P0190', null, 'template de outro número');
select throws_ok($$ select mkt.save_dispatch(jsonb_build_object('campaign_id', (select v from ids where k = 'camp'), 'channel_account_id', '00000000-0000-4000-8000-0000000009f8', 'template_id', '00000000-0000-4000-8000-0000000009f2', 'variables', '[]'::jsonb)) $$, 'P0190', null, 'template não aprovado');
select throws_ok($$ select mkt.save_dispatch(jsonb_build_object('campaign_id', (select v from ids where k = 'camp'), 'channel_account_id', '00000000-0000-4000-8000-0000000009f8', 'template_id', '00000000-0000-4000-8000-0000000009f1', 'variables', '[]'::jsonb)) $$, 'P0190', null, 'faltam variáveis');
select throws_ok($$ select mkt.save_dispatch(jsonb_build_object('campaign_id', (select v from ids where k = 'camp'), 'channel_account_id', '00000000-0000-4000-8000-0000000009f8', 'template_id', '00000000-0000-4000-8000-0000000009f1', 'variables', '[{"source":"CPF"}]'::jsonb)) $$, 'P0190', null, 'origem de variável inválida');
select throws_ok($$ select mkt.save_dispatch(jsonb_build_object('campaign_id', (select v from ids where k = 'camp'), 'channel_account_id', '00000000-0000-4000-8000-0000000009f8', 'template_id', '00000000-0000-4000-8000-0000000009f1', 'variables', '[{"source":"TEXT","text":"a\nb"}]'::jsonb)) $$, 'P0190', null, 'texto fixo com quebra de linha');
select throws_ok($$ select mkt.save_dispatch(jsonb_build_object('campaign_id', (select v from ids where k = 'camp'), 'channel_account_id', '00000000-0000-4000-8000-0000000009f8', 'template_id', '00000000-0000-4000-8000-0000000009f1', 'variables', '[{"source":"COUPON_CODE"}]'::jsonb)) $$, 'P0190', null, 'cupom na mensagem sem oferta com cupom');
select throws_ok($$ select mkt.save_dispatch(jsonb_build_object('campaign_id', (select v from ids where k = 'camp'), 'channel_account_id', '00000000-0000-4000-8000-0000000009f8', 'template_id', '00000000-0000-4000-8000-0000000009f1', 'variables', '[{"source":"FIRST_NAME"}]'::jsonb, 'frequency_cap_days', 120)) $$, 'P0190', null, 'intervalo acima de 90 dias');
select throws_ok($$ select mkt.save_dispatch(jsonb_build_object('campaign_id', (select v from ids where k = 'camp'), 'channel_account_id', '00000000-0000-4000-8000-0000000009f8', 'template_id', '00000000-0000-4000-8000-0000000009f1', 'variables', '[{"source":"FIRST_NAME"}]'::jsonb, 'daily_limit', 0)) $$, 'P0190', null, 'limite diário inválido');
select throws_ok($$ select mkt.save_dispatch(jsonb_build_object('campaign_id', (select v from ids where k = 'camp'), 'channel_account_id', '00000000-0000-4000-8000-0000000009f8', 'template_id', '00000000-0000-4000-8000-0000000009f1', 'variables', '[{"source":"FIRST_NAME"}]'::jsonb, 'filter', 'NOT_BOUGHT')) $$, 'P0190', null, 'lembrete sem data');

-- sem canal a campanha não lança
select is((mkt.campaign_checklist((select v from ids where k = 'camp')::uuid) ->> 'can_launch')::boolean, false, 'sem disparo nem anúncio a campanha não pode lançar');
select throws_ok($$ select mkt.launch_campaign((select v from ids where k = 'camp')::uuid) $$, 'P0191', null, 'lançar com pendência dá erro claro');

insert into ids select 'disp', (mkt.save_dispatch(jsonb_build_object('campaign_id', (select v from ids where k = 'camp'), 'channel_account_id', '00000000-0000-4000-8000-0000000009f8', 'template_id', '00000000-0000-4000-8000-0000000009f1',
  'variables', '[{"source":"FIRST_NAME"}]'::jsonb, 'frequency_cap_days', 7, 'daily_limit', 1))).id::text;

-- ---------- Prévia ----------
select is((mkt.campaign_preview((select v from ids where k = 'camp')::uuid) ->> 'audience')::int, 6, 'público de 6');
select is((mkt.campaign_preview((select v from ids where k = 'camp')::uuid) ->> 'eligible')::int, 2, 'só 2 podem receber');
select is((mkt.campaign_preview((select v from ids where k = 'camp')::uuid) -> 'excluded')::text::jsonb, '{"NO_PHONE": 1, "NO_CONSENT": 2, "FREQUENCY_CAP": 1}'::jsonb, 'quem fica de fora e por quê (sem aceite, recusou, sem telefone, recebeu há pouco)');
select is((mkt.campaign_preview((select v from ids where k = 'camp')::uuid) ->> 'days_needed')::int, 2, 'com limite de 1 por dia levaria 2 dias');
select is((mkt.campaign_checklist((select v from ids where k = 'camp')::uuid) ->> 'can_launch')::boolean, true, 'com disparo, público e template aprovado a campanha pode lançar');

-- ---------- Lançar ----------
select is((mkt.launch_campaign((select v from ids where k = 'camp')::uuid)).status, 'ACTIVE', 'lança: campanha ativa');
select is((select status from mkt.campaign_dispatches where id = pg_temp.did('camp')), 'SENDING', 'o disparo começa a enviar');
select is((select count(*)::int from mkt.campaign_members where campaign_id = (select v from ids where k = 'camp')::uuid and grp = 'TREATMENT'), 6, 'quem entra fica congelado (6 pessoas)');
select is((select count(*)::int from mkt.campaign_recipients where dispatch_id = pg_temp.did('camp') and status = 'PENDING'), 2, 'dois pendentes');
select is((select string_agg(distinct skip_reason, ',' order by skip_reason) from mkt.campaign_recipients where dispatch_id = pg_temp.did('camp') and status = 'SKIPPED'), 'FREQUENCY_CAP,NO_CONSENT,NO_PHONE', 'os demais ficam registrados como pulados, com o motivo');
select throws_ok($$ select mkt.launch_campaign((select v from ids where k = 'camp')::uuid) $$, 'P0191', null, 'não lança duas vezes');
select is((select count(*)::int from mkt.tracking_links where campaign_id = (select v from ids where k = 'camp')::uuid and active), 3, 'o lançamento cria os links da campanha (story, bio e QR)');
select is((select name from mkt.save_campaign(jsonb_build_object('id', (select v from ids where k = 'camp'), 'name', 'Outono renomeada', 'audience', '{"tags":["outra"]}'::jsonb))), 'Outono renomeada', 'campanha ativa aceita mudar o nome');
select is((select audience ->> 'tags' from mkt.campaigns where id = (select v from ids where k = 'camp')::uuid), '["cmp-test"]', 'mas o público não muda depois de lançada');
select throws_ok($$ select mkt.save_dispatch(jsonb_build_object('id', pg_temp.did('camp'), 'campaign_id', (select v from ids where k = 'camp'), 'channel_account_id', '00000000-0000-4000-8000-0000000009f8', 'template_id', '00000000-0000-4000-8000-0000000009f1', 'variables', '[{"source":"FIRST_NAME"}]'::jsonb)) $$, 'P0191', null, 'disparo agendado não se edita');
reset role;
select is((select queue_length from pgmq.metrics('campaign_tasks')) - (select t from q0), 1::bigint, 'o envio vai para a fila do worker');

-- ---------- Envio (worker) ----------
select is((mkt.dispatch_send_batch(pg_temp.did('camp'), 50) ->> 'sent')::int, 1, 'envia só 1: o limite diário do número é 1');
select is((mkt.dispatch_send_batch(pg_temp.did('camp'), 50) ->> 'blocked_by_daily_limit')::boolean, true, 'na segunda rodada o limite diário segura');
select is((select count(*)::int from mkt.campaign_recipients where dispatch_id = pg_temp.did('camp') and status = 'QUEUED'), 1, 'um na fila de envio');
select is((select m.type || '/' || m.author_type || '/' || m.status || '/' || m.body from omni.messages m join mkt.campaign_recipients r on r.message_id = m.id where r.dispatch_id = pg_temp.did('camp')),
  'TEMPLATE/SYSTEM/QUEUED/Oi Cami! A coleção de outono chegou. Quer ver?', 'mensagem de template com o primeiro nome, como sistema');
select is((select m.payload ->> 'campaign_id' from omni.messages m join mkt.campaign_recipients r on r.message_id = m.id where r.dispatch_id = pg_temp.did('camp')), (select v from ids where k = 'camp'), 'a mensagem guarda a campanha (para atribuir vendas)');
select is((select queue_length from pgmq.metrics('outbound_messages')) - (select o from q0), 1::bigint, 'enfileirada para o sender');
select is((select count(*)::int from omni.channel_identities where channel_account_id = '00000000-0000-4000-8000-0000000009f8' and external_id = (select regexp_replace(value_normalized, '\D', '', 'g') from crm.party_contact_points where party_id = '00000000-0000-4000-8000-0000000009c1' and type = 'WHATSAPP')), 1, 'cria a conversa da pessoa no número');
-- a Dani retira o consentimento antes do envio dela
insert into crm.consents (org_id, party_id, purpose, granted, legal_basis) values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000009c2', 'MARKETING_WHATSAPP', false, 'CONSENT');
update mkt.campaign_recipients set sent_at = now() - interval '25 hours' where dispatch_id = pg_temp.did('camp') and status = 'QUEUED';
select is((mkt.dispatch_send_batch(pg_temp.did('camp'), 50) ->> 'sent')::int, 0, 'recusa no meio do disparo: não envia');
select is((select skip_reason from mkt.campaign_recipients where dispatch_id = pg_temp.did('camp') and party_id = '00000000-0000-4000-8000-0000000009c2'), 'NO_CONSENT', 'e registra o motivo');
select is((select status from mkt.campaign_dispatches where id = pg_temp.did('camp')), 'DONE', 'sem pendentes o disparo termina');
select is((select status from mkt.campaigns where id = (select v from ids where k = 'camp')::uuid), 'ACTIVE', 'a campanha segue ativa durante a janela de atribuição');
select is((mkt.dispatch_send_batch(pg_temp.did('camp'), 50) ->> 'done')::boolean, true, 'rodar de novo depois de concluído não faz nada');
select is(private.close_campaigns(), 0, 'o fechamento automático espera a janela de atribuição');
update mkt.campaign_dispatches set finished_at = now() - interval '10 days' where id = pg_temp.did('camp');
select is(private.close_campaigns(), 1, 'passada a janela, a campanha fecha sozinha');
select is((select status from mkt.campaigns where id = (select v from ids where k = 'camp')::uuid), 'ENDED', 'encerrada');
select is((select count(*)::int from mkt.tracking_links where campaign_id = (select v from ids where k = 'camp')::uuid and active), 0, 'e os links da campanha são pausados');

-- ---------- Acompanhamento ----------
update omni.messages set status = 'DELIVERED' where id = (select message_id from mkt.campaign_recipients where dispatch_id = pg_temp.did('camp') and message_id is not null);
select is((select status from mkt.campaign_recipients where dispatch_id = pg_temp.did('camp') and message_id is not null), 'SENT', 'entregue: destinatária fica como enviada');
update omni.messages set status = 'READ' where id = (select message_id from mkt.campaign_recipients where dispatch_id = pg_temp.did('camp') and message_id is not null);
insert into omni.messages (org_id, conversation_id, channel_account_id, direction, author_type, type, body, status, provider_message_id)
  select '00000000-0000-4000-8000-000000000001', m.conversation_id, m.channel_account_id, 'IN', 'CUSTOMER', 'TEXT', 'Quero ver sim!', 'RECEIVED', 'wamid.cmp.reply' from omni.messages m where m.payload ->> 'campaign_id' = (select v from ids where k = 'camp');
insert into sales.orders (org_id, legal_entity_id, store_id, location_id, number, channel, status, party_id, subtotal, total, cost_total, idempotency_key)
  values ('00000000-0000-4000-8000-000000000001', (select id from core.legal_entities limit 1), '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1', 'CMP-1', 'POS', 'PAID', '00000000-0000-4000-8000-0000000009c1', 450, 450, 150, 'cmp-1');
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');
select is((mkt.campaign_results((select v from ids where k = 'camp')::uuid) ->> 'read')::int, 1, 'lida');
select is((mkt.campaign_results((select v from ids where k = 'camp')::uuid) ->> 'replied')::int, 1, 'respondeu em 72 h');
select is((mkt.campaign_results((select v from ids where k = 'camp')::uuid) ->> 'revenue')::numeric, 450.00, 'vendas depois do envio');
select is((mkt.campaign_results((select v from ids where k = 'camp')::uuid) -> 'skipped')::text::jsonb ->> 'NO_CONSENT', '3', 'pulados por falta de consentimento (2 no lançamento + 1 retirado no meio)');

-- ---------- Link público ----------
select is((public.resolve_link((select code || '-story' from mkt.campaigns where id = (select v from ids where k = 'camp')::uuid)))::text, null, 'link de campanha encerrada não resolve');

-- ---------- Cancelar e excluir ----------
insert into ids select 'camp2', (mkt.save_campaign('{"name":"Segunda campanha","audience":{"tags":["cmp-test"]}}')).id::text;
select is((mkt.cancel_campaign((select v from ids where k = 'camp2')::uuid)).status, 'CANCELLED', 'cancela rascunho');
select throws_ok($$ select mkt.cancel_campaign((select v from ids where k = 'camp')::uuid) $$, 'P0191', null, 'encerrada não cancela');
insert into ids select 'camp3', (mkt.save_campaign('{"name":"Terceira campanha"}')).id::text;
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
select ok(not has_function_privilege('authenticated', 'mkt.dispatch_send_batch(uuid,integer)', 'execute') and not has_function_privilege('authenticated', 'private.campaign_skip_reason(uuid,integer,uuid)', 'execute')
  and not has_function_privilege('authenticated', 'private.ensure_wa_conversation(uuid,uuid,text)', 'execute') and not has_function_privilege('authenticated', 'mkt.sync_recipient_status()', 'execute'), 'funções do worker e internas não são chamáveis pela tela');
select ok(has_function_privilege('authenticated', 'mkt.launch_campaign(uuid)', 'execute') and has_function_privilege('authenticated', 'crm.audience(jsonb)', 'execute'), 'funções da tela chamáveis');

select * from finish();
rollback;
