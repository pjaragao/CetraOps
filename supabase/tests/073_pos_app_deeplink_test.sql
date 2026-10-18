begin;
create extension if not exists pgtap with schema extensions;
select plan(24);

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
create or replace function pg_temp.v(p text) returns text language sql as $$ select v from ids where k = p $$;
grant execute on function pg_temp.v(text) to authenticated;

-- hashes (o servidor web gera o código e o token; o banco só vê o sha256)
insert into ids values ('code', encode(extensions.digest('ABCD2345', 'sha256'), 'hex')), ('tok', encode(extensions.digest('token-do-aparelho', 'sha256'), 'hex')),
                       ('code2', encode(extensions.digest('ZZZZ9999', 'sha256'), 'hex')), ('tok2', encode(extensions.digest('token-novo', 'sha256'), 'hex'));
insert into ids select 'var', id::text from catalog.variants where product_id = '00000000-0000-4000-8000-000000000401' and size = 'M' limit 1;
insert into inv.movements (org_id, variant_id, location_id, qty, unit_cost, total_cost, movement_type)
values ('00000000-0000-4000-8000-000000000001', pg_temp.v('var')::uuid, '00000000-0000-4000-8000-0000000000b1', 20, 50, 1000, 'PURCHASE_RECEIPT');
insert into ids select 'price', catalog.current_price(pg_temp.v('var')::uuid, (select id from catalog.price_lists where org_id = '00000000-0000-4000-8000-000000000001' and is_default))::text;

-- ---------- Pareamento ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');   -- vendedora
select throws_ok($$ select sales.create_pos_device_pairing('00000000-0000-4000-8000-0000000000a1', 'Caixa', pg_temp.v('code')) $$, '42501', null, 'só o sócio pareia maquininha');
select throws_ok($$ select sales.pair_pos_device(pg_temp.v('code'), pg_temp.v('tok'), 'PB01', 'L400', '1.0') $$, '42501', null, 'trocar o código pelo token é só do servidor');
select is(sales.list_pos_devices(), '[]'::jsonb, 'a vendedora não vê as maquininhas');
select throws_ok($$ select token_hash from sales.pos_devices $$, '42501', null, 'nem lê a tabela (os hashes não saem do banco)');

select pg_temp.login('00000000-0000-4000-8000-0000000000f1');   -- sócio
select throws_ok($$ select sales.create_pos_device_pairing('00000000-0000-4000-8000-0000000000a1', 'Caixa', 'abc') $$, '22023', null, 'código precisa vir como hash');
insert into ids select 'dev', (sales.create_pos_device_pairing('00000000-0000-4000-8000-0000000000a1', 'Caixa 1', pg_temp.v('code')) ->> 'id');
select is((sales.list_pos_devices() -> 0 ->> 'pairing_pending')::boolean, true, 'maquininha criada aguardando o pareamento');
select ok(sales.list_pos_devices() -> 0 -> 'token_hash' is null, 'a lista não traz hash');

reset role;
select is((sales.pair_pos_device(encode(extensions.digest('ERRADO00', 'sha256'), 'hex'), pg_temp.v('tok'), 'PB01', 'L400', '1.0') ->> 'ok')::boolean, false, 'código errado não pareia');
select is(sales.pair_pos_device(pg_temp.v('code'), pg_temp.v('tok'), 'PB01', 'L400', '1.0') ->> 'store_id', '00000000-0000-4000-8000-0000000000a1', 'código certo pareia e devolve a loja');
select is((sales.pair_pos_device(pg_temp.v('code'), pg_temp.v('tok2'), 'PB01', 'L400', '1.0') ->> 'ok')::boolean, false, 'o mesmo código não serve duas vezes');
select is(sales.pos_device_by_token(pg_temp.v('tok')) ->> 'device_id', pg_temp.v('dev'), 'o servidor reconhece o aparelho pelo token');

