begin;
create extension if not exists pgtap with schema extensions;
select plan(42);

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

select pg_temp.login('00000000-0000-4000-8000-0000000000f1');   -- sócio

-- ---------- Recorrências ----------
select lives_ok($$ insert into ids select 'rec1', (fin.save_recurring(jsonb_build_object(
  'legal_entity_id', '00000000-0000-4000-8000-0000000000e1', 'description', 'Aluguel do depósito', 'amount', 1000, 'day_of_month', 10,
  'chart_account_id', (select id from fin.chart_accounts where code = '7.2.99'), 'start_date', '2026-09-01'))).id $$, 'cria recorrência mensal');
select is((select next_run from fin.recurring_templates where id = (select v from ids where k = 'rec1')), date '2026-09-01', 'primeira competência = mês do início');
select is(fin.run_recurring(date '2026-11-30'), 3, 'gera setembro, outubro e novembro');
select is(fin.run_recurring(date '2026-11-30'), 0, 'idempotente: nada novo na segunda execução');
select is((select array_agg(i.due_date::text order by i.due_date) from fin.title_installments i join fin.titles t on t.id = i.title_id where t.origin_id = (select v from ids where k = 'rec1')),
          array['2026-09-10', '2026-10-10', '2026-11-10'], 'vencimentos no dia 10 de cada mês');
select is((select distinct approval_status from fin.titles where origin_id = (select v from ids where k = 'rec1')), 'DRAFT', 'sem aprovação automática: rascunho para o financeiro aprovar');
select is((select next_run from fin.recurring_templates where id = (select v from ids where k = 'rec1')), date '2026-12-01', 'próxima competência avança');
select lives_ok($$ insert into ids select 'rec2', (fin.save_recurring(jsonb_build_object(
  'legal_entity_id', '00000000-0000-4000-8000-0000000000e1', 'description', 'Assinatura de software', 'amount', 250.50, 'day_of_month', 5, 'auto_approve', true,
  'chart_account_id', (select id from fin.chart_accounts where code = '7.2.99'), 'start_date', '2026-10-20'))).id $$, 'recorrência com aprovação automática (início depois do dia 5)');
select is((select next_run from fin.recurring_templates where id = (select v from ids where k = 'rec2')), date '2026-11-01', 'começa no mês seguinte quando o dia já passou');
select is(fin.run_recurring(date '2026-11-30'), 1, 'gera a competência de novembro');
select isnt((select accrual_entry_id from fin.titles where origin_id = (select v from ids where k = 'rec2')), null, 'título aprovado já contabiliza a despesa');

-- ---------- Fluxo de caixa ----------
create temp table cf0 as select * from fin.cash_flow(private.today_sp(), private.today_sp() + 10, '00000000-0000-4000-8000-0000000000e1');
grant all on cf0 to authenticated;
select lives_ok($$ select fin.create_title(jsonb_build_object('direction', 'PAYABLE', 'legal_entity_id', '00000000-0000-4000-8000-0000000000e1',
  'description', 'Fornecedor X', 'chart_account_id', (select id from fin.chart_accounts where code = '7.2.99'),
  'installments', jsonb_build_array(jsonb_build_object('due_date', private.today_sp() + 5, 'amount', 500)))) $$, 'conta a pagar de R$ 500 em 5 dias');
select lives_ok($$ select fin.create_title(jsonb_build_object('direction', 'RECEIVABLE', 'legal_entity_id', '00000000-0000-4000-8000-0000000000e1',
  'description', 'Cliente B2B', 'chart_account_id', (select id from fin.chart_accounts where code = '4.1.01'),
  'installments', jsonb_build_array(jsonb_build_object('due_date', private.today_sp() + 3, 'amount', 300)))) $$, 'conta a receber de R$ 300 em 3 dias');
select is((select projected_out from fin.cash_flow(private.today_sp(), private.today_sp() + 10, '00000000-0000-4000-8000-0000000000e1') where day = private.today_sp() + 5)
        - (select projected_out from cf0 where day = private.today_sp() + 5), 500.00, 'fluxo: saída projetada no dia do vencimento');
select is((select projected_in from fin.cash_flow(private.today_sp(), private.today_sp() + 10, '00000000-0000-4000-8000-0000000000e1') where day = private.today_sp() + 3)
        - (select projected_in from cf0 where day = private.today_sp() + 3), 300.00, 'fluxo: entrada projetada no dia previsto');
