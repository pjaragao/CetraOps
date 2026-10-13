begin;
create extension if not exists pgtap with schema extensions;
select plan(44);

create or replace function pg_temp.login(p_user uuid) returns void language plpgsql as $$
declare m record;
begin
  select id, org_id into m from core.members where user_id = p_user;
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated',
    'app_metadata', json_build_object('org_id', m.org_id, 'member_id', m.id))::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
grant execute on function pg_temp.login(uuid) to authenticated, anon;
create temp table ids (k text primary key, v uuid);
grant all on ids to authenticated;
create or replace function pg_temp.v(p text) returns uuid language sql as $$ select v from ids where k = p $$;
grant execute on function pg_temp.v(text) to authenticated;

insert into ids values ('store', '00000000-0000-4000-8000-0000000000a1'), ('loc', '00000000-0000-4000-8000-0000000000b1'), ('prod', '00000000-0000-4000-8000-000000000401');
insert into ids select 'var', id from catalog.variants where product_id = pg_temp.v('prod') order by sku limit 1;
insert into ids select 'cli', id from crm.parties where kind = 'PERSON' and org_id = '00000000-0000-4000-8000-000000000001' order by created_at limit 1;
insert into ids select 'sup', p.id from crm.parties p join crm.party_roles r on r.party_id = p.id and r.role = 'SUPPLIER' where p.org_id = '00000000-0000-4000-8000-000000000001' order by p.created_at limit 1;
insert into ids select 'prod2', '00000000-0000-4000-8000-000000000402'::uuid union all select 'prod3', '00000000-0000-4000-8000-000000000403'::uuid;
insert into ids select 'var2', id from catalog.variants where product_id = pg_temp.v('prod2') order by sku limit 1;
insert into ids select 'var3', id from catalog.variants where product_id = pg_temp.v('prod3') order by sku limit 1;
delete from core.settings where key = 'backorders';
-- tira o estoque da peça (a encomenda é de peça que não está na loja)
update inv.stock_levels set on_hand = 0, reserved = 0 where variant_id = pg_temp.v('var');
-- a peça 2 tem 1 na loja (produto ainda não liberado); a peça 3 tem 5 (produto nunca liberado)
insert into inv.stock_levels (org_id, location_id, variant_id, on_hand) values
  ('00000000-0000-4000-8000-000000000001', pg_temp.v('loc'), pg_temp.v('var2'), 1), ('00000000-0000-4000-8000-000000000001', pg_temp.v('loc'), pg_temp.v('var3'), 5)
on conflict (location_id, variant_id) do update set on_hand = excluded.on_hand, reserved = 0;
insert into sales.coupons (org_id, code, kind, value) values ('00000000-0000-4000-8000-000000000001', 'ENC10', 'PERCENT', 10);

select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select throws_ok($$ select sales.create_backorder(jsonb_build_object('store_id', pg_temp.v('store'), 'party_id', pg_temp.v('cli'), 'items', jsonb_build_array(jsonb_build_object('variant_id', pg_temp.v('var'), 'qty', 1)))) $$,
  'P0352', null, 'produto não liberado para encomenda');
select is(catalog.set_backorder(jsonb_build_object('enabled', true, 'product_ids', jsonb_build_array(pg_temp.v('prod')))), 1, 'libera o produto para encomenda');
select throws_ok($$ select sales.create_backorder(jsonb_build_object('store_id', pg_temp.v('store'), 'party_id', pg_temp.v('cli'), 'items', jsonb_build_array(jsonb_build_object('variant_id', pg_temp.v('var'), 'qty', 1)))) $$,
  'P0351', null, 'sem fornecedor definido, avisa');
select lives_ok($$ select sales.set_backorder_supplier(pg_temp.v('sup')) $$, 'define o fornecedor das encomendas');

