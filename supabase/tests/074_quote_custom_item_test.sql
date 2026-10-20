begin;
create extension if not exists pgtap with schema extensions;
select plan(8);

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
insert into ids select 'var', id from catalog.variants where product_id = '00000000-0000-4000-8000-000000000401' and size = 'M' limit 1;

-- ---------- Central: cotação com item avulso ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');   -- sócio
create temp table q as select sales.quote_order(jsonb_build_object('store_id', '00000000-0000-4000-8000-0000000000a1', 'items', jsonb_build_array(
  jsonb_build_object('description', 'Item avulso', 'unit_price', 100, 'qty', 1),
  jsonb_build_object('variant_id', pg_temp.v('var'), 'qty', 1)))) as r;
select is(jsonb_array_length((select r from q) -> 'items'), 2, 'a cotação traz a linha avulsa e a peça');
select is(((select r from q) -> 'items' -> 0 ->> 'custom')::boolean, true, 'a linha avulsa vem marcada');
select is(((select r from q) -> 'items' -> 0 ->> 'available'), null, 'sem estoque a conferir no avulso');
select is(((select r from q) ->> 'total')::numeric, 100 + ((select r from q) -> 'items' -> 1 ->> 'total')::numeric, 'o total soma o avulso e a peça');
select throws_ok($$ select sales.quote_order(jsonb_build_object('store_id', '00000000-0000-4000-8000-0000000000a1',
  'items', jsonb_build_array(jsonb_build_object('description', '  ', 'unit_price', 10, 'qty', 1)))) $$, '22023', null, 'avulso sem descrição é recusado');
select throws_ok($$ select sales.quote_order(jsonb_build_object('store_id', '00000000-0000-4000-8000-0000000000a1',
  'items', jsonb_build_array(jsonb_build_object('description', 'Ajuste', 'qty', 1)))) $$, 'P0460', null, 'avulso sem preço é recusado');
reset role;
delete from core.role_permissions rp using core.roles r where r.id = rp.role_id and r.key = 'seller' and rp.permission_key = 'sales.custom_item';
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');   -- vendedora sem sales.custom_item
select throws_ok($$ select sales.quote_order(jsonb_build_object('store_id', '00000000-0000-4000-8000-0000000000a1',
  'items', jsonb_build_array(jsonb_build_object('description', 'Ajuste de barra', 'unit_price', 30, 'qty', 1)))) $$, '42501', null, 'item avulso na Central exige a mesma permissão do PDV');
select lives_ok($$ select sales.quote_order(jsonb_build_object('store_id', '00000000-0000-4000-8000-0000000000a1',
  'items', jsonb_build_array(jsonb_build_object('variant_id', pg_temp.v('var'), 'qty', 1)))) $$, 'peça do catálogo continua cotando normalmente');

select * from finish();
rollback;