select is((select balance from fin.cash_flow(private.today_sp(), private.today_sp() + 10, '00000000-0000-4000-8000-0000000000e1') where day = private.today_sp() + 10)
        - (select balance from cf0 where day = private.today_sp() + 10), -200.00, 'saldo final projetado cai R$ 200 (300 − 500)');
select is((select count(*)::int from fin.cash_flow(private.today_sp(), private.today_sp() + 10)), 11, 'uma linha por dia do intervalo');
select throws_ok($$ select * from fin.cash_flow(private.today_sp(), private.today_sp() + 500) $$, null, null, 'intervalo máximo de 400 dias');

-- ---------- Orçamento ----------
select lives_ok($$ insert into ids select 'bud1', (fin.save_budget(jsonb_build_object('legal_entity_id', '00000000-0000-4000-8000-0000000000e1', 'year', 2026,
  'lines', jsonb_build_array(
    jsonb_build_object('code', '4.1.01', 'month', 8, 'amount', 10000), jsonb_build_object('code', '4.1.01', 'month', 9, 'amount', 12000),
    jsonb_build_object('code', '7.2.99', 'month', 8, 'amount', 900))))).id $$, 'cria orçamento 2026 por conta e mês');
select is((select version from fin.budgets where id = (select v from ids where k = 'bud1')), 1, 'primeira versão do cenário base');
select is((select (fin.save_budget(jsonb_build_object('legal_entity_id', '00000000-0000-4000-8000-0000000000e1', 'year', 2026,
  'lines', jsonb_build_array(jsonb_build_object('code', '4.1.01', 'month', 1, 'amount', 1))))).version), 2, 'novo orçamento do mesmo ano/cenário vira versão 2');
select throws_ok($$ select fin.save_budget(jsonb_build_object('id', (select v from ids where k = 'bud1'), 'legal_entity_id', '00000000-0000-4000-8000-0000000000e1', 'year', 2026,
  'lines', jsonb_build_array(jsonb_build_object('code', '1.1.1.02', 'month', 1, 'amount', 5)))) $$, 'P0090', null, 'orçamento só aceita contas analíticas de resultado');

-- ---------- Rateio por direcionadores + fechamento (agosto/2026) ----------
select lives_ok($$ select fin.post_manual_entry(jsonb_build_object('legal_entity_id', '00000000-0000-4000-8000-0000000000e1', 'entry_date', '2026-08-10',
  'description', 'Receita balcão (teste)', 'lines', jsonb_build_array(
    jsonb_build_object('account_id', (select id from fin.chart_accounts where code = '1.1.1.02'), 'debit', 10000),
    jsonb_build_object('account_id', (select id from fin.chart_accounts where code = '4.1.01'), 'cost_center_id', (select id from core.cost_centers where code = 'PILOTO-BALCAO'), 'credit', 6000),
    jsonb_build_object('account_id', (select id from fin.chart_accounts where code = '4.1.02'), 'cost_center_id', (select id from core.cost_centers where code = 'PILOTO-DIGITAL'), 'credit', 4000)))) $$, 'receita do mês por canal');
select lives_ok($$ select fin.post_manual_entry(jsonb_build_object('legal_entity_id', '00000000-0000-4000-8000-0000000000e1', 'entry_date', '2026-08-12',
  'description', 'Despesa corporativa (teste)', 'lines', jsonb_build_array(
    jsonb_build_object('account_id', (select id from fin.chart_accounts where code = '7.2.99'), 'cost_center_id', (select id from core.cost_centers where code = 'CORP'), 'debit', 1000),
    jsonb_build_object('account_id', (select id from fin.chart_accounts where code = '1.1.1.02'), 'credit', 1000)))) $$, 'despesa no centro corporativo');
select lives_ok($$ insert into fin.allocation_rules (org_id, name, method, source_cost_center_id, targets)
  values ('00000000-0000-4000-8000-000000000001', 'Corporativo por receita', 'REVENUE_SHARE', (select id from core.cost_centers where code = 'CORP'),
    jsonb_build_array(jsonb_build_object('cost_center_id', (select id from core.cost_centers where code = 'PILOTO-BALCAO')),
                      jsonb_build_object('cost_center_id', (select id from core.cost_centers where code = 'PILOTO-DIGITAL')))) $$, 'regra: corporativo rateado pela receita');