insert into ids select 'o1', (sales.create_backorder(jsonb_build_object('store_id', pg_temp.v('store'), 'party_id', pg_temp.v('cli'),
  'items', jsonb_build_array(jsonb_build_object('variant_id', pg_temp.v('var'), 'qty', 2))))).id;
select is((select status::text from sales.orders where id = pg_temp.v('o1')), 'PENDING_PAYMENT', 'encomenda nasce aguardando pagamento');
insert into ids select 'po', po_id from sales.backorder_items where order_id = pg_temp.v('o1');
select is((select status from purch.purchase_orders where id = pg_temp.v('po')), 'DRAFT', 'gera pedido de compra em rascunho');
select is((select qty_ordered::int from purch.po_items where po_id = pg_temp.v('po') and variant_id = pg_temp.v('var')), 2, 'com a peça encomendada');
select is((select unit_cost from purch.po_items where po_id = pg_temp.v('po') and variant_id = pg_temp.v('var')), coalesce((select coalesce(last_cost, nullif(avg_cost, 0)) from inv.item_costs where variant_id = pg_temp.v('var') limit 1), catalog.current_price(pg_temp.v('var'))), 'custo: último custo, senão preço de catálogo');
select ok((select notes from purch.purchase_orders where id = pg_temp.v('po')) like '%Encomenda VEN-%', 'e a observação de qual venda pediu');
select is((select count(*)::int from crm.tasks where source_rule = 'po_close:' || pg_temp.v('po') and status = 'OPEN'), 1, 'tarefa de fechar o pedido de compra');

insert into ids select 'o2', (sales.create_backorder(jsonb_build_object('store_id', pg_temp.v('store'), 'party_id', pg_temp.v('cli'),
  'items', jsonb_build_array(jsonb_build_object('variant_id', pg_temp.v('var'), 'qty', 1))))).id;
select is((select po_id from sales.backorder_items where order_id = pg_temp.v('o2')), pg_temp.v('po'), 'segunda encomenda complementa o mesmo pedido de compra');
select is((select qty_ordered::int from purch.po_items where po_id = pg_temp.v('po') and variant_id = pg_temp.v('var')), 3, 'somando a quantidade');
select is((select count(*)::int from crm.tasks where source_rule = 'po_close:' || pg_temp.v('po')), 1, 'sem repetir a tarefa');

-- carrinho misto no PDV: peça com estoque fica reservada, só o que falta vai ao pedido de compra
select throws_ok($$ select sales.create_backorder(jsonb_build_object('store_id', pg_temp.v('store'), 'party_id', pg_temp.v('cli'), 'items', jsonb_build_array(jsonb_build_object('variant_id', pg_temp.v('var2'), 'qty', 2)))) $$,
  'P0352', null, 'produto não liberado: sem a quantidade inteira em estoque não entra');
select throws_ok($$ select sales.create_backorder(jsonb_build_object('store_id', pg_temp.v('store'), 'party_id', pg_temp.v('cli'), 'items', jsonb_build_array(jsonb_build_object('variant_id', pg_temp.v('var3'), 'qty', 6)))) $$,
  'P0352', null, 'produto nunca liberado: pedir mais que o estoque não entra');
select is(catalog.set_backorder(jsonb_build_object('enabled', true, 'product_ids', jsonb_build_array(pg_temp.v('prod2')))), 1, 'libera a segunda peça');
insert into ids select 'o3', (sales.create_backorder(jsonb_build_object('store_id', pg_temp.v('store'), 'party_id', pg_temp.v('cli'),
  'items', jsonb_build_array(jsonb_build_object('variant_id', pg_temp.v('var2'), 'qty', 3, 'discount_amount', 6),
                             jsonb_build_object('variant_id', pg_temp.v('var3'), 'qty', 1),
                             jsonb_build_object('description', 'Ajuste de barra', 'unit_price', 30, 'qty', 1))))).id;