-- ---------- Cobrança pelo Deeplink ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');
select throws_ok($$ select sales.open_stone_deeplink_charge(pg_temp.v('tok2'), 100, 'CREDIT', 1) $$, '42501', null, 'sem maquininha pareada não abre cobrança');
select throws_ok($$ select sales.open_stone_deeplink_charge(pg_temp.v('tok'), 100, 'DEBIT', 3) $$, '22023', null, 'débito não parcela');
insert into ids select 'c1', sales.open_stone_deeplink_charge(pg_temp.v('tok'), pg_temp.v('price')::numeric, 'CREDIT', 2) ->> 'charge_id';
select ok(pg_temp.v('c1') like 'dl\_%', 'cobrança aberta com identificador próprio');
select is((sales.confirm_stone_deeplink_charge(pg_temp.v('tok'), pg_temp.v('c1'), pg_temp.v('price')::numeric - 1, 'ATK0001', 'ITK1', '123456', 'VISA', 2) ->> 'ok')::boolean, false,
  'valor aprovado diferente do aberto não confirma');
select is((select status from sales.stone_pos_orders where stone_order_id = pg_temp.v('c1')), 'FAILED', 'e a cobrança fica como falha (para estornar)');

insert into ids select 'c2', sales.open_stone_deeplink_charge(pg_temp.v('tok'), pg_temp.v('price')::numeric, 'CREDIT', 2) ->> 'charge_id';
select is((sales.confirm_stone_deeplink_charge(pg_temp.v('tok'), pg_temp.v('c2'), pg_temp.v('price')::numeric, 'ATK0002', 'ITK2', '123456', 'VISA', 2) ->> 'installments')::int, 2, 'valor certo confirma');
select is((sales.confirm_stone_deeplink_charge(pg_temp.v('tok'), pg_temp.v('c2'), pg_temp.v('price')::numeric, 'ATK0002', 'ITK2', '123456', 'VISA', 2) ->> 'already')::boolean, true, 'repetir o retorno não duplica');
insert into ids select 'c3', sales.open_stone_deeplink_charge(pg_temp.v('tok'), pg_temp.v('price')::numeric, 'DEBIT', 1) ->> 'charge_id';
select throws_ok($$ select sales.confirm_stone_deeplink_charge(pg_temp.v('tok'), pg_temp.v('c3'), pg_temp.v('price')::numeric, 'ATK0002', 'ITK3', '1', 'VISA', 1) $$, 'P0005', null,
  'a mesma transação da Stone não paga duas cobranças');
select is(sales.close_stone_deeplink_charge(pg_temp.v('tok'), pg_temp.v('c3'), 'CANCELLED') ->> 'status', 'CANCELLED', 'desistência fecha a cobrança aberta');

-- a venda usa a cobrança confirmada, uma vez só
insert into ids select 'venda', (sales.create_pos_order(jsonb_build_object('idempotency_key', 't073-s1', 'store_id', '00000000-0000-4000-8000-0000000000a1',
  'items', jsonb_build_array(jsonb_build_object('variant_id', pg_temp.v('var'), 'qty', 1)),
  'payments', jsonb_build_array(jsonb_build_object('method', 'CREDIT', 'amount', pg_temp.v('price')::numeric, 'installments', 2, 'acquirer', 'STONE', 'nsu', 'ATK0002', 'external_id', pg_temp.v('c2')))))).id::text;
select is((select order_id::text from sales.stone_pos_orders where stone_order_id = pg_temp.v('c2')), pg_temp.v('venda'), 'a venda fica ligada à cobrança da maquininha');
select throws_ok($$ select sales.close_stone_deeplink_charge(pg_temp.v('tok'), pg_temp.v('c2'), 'REFUNDED') $$, 'P0005', null, 'cobrança que já está numa venda não é estornada por aqui');

-- ---------- Desativar ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select ok(sales.revoke_pos_device(pg_temp.v('dev')::uuid), 'sócio desativa a maquininha');
reset role;
select is(sales.pos_device_by_token(pg_temp.v('tok')), null, 'e o token deixa de valer');

select * from finish();
rollback;
