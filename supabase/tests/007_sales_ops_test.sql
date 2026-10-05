begin;
create extension if not exists pgtap with schema extensions;
select plan(57);

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

update sales.cash_sessions set status = 'CLOSED', closed_at = now() where status = 'OPEN';   -- (caixa aberto na base de desenvolvimento não pode atrapalhar o teste)
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');   -- sócio

-- cliente e caixa
insert into ids select 'cli', crm.quick_customer('48999990001', 'Cliente Troca (teste)', false);
insert into ids select 'cli2', crm.quick_customer('48999990002', 'Cliente Remoto (teste)', false);
insert into ids select 'cash', (sales.open_cash_session('00000000-0000-4000-8000-0000000000d1', 200)).id;

-- ---------- Devolução para vale-troca ----------
select lives_ok($$ insert into ids select 'oA', (sales.create_pos_order(jsonb_build_object('idempotency_key', 't-ret-A', 'store_id', '00000000-0000-4000-8000-0000000000a1',
  'party_id', (select v from ids where k = 'cli'), 'items', jsonb_build_array(
    jsonb_build_object('variant_id', (select id from catalog.variants where sku = 'DEMO-LEG01-PRT-M'), 'qty', 2),
    jsonb_build_object('variant_id', (select id from catalog.variants where sku = 'DEMO-TEE01-PRT-G'), 'qty', 1)),
  'payments', jsonb_build_array(jsonb_build_object('method', 'PIX', 'amount', 1107, 'acquirer', 'STONE'))))).id $$, 'venda de R$ 1.107 (2 leggings + 1 camiseta)');
select lives_ok($$ insert into ids select 'rA1', (sales.create_return(jsonb_build_object('order_id', (select v from ids where k = 'oA'), 'type', 'STORE_CREDIT', 'reason', 'SIZE',
  'items', jsonb_build_array(jsonb_build_object('order_item_id', (select id from sales.order_items where order_id = (select v from ids where k = 'oA') and variant_id = (select id from catalog.variants where sku = 'DEMO-LEG01-PRT-M')), 'qty', 1))))).id $$,
  'devolve 1 legging para vale-troca');
select is(sales.store_credit_balance((select v from ids where k = 'cli')), 429.00, 'vale-troca de R$ 429');
select is((select status::text from sales.orders where id = (select v from ids where k = 'oA')), 'PARTIALLY_RETURNED', 'pedido parcialmente devolvido');
select is((select on_hand from inv.stock_levels sl join catalog.variants v on v.id = sl.variant_id where v.sku = 'DEMO-LEG01-PRT-M' and sl.location_id = '00000000-0000-4000-8000-0000000000b1'), 4.000, 'estoque: 5 − 2 vendidas + 1 devolvida');
select is((select sum(l.debit) from fin.journal_lines l join fin.journal_entries e on e.id = l.entry_id where e.source_id = (select v from ids where k = 'rA1') and e.kind = 'SALE_RETURN'
           and l.account_id = (select id from fin.chart_accounts where code = '5.1.02')), 429.00, 'razão: devolução debita a dedução da receita');
select is((select sum(l.credit) from fin.journal_lines l join fin.journal_entries e on e.id = l.entry_id where e.source_id = (select v from ids where k = 'rA1') and e.kind = 'SALE_RETURN'
           and l.account_id = (select id from fin.chart_accounts where code = '2.1.5.01')), 429.00, 'razão: vale-troca é passivo');
select is((select cogs_amount from sales.returns where id = (select v from ids where k = 'rA1')), 178.75, 'CMV estornado pelo custo da venda');
select throws_ok($$ select sales.create_return(jsonb_build_object('order_id', (select v from ids where k = 'oA'), 'type', 'RETURN_REFUND', 'reason', 'OTHER',
  'items', jsonb_build_array(jsonb_build_object('order_item_id', (select id from sales.order_items where order_id = (select v from ids where k = 'oA') and variant_id = (select id from catalog.variants where sku = 'DEMO-LEG01-PRT-M')), 'qty', 5)))) $$,
  'P0093', null, 'não devolve mais do que foi vendido');

