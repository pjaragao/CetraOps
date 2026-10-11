begin;
create extension if not exists pgtap with schema extensions;
select plan(40);

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

-- ---------- Preparação (dono do banco) ----------
select vault.create_secret('{"secret_key":"sk_test_SEGREDO"}', 'stone-teste-065');
insert into core.integration_connections (org_id, provider, capability, secret_ref, status, config)
values ('00000000-0000-4000-8000-000000000001', 'STONE', 'ACQUIRER', 'stone-teste-065', 'ACTIVE', '{"terminals":[{"id":"t1","name":"Caixa","serial":"PB0123456","is_default":true}]}');
insert into ids select 'var', id from catalog.variants where product_id = '00000000-0000-4000-8000-000000000401' and size = 'M' limit 1;
insert into inv.movements (org_id, variant_id, location_id, qty, unit_cost, total_cost, movement_type)
values ('00000000-0000-4000-8000-000000000001', pg_temp.v('var'), '00000000-0000-4000-8000-0000000000b1', 20, 50, 1000, 'PURCHASE_RECEIPT');
insert into ids values ('ped', '00000000-0000-4000-8000-0000000065a1'), ('ped2', '00000000-0000-4000-8000-0000000065a2');
insert into sales.orders (id, org_id, legal_entity_id, store_id, location_id, number, channel, status, subtotal, total, idempotency_key) values
  (pg_temp.v('ped'), '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1', 'T065-1', 'WHATSAPP', 'PENDING_PAYMENT', 500, 500, 't065-1'),
  (pg_temp.v('ped2'), '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1', 'T065-2', 'WHATSAPP', 'PENDING_PAYMENT', 300, 300, 't065-2');
insert into sales.order_items (org_id, order_id, variant_id, qty, list_price, unit_price, total) values
  ('00000000-0000-4000-8000-000000000001', pg_temp.v('ped'), pg_temp.v('var'), 1, 500, 500, 500),
  ('00000000-0000-4000-8000-000000000001', pg_temp.v('ped2'), pg_temp.v('var'), 1, 300, 300, 300);

-- ---------- Stone: a chave não sai do servidor e só o servidor confirma pagamento ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');   -- vendedora
select is(sales.get_stone_config() ->> 'secret_key', null, 'a configuração da Stone não traz a chave secreta');
select is((sales.get_stone_config() ->> 'has_integration')::boolean, true, 'mas diz que a integração existe');
select is(jsonb_array_length(sales.get_stone_config() -> 'terminals'), 1, 'e lista as maquininhas');
select throws_ok($$ select sales.stone_secret('00000000-0000-4000-8000-000000000001') $$, '42501', null, 'a vendedora não lê a chave');
select is((sales.record_stone_pos_order(pg_temp.v('ped'), 'or_t065_a', 'PB0123456', 500, 'CREDIT', 2)).status, 'PENDING', 'registra a cobrança enviada à maquininha');
select throws_ok($$ select sales.complete_stone_pos_payment('00000000-0000-4000-8000-000000000001', 'or_t065_a', 500, 'CREDIT', 2, 'NSU-FALSO') $$, '42501', null, 'a vendedora não confirma pagamento sozinha');
select throws_ok($$ select sales.save_stone_terminals('[{"serial":"PB999999"}]') $$, '42501', null, 'maquininhas só pelo sócio');
select throws_ok($$ select sales.record_stone_pos_order(null, 'or_x', 'PB0123456', -5, 'CREDIT', 1) $$, '22023', null, 'valor negativo recusado');
reset role;
-- servidor: valor pago diferente não confirma
select is((sales.complete_stone_pos_payment('00000000-0000-4000-8000-000000000001', 'or_t065_a', 450, 'CREDIT', 2, 'NSU1') ->> 'ok')::boolean, false, 'valor pago diferente do cobrado não confirma');
select is((select status from sales.stone_pos_orders where stone_order_id = 'or_t065_a'), 'FAILED', 'e a cobrança fica como falha');
insert into sales.stone_pos_orders (org_id, order_id, stone_order_id, terminal_serial, amount, method, installments)
values ('00000000-0000-4000-8000-000000000001', pg_temp.v('ped2'), 'or_t065_b', 'PB0123456', 300, 'CREDIT', 1);
select is((sales.complete_stone_pos_payment('00000000-0000-4000-8000-000000000001', 'or_t065_b', 300, 'DEBIT', 1, 'NSU2') ->> 'ok')::boolean, true, 'com o valor certo, confirma');
select is((select status::text || '/' || paid_total from sales.orders where id = pg_temp.v('ped2')), 'COMPLETED/300.00', 'e o pedido é pago pelo caminho normal (pagamento registrado e venda fechada)');
select is((select method::text from sales.payments where order_id = pg_temp.v('ped2')), 'DEBIT', 'com a forma que a Stone informou');
select is((sales.complete_stone_pos_payment('00000000-0000-4000-8000-000000000001', 'or_t065_b', 300, 'DEBIT', 1, 'NSU2') ->> 'already')::boolean, true, 'confirmar de novo não duplica');
select is((select count(*)::int from sales.payments where order_id = pg_temp.v('ped2')), 1, 'um pagamento só');
select is((sales.complete_stone_pos_payment('00000000-0000-4000-8000-000000000002', 'or_t065_b', 300, 'DEBIT', 1, 'NSU2') ->> 'ok')::boolean, false, 'ordem de outra empresa não é encontrada');

