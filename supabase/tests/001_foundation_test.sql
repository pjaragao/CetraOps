begin;
create extension if not exists pgtap with schema extensions;
select plan(24);

-- Helpers: simula um usuário logado (JWT com claims do hook)
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

-- ---------- Estrutura ----------
select has_table('core', 'orgs', 'core.orgs existe');
select has_table('inv', 'movements', 'livro-razão de estoque existe');
select has_function('sales', 'create_pos_order', array['jsonb'], 'RPC do PDV existe');
select is((select count(*)::int from fin.chart_accounts where code = '7.2.01' and name like 'Patrocínio%'), 1,
          'licença de espaço do parceiro classificada como patrocínio, não aluguel');
select is(fiscal.simples_effective_rate('I', 180000), 4.0000, 'Simples Anexo I faixa 1 = 4%');
select is(fiscal.simples_effective_rate('I', 500000), round(((500000 * 0.095) - 13860) / 500000 * 100, 4), 'Simples faixa 3 com dedução');

-- ---------- Identidade ----------
select is(private.normalize_phone('(48) 99999-0001'), '+5548999990001', 'telefone normalizado em E.164');
select is(
  crm.resolve_identity('00000000-0000-4000-8000-000000000001', 'WHATSAPP', '48 99999-0001'),
  '00000000-0000-4000-8000-000000000501'::uuid,
  'mesmo telefone em outro formato resolve para a mesma pessoa');

-- ---------- Estoque ----------
select throws_ok(
  $$ update inv.movements set qty = 99 where id = (select min(id) from inv.movements) $$,
  'P0001', null, 'movimentos de estoque são imutáveis');
select throws_ok(
  $$ insert into inv.movements (org_id, variant_id, location_id, qty, movement_type)
     select v.org_id, v.id, '00000000-0000-4000-8000-0000000000b1', -999, 'LOSS' from catalog.variants v where v.sku = 'DEMO-LEG01-PRT-M' $$,
  'P0002', null, 'estoque negativo é bloqueado');
select is(
  (select sl.on_hand from inv.stock_levels sl join catalog.variants v on v.id = sl.variant_id
   where v.sku = 'DEMO-LEG01-PRT-M' and sl.location_id = '00000000-0000-4000-8000-0000000000b1'),
  5.000, 'saldo = soma dos movimentos');

-- ---------- RLS: vendedora ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');
select is((select count(*)::int from fin.chart_accounts), 0, 'vendedora NÃO vê o plano de contas (fin)');
select ok((select count(*) from catalog.products) >= 3, 'vendedora vê o catálogo');
select ok((select count(*) from omni.conversations) >= 1, 'vendedora vê a inbox');
select throws_ok(
  $$ insert into inv.movements (org_id, variant_id, location_id, qty, movement_type)
     select org_id, id, '00000000-0000-4000-8000-0000000000b1', 10, 'COUNT_ADJUST' from catalog.variants limit 1 $$,
  '42501', null, 'vendedora não lança movimento de estoque direto (só via RPC)');

-- Venda no PDV: 1 legging M (R$ 429) + 1 camiseta masculina G (R$ 249) = 678; Pix 200 + crédito 3x D+1 478
select lives_ok($$
  select sales.create_pos_order(jsonb_build_object(
    'idempotency_key', 'test-sale-1',
    'store_id', '00000000-0000-4000-8000-0000000000a1',
    'party_id', '00000000-0000-4000-8000-000000000501',
    'items', jsonb_build_array(
      jsonb_build_object('variant_id', (select id from catalog.variants where sku = 'DEMO-LEG01-PRT-M'), 'qty', 1),
      jsonb_build_object('variant_id', (select id from catalog.variants where sku = 'DEMO-TEE01-PRT-G'), 'qty', 1)),
    'payments', jsonb_build_array(
      jsonb_build_object('method', 'PIX', 'amount', 200, 'acquirer', 'STONE'),
      jsonb_build_object('method', 'CREDIT', 'amount', 478, 'installments', 3, 'acquirer', 'STONE', 'anticipation_mode', 'D1'))))
$$, 'vendedora finaliza venda multi-pagamento no PDV');

select is((select status::text from sales.orders where idempotency_key = 'test-sale-1'), 'COMPLETED', 'pedido concluído');
select is((select total from sales.orders where idempotency_key = 'test-sale-1'), 678.00, 'total calculado no banco pelo preço vigente');

select throws_ok($$
  select sales.create_pos_order(jsonb_build_object(
    'idempotency_key', 'test-sale-desconto',
    'store_id', '00000000-0000-4000-8000-0000000000a1',
    'items', jsonb_build_array(jsonb_build_object('variant_id', (select id from catalog.variants where sku = 'DEMO-TOP01-PRT-P'), 'qty', 1, 'unit_price', 100)),
    'payments', jsonb_build_array(jsonb_build_object('method', 'PIX', 'amount', 100))))
$$, '42501', null, 'vendedora sem permissão não dá desconto');

reset role;
select set_config('request.jwt.claims', '', true);

-- ---------- Efeitos da venda (conferidos como admin) ----------
select is(
  (select sl.on_hand from inv.stock_levels sl join catalog.variants v on v.id = sl.variant_id
   where v.sku = 'DEMO-LEG01-PRT-M' and sl.location_id = '00000000-0000-4000-8000-0000000000b1'),
  4.000, 'estoque baixado por tamanho');
select is(
  (select count(*)::int from fin.title_installments i join fin.titles t on t.id = i.title_id
   join sales.orders o on o.id = t.origin_id where o.idempotency_key = 'test-sale-1'),
  4, 'recebíveis: 1 parcela Pix + 3 parcelas de crédito');
select is(
  (select sum(i.fee_expected) from fin.title_installments i join fin.titles t on t.id = i.title_id
   join sales.orders o on o.id = t.origin_id where o.idempotency_key = 'test-sale-1' and t.document_kind = 'CREDIT'),
  round(159.33 * 0.0471, 2) * 2 + round(159.34 * 0.0471, 2), 'taxa esperada usa a tabela real (3x D+1 = 4,71%)');
select is((select lifecycle_stage::text from crm.parties where id = '00000000-0000-4000-8000-000000000501'), 'CUSTOMER', 'lead virou cliente');
select ok((select count(*) from pgmq.q_fiscal_emission) >= 1, 'NFC-e enfileirada no outbox fiscal');

select * from finish();
rollback;
