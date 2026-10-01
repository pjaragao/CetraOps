begin;
create extension if not exists pgtap with schema extensions;
select plan(21);

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

insert into omni.channel_accounts (id, org_id, channel, provider_account_id, display_name, store_id, default_ai_mode, created_at) values
  ('00000000-0000-4000-8000-0000000009f1', '00000000-0000-4000-8000-000000000001', 'WHATSAPP', 'PNID-NOTICE', 'WhatsApp (avisos)', '00000000-0000-4000-8000-0000000000a1', 'AI_COPILOT', '2000-01-01');
insert into omni.templates (id, org_id, channel_account_id, name, language, category, status, components) values
  ('00000000-0000-4000-8000-0000000009f2', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000009f1', 'pronto_para_retirada', 'pt_BR', 'UTILITY', 'APPROVED',
   '[{"type":"BODY","text":"Oi, {{1}}! O pedido {{2}} está pronto para retirar."}]'),
  ('00000000-0000-4000-8000-0000000009f3', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000009f1', 'novidades', 'pt_BR', 'MARKETING', 'APPROVED',
   '[{"type":"BODY","text":"Oi, {{1}}! Novidades."}]');

-- cliente com conversa aberta (janela de 24 h) e cliente sem conversa recente
insert into ids select 'conv', ((omni.ingest_event(jsonb_build_object('kind', 'MESSAGE', 'channel', 'WHATSAPP', 'provider_account_id', 'PNID-NOTICE',
  'external_id', '5548955550001', 'phone', '5548955550001', 'display_name', 'Olga Aviso', 'provider_message_id', 'wamid.N1', 'type', 'TEXT', 'body', 'Oi')))->>'conversation_id')::uuid;
insert into ids select 'olga', party_id from omni.conversations where id = (select v from ids where k = 'conv');
insert into ids select 'paula', crm.resolve_identity('00000000-0000-4000-8000-000000000001', 'WHATSAPP', '+55 48 95555-0002', 'Paula Aviso', 'TEST');
insert into ids select 'semzap', crm.resolve_identity('00000000-0000-4000-8000-000000000001', 'INSTAGRAM', 'semzap.aviso', 'Sem Zap', 'TEST');

create or replace function pg_temp.order_for(p_party uuid, p_n text, p_status text, p_channel text default 'WHATSAPP') returns uuid language plpgsql as $$
declare v uuid;
begin
  insert into sales.orders (org_id, legal_entity_id, store_id, location_id, number, channel, status, party_id, subtotal, discount_total, total, cost_total, idempotency_key)
  values ('00000000-0000-4000-8000-000000000001', (select id from core.legal_entities limit 1), '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1',
          p_n, p_channel::sales.channel, p_status::sales.order_status, p_party, 200, 0, 200, 80, 'ntc-' || p_n) returning id into v;
  return v;
end $$;

-- ---------- Cadastro ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select throws_ok($$ select omni.save_notice_rule('{"event":"READY_FOR_PICKUP","template_id":"00000000-0000-4000-8000-0000000009f3"}') $$, 'P0331', null, 'aviso não aceita template de marketing');
select throws_ok($$ select omni.save_notice_rule('{"event":"QUALQUER"}') $$, 'P0330', null, 'aviso desconhecido é recusado');
select lives_ok($$ select omni.save_notice_rule('{"event":"READY_FOR_PICKUP","active":true,"channel_account_id":"00000000-0000-4000-8000-0000000009f1","template_id":"00000000-0000-4000-8000-0000000009f2","template_vars":["FIRST_NAME","ORDER_NUMBER"]}') $$, 'liga o aviso de pronto para retirar');
select lives_ok($$ select omni.save_notice_rule('{"event":"ORDER_PAID","active":true,"channel_account_id":"00000000-0000-4000-8000-0000000009f1"}') $$, 'liga o aviso de pagamento (sem template)');
select is((select free_text from omni.notice_rules where event = 'ORDER_PAID' and org_id = '00000000-0000-4000-8000-000000000001') like 'Oi, {nome}! Recebemos o pagamento%', true, 'texto padrão quando não informado');
reset role;

-- ---------- Janela aberta: texto livre ----------
insert into ids select 'o1', pg_temp.order_for((select v from ids where k = 'olga'), 'NTC-1', 'PENDING_PAYMENT');
update sales.orders set status = 'PAID' where id = (select v from ids where k = 'o1');
select is((select status from omni.notices_log where source_id = (select v from ids where k = 'o1') and event = 'ORDER_PAID'), 'SENT_TEXT', 'janela aberta: aviso sai como texto');
select ok(exists (select 1 from omni.messages where conversation_id = (select v from ids where k = 'conv') and author_type = 'SYSTEM' and body like 'Oi, Olga! Recebemos o pagamento do pedido NTC-1%'), 'texto com nome e pedido');
update sales.orders set status = 'PENDING_PAYMENT' where id = (select v from ids where k = 'o1');
update sales.orders set status = 'PAID' where id = (select v from ids where k = 'o1');
select is((select count(*)::int from omni.notices_log where source_id = (select v from ids where k = 'o1') and event = 'ORDER_PAID'), 1, 'um aviso por fato');