-- ---------- Devolução em dinheiro (fecha o pedido) ----------
select lives_ok($$ insert into ids select 'rA2', (sales.create_return(jsonb_build_object('order_id', (select v from ids where k = 'oA'), 'type', 'RETURN_REFUND', 'reason', 'REGRET_7D',
  'refund_method', 'CASH', 'cash_session_id', (select v from ids where k = 'cash'), 'items', jsonb_build_array(
    jsonb_build_object('order_item_id', (select id from sales.order_items where order_id = (select v from ids where k = 'oA') and variant_id = (select id from catalog.variants where sku = 'DEMO-LEG01-PRT-M')), 'qty', 1),
    jsonb_build_object('order_item_id', (select id from sales.order_items where order_id = (select v from ids where k = 'oA') and variant_id = (select id from catalog.variants where sku = 'DEMO-TEE01-PRT-G')), 'qty', 1))))).id $$,
  'devolve o restante em dinheiro');
select is((select status::text from sales.orders where id = (select v from ids where k = 'oA')), 'RETURNED', 'pedido totalmente devolvido');
select is((select amount from sales.cash_session_movements where session_id = (select v from ids where k = 'cash') and type = 'REFUND_CASH'), -678.00, 'gaveta: saída de R$ 678 (429 + 249)');
select throws_ok($$ select sales.create_return(jsonb_build_object('order_id', (select v from ids where k = 'oA'), 'type', 'STORE_CREDIT', 'reason', 'OTHER',
  'items', jsonb_build_array(jsonb_build_object('order_item_id', (select id from sales.order_items where order_id = (select v from ids where k = 'oA') limit 1), 'qty', 1)))) $$,
  'P0093', null, 'pedido totalmente devolvido não aceita nova devolução');

-- ---------- Devolução por Pix vira conta a pagar ----------
select lives_ok($$ insert into ids select 'oB', (sales.create_pos_order(jsonb_build_object('idempotency_key', 't-ret-B', 'store_id', '00000000-0000-4000-8000-0000000000a1',
  'party_id', (select v from ids where k = 'cli'), 'items', jsonb_build_array(jsonb_build_object('variant_id', (select id from catalog.variants where sku = 'DEMO-TEE01-PRT-G'), 'qty', 1)),
  'payments', jsonb_build_array(jsonb_build_object('method', 'PIX', 'amount', 249, 'acquirer', 'STONE'))))).id $$, 'venda Pix de R$ 249');
select lives_ok($$ insert into ids select 'rB', (sales.create_return(jsonb_build_object('order_id', (select v from ids where k = 'oB'), 'type', 'RETURN_REFUND', 'reason', 'DEFECT',
  'items', jsonb_build_array(jsonb_build_object('order_item_id', (select id from sales.order_items where order_id = (select v from ids where k = 'oB')), 'qty', 1))))).id $$, 'devolução padrão (Pix)');
select is((select total_amount from fin.titles where origin_type = 'RETURN' and origin_id = (select v from ids where k = 'rB')), 249.00, 'título a pagar de R$ 249 ao cliente');
select is((select control_account_id from fin.titles where origin_type = 'RETURN' and origin_id = (select v from ids where k = 'rB')), (select id from fin.chart_accounts where code = '2.1.6.01'), 'controle: adiantamentos/devoluções a clientes');

-- ---------- Estorno no cartão reduz o recebível da adquirente ----------
select lives_ok($$ insert into ids select 'oC', (sales.create_pos_order(jsonb_build_object('idempotency_key', 't-ret-C', 'store_id', '00000000-0000-4000-8000-0000000000a1',
  'party_id', (select v from ids where k = 'cli'), 'items', jsonb_build_array(jsonb_build_object('variant_id', (select id from catalog.variants where sku = 'DEMO-LEG01-OFW-M'), 'qty', 1)),
  'payments', jsonb_build_array(jsonb_build_object('method', 'CREDIT', 'amount', 429, 'installments', 3, 'acquirer', 'STONE', 'anticipation_mode', 'NATURAL'))))).id $$, 'venda no crédito em 3x');
