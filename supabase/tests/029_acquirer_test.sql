begin;
create extension if not exists pgtap with schema extensions;
select plan(21);

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

-- Recebível da venda no formato do arquivo da adquirente (usa as parcelas e as taxas esperadas do próprio sistema, ou valores forçados)
create or replace function pg_temp.receivables(p_order uuid, p_payout text, p_extra_mdr numeric default 0) returns jsonb language sql as $$
  select jsonb_agg(jsonb_build_object('n', i.n, 'expected_date', i.expected_date, 'gross', i.amount, 'mdr_fee', round(i.fee_expected - i.fee_anticipation_expected + p_extra_mdr / 3, 2),
         'anticipation_fee', i.fee_anticipation_expected, 'net', i.amount - round(i.fee_expected - i.fee_anticipation_expected + p_extra_mdr / 3, 2) - i.fee_anticipation_expected, 'payout_external_id', p_payout) order by i.n)
  from fin.title_installments i join fin.titles t on t.id = i.title_id where t.origin_type = 'ORDER' and t.origin_id = p_order and t.document_kind = 'CREDIT'
$$;
grant execute on function pg_temp.receivables(uuid, text, numeric) to authenticated;

-- ---------- Vendas do sistema (cartão em 3x com antecipação D+1, e cartão à vista) ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');   -- sócio
select sales.create_pos_order(jsonb_build_object('idempotency_key', 't-acq-1', 'store_id', '00000000-0000-4000-8000-0000000000a1', 'party_id', '00000000-0000-4000-8000-000000000501',
  'items', jsonb_build_array(jsonb_build_object('variant_id', (select id from catalog.variants where sku = 'DEMO-LEG01-PRT-M'), 'qty', 1), jsonb_build_object('variant_id', (select id from catalog.variants where sku = 'DEMO-TEE01-PRT-G'), 'qty', 1)),
  'payments', jsonb_build_array(jsonb_build_object('method', 'CREDIT', 'amount', 678, 'installments', 3, 'acquirer', 'STONE', 'anticipation_mode', 'D1'))));
select sales.create_pos_order(jsonb_build_object('idempotency_key', 't-acq-2', 'store_id', '00000000-0000-4000-8000-0000000000a1', 'party_id', '00000000-0000-4000-8000-000000000501',
  'items', jsonb_build_array(jsonb_build_object('variant_id', (select id from catalog.variants where sku = 'DEMO-TEE01-PRT-G'), 'qty', 1)),
  'payments', jsonb_build_array(jsonb_build_object('method', 'CREDIT', 'amount', 249, 'installments', 3, 'acquirer', 'STONE', 'anticipation_mode', 'D1'))));
reset role;
insert into ids select 'o1', id::text from sales.orders where idempotency_key = 't-acq-1';
insert into ids select 'o2', id::text from sales.orders where idempotency_key = 't-acq-2';
update sales.payments set nsu = 'NSU-A1' where order_id = (select v from ids where k = 'o1')::uuid;
update sales.payments set nsu = 'NSU-A2' where order_id = (select v from ids where k = 'o2')::uuid;
insert into ids select 'amount1', amount::text from sales.payments where order_id = (select v from ids where k = 'o1')::uuid;
insert into ids select 'amount2', amount::text from sales.payments where order_id = (select v from ids where k = 'o2')::uuid;

-- ---------- Permissões ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');   -- vendedora: sem permissão financeira de escrita
select throws_ok($$ select fin.import_acquirer('{"acquirer":"STONE","transactions":[]}') $$, '42501', null, 'quem não é do financeiro não importa');
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');

-- ---------- Importação ----------
select throws_ok($$ select fin.import_acquirer('{"acquirer":"S","transactions":[]}') $$, 'P0260', null, 'adquirente precisa de nome');
select throws_ok($$ select fin.import_acquirer('{"acquirer":"STONE","transactions":[{"external_id":"X","gross":100,"captured_at":"2026-09-30T10:00:00-03:00","method":"BOLETO"}]}') $$, 'P0260', null, 'forma de pagamento inválida');
select throws_ok($$ select fin.import_acquirer(jsonb_build_object('acquirer', 'STONE', 'transactions', jsonb_build_array(jsonb_build_object('external_id', 'X', 'gross', 100, 'captured_at', now(), 'method', 'CREDIT',
  'receivables', jsonb_build_array(jsonb_build_object('n', 1, 'gross', 40, 'net', 40)))))) $$, 'P0262', null, 'parcelas que não somam a venda');