-- ---------- Janela fechada: template de utilidade ----------
insert into ids select 'o2', pg_temp.order_for((select v from ids where k = 'paula'), 'NTC-2', 'PAID');
update sales.orders set status = 'READY_FOR_PICKUP' where id = (select v from ids where k = 'o2');
select is((select status from omni.notices_log where source_id = (select v from ids where k = 'o2') and event = 'READY_FOR_PICKUP'), 'SENT_TEMPLATE', 'janela fechada: vai o template de utilidade');
select is((select body from omni.messages where client_dedupe_key = 'notice:READY_FOR_PICKUP:' || (select v from ids where k = 'o2') || ':' || (select v from ids where k = 'paula')), 'Oi, Paula! O pedido NTC-2 está pronto para retirar.', 'variáveis do template preenchidas');
-- sem template configurado e janela fechada (pagamento da Paula): vira tarefa
update sales.orders set status = 'PENDING_PAYMENT' where id = (select v from ids where k = 'o2');
update sales.orders set status = 'PAID' where id = (select v from ids where k = 'o2');
select is((select status || '/' || reason from omni.notices_log where source_id = (select v from ids where k = 'o2') and event = 'ORDER_PAID'), 'TASK/WINDOW_CLOSED_NO_TEMPLATE', 'sem template: tarefa para a equipe');
-- sem WhatsApp
insert into ids select 'o3', pg_temp.order_for((select v from ids where k = 'semzap'), 'NTC-3', 'PENDING_PAYMENT');
update sales.orders set status = 'PAID' where id = (select v from ids where k = 'o3');
select is((select reason from omni.notices_log where source_id = (select v from ids where k = 'o3')), 'NO_WHATSAPP', 'sem WhatsApp: tarefa com o motivo');
-- venda no balcão não avisa pagamento (a cliente está na loja)
insert into ids select 'o4', pg_temp.order_for((select v from ids where k = 'olga'), 'NTC-4', 'PENDING_PAYMENT', 'POS');
update sales.orders set status = 'PAID' where id = (select v from ids where k = 'o4');
select is((select count(*)::int from omni.notices_log where source_id = (select v from ids where k = 'o4')), 0, 'balcão não recebe aviso de pagamento');
-- aviso desligado não faz nada
select is(private.dispatch_notice('00000000-0000-4000-8000-000000000001', 'SHIPPED', (select v from ids where k = 'olga'), gen_random_uuid()), 'NO_RULE', 'aviso desligado não dispara');

-- ---------- Retomada ----------
insert into ids select 'o5', pg_temp.order_for((select v from ids where k = 'paula'), 'NTC-5', 'PENDING_PAYMENT');
select sales.expire_pending_orders();
select is((select status::text from sales.orders where id = (select v from ids where k = 'o5')), 'CANCELLED', 'pedido sem pagamento expira');
select ok(exists (select 1 from crm.tasks where source_rule = 'recovery:ORDER_EXPIRED:' || (select v from ids where k = 'o5') and type = 'RECOVERY' and suggested_message like '%link novo%'), 'pedido expirado vira tarefa de retomada');

insert into inv.lockers (id, org_id, store_id, code) values ('00000000-0000-4000-8000-0000000009f5', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a1', 'TST-9');
insert into sales.locker_drops (id, org_id, store_id, locker_id, party_id, expires_at) values
  ('00000000-0000-4000-8000-0000000009f6', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000009f5', (select v from ids where k = 'paula'), now() + interval '2 days');
update sales.locker_drops set outcome = 'RETURNED' where id = '00000000-0000-4000-8000-0000000009f6';
select ok(exists (select 1 from crm.tasks where source_rule = 'recovery:LOCKER_RETURNED:00000000-0000-4000-8000-0000000009f6'), 'armário devolvido sem compra vira tarefa');
select ok(exists (select 1 from crm.timeline_events where kind = 'RECOVERY' and party_id = (select v from ids where k = 'paula')), 'retomada na linha do tempo');

-- venda depois da retomada conta como recuperada
insert into ids select 'o6', pg_temp.order_for((select v from ids where k = 'paula'), 'NTC-6', 'PAID');
update sales.orders set created_at = now() + interval '1 hour' where id = (select v from ids where k = 'o6');   -- no teste tudo acontece no mesmo instante
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select is((select recovered from sales.report_recovered(current_date, current_date) where kind = 'ORDER_EXPIRED'), 1, 'relatório de vendas recuperadas');
select ok((select attempts from sales.report_recovered(current_date, current_date) where kind = 'LOCKER_RETURNED') = 1, 'tentativas por tipo');
reset role;
select lives_ok($$ select private.sweep_notices() $$, 'varredura de 15 em 15 min roda');

select * from finish();
rollback;