select lives_ok($$ select sales.create_return(jsonb_build_object('order_id', (select v from ids where k = 'oC'), 'type', 'RETURN_REFUND', 'reason', 'OTHER', 'refund_method', 'CARD',
  'items', jsonb_build_array(jsonb_build_object('order_item_id', (select id from sales.order_items where order_id = (select v from ids where k = 'oC')), 'qty', 1)))) $$, 'estorno no cartão');
select is((select coalesce(sum(i.amount), 0) from fin.title_installments i join fin.titles t on t.id = i.title_id where t.origin_type = 'ORDER' and t.origin_id = (select v from ids where k = 'oC') and i.status <> 'CANCELLED'), 0.00, 'as 3 parcelas a receber da adquirente foram canceladas');
select is((select count(*)::int from fin.titles where origin_type = 'RETURN' and origin_id = (select id from sales.returns where order_id = (select v from ids where k = 'oC'))), 0, 'nada a pagar ao cliente: a adquirente devolve no cartão');

-- ---------- Cupom: limites ----------
insert into sales.coupons (org_id, code, kind, value, max_uses, per_customer_limit) values ('00000000-0000-4000-8000-000000000001', 'UMA-VEZ', 'PERCENT', 10, 1, 1);
select is((sales.validate_coupon('uma-vez', 1000, null))->>'discount', '100.00', 'prévia do cupom: 10% de R$ 1.000');
select lives_ok($$ select sales.create_pos_order(jsonb_build_object('idempotency_key', 't-cup-1', 'store_id', '00000000-0000-4000-8000-0000000000a1', 'coupon_code', 'UMA-VEZ',
  'party_id', (select v from ids where k = 'cli'), 'items', jsonb_build_array(jsonb_build_object('variant_id', (select id from catalog.variants where sku = 'DEMO-TEE01-PRT-M'), 'qty', 1)),
  'payments', jsonb_build_array(jsonb_build_object('method', 'PIX', 'amount', 224.10, 'acquirer', 'STONE')))) $$, 'usa o cupom uma vez (R$ 249 − 10%)');
select throws_ok($$ select sales.create_pos_order(jsonb_build_object('idempotency_key', 't-cup-2', 'store_id', '00000000-0000-4000-8000-0000000000a1', 'coupon_code', 'UMA-VEZ',
  'party_id', (select v from ids where k = 'cli2'), 'items', jsonb_build_array(jsonb_build_object('variant_id', (select id from catalog.variants where sku = 'DEMO-TEE01-PRT-P'), 'qty', 1)),
  'payments', jsonb_build_array(jsonb_build_object('method', 'PIX', 'amount', 224.10, 'acquirer', 'STONE')))) $$, 'P0008', null, 'cupom esgotado');
select is((sales.validate_coupon('UMA-VEZ', 1000, null))->>'valid', 'false', 'prévia também recusa o cupom esgotado');
-- devolução de pedido com cupom devolve o valor líquido
select lives_ok($$ insert into ids select 'rCup', (sales.create_return(jsonb_build_object('order_id', (select o.id from sales.orders o where o.idempotency_key = 't-cup-1'), 'type', 'RETURN_REFUND', 'reason', 'OTHER',
  'items', jsonb_build_array(jsonb_build_object('order_item_id', (select i.id from sales.order_items i join sales.orders o on o.id = i.order_id where o.idempotency_key = 't-cup-1'), 'qty', 1))))).id $$, 'devolve o item comprado com cupom');
select is((select amount from sales.returns where id = (select v from ids where k = 'rCup')), 224.10, 'devolução com cupom = valor efetivamente pago');

