begin;
create extension if not exists pgtap with schema extensions;
select plan(63);

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

create temp table snap (k text primary key, v numeric);
grant all on snap to authenticated;

-- ---------- Configuração ----------
select ok((select count(*) from fin.account_roles) >= 60, 'papéis contábeis carregados');
select is((select count(*)::int from fin.account_roles ar join fin.chart_accounts a on a.id = ar.chart_account_id where a.kind <> 'ANALYTIC'), 0,
          'todo papel contábil aponta para conta analítica');

select pg_temp.login('00000000-0000-4000-8000-0000000000f1');   -- sócio

-- ---------- Título com rateio na criação (mídia paga 80/20) ----------
select lives_ok($$ select fin.create_title(jsonb_build_object(
  'direction', 'PAYABLE', 'legal_entity_id', '00000000-0000-4000-8000-0000000000e1', 'party_id', '00000000-0000-4000-8000-000000000713',
  'description', 'Meta Ads outubro (teste)', 'document_kind', 'BOLETO',
  'chart_account_id', (select id from fin.chart_accounts where code = '7.3.02'),
  'allocation_template_id', '00000000-0000-4000-8000-000000000721',
  'installments', jsonb_build_array(jsonb_build_object('due_date', private.today_sp() + 5, 'amount', 1000)))) $$,
  'cria conta a pagar com modelo de rateio');
select is((select count(*)::int from fin.title_lines l join fin.titles t on t.id = l.title_id where t.description = 'Meta Ads outubro (teste)'), 2,
          'rateio 80/20 gerou duas linhas de composição');
select is((select l.amount from fin.title_lines l join fin.titles t on t.id = l.title_id
           where t.description = 'Meta Ads outubro (teste)' and l.cost_center_id = '00000000-0000-4000-8000-0000000000c4'), 800.00,
          'digital recebe 80%');
select is((select accrual_entry_id is null from fin.titles where description = 'Meta Ads outubro (teste)'), true,
          'rascunho ainda não contabilizou a competência');
select lives_ok($$ select fin.approve_title((select id from fin.titles where description = 'Meta Ads outubro (teste)')) $$, 'sócio aprova a conta a pagar');
select is((select count(*)::int from fin.journal_lines l join fin.titles t on t.accrual_entry_id = l.entry_id where t.description = 'Meta Ads outubro (teste)'), 3,
          'competência: crédito em fornecedores + 2 débitos por centro de custo');

select lives_ok($$ select fin.create_title(jsonb_build_object(
  'direction', 'PAYABLE', 'legal_entity_id', '00000000-0000-4000-8000-0000000000e1', 'party_id', '00000000-0000-4000-8000-000000000712',
  'description', 'Honorários outubro (teste)', 'document_kind', 'BOLETO',
  'chart_account_id', (select id from fin.chart_accounts where code = '7.2.05'), 'cost_center_id', '00000000-0000-4000-8000-0000000000c0',
  'installments', jsonb_build_array(jsonb_build_object('due_date', private.today_sp() + 3, 'amount', 650)))) $$, 'cria honorários');
select lives_ok($$ select fin.approve_title((select id from fin.titles where description = 'Honorários outubro (teste)')) $$, 'aprova honorários');

select throws_ok($$ select fin.create_title(jsonb_build_object(
  'direction', 'PAYABLE', 'legal_entity_id', '00000000-0000-4000-8000-0000000000e1', 'description', 'Composição errada',
  'lines', jsonb_build_array(jsonb_build_object('chart_account_id', (select id from fin.chart_accounts where code = '7.2.05'), 'amount', 90)),
  'installments', jsonb_build_array(jsonb_build_object('due_date', private.today_sp(), 'amount', 100)))) $$,
  'P0024', null, 'composição precisa somar o valor do título');

