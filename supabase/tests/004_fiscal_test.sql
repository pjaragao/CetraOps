begin;
create extension if not exists pgtap with schema extensions;
select plan(11);

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

select pg_temp.login('00000000-0000-4000-8000-0000000000f1');   -- sócio

select lives_ok($$ select sales.create_pos_order(jsonb_build_object(
  'idempotency_key', 't-das-1', 'store_id', '00000000-0000-4000-8000-0000000000a1',
  'items', jsonb_build_array(
    jsonb_build_object('variant_id', (select id from catalog.variants where sku = 'DEMO-LEG01-PRT-M'), 'qty', 1),
    jsonb_build_object('variant_id', (select id from catalog.variants where sku = 'DEMO-TEE01-PRT-G'), 'qty', 1)),
  'payments', jsonb_build_array(jsonb_build_object('method', 'PIX', 'amount', 200, 'acquirer', 'STONE'),
                                jsonb_build_object('method', 'CREDIT', 'amount', 478, 'installments', 3, 'acquirer', 'STONE', 'anticipation_mode', 'D1')))) $$,
  'venda de R$ 678 no mês');

select is((select revenue_annex1 from fiscal.simples_calc('00000000-0000-4000-8000-0000000000e1', private.today_sp())), 678.00, 'receita do mês vem do razão contábil (Anexo I)');
select is((select rbt12 from fiscal.simples_calc('00000000-0000-4000-8000-0000000000e1', private.today_sp())), 8136.00, 'início de atividade: RBT12 = receita do mês × 12');
select is((select rate1 from fiscal.simples_calc('00000000-0000-4000-8000-0000000000e1', private.today_sp())), 4.0000, 'faixa 1 do Anexo I = 4%');
select is((select das from fiscal.simples_calc('00000000-0000-4000-8000-0000000000e1', private.today_sp())), 27.12, 'DAS estimado = 678 × 4%');

select lives_ok($$ select fiscal.post_das('00000000-0000-4000-8000-0000000000e1', private.today_sp()) $$, 'gera a guia do DAS');
select is((select t.total_amount from fin.titles t join fiscal.tax_periods tp on tp.title_id = t.id where tp.competence = date_trunc('month', private.today_sp())::date), 27.12, 'guia vira conta a pagar');
select is((select count(*)::int from fiscal.obligations where kind = 'DAS' and competence = date_trunc('month', private.today_sp())::date), 1, 'DAS no calendário de obrigações');
select is((select sum(l.debit) from fin.journal_lines l join fin.chart_accounts a on a.id = l.account_id
           join fin.titles t on t.accrual_entry_id = l.entry_id join fiscal.tax_periods tp on tp.title_id = t.id where a.code = '5.1.01'), 27.12,
          'competência contabilizada em deduções da receita (5.1.01)');
select throws_ok($$ select fiscal.post_das('00000000-0000-4000-8000-0000000000e1', private.today_sp()) $$, 'P0070', null, 'não duplica a guia do mês');

select pg_temp.login('00000000-0000-4000-8000-0000000000f2');   -- vendedora
select throws_ok($$ select fiscal.post_das('00000000-0000-4000-8000-0000000000e1', private.today_sp()) $$, '42501', null, 'vendedora não gera guia');

select * from finish();
rollback;