-- ---------- Pedido remoto ----------
select lives_ok($$ insert into ids select 'oR', (sales.create_remote_order(jsonb_build_object('idempotency_key', 't-rem-1', 'store_id', '00000000-0000-4000-8000-0000000000a1', 'channel', 'WHATSAPP',
  'party_id', (select v from ids where k = 'cli2'), 'shipping_total', 20, 'fulfillment_type', 'MOTOBOY', 'assisted_by_ai', true,
  'items', jsonb_build_array(jsonb_build_object('variant_id', (select id from catalog.variants where sku = 'DEMO-LEG01-PRT-G'), 'qty', 1),
                             jsonb_build_object('variant_id', (select id from catalog.variants where sku = 'DEMO-TEE01-OFW-G'), 'qty', 1))))).id $$, 'cria pedido remoto (WhatsApp)');
select is((select total from sales.orders where id = (select v from ids where k = 'oR')), 698.00, 'total calculado no banco: 429 + 249 + frete 20');
select is((select status::text from sales.orders where id = (select v from ids where k = 'oR')), 'PENDING_PAYMENT', 'aguardando pagamento');
select is((select reserved from inv.stock_levels sl join catalog.variants v on v.id = sl.variant_id where v.sku = 'DEMO-LEG01-PRT-G' and sl.location_id = '00000000-0000-4000-8000-0000000000b1'), 1.000, 'estoque reservado enquanto aguarda pagamento');
select is((select role from sales.order_credits where order_id = (select v from ids where k = 'oR')), 'AI', 'crédito da venda para a IA (sem humano atribuído)');
select is((select cc.code from sales.orders o join core.cost_centers cc on cc.id = o.profit_cost_center_id where o.id = (select v from ids where k = 'oR')), 'PILOTO-DIGITAL', 'resultado no centro DIGITAL da loja');
select lives_ok($$ insert into ids select 'lnk', (sales.create_payment_link((select v from ids where k = 'oR'), 3)).id $$, 'gera o link de pagamento');
select lives_ok($$ select sales.register_payment(jsonb_build_object('order_id', (select v from ids where k = 'oR'), 'method', 'PIX', 'amount', 300, 'acquirer', 'STONE', 'external_id', 'pix-1')) $$, 'Pix parcial de R$ 300');
select lives_ok($$ select sales.register_payment(jsonb_build_object('order_id', (select v from ids where k = 'oR'), 'method', 'PIX', 'amount', 300, 'acquirer', 'STONE', 'external_id', 'pix-1')) $$, 'mesmo evento repetido é ignorado (idempotente)');
select is((select paid_total from sales.orders where id = (select v from ids where k = 'oR')), 300.00, 'pago R$ 300 (não duplicou)');
select throws_ok($$ select sales.register_payment(jsonb_build_object('order_id', (select v from ids where k = 'oR'), 'method', 'PIX', 'amount', 500, 'acquirer', 'STONE', 'external_id', 'pix-x')) $$, 'P0005', null, 'pagamento acima do saldo é recusado');
select is((sales.register_payment(jsonb_build_object('order_id', (select v from ids where k = 'oR'), 'method', 'CREDIT', 'amount', 398, 'installments', 2, 'acquirer', 'STONE', 'external_id', 'card-1'))).status::text, 'PAID', 'pagamento completo finaliza o pedido');
select is((select status from sales.payment_links where id = (select v from ids where k = 'lnk')), 'PAID', 'link marcado como pago');
select is((select status from inv.reservations where order_id = (select v from ids where k = 'oR') limit 1), 'CONSUMED', 'reservas consumidas na finalização');
select is((select count(*)::int from fin.journal_entries where source_id = (select v from ids where k = 'oR') and kind = 'SALE'), 1, 'venda contabilizada no razão');
select lives_ok($$ select sales.save_shipment(jsonb_build_object('order_id', (select v from ids where k = 'oR'), 'carrier', 'MOTOBOY_OWN', 'status', 'IN_TRANSIT', 'cost', 15, 'charged', 20)) $$, 'despacha por motoboy');
select is((select status::text from sales.orders where id = (select v from ids where k = 'oR')), 'SHIPPED', 'pedido enviado');