-- ---------- UM Pix baixando DUAS contas, com juros e desconto ----------
select lives_ok($$ select fin.settle(jsonb_build_object(
  'bank_account_id', '00000000-0000-4000-8000-000000000701', 'direction', 'PAYABLE', 'method', 'PIX',
  'amount', 1655, 'idempotency_key', 't-pay-1', 'description', 'Pix para fornecedores',
  'lines', jsonb_build_array(
    jsonb_build_object('kind', 'PRINCIPAL', 'amount', 1000, 'installment_id', (select i.id from fin.title_installments i join fin.titles t on t.id = i.title_id where t.description = 'Meta Ads outubro (teste)')),
    jsonb_build_object('kind', 'PRINCIPAL', 'amount', 650,  'installment_id', (select i.id from fin.title_installments i join fin.titles t on t.id = i.title_id where t.description = 'Honorários outubro (teste)')),
    jsonb_build_object('kind', 'INTEREST',  'amount', 10,   'installment_id', (select i.id from fin.title_installments i join fin.titles t on t.id = i.title_id where t.description = 'Meta Ads outubro (teste)')),
    jsonb_build_object('kind', 'DISCOUNT',  'amount', 5,    'installment_id', (select i.id from fin.title_installments i join fin.titles t on t.id = i.title_id where t.description = 'Honorários outubro (teste)'))))) $$,
  'um Pix baixa duas contas com juros e desconto');
select is((select amount from fin.settlements where idempotency_key = 't-pay-1'), 1655.00, 'movimento líquido = 1000 + 650 + 10 − 5');
select is((select amount from fin.cash_transactions where settlement_id = (select id from fin.settlements where idempotency_key = 't-pay-1')), -1655.00,
          'saída de 1.655 no banco');
select is((select count(*)::int from fin.title_installments i join fin.titles t on t.id = i.title_id
           where t.description in ('Meta Ads outubro (teste)', 'Honorários outubro (teste)') and i.status = 'SETTLED'), 2, 'as duas parcelas foram quitadas');
select is((select sum(l.debit) from fin.journal_lines l join fin.journal_entries e on e.id = l.entry_id
           where e.source_id = (select id from fin.settlements where idempotency_key = 't-pay-1')
             and l.account_id = (select id from fin.chart_accounts where code = '8.1.03') and l.cost_center_id = '00000000-0000-4000-8000-0000000000c4'), 8.00,
          'juros rateados como o título: 80% no digital');
select is((select sum(l.debit) from fin.journal_lines l join fin.journal_entries e on e.id = l.entry_id
           where e.source_id = (select id from fin.settlements where idempotency_key = 't-pay-1')
             and l.account_id = (select id from fin.chart_accounts where code = '8.1.03') and l.cost_center_id = '00000000-0000-4000-8000-0000000000c3'), 2.00,
          'juros rateados como o título: 20% no balcão');
select is((select balance from fin.v_bank_balances where bank_account_id = '00000000-0000-4000-8000-000000000701'), 48345.00, 'saldo do banco = 50.000 − 1.655');

select lives_ok($$ select fin.settle(jsonb_build_object(
  'bank_account_id', '00000000-0000-4000-8000-000000000701', 'direction', 'PAYABLE', 'amount', 1655, 'idempotency_key', 't-pay-1',
  'lines', jsonb_build_array(jsonb_build_object('kind', 'PRINCIPAL', 'amount', 1, 'installment_id', gen_random_uuid())))) $$,
  'repetir a mesma chave de idempotência devolve a baixa existente sem erro');
select is((select count(*)::int from fin.settlements where idempotency_key = 't-pay-1'), 1, 'idempotência: continua uma única baixa');

-- ---------- Regras de validação ----------
select throws_ok($$ select fin.settle(jsonb_build_object(
  'bank_account_id', '00000000-0000-4000-8000-000000000701', 'direction', 'PAYABLE', 'method', 'PIX',
  'lines', jsonb_build_array(jsonb_build_object('kind', 'PRINCIPAL', 'amount', 1000, 'installment_id',
     (select i.id from fin.title_installments i join fin.titles t on t.id = i.title_id where t.description = 'Meta Ads outubro (teste)'))))) $$,
  'P0027', null, 'parcela já quitada não pode ser baixada de novo');

