begin;
create extension if not exists pgtap with schema extensions;
select plan(13);

create or replace function pg_temp.login(p_user uuid) returns void language plpgsql as $$
declare m record;
begin
  select id, org_id into m from core.members where user_id = p_user;
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated',
    'app_metadata', json_build_object('org_id', m.org_id, 'member_id', m.id))::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
grant execute on function pg_temp.login(uuid) to authenticated, anon;

-- ---------- Duas vendas no balcão, feitas há 5 dias (sem nota e sem a transação da maquininha) ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select sales.create_pos_order(jsonb_build_object('idempotency_key', 't-rep-1', 'store_id', '00000000-0000-4000-8000-0000000000a1', 'party_id', '00000000-0000-4000-8000-000000000501',
  'items', jsonb_build_array(jsonb_build_object('variant_id', (select id from catalog.variants where sku = 'DEMO-LEG01-PRT-M'), 'qty', 1), jsonb_build_object('variant_id', (select id from catalog.variants where sku = 'DEMO-TEE01-PRT-G'), 'qty', 1)),
  'payments', jsonb_build_array(jsonb_build_object('method', 'CREDIT', 'amount', 678, 'installments', 3, 'acquirer', 'STONE', 'anticipation_mode', 'D1'))));
select sales.create_pos_order(jsonb_build_object('idempotency_key', 't-rep-2', 'store_id', '00000000-0000-4000-8000-0000000000a1', 'party_id', '00000000-0000-4000-8000-000000000501',
  'items', jsonb_build_array(jsonb_build_object('variant_id', (select id from catalog.variants where sku = 'DEMO-TEE01-PRT-G'), 'qty', 1)),
  'payments', jsonb_build_array(jsonb_build_object('method', 'PIX', 'amount', 249, 'acquirer', 'STONE'))));
reset role;
update sales.orders set created_at = now() - interval '5 days' where idempotency_key in ('t-rep-1', 't-rep-2');
update sales.payments set created_at = now() - interval '5 days' where order_id in (select id from sales.orders where idempotency_key in ('t-rep-1', 't-rep-2'));
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');

-- ---------- Vendas por agrupamento ----------
select throws_ok($$ select sales.report_sales(private.today_sp() - 10, private.today_sp(), 'cor') $$, 'P0280', null, 'agrupamento inválido');
select throws_ok($$ select sales.report_sales(private.today_sp(), private.today_sp() - 1, 'channel') $$, 'P0280', null, 'período invertido');
select is((select (x ->> 'orders')::int from jsonb_array_elements(sales.report_sales(private.today_sp() - 10, private.today_sp(), 'channel')) x where x ->> 'label' = 'POS'), 2, 'por canal: 2 pedidos no balcão');
select is((select (x ->> 'revenue')::numeric from jsonb_array_elements(sales.report_sales(private.today_sp() - 10, private.today_sp(), 'channel')) x where x ->> 'label' = 'POS'), 927.00, 'receita do canal = soma dos pedidos pagos');
select is((select (x ->> 'avg_ticket')::numeric from jsonb_array_elements(sales.report_sales(private.today_sp() - 10, private.today_sp(), 'month')) x where x ->> 'label' = to_char(private.today_sp() - 5, 'YYYY-MM')), 463.50, 'ticket médio por mês');
select is(jsonb_array_length(sales.report_sales(private.today_sp() - 3, private.today_sp(), 'channel')), 0, 'período sem vendas: lista vazia (as de 5 dias atrás ficam de fora)');

-- ---------- Curva ABC ----------
select is((sales.report_abc(private.today_sp() - 10, private.today_sp(), 'product') -> 0 ->> 'revenue')::numeric, 498.00, 'o produto que mais vendeu em receita vem primeiro');
select is((sales.report_abc(private.today_sp() - 10, private.today_sp(), 'product') -> 0 ->> 'share_pct')::numeric, 53.7, 'com a participação na receita');
select is((sales.report_abc(private.today_sp() - 10, private.today_sp(), 'product') -> 1 ->> 'cumulative_pct')::numeric, 100.0, 'e o acumulado fecha em 100%');
select is((select count(*)::int from jsonb_array_elements(sales.report_abc(private.today_sp() - 10, private.today_sp(), 'size')) x where x ->> 'label' in ('M', 'G')), 2, 'por tamanho');
select throws_ok($$ select sales.report_abc(private.today_sp() - 10, private.today_sp(), 'cor') $$, 'P0280', null, 'agrupamento da curva inválido');

-- ---------- Cruzamento vendas × nota × maquininha ----------
select is((select count(*)::int from jsonb_array_elements(fin.report_cross_gaps(private.today_sp() - 10, private.today_sp())) x where x ->> 'kind' = 'VENDA_SEM_NOTA' and x ->> 'ref' in (select number from sales.orders where idempotency_key in ('t-rep-1', 't-rep-2'))), 2, 'as duas vendas aparecem como sem nota');
select is((select count(*)::int from jsonb_array_elements(fin.report_cross_gaps(private.today_sp() - 10, private.today_sp())) x where x ->> 'kind' = 'CARTAO_SEM_ADQUIRENTE' and (x ->> 'amount')::numeric = 678), 1, 'o cartão sem transação da maquininha aparece (o Pix não)');

select * from finish();
rollback;