select is((select total from fin.run_allocation_batch('00000000-0000-4000-8000-0000000000e1', date '2026-08-01')), 1000.00, 'lote aplicado: pool de R$ 1.000');
select is((select amount from fin.dre(date '2026-08-01', date '2026-08-31', '00000000-0000-4000-8000-0000000000e1',
            core.cc_subtree((select id from core.cost_centers where code = 'PILOTO-BALCAO')), 'ALL') where code = 'DF'), 600.00, 'DRE do balcão com rateio: 60% do corporativo');
select is((select amount from fin.dre(date '2026-08-01', date '2026-08-31', '00000000-0000-4000-8000-0000000000e1',
            core.cc_subtree((select id from core.cost_centers where code = 'PILOTO-DIGITAL')), 'ALL') where code = 'DF'), 400.00, 'DRE do digital com rateio: 40%');
select is((select amount from fin.dre(date '2026-08-01', date '2026-08-31', '00000000-0000-4000-8000-0000000000e1',
            core.cc_subtree((select id from core.cost_centers where code = 'PILOTO-BALCAO')), 'LEGAL') where code = 'DF'), 0.00, 'sem rateio: margem da unidade sem o corporativo');
select is((select amount from fin.dre(date '2026-08-01', date '2026-08-31', '00000000-0000-4000-8000-0000000000e1', null, 'ALL') where code = 'DF'), 1000.00, 'consolidado não muda com o rateio');
select throws_ok($$ select fin.run_allocation_batch('00000000-0000-4000-8000-0000000000e1', date '2026-08-01') $$, 'P0091', null, 'não aplica o rateio duas vezes');

-- ---------- Fechamento ----------
select is((select count(*)::int from fin.closing_checklist('00000000-0000-4000-8000-0000000000e1', date '2026-08-01')), 12, 'checklist com 12 verificações (notas recebidas, recebimentos e reembolsos desde 23/10/2026)');
select lives_ok($$ select fin.create_title(jsonb_build_object('direction', 'PAYABLE', 'legal_entity_id', '00000000-0000-4000-8000-0000000000e1',
  'description', 'Fatura pendente de aprovação', 'competence_date', '2026-08-20', 'chart_account_id', (select id from fin.chart_accounts where code = '7.2.99'),
  'installments', jsonb_build_array(jsonb_build_object('due_date', '2026-09-20', 'amount', 80)))) $$, 'título de agosto em rascunho');
select throws_ok($$ select fin.close_month('00000000-0000-4000-8000-0000000000e1', date '2026-08-01') $$, 'P0092', null, 'rascunho de agosto bloqueia o fechamento');
select lives_ok($$ select fin.close_month('00000000-0000-4000-8000-0000000000e1', date '2026-08-01', true) $$, 'fechamento forçado por quem aprova');
select is((select status from fin.periods where legal_entity_id = '00000000-0000-4000-8000-0000000000e1' and competence = date '2026-08-01'), 'CLOSED', 'período de agosto fechado');
select throws_ok($$ select fin.post_manual_entry(jsonb_build_object('legal_entity_id', '00000000-0000-4000-8000-0000000000e1', 'entry_date', '2026-08-20',
  'description', 'Fora do prazo', 'lines', jsonb_build_array(
    jsonb_build_object('account_id', (select id from fin.chart_accounts where code = '7.2.99'), 'debit', 5),
    jsonb_build_object('account_id', (select id from fin.chart_accounts where code = '1.1.1.02'), 'credit', 5)))) $$, 'P0022', null, 'período fechado recusa lançamentos');
select throws_ok($$ select fin.reopen_month('00000000-0000-4000-8000-0000000000e1', date '2026-08-01', '') $$, 'P0092', null, 'reabrir exige motivo');
select lives_ok($$ select fin.reopen_month('00000000-0000-4000-8000-0000000000e1', date '2026-08-01', 'ajuste do contador') $$, 'reabre o período');
select is((select status from fin.allocation_batches where legal_entity_id = '00000000-0000-4000-8000-0000000000e1' and competence = date '2026-08-01'), 'REVERSED', 'reabertura estorna o rateio');

-- ---------- Permissões ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');   -- vendedora
select throws_ok($$ select fin.run_recurring() $$, '42501', null, 'vendedora não gera recorrências');
select throws_ok($$ select fin.close_month('00000000-0000-4000-8000-0000000000e1', date '2026-08-01', true) $$, '42501', null, 'vendedora não fecha o mês');

select * from finish();
rollback;