select lives_ok($$ select fin.create_title(jsonb_build_object(
  'direction', 'PAYABLE', 'legal_entity_id', '00000000-0000-4000-8000-0000000000e1', 'party_id', '00000000-0000-4000-8000-000000000711',
  'description', 'Rascunho (teste)', 'chart_account_id', (select id from fin.chart_accounts where code = '7.2.05'),
  'installments', jsonb_build_array(jsonb_build_object('due_date', private.today_sp(), 'amount', 300)))) $$, 'cria conta em rascunho');
select throws_ok($$ select fin.settle(jsonb_build_object(
  'bank_account_id', '00000000-0000-4000-8000-000000000701', 'direction', 'PAYABLE',
  'lines', jsonb_build_array(jsonb_build_object('kind', 'PRINCIPAL', 'amount', 300, 'installment_id',
     (select i.id from fin.title_installments i join fin.titles t on t.id = i.title_id where t.description = 'Rascunho (teste)'))))) $$,
  'P0011', null, 'conta a pagar sem aprovação não pode ser paga');

select lives_ok($$ select fin.approve_title((select id from fin.titles where description = 'Rascunho (teste)')) $$, 'aprova a conta');
select throws_ok($$ select fin.settle(jsonb_build_object(
  'bank_account_id', '00000000-0000-4000-8000-000000000701', 'direction', 'PAYABLE', 'amount', 250,
  'lines', jsonb_build_array(jsonb_build_object('kind', 'PRINCIPAL', 'amount', 300, 'installment_id',
     (select i.id from fin.title_installments i join fin.titles t on t.id = i.title_id where t.description = 'Rascunho (teste)'))))) $$,
  'P0023', null, 'soma dos itens diferente do valor do movimento é recusada');
select throws_ok($$ select fin.settle(jsonb_build_object(
  'bank_account_id', '00000000-0000-4000-8000-000000000701', 'direction', 'PAYABLE',
  'lines', jsonb_build_array(jsonb_build_object('kind', 'PRINCIPAL', 'amount', 999, 'installment_id',
     (select i.id from fin.title_installments i join fin.titles t on t.id = i.title_id where t.description = 'Rascunho (teste)'))))) $$,
  'P0028', null, 'não baixa mais que o saldo da parcela');

-- ---------- Pagamento parcial, adiantamento e uso de crédito ----------
select lives_ok($$ select fin.settle(jsonb_build_object(
  'bank_account_id', '00000000-0000-4000-8000-000000000701', 'direction', 'PAYABLE',
  'lines', jsonb_build_array(jsonb_build_object('kind', 'PRINCIPAL', 'amount', 100, 'installment_id',
     (select i.id from fin.title_installments i join fin.titles t on t.id = i.title_id where t.description = 'Rascunho (teste)'))))) $$,
  'pagamento parcial');
select is((select i.status::text from fin.title_installments i join fin.titles t on t.id = i.title_id where t.description = 'Rascunho (teste)'), 'PARTIAL',
          'parcela fica parcialmente paga');
select lives_ok($$ select fin.settle(jsonb_build_object(
  'bank_account_id', '00000000-0000-4000-8000-000000000701', 'direction', 'PAYABLE', 'party_id', '00000000-0000-4000-8000-000000000711',
  'lines', jsonb_build_array(
    jsonb_build_object('kind', 'PRINCIPAL', 'amount', 200, 'installment_id',
      (select i.id from fin.title_installments i join fin.titles t on t.id = i.title_id where t.description = 'Rascunho (teste)')),
    jsonb_build_object('kind', 'ADVANCE', 'amount', 50, 'memo', 'sobra de pix')))) $$,
  'quita o saldo e paga 50 a mais (adiantamento)');
select is((select amount - used from fin.party_credits where party_id = '00000000-0000-4000-8000-000000000711' and status = 'OPEN'), 50.00,
          'a sobra virou crédito com o fornecedor');