-- ---------- Situação do pedido ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');
select throws_ok($$ select sales.set_order_status(pg_temp.v('ped'), 'PAID', null) $$, 'P0004', null, 'não marca como pago sem registrar pagamento');
select throws_ok($$ select sales.set_order_status(pg_temp.v('ped'), 'COMPLETED', null) $$, 'P0004', null, 'nem como concluído');
select throws_ok($$ select sales.set_order_status(pg_temp.v('ped2'), 'RETURNED', null) $$, 'P0004', null, 'devolução só pela tela de trocas');
select is((sales.set_order_status(pg_temp.v('ped'), 'DRAFT', 'voltou para negociação')).status::text, 'DRAFT', 'pedido sem pagamento volta para rascunho');
select is((sales.set_order_status(pg_temp.v('ped'), 'PENDING_PAYMENT', null)).status::text, 'PENDING_PAYMENT', 'e de rascunho para aguardando pagamento');
select is((sales.set_order_status(pg_temp.v('ped'), 'CANCELLED', 'desistiu')).status::text, 'CANCELLED', 'cancelar usa o cancelamento completo');
select throws_ok($$ select sales.set_order_status(pg_temp.v('ped2'), 'CANCELLED', null) $$, 'P0004', null, 'pedido pago não se cancela pela situação');

-- ---------- Descontos e item avulso ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');   -- sócio
select throws_ok($$ select sales.create_pos_order(jsonb_build_object('idempotency_key', 't065-d1', 'store_id', '00000000-0000-4000-8000-0000000000a1',
  'items', jsonb_build_array(jsonb_build_object('variant_id', pg_temp.v('var'), 'qty', 1, 'discount_amount', 999999)), 'payments', '[]'::jsonb)) $$, 'P0008', null, 'desconto maior que o item é recusado');
select throws_ok($$ select sales.create_pos_order(jsonb_build_object('idempotency_key', 't065-d2', 'store_id', '00000000-0000-4000-8000-0000000000a1',
  'items', jsonb_build_array(jsonb_build_object('variant_id', pg_temp.v('var'), 'qty', 1, 'discount_amount', -50)), 'payments', '[]'::jsonb)) $$, 'P0008', null, 'desconto negativo é recusado');
