begin;
create extension if not exists pgtap with schema extensions;
select plan(29);

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
create or replace function pg_temp.queued(p_action text default null) returns bigint language sql as $$
  select count(*) from pgmq.q_fiscal_emission where (p_action is null and message ->> 'action' is null) or message ->> 'action' = p_action;
$$;

-- ---------- Uma venda real no PDV (Pix, R$ 249) ----------
update sales.cash_sessions set status = 'CLOSED', closed_at = now() where status = 'OPEN';   -- (caixa aberto na base de desenvolvimento não pode atrapalhar o teste)
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');   -- sócio
insert into ids select 'cli', crm.quick_customer('48999990003', 'Cliente Fiscal (teste)', false);
insert into ids select 'cash', (sales.open_cash_session('00000000-0000-4000-8000-0000000000d1', 200)).id;
insert into ids select 'order', (sales.create_pos_order(jsonb_build_object('idempotency_key', 't-fiscal-1', 'store_id', '00000000-0000-4000-8000-0000000000a1', 'party_id', (select v from ids where k = 'cli'),
  'items', jsonb_build_array(jsonb_build_object('variant_id', (select id from catalog.variants where sku = 'DEMO-TEE01-PRT-G'), 'qty', 1)),
  'payments', jsonb_build_array(jsonb_build_object('method', 'PIX', 'amount', 249, 'acquirer', 'STONE'))))).id;

reset role;
create temp table q0 as select pg_temp.queued() as n, pg_temp.queued('CANCEL') as c;
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');

-- ---------- Venda paga sem nota ----------
select is((select count(*)::int from fiscal.v_uninvoiced_orders where order_id = (select v from ids where k = 'order')::uuid), 1, 'venda paga sem nota aparece na lista de pendências');

-- ---------- Emitir / reenviar ----------
select lives_ok($$ select fiscal.request_emission((select v from ids where k = 'order')::uuid) $$, 'pede a emissão da nota');
reset role;
select is(pg_temp.queued() - (select n from q0), 1::bigint, 'o pedido vai para a fila fiscal');
select is((select message ->> 'ref' from pgmq.q_fiscal_emission where message ->> 'order_id' = (select v from ids where k = 'order') and (message ->> 'manual') = 'true' order by msg_id desc limit 1),
          (select v from ids where k = 'order') || ':SALE', 'mesma referência da emissão original (idempotente no provedor)');
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select throws_ok($$ select fiscal.request_emission('00000000-0000-4000-8000-0000000000ee') $$, 'P0123', null, 'pedido inexistente');

-- pedido ainda não pago não tem o que faturar
reset role;
update sales.orders set status = 'PENDING_PAYMENT' where id = (select v from ids where k = 'order')::uuid;
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select throws_ok($$ select fiscal.request_emission((select v from ids where k = 'order')::uuid) $$, 'P0120', null, 'pedido não pago não gera nota');
select is((select count(*)::int from fiscal.v_uninvoiced_orders where order_id = (select v from ids where k = 'order')::uuid), 0, 'pedido não pago não conta como pendência');
reset role;
update sales.orders set status = 'PAID' where id = (select v from ids where k = 'order')::uuid;

-- nota autorizada bloqueia nova emissão e sai da lista de pendências
insert into fiscal.documents (org_id, legal_entity_id, direction, model, series, number, access_key, status, issue_at, order_id, provider_ref, idempotency_key, totals)
select o.org_id, o.legal_entity_id, 'OUT', '65', 1, 77, '42260911222333000181650010000000771000000771', 'AUTHORIZED', now(), o.id, o.id::text || ':SALE', o.id::text || ':SALE', jsonb_build_object('vNF', o.total)
from sales.orders o where o.id = (select v from ids where k = 'order')::uuid;
insert into ids select 'doc', id::text from fiscal.documents where order_id = (select v from ids where k = 'order')::uuid;
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select throws_ok($$ select fiscal.request_emission((select v from ids where k = 'order')::uuid) $$, 'P0121', null, 'já existe nota autorizada');
select is((select count(*)::int from fiscal.v_uninvoiced_orders where order_id = (select v from ids where k = 'order')::uuid), 0, 'com nota autorizada, não é pendência');