select lives_ok($$ select fin.create_title(jsonb_build_object(
  'direction', 'PAYABLE', 'legal_entity_id', '00000000-0000-4000-8000-0000000000e1', 'party_id', '00000000-0000-4000-8000-000000000711',
  'description', 'Compra seguinte (teste)', 'chart_account_id', (select id from fin.chart_accounts where code = '7.2.05'),
  'installments', jsonb_build_array(jsonb_build_object('due_date', private.today_sp(), 'amount', 200)))) $$, 'nova conta do mesmo fornecedor');
select lives_ok($$ select fin.approve_title((select id from fin.titles where description = 'Compra seguinte (teste)')) $$, 'aprova');
select lives_ok($$ select fin.settle(jsonb_build_object(
  'bank_account_id', '00000000-0000-4000-8000-000000000701', 'direction', 'PAYABLE', 'party_id', '00000000-0000-4000-8000-000000000711', 'amount', 150,
  'lines', jsonb_build_array(
    jsonb_build_object('kind', 'PRINCIPAL', 'amount', 200, 'installment_id',
      (select i.id from fin.title_installments i join fin.titles t on t.id = i.title_id where t.description = 'Compra seguinte (teste)')),
    jsonb_build_object('kind', 'CREDIT_USE', 'amount', 50, 'credit_id',
      (select id from fin.party_credits where party_id = '00000000-0000-4000-8000-000000000711' and status = 'OPEN'))))) $$,
  'usa o crédito de 50 e paga 150 em dinheiro');
select is((select status from fin.party_credits where party_id = '00000000-0000-4000-8000-000000000711'), 'USED', 'crédito consumido');

-- ---------- Estorno ----------
insert into snap select 'antes', balance from fin.v_bank_balances where bank_account_id = '00000000-0000-4000-8000-000000000701';
select lives_ok($$ select fin.reverse_settlement((select id from fin.settlements where idempotency_key = 't-pay-1'), 'teste de estorno') $$, 'estorna o Pix duplo');
select is((select count(*)::int from fin.title_installments i join fin.titles t on t.id = i.title_id
           where t.description in ('Meta Ads outubro (teste)', 'Honorários outubro (teste)') and i.status = 'OPEN'), 2, 'parcelas reabertas');
select is((select balance from fin.v_bank_balances where bank_account_id = '00000000-0000-4000-8000-000000000701') - (select v from snap where k = 'antes'), 1655.00,
          'saldo do banco devolvido');
select is((select sum(debit) - sum(credit) from fin.journal_lines), 0.00, 'razão fechado: débitos = créditos');

-- ---------- Recebimento agrupado da adquirente (cartão: 3 parcelas, MDR × antecipação) ----------
select lives_ok($$ select sales.create_pos_order(jsonb_build_object(
  'idempotency_key', 't-sale-ar', 'store_id', '00000000-0000-4000-8000-0000000000a1', 'party_id', '00000000-0000-4000-8000-000000000501',
  'items', jsonb_build_array(
    jsonb_build_object('variant_id', (select id from catalog.variants where sku = 'DEMO-LEG01-PRT-M'), 'qty', 1),
    jsonb_build_object('variant_id', (select id from catalog.variants where sku = 'DEMO-TEE01-PRT-G'), 'qty', 1)),
  'payments', jsonb_build_array(
    jsonb_build_object('method', 'PIX', 'amount', 200, 'acquirer', 'STONE'),
    jsonb_build_object('method', 'CREDIT', 'amount', 478, 'installments', 3, 'acquirer', 'STONE', 'anticipation_mode', 'D1')))) $$,
  'venda multi-pagamento contabiliza no razão');
select is((select sum(l.debit) from fin.journal_lines l join fin.journal_entries e on e.id = l.entry_id
           join sales.orders o on o.id = e.source_id where o.idempotency_key = 't-sale-ar' and e.kind = 'SALE'), 678.00, 'venda: débito em recebíveis = total');
select is((select sum(fee_anticipation_expected) from fin.title_installments i join fin.titles t on t.id = i.title_id join sales.orders o on o.id = t.origin_id
           where o.idempotency_key = 't-sale-ar' and t.document_kind = 'CREDIT'), 15.09, 'taxa esperada separa a parte de antecipação (D+1 − natural)');

