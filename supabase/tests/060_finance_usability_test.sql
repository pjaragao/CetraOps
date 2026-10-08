begin;
create extension if not exists pgtap with schema extensions;
select plan(16);

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

-- ---------- Título: editar rascunho e aprovado ----------
insert into ids select 't1', (fin.create_title(jsonb_build_object('direction', 'PAYABLE', 'legal_entity_id', '00000000-0000-4000-8000-0000000000e1', 'description', 'Conserto (teste edição)',
  'chart_account_id', (select id from fin.chart_accounts where code = '7.2.99'), 'competence_date', private.today_sp(),
  'installments', jsonb_build_array(jsonb_build_object('due_date', private.today_sp() + 10, 'amount', 300))))).id;
select ok((select search like '%conserto%' from fin.v_installments where title_id = (select v from ids where k = 't1')), 'parcelas aparecem na lista com texto de busca');
select lives_ok($$ select fin.update_title(jsonb_build_object('id', (select v from ids where k = 't1'), 'description', 'Conserto da vitrine',
  'installments', jsonb_build_array(jsonb_build_object('due_date', private.today_sp() + 10, 'amount', 200), jsonb_build_object('due_date', private.today_sp() + 40, 'amount', 200)))) $$, 'edita o rascunho: descrição e parcelas');
select is((select total_amount from fin.titles where id = (select v from ids where k = 't1')), 400.00, 'total acompanha as parcelas');
select is((select sum(amount) from fin.title_lines where title_id = (select v from ids where k = 't1')), 400.00, 'classificação refeita com o total novo');
select fin.approve_title((select v from ids where k = 't1'));
select lives_ok($$ select fin.update_title(jsonb_build_object('id', (select v from ids where k = 't1'), 'chart_account_id', (select id from fin.chart_accounts where code = '7.2.05'))) $$, 'reclassifica o título aprovado');
select ok((select a.code = '7.2.05' from fin.titles t join fin.journal_lines l on l.entry_id = t.accrual_entry_id join fin.chart_accounts a on a.id = l.account_id
           where t.id = (select v from ids where k = 't1') and l.debit > 0 limit 1), 'a competência é lançada de novo na conta nova');

-- ---------- Empréstimo ----------
insert into ids select 'loan', (fin.create_loan(jsonb_build_object('bank_account_id', '00000000-0000-4000-8000-000000000701', 'description', 'Capital de giro (teste)',
  'principal', 10000, 'installments', 12, 'monthly_rate_pct', 2, 'first_due', private.today_sp() + 30, 'received_on', private.today_sp()))).id;
select is((select count(*)::int from fin.titles where origin_type = 'LOAN' and origin_id = (select v from ids where k = 'loan')), 12, 'uma conta a pagar por parcela');
select ok((select abs(sum(l.amount) - 10000) < 0.05 from fin.title_lines l join fin.titles t on t.id = l.title_id join fin.chart_accounts a on a.id = l.chart_account_id
           where t.origin_id = (select v from ids where k = 'loan') and a.code = '2.1.7.01'), 'as amortizações somam o valor emprestado');
select is((select amount from fin.cash_transactions where id = (select cash_transaction_id from fin.loans where id = (select v from ids where k = 'loan'))), 10000.00, 'o dinheiro entra na conta');
select is((select installment_amount from fin.loans where id = (select v from ids where k = 'loan')), 945.60, 'parcela pela tabela Price (10 mil, 12x, 2% a.m.)');

-- ---------- Conta bancária e loja ----------
select lives_ok($$ select fin.update_bank_account(jsonb_build_object('id', '00000000-0000-4000-8000-000000000702', 'name', 'BTG (renomeado)', 'agency', '0051', 'pix_keys', jsonb_build_array('pix@teste.com'))) $$, 'edita dados da conta bancária');
select throws_ok($$ select fin.update_bank_account(jsonb_build_object('id', '00000000-0000-4000-8000-000000000701', 'name', 'Inter', 'chart_account_id', (select id from fin.chart_accounts where code = '1.1.1.03'))) $$,
  'P0502', null, 'conta com movimento não troca a conta do plano');
select lives_ok($$ select core.update_store(jsonb_build_object('id', '00000000-0000-4000-8000-0000000000a1', 'name', 'Boutique Piloto (renomeada)', 'format', 'SHOP_IN_SHOP', 'status', 'ACTIVE')) $$, 'edita a loja');

-- ---------- Tarefa: editar e atribuir ----------
insert into ids select 'task', (crm.save_task(jsonb_build_object('title', 'Ligar para fornecedor (teste)'))).id;
select lives_ok($$ select crm.update_task(jsonb_build_object('id', (select v from ids where k = 'task'), 'title', 'Ligar para o fornecedor de tecido', 'assignee_member_id', '00000000-0000-4000-8000-000000000102')) $$, 'edita e atribui a tarefa');
select is((select assignee_member_id from crm.tasks where id = (select v from ids where k = 'task')), '00000000-0000-4000-8000-000000000102'::uuid, 'responsável trocado');

-- ---------- Lista de pessoas sem ids na URL ----------
select ok((select count(*) > 0 from crm.v_people_list where not is_internal), 'lista de clientes filtra por coluna (sem listas de ids)');

select * from finish();
rollback;