select throws_ok($$ select sales.create_remote_order(jsonb_build_object('idempotency_key', 't065-d3', 'store_id', '00000000-0000-4000-8000-0000000000a1', 'channel', 'WHATSAPP',
  'items', jsonb_build_array(jsonb_build_object('variant_id', pg_temp.v('var'), 'qty', 1, 'discount_amount', 999999)))) $$, 'P0008', null, 'também no pedido remoto');
reset role;
delete from core.role_permissions rp using core.roles r where r.id = rp.role_id and r.key = 'seller' and rp.permission_key = 'sales.custom_item';
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');
select throws_ok($$ select sales.create_remote_order(jsonb_build_object('idempotency_key', 't065-c1', 'store_id', '00000000-0000-4000-8000-0000000000a1', 'channel', 'WHATSAPP',
  'items', jsonb_build_array(jsonb_build_object('description', 'Ajuste de barra', 'unit_price', 30, 'qty', 1)))) $$, '42501', null, 'item avulso exige a permissão própria (sales.write não basta)');
select throws_ok($$ select sales.save_order_draft(jsonb_build_object('store_id', '00000000-0000-4000-8000-0000000000a1',
  'items', jsonb_build_array(jsonb_build_object('description', 'Ajuste de barra', 'unit_price', 30, 'qty', 1)))) $$, '42501', null, 'inclusive no rascunho');
select is((sales.save_order_draft(jsonb_build_object('store_id', '00000000-0000-4000-8000-0000000000a1',
  'items', jsonb_build_array(jsonb_build_object('variant_id', pg_temp.v('var'), 'qty', 1, 'discount_amount', 999999))))).total >= 0, true, 'rascunho com desconto exagerado é ajustado, nunca fica negativo');

-- ---------- Maquininha dentro da venda de balcão ----------
reset role;
insert into sales.stone_pos_orders (org_id, stone_order_id, terminal_serial, amount, method, installments, status)
values ('00000000-0000-4000-8000-000000000001', 'or_t065_c', 'PB0123456', 289, 'CREDIT', 1, 'PAID'), ('00000000-0000-4000-8000-000000000001', 'or_t065_d', 'PB0123456', 289, 'CREDIT', 1, 'PENDING');
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select throws_ok($$ select sales.create_pos_order(jsonb_build_object('idempotency_key', 't065-s1', 'store_id', '00000000-0000-4000-8000-0000000000a1',
  'items', jsonb_build_array(jsonb_build_object('variant_id', pg_temp.v('var'), 'qty', 1)),
  'payments', jsonb_build_array(jsonb_build_object('method', 'CREDIT', 'amount', (select catalog.current_price(pg_temp.v('var'), null)), 'acquirer', 'STONE', 'external_id', 'or_t065_d')))) $$,
  'P0005', null, 'pagamento da maquininha não confirmado pela Stone não fecha a venda');
reset role;
update sales.stone_pos_orders set amount = (select catalog.current_price(pg_temp.v('var'), (select id from catalog.price_lists where org_id = '00000000-0000-4000-8000-000000000001' and is_default))) where stone_order_id = 'or_t065_c';
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
insert into ids select 'venda', (sales.create_pos_order(jsonb_build_object('idempotency_key', 't065-s2', 'store_id', '00000000-0000-4000-8000-0000000000a1',
  'items', jsonb_build_array(jsonb_build_object('variant_id', pg_temp.v('var'), 'qty', 1), jsonb_build_object('description', 'Ajuste de barra', 'unit_price', 30, 'qty', 1)),
  'payments', jsonb_build_array(
    jsonb_build_object('method', 'CREDIT', 'amount', (select amount from sales.stone_pos_orders where stone_order_id = 'or_t065_c'), 'acquirer', 'STONE', 'external_id', 'or_t065_c'),
    jsonb_build_object('method', 'PIX', 'amount', 30))))).id;