select lives_ok($$ select fin.settle(jsonb_build_object(
  'bank_account_id', '00000000-0000-4000-8000-000000000705', 'direction', 'RECEIVABLE', 'method', 'CARD_PAYOUT', 'amount', 455.50,
  'description', 'Repasse Stone (3 parcelas)',
  'lines', (select jsonb_agg(x) from (
    select jsonb_build_object('kind', 'PRINCIPAL', 'amount', i.amount, 'installment_id', i.id) as x
      from fin.title_installments i join fin.titles t on t.id = i.title_id join sales.orders o on o.id = t.origin_id
      where o.idempotency_key = 't-sale-ar' and t.document_kind = 'CREDIT'
    union all
    select jsonb_build_object('kind', 'FEE', 'amount', i.fee_expected - i.fee_anticipation_expected, 'installment_id', i.id,
                              'chart_account_id', (select id from fin.chart_accounts where code = '7.1.02'))
      from fin.title_installments i join fin.titles t on t.id = i.title_id join sales.orders o on o.id = t.origin_id
      where o.idempotency_key = 't-sale-ar' and t.document_kind = 'CREDIT'
    union all
    select jsonb_build_object('kind', 'FEE', 'amount', i.fee_anticipation_expected, 'installment_id', i.id,
                              'chart_account_id', (select id from fin.chart_accounts where code = '8.1.01'))
      from fin.title_installments i join fin.titles t on t.id = i.title_id join sales.orders o on o.id = t.origin_id
      where o.idempotency_key = 't-sale-ar' and t.document_kind = 'CREDIT') q))) $$,
  'um repasse da adquirente baixa 3 parcelas com MDR e antecipação em contas distintas');
select is((select sum(variance) from fin.v_fee_audit), 0.00, 'auditoria de taxa: cobrado = esperado');
select is((select closing from fin.trial_balance(null, date '2000-01-01', private.today_sp(), 'LEGAL') where code = '1.1.2.01'), 0.00,
          'recebíveis de cartão zerados após o repasse');
select is((select amount from fin.dre(date_trunc('month', private.today_sp())::date, private.today_sp(), null, null, 'LEGAL') where code = 'RB'), 678.00,
          'DRE: receita bruta vem do razão');

-- ---------- Extrato: importar, conciliar, classificar ----------
select lives_ok($$ select fin.import_statement(jsonb_build_object(
  'bank_account_id', '00000000-0000-4000-8000-000000000701', 'source', 'OFX', 'file_hash', 'hash-inter-1',
  'lines', jsonb_build_array(
    jsonb_build_object('posted_on', private.today_sp(), 'amount', -150, 'description', 'PIX ENVIADO FORNECEDOR', 'external_id', 'E2E-1'),
    jsonb_build_object('posted_on', private.today_sp(), 'amount', -12.50, 'description', 'TARIFA PIX', 'external_id', 'TAR-1'),
    jsonb_build_object('posted_on', private.today_sp(), 'amount', 200, 'description', 'PIX RECEBIDO CLIENTE TESTE', 'external_id', 'E2E-2'),
    jsonb_build_object('posted_on', private.today_sp(), 'amount', 3.10, 'description', 'RENDIMENTO APLICACAO', 'external_id', 'RND-1'),
    jsonb_build_object('posted_on', private.today_sp(), 'amount', -1000, 'description', 'TED ENVIADA BTG', 'external_id', 'TED-1')))) $$,
  'importa extrato do Inter');
select is((fin.import_statement(jsonb_build_object('bank_account_id', '00000000-0000-4000-8000-000000000701', 'source', 'OFX', 'file_hash', 'hash-inter-1',
  'lines', jsonb_build_array(jsonb_build_object('posted_on', private.today_sp(), 'amount', 1, 'description', 'x')))) ->> 'duplicate_file')::boolean, true,
  'reimportar o mesmo arquivo é ignorado');