select is(fin.import_acquirer(jsonb_build_object('acquirer', 'stone', 'filename', 'stone-setembro.csv', 'hash', 'h1', 'bank_account_id', '00000000-0000-4000-8000-000000000705',
  'payouts', jsonb_build_array(jsonb_build_object('external_id', 'PO-1', 'paid_on', private.today_sp(),
    'amount', (select sum((x ->> 'net')::numeric) from jsonb_array_elements(pg_temp.receivables((select v from ids where k = 'o1')::uuid, 'PO-1')) x)),
    jsonb_build_object('external_id', 'PO-2', 'paid_on', private.today_sp(), 'amount', 90)),
  'transactions', jsonb_build_array(
    jsonb_build_object('external_id', 'ACQ-1', 'nsu', 'NSU-A1', 'captured_at', now(), 'method', 'CREDIT', 'installments', 3, 'gross', (select v::numeric from ids where k = 'amount1'),
      'mdr_fee', (select sum((x ->> 'mdr_fee')::numeric) from jsonb_array_elements(pg_temp.receivables((select v from ids where k = 'o1')::uuid, 'PO-1')) x),
      'anticipation_fee', (select sum((x ->> 'anticipation_fee')::numeric) from jsonb_array_elements(pg_temp.receivables((select v from ids where k = 'o1')::uuid, 'PO-1')) x),
      'receivables', pg_temp.receivables((select v from ids where k = 'o1')::uuid, 'PO-1')),
    jsonb_build_object('external_id', 'ACQ-2', 'nsu', 'NSU-A2', 'captured_at', now(), 'method', 'CREDIT', 'installments', 3, 'gross', (select v::numeric from ids where k = 'amount2'),
      'mdr_fee', 60, 'anticipation_fee', 0,
      'receivables', pg_temp.receivables((select v from ids where k = 'o2')::uuid, 'PO-2', 50)),
    jsonb_build_object('external_id', 'ACQ-3', 'nsu', 'NSU-SEM-VENDA', 'captured_at', now(), 'method', 'CREDIT', 'installments', 1, 'gross', 90.00, 'mdr_fee', 2, 'anticipation_fee', 0,
      'receivables', jsonb_build_array(jsonb_build_object('n', 1, 'expected_date', private.today_sp(), 'gross', 90.00, 'mdr_fee', 2, 'net', 88, 'payout_external_id', 'PO-2')))))) - 'import_id',
  '{"matched":2,"unmatched":1,"payouts_new":2,"fee_alerts":1,"transactions_new":3,"transactions_duplicate":0}'::jsonb, 'duas transações casam pelo NSU, uma fica sem venda, e a taxa alta gera alerta');
select throws_ok($$ select fin.import_acquirer('{"acquirer":"STONE","hash":"h1","transactions":[]}') $$, 'P0261', null, 'o mesmo arquivo não entra duas vezes');
select is((select count(*)::int from fin.acquirer_receivables r join fin.acquirer_transactions t on t.id = r.transaction_id where t.external_id = 'ACQ-1' and r.installment_id is not null), 3, 'as 3 parcelas da adquirente ligam às parcelas a receber da venda');
select ok((select abs(fee_variance) <= 0.05 from fin.acquirer_transactions where external_id = 'ACQ-1'), 'taxa cobrada igual à esperada (até o arredondamento): sem variação');
select ok((select fee_variance > 20 from fin.acquirer_transactions where external_id = 'ACQ-2'), 'taxa cobrada acima do contratado fica registrada');
select is((select count(*)::int from ai.suggestions where payload ->> 'rule' = 'FEE_MISMATCH' and status = 'OPEN'), 1, 'e vira sugestão para contestar com a adquirente');
select is((select match_status from fin.acquirer_transactions where external_id = 'ACQ-3'), 'UNMATCHED', 'transação sem venda correspondente fica pendente');
select is(fin.import_acquirer(jsonb_build_object('acquirer', 'STONE', 'transactions', jsonb_build_array(jsonb_build_object('external_id', 'ACQ-1', 'nsu', 'NSU-A1', 'captured_at', now(), 'method', 'CREDIT', 'installments', 3, 'gross', 1.00)))) ->> 'transactions_duplicate', '1',
  'a mesma transação em outro arquivo não duplica');

-- ---------- Auditoria ----------
select is((select (elem ->> 'transactions')::int from jsonb_array_elements(fin.acquirer_audit(private.today_sp() - 1, private.today_sp() + 1)) elem where elem ->> 'installments' = '3' order by (elem ->> 'variance')::numeric desc limit 1), 2, 'a auditoria agrupa por forma e parcelas');

-- ---------- Repasse ----------
select throws_ok($$ select fin.settle_acquirer_payout((select id from fin.acquirer_payouts where external_id = 'PO-2')) $$, 'P0261', null, 'repasse com parcela que não casa com venda não baixa');
select throws_ok($$ select fin.settle_acquirer_payout('00000000-0000-4000-8000-0000000000ee') $$, 'P0263', null, 'repasse inexistente');
select ok((fin.settle_acquirer_payout((select id from fin.acquirer_payouts where external_id = 'PO-1'))).id is not null, 'repasse baixa as parcelas com a taxa cobrada');
select is((select count(*)::int from fin.title_installments i join fin.titles t on t.id = i.title_id where t.origin_id = (select v from ids where k = 'o1')::uuid and t.document_kind = 'CREDIT' and i.status = 'SETTLED'), 3, 'as 3 parcelas a receber ficam baixadas');
select is((select status from fin.acquirer_payouts where external_id = 'PO-1'), 'SETTLED', 'repasse baixado');
select is((select count(*)::int from fin.acquirer_receivables where payout_id = (select id from fin.acquirer_payouts where external_id = 'PO-1') and status = 'PAID'), 3, 'recebíveis pagos');
select throws_ok($$ select fin.settle_acquirer_payout((select id from fin.acquirer_payouts where external_id = 'PO-1')) $$, 'P0261', null, 'não baixa o mesmo repasse duas vezes');
select is((select sum(debit) - sum(credit) from fin.journal_lines), 0.00, 'razão fechado: débitos = créditos');

select * from finish();
rollback;