select is((select order_id from sales.stone_pos_orders where stone_order_id = 'or_t065_c'), pg_temp.v('venda'), 'com a Stone confirmada, a venda fecha e fica ligada à cobrança');
select throws_ok($$ select sales.create_pos_order(jsonb_build_object('idempotency_key', 't065-s3', 'store_id', '00000000-0000-4000-8000-0000000000a1',
  'items', jsonb_build_array(jsonb_build_object('variant_id', pg_temp.v('var'), 'qty', 1)),
  'payments', jsonb_build_array(jsonb_build_object('method', 'CREDIT', 'amount', (select amount from sales.stone_pos_orders where stone_order_id = 'or_t065_c'), 'acquirer', 'STONE', 'external_id', 'or_t065_c')))) $$,
  'P0005', null, 'o mesmo pagamento da maquininha não entra em duas vendas');

-- ---------- NFC-e com item avulso ----------
reset role;
update sales.order_items set ncm = '96190000' where order_id = pg_temp.v('venda') and variant_id is null;
select is(jsonb_array_length(fiscal.emission_payload(pg_temp.v('venda'), 'SALE') #> '{document,itens}'), 2, 'o item avulso entra na nota');
select is((select x ->> 'descricao' || '/' || (x ->> 'codigo_ncm') from jsonb_array_elements(fiscal.emission_payload(pg_temp.v('venda'), 'SALE') #> '{document,itens}') x where x ->> 'codigo_produto' like 'AVULSO-%'),
  'Ajuste de barra/96190000', 'com a descrição digitada e o NCM do item');
select ok(not exists (select 1 from pg_proc where proname = 'build_emission_payload'), 'a função paralela que ninguém usava foi removida');

-- ---------- IA: rascunho de campanha só com confirmação ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
insert into ids select 'acao', (ai.assistant_propose(jsonb_build_object('tool', 'campanha_rascunho', 'summary', 'Campanha teste', 'args', jsonb_build_object('name', 'Reativar (teste 065)', 'objective', 'REACTIVATE', 'audience', jsonb_build_object('inactive_days', 90))))).id;
select is((select count(*)::int from mkt.campaigns where name = 'Reativar (teste 065)'), 0, 'propor não cria nada');
select is(ai.assistant_execute(pg_temp.v('acao')) #>> '{result,target_type}', 'mkt.campaigns', 'confirmar cria o rascunho');
select is((select status from mkt.campaigns where name = 'Reativar (teste 065)'), 'DRAFT', 'sempre como rascunho');

-- ---------- Link curto: clique repetido conta uma vez ----------
reset role;
insert into omni.channel_accounts (id, org_id, channel, provider_account_id, display_name, store_id, default_ai_mode, public_address)
values ('00000000-0000-4000-8000-0000000065f8', '00000000-0000-4000-8000-000000000001', 'WHATSAPP', 'PN-065', 'WA 065', '00000000-0000-4000-8000-0000000000a1', 'AI_COPILOT', '5548900000065');
insert into mkt.tracking_links (org_id, code, name, kind, channel_account_id) values ('00000000-0000-4000-8000-000000000001', 'qr-teste-065', 'QR teste', 'QR', '00000000-0000-4000-8000-0000000065f8');
select public.resolve_link('qr-teste-065', '{"fingerprint":"abc"}'), public.resolve_link('qr-teste-065', '{"fingerprint":"abc"}'), public.resolve_link('qr-teste-065', '{"fingerprint":"xyz"}');
select is((select count(*)::int from mkt.link_clicks k join mkt.tracking_links l on l.id = k.tracking_link_id where l.code = 'qr-teste-065'), 2, 'mesma pessoa em 10 min conta uma vez');

-- ---------- Privilégios ----------
select ok(not has_function_privilege('authenticated', 'sales.complete_stone_pos_payment(uuid,text,numeric,text,integer,text,text,text,jsonb)', 'execute')
          and not has_function_privilege('authenticated', 'sales.stone_secret(uuid)', 'execute')
          and has_function_privilege('service_role', 'sales.complete_stone_pos_payment(uuid,text,numeric,text,integer,text,text,text,jsonb)', 'execute'), 'confirmação e chave só para o servidor');

select * from finish();
rollback;