select is((select count(*)::int from sales.order_items where order_id = pg_temp.v('o3') and variant_id = pg_temp.v('var2')), 2, 'linha maior que o estoque divide em reservada + encomendada');
select is((select sum(qty)::int from sales.order_items where order_id = pg_temp.v('o3') and variant_id = pg_temp.v('var2') and reservation_id is not null), 1, 'a parte em estoque fica reservada');
select is((select qty::int from sales.backorder_items where order_id = pg_temp.v('o3') and variant_id = pg_temp.v('var2')), 2, 'só o que falta é encomendado');
select is((select qty_ordered::int from purch.po_items where po_id = pg_temp.v('po') and variant_id = pg_temp.v('var2')), 2, 'e vai ao pedido de compra');
select is((select count(*)::int from sales.backorder_items where order_id = pg_temp.v('o3')), 1, 'peça com estoque suficiente não é encomendada');
select is((select discount_total from sales.orders where id = pg_temp.v('o3')), 6.00::numeric, 'desconto da linha (6,00) entra inteiro, dividido entre as partes');
select is((select total from sales.orders where id = pg_temp.v('o3')),
  (catalog.current_price(pg_temp.v('var2')) * 3 + catalog.current_price(pg_temp.v('var3')) + 30 - 6)::numeric(14,2), 'total: peças + avulso - desconto');
select is((select count(*)::int from sales.order_items where order_id = pg_temp.v('o3') and variant_id is null and description = 'Ajuste de barra'), 1, 'item avulso entra na encomenda');
select is((select count(*)::int from sales.order_credits where order_id = pg_temp.v('o3')), 1, 'grava o crédito do vendedor (comissão)');

insert into ids select 'o4', (sales.create_backorder(jsonb_build_object('store_id', pg_temp.v('store'), 'party_id', pg_temp.v('cli'), 'coupon_code', 'enc10',
  'items', jsonb_build_array(jsonb_build_object('variant_id', pg_temp.v('var2'), 'qty', 1))))).id;
select is((select discount_total from sales.orders where id = pg_temp.v('o4')), round(catalog.current_price(pg_temp.v('var2')) * 0.10, 2), 'cupom de 10% sobre a encomenda');
select throws_ok($$ select sales.create_backorder(jsonb_build_object('store_id', pg_temp.v('store'), 'party_id', pg_temp.v('cli'), 'coupon_code', 'NAOEXISTE',
  'items', jsonb_build_array(jsonb_build_object('variant_id', pg_temp.v('var2'), 'qty', 1)))) $$, 'P0008', null, 'cupom inexistente não passa');
select throws_ok($$ select sales.create_backorder(jsonb_build_object('store_id', pg_temp.v('store'), 'party_id', pg_temp.v('cli'),
  'items', jsonb_build_array(jsonb_build_object('variant_id', pg_temp.v('var2'), 'qty', 1, 'discount_amount', 100000)))) $$, 'P0008', null, 'desconto maior que a peça não passa');

insert into ids select 'o5', (sales.create_backorder(jsonb_build_object('store_id', pg_temp.v('store'), 'party_id', pg_temp.v('cli'),
  'items', jsonb_build_array(jsonb_build_object('variant_id', pg_temp.v('var3'), 'qty', 2))))).id;
select is((select count(*)::int from sales.backorder_items where order_id = pg_temp.v('o5')), 0, 'tudo em estoque: nada vai ao pedido de compra');
insert into ids select 'o6', (sales.create_backorder(jsonb_build_object('store_id', pg_temp.v('store'), 'party_id', pg_temp.v('cli'), 'idempotency_key', 'pdv-teste-1',
  'items', jsonb_build_array(jsonb_build_object('variant_id', pg_temp.v('var3'), 'qty', 1))))).id;
select is((sales.create_backorder(jsonb_build_object('store_id', pg_temp.v('store'), 'party_id', pg_temp.v('cli'), 'idempotency_key', 'pdv-teste-1',
  'items', jsonb_build_array(jsonb_build_object('variant_id', pg_temp.v('var3'), 'qty', 1))))).id, pg_temp.v('o6'), 'mesma chave devolve a encomenda já criada (sem duplicar)');