select is(fin.auto_match('00000000-0000-4000-8000-000000000701'), 1, 'conciliação automática casa o pagamento de 150 já lançado');
select is(fin.apply_recon_rules('00000000-0000-4000-8000-000000000701'), 2, 'regras classificam tarifa e rendimento');

select lives_ok($$ select fin.settle(jsonb_build_object(
  'bank_account_id', '00000000-0000-4000-8000-000000000701', 'direction', 'RECEIVABLE', 'method', 'PIX',
  'statement_line_id', (select id from fin.statement_lines where external_id = 'E2E-2'),
  'lines', jsonb_build_array(jsonb_build_object('kind', 'PRINCIPAL', 'amount', 200, 'installment_id',
     (select i.id from fin.title_installments i join fin.titles t on t.id = i.title_id join sales.orders o on o.id = t.origin_id
      where o.idempotency_key = 't-sale-ar' and t.document_kind = 'PIX'))))) $$,
  'dar baixa a partir da linha do extrato: Pix recebido');
select is((select status from fin.statement_lines where external_id = 'E2E-2'), 'MATCHED', 'a linha do extrato ficou conciliada');

-- Transferência entre contas próprias, conciliando as duas pontas
select lives_ok($$ select fin.import_statement(jsonb_build_object(
  'bank_account_id', '00000000-0000-4000-8000-000000000702', 'source', 'OFX', 'file_hash', 'hash-btg-1',
  'lines', jsonb_build_array(jsonb_build_object('posted_on', private.today_sp(), 'amount', 1000, 'description', 'TED RECEBIDA INTER', 'external_id', 'TED-R1')))) $$,
  'importa extrato do BTG');
select lives_ok($$ select fin.transfer(jsonb_build_object(
  'from_bank_account_id', '00000000-0000-4000-8000-000000000701', 'to_bank_account_id', '00000000-0000-4000-8000-000000000702', 'amount', 1000,
  'from_statement_line_id', (select id from fin.statement_lines where external_id = 'TED-1'),
  'to_statement_line_id', (select id from fin.statement_lines where external_id = 'TED-R1'))) $$, 'transferência Inter → BTG conciliada nas duas pontas');
select is((select count(*)::int from fin.statement_lines where bank_account_id in ('00000000-0000-4000-8000-000000000701', '00000000-0000-4000-8000-000000000702') and status <> 'MATCHED'), 0,
          'nada pendente nos extratos');
select is((select balance from fin.v_bank_balances where bank_account_id = '00000000-0000-4000-8000-000000000702'), 1000.00, 'BTG recebeu 1.000');

-- ---------- Período fechado bloqueia ----------
select lives_ok($$ select fin.set_period_status('00000000-0000-4000-8000-0000000000e1', private.today_sp(), 'CLOSED') $$, 'fecha o mês');
select throws_ok($$ select fin.post_cash_movement(jsonb_build_object('bank_account_id', '00000000-0000-4000-8000-000000000701', 'kind', 'BANK_FEE',
  'direction', 'OUT', 'amount', 5)) $$, 'P0022', null, 'lançar em período fechado é bloqueado');
select lives_ok($$ select fin.set_period_status('00000000-0000-4000-8000-0000000000e1', private.today_sp(), 'OPEN') $$, 'reabre o mês');

-- ---------- Segurança ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');   -- vendedora
select is((select count(*)::int from fin.settlements), 0, 'vendedora não vê baixas');
select throws_ok($$ select fin.settle(jsonb_build_object('bank_account_id', '00000000-0000-4000-8000-000000000701', 'direction', 'PAYABLE', 'lines', '[]')) $$,
  '42501', null, 'vendedora não baixa títulos');
select throws_ok($$ update fin.title_installments set amount_settled = 999 $$, '42501', null, 'ninguém altera parcela por fora das RPCs');

reset role;
select set_config('request.jwt.claims', '', true);
select throws_ok($$ update fin.journal_lines set memo = 'x' $$, 'P0001', null, 'linhas do razão são imutáveis');
select throws_ok($$ delete from fin.settlement_lines $$, 'P0001', null, 'itens de baixa são imutáveis');

select * from finish();
rollback;