-- cancelamento libera a reserva
select lives_ok($$ insert into ids select 'oR2', (sales.create_remote_order(jsonb_build_object('idempotency_key', 't-rem-2', 'store_id', '00000000-0000-4000-8000-0000000000a1',
  'party_id', (select v from ids where k = 'cli2'), 'items', jsonb_build_array(jsonb_build_object('variant_id', (select id from catalog.variants where sku = 'DEMO-LEG01-PRT-GG'), 'qty', 2))))).id $$, 'outro pedido remoto');
select lives_ok($$ select sales.cancel_order((select v from ids where k = 'oR2'), 'cliente desistiu') $$, 'cancela o pedido');
select is((select reserved from inv.stock_levels sl join catalog.variants v on v.id = sl.variant_id where v.sku = 'DEMO-LEG01-PRT-GG' and sl.location_id = '00000000-0000-4000-8000-0000000000b1'), 0.000, 'reserva liberada');

-- ---------- Armário VIP e retenção da IA ----------
select is(inv.ensure_lockers('00000000-0000-4000-8000-0000000000a1', 3), 3, 'cadastra 3 armários');
select lives_ok($$ insert into ids select 'drop', (sales.prepare_locker(jsonb_build_object('store_id', '00000000-0000-4000-8000-0000000000a1', 'locker_id', (select id from inv.lockers where code = 'A01'),
  'party_id', (select v from ids where k = 'cli2'), 'items', jsonb_build_array(jsonb_build_object('variant_id', (select id from catalog.variants where sku = 'DEMO-LEG01-OFW-P'), 'qty', 1),
    jsonb_build_object('variant_id', (select id from catalog.variants where sku = 'DEMO-LEG01-OFW-PP'), 'qty', 1))))).id $$, 'prepara o Armário VIP com 2 peças');
select is((select status from inv.lockers where code = 'A01'), 'OCCUPIED', 'armário ocupado');
select throws_ok($$ select sales.prepare_locker(jsonb_build_object('store_id', '00000000-0000-4000-8000-0000000000a1', 'locker_id', (select id from inv.lockers where code = 'A01'),
  'party_id', (select v from ids where k = 'cli2'), 'items', jsonb_build_array(jsonb_build_object('variant_id', (select id from catalog.variants where sku = 'DEMO-LEG01-OFW-G'), 'qty', 1)))) $$, 'P0095', null, 'armário ocupado não recebe outro');
select is((select (sales.close_locker_drop((select v from ids where k = 'drop'), 'RETURNED')).outcome), 'RETURNED', 'fecha o armário: cliente não levou nada');
select is((select count(*)::int from inv.reservations where drop_id = (select v from ids where k = 'drop') and status = 'ACTIVE'), 0, 'reservas liberadas');
select is((select status from inv.lockers where code = 'A01'), 'FREE', 'armário livre de novo');
select lives_ok($$ select inv.reserve(jsonb_build_object('variant_id', (select id from catalog.variants where sku = 'DEMO-TEE01-OFW-P'), 'store_id', '00000000-0000-4000-8000-0000000000a1', 'qty', 1,
  'reason', 'AI_HOLD', 'party_id', (select v from ids where k = 'cli2'), 'created_by_kind', 'AI')) $$, 'IA retém 1 peça');
select throws_ok($$ select inv.reserve(jsonb_build_object('variant_id', (select id from catalog.variants where sku = 'DEMO-TEE01-OFW-M'), 'store_id', '00000000-0000-4000-8000-0000000000a1', 'qty', 1,
  'reason', 'AI_HOLD', 'party_id', (select v from ids where k = 'cli2'), 'hold_hours', 72)) $$, 'P0094', null, 'IA não retém por mais de 48 h');

-- ---------- Jobs e permissões ----------
select throws_ok($$ select sales.expire_locker_drops() $$, '42501', null, 'job de expiração não é chamável por usuário');

select * from finish();
rollback;