select ok((select expires_at is not null from inv.reservations where order_id = pg_temp.v('o5') and status = 'ACTIVE' limit 1), 'tudo em estoque: reserva com prazo (24 h)');

-- pagamento: sinal sim, total não
select lives_ok($$ select sales.register_payment(jsonb_build_object('order_id', pg_temp.v('o1'), 'method', 'PIX', 'amount', 10)) $$, 'aceita sinal');
select throws_ok($$ select sales.register_payment(jsonb_build_object('order_id', pg_temp.v('o1'), 'method', 'PIX', 'amount', (select total - paid_total from sales.orders where id = pg_temp.v('o1')))) $$,
  'P0352', null, 'não aceita o total antes de chegar');
reset role;
select is(sales.expire_pending_orders() >= 0 and (select status::text from sales.orders where id = pg_temp.v('o2')) = 'PENDING_PAYMENT', true, 'a rotina de pedidos sem pagamento não cancela encomenda');

-- cancelar a segunda tira do pedido de compra
update sales.orders set status = 'CANCELLED' where id = pg_temp.v('o2');
select is((select qty_ordered::int from purch.po_items where po_id = pg_temp.v('po') and variant_id = pg_temp.v('var')), 2, 'cancelada a encomenda, sai do pedido de compra');

-- fechar o pedido de compra conclui a tarefa
update purch.purchase_orders set status = 'APPROVED' where id = pg_temp.v('po');
select is((select status from crm.tasks where source_rule = 'po_close:' || pg_temp.v('po')), 'DONE', 'aprovar o pedido de compra conclui a tarefa');

-- chegada
insert into inv.movements (org_id, variant_id, location_id, qty, unit_cost, movement_type)
values ('00000000-0000-4000-8000-000000000001', pg_temp.v('var'), pg_temp.v('loc'), 2, 50, 'PURCHASE_RECEIPT');
select is((select status from sales.backorder_items where order_id = pg_temp.v('o1')), 'ARRIVED', 'peça chegou e foi separada para a encomenda');
select is((select reserved::int from inv.stock_levels where location_id = pg_temp.v('loc') and variant_id = pg_temp.v('var')), 2, 'reservada no nome da cliente');
select ok(exists (select 1 from crm.tasks where source_rule = 'backorder:' || pg_temp.v('o1')), 'tarefa de avisar a cliente');

-- encomenda mista: chega o que faltava, a cliente paga o total e as duas partes (reservada e encomendada) saem do estoque
insert into inv.movements (org_id, variant_id, location_id, qty, unit_cost, movement_type)
values ('00000000-0000-4000-8000-000000000001', pg_temp.v('var2'), pg_temp.v('loc'), 2, 40, 'PURCHASE_RECEIPT');
select is((select count(*)::int from sales.backorder_items where order_id = pg_temp.v('o3') and status = 'ARRIVED'), 1, 'chegou a parte encomendada da encomenda mista');
select is((select count(*)::int from sales.order_items where order_id = pg_temp.v('o3') and variant_id is not null and reservation_id is null), 0, 'todas as peças da encomenda mista têm reserva');
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select lives_ok($$ select sales.register_payment(jsonb_build_object('order_id', pg_temp.v('o3'), 'method', 'PIX', 'amount', (select total - paid_total from sales.orders where id = pg_temp.v('o3')))) $$, 'paga o total da encomenda mista');
reset role;
select isnt((select status::text from sales.orders where id = pg_temp.v('o3')), 'PENDING_PAYMENT', 'encomenda mista concluída');
select is((select (on_hand::int, reserved::int)::text from inv.stock_levels where location_id = pg_temp.v('loc') and variant_id = pg_temp.v('var2')), '(0,0)', 'estoque da peça zerado e sem reserva sobrando');

select * from finish();
rollback;