-- ---------- Cancelar ----------
select throws_ok($$ select fiscal.request_cancellation((select v from ids where k = 'doc')::uuid, 'curto') $$, 'P0122', null, 'justificativa curta demais');
select throws_ok($$ select fiscal.request_cancellation((select v from ids where k = 'doc')::uuid, repeat('x', 256)) $$, 'P0122', null, 'justificativa longa demais');
select throws_ok($$ select fiscal.request_cancellation('00000000-0000-4000-8000-0000000000ee', 'Venda cancelada a pedido da cliente') $$, 'P0123', null, 'nota inexistente');
select lives_ok($$ select fiscal.request_cancellation((select v from ids where k = 'doc')::uuid, '  Venda cancelada a pedido da cliente  ') $$, 'pede o cancelamento');
reset role;
select is(pg_temp.queued('CANCEL') - (select c from q0), 1::bigint, 'pedido de cancelamento enfileirado');
select is((select message ->> 'reason' from pgmq.q_fiscal_emission where message ->> 'action' = 'CANCEL' and message ->> 'document_id' = (select v from ids where k = 'doc') order by msg_id desc limit 1),
          'Venda cancelada a pedido da cliente', 'justificativa enviada sem espaços nas pontas');
select is((select events -> -1 ->> 'type' from fiscal.documents where id = (select v from ids where k = 'doc')::uuid), 'CANCEL_REQUESTED', 'o pedido fica no histórico da nota');
update fiscal.documents set status = 'REJECTED' where id = (select v from ids where k = 'doc')::uuid;
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select throws_ok($$ select fiscal.request_cancellation((select v from ids where k = 'doc')::uuid, 'Venda cancelada a pedido da cliente') $$, 'P0120', null, 'só nota autorizada se cancela');

-- nota rejeitada volta a ser pendência (e pode ser reenviada)
select is((select count(*)::int from fiscal.v_uninvoiced_orders where order_id = (select v from ids where k = 'order')::uuid), 1, 'nota rejeitada deixa a venda como pendente');
select lives_ok($$ select fiscal.request_emission((select v from ids where k = 'order')::uuid) $$, 'reenvia a nota rejeitada');
reset role;
select is((select events -> -1 ->> 'type' from fiscal.documents where id = (select v from ids where k = 'doc')::uuid), 'RESEND_REQUESTED', 'reenvio registrado no histórico');

-- nota cancelada com a venda ainda de pé (pedido pago) volta a ser pendência: precisa de nova nota
reset role;
update fiscal.documents set status = 'CANCELLED' where id = (select v from ids where k = 'doc')::uuid;
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select is((select count(*)::int from fiscal.v_uninvoiced_orders where order_id = (select v from ids where k = 'order')::uuid), 1, 'nota cancelada com a venda de pé volta a ser pendência');
reset role;
update sales.orders set status = 'CANCELLED' where id = (select v from ids where k = 'order')::uuid;
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select is((select count(*)::int from fiscal.v_uninvoiced_orders where order_id = (select v from ids where k = 'order')::uuid), 0, 'venda cancelada não é pendência fiscal');
reset role;
update sales.orders set status = 'PAID' where id = (select v from ids where k = 'order')::uuid;
update fiscal.documents set status = 'REJECTED' where id = (select v from ids where k = 'doc')::uuid;

-- ---------- Permissão ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');   -- vendedora (sem fiscal.write)
select throws_ok($$ select fiscal.request_emission((select v from ids where k = 'order')::uuid) $$, '42501', null, 'vendedora não emite nota');
select throws_ok($$ select fiscal.request_cancellation((select v from ids where k = 'doc')::uuid, 'Venda cancelada a pedido da cliente') $$, '42501', null, 'vendedora não cancela nota');

-- ---------- Alerta de venda sem nota (pg_cron) ----------
reset role;
delete from fiscal.documents where id = (select v from ids where k = 'doc')::uuid;
update sales.orders set created_at = now() - interval '2 hours' where id = (select v from ids where k = 'order')::uuid;
delete from core.notifications where kind = 'FISCAL_PENDING';
select ok(private.check_uninvoiced_orders() >= 1, 'venda paga há mais de 30 min sem nota gera alerta');
select ok((select count(*) from core.notifications where kind = 'FISCAL_PENDING') >= 1, 'quem tem fiscal.write é avisado');
create temp table pend_before as select count(*)::int as n from core.notifications where kind = 'FISCAL_PENDING';
select private.check_uninvoiced_orders();
select is((select count(*)::int from core.notifications where kind = 'FISCAL_PENDING'), (select n from pend_before), 'no máximo um aviso por dia');

-- ---------- Privilégios e agenda ----------
select ok(not has_function_privilege('authenticated', 'fiscal.record_document_event(uuid,jsonb)', 'execute') and not has_function_privilege('authenticated', 'fiscal.record_cancellation(uuid,jsonb)', 'execute')
      and not has_function_privilege('authenticated', 'private.check_uninvoiced_orders()', 'execute'), 'registro de eventos/cancelamento e o alerta só pelo servidor');
select is((select count(*)::int from cron.job where jobname = 'sie-uninvoiced-orders' and active), 1, 'alerta de vendas sem nota agendado (de hora em hora)');

select * from finish();
rollback;
