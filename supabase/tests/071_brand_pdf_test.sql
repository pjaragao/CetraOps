begin;
create extension if not exists pgtap with schema extensions;
select plan(16);

create or replace function pg_temp.login(p_user uuid) returns void language plpgsql as $$
declare m record;
begin
  select id, org_id into m from core.members where user_id = p_user;
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated',
    'app_metadata', json_build_object('org_id', m.org_id, 'member_id', m.id))::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
grant execute on function pg_temp.login(uuid) to authenticated, anon;
create temp table r (k text primary key, v jsonb);
grant all on r to authenticated;

select pg_temp.login('00000000-0000-4000-8000-0000000000f2');   -- vendedora (sem catalog.write)
select throws_ok($$ select catalog.apply_brand_items('[]') $$, '42501', null, 'vendedora não cadastra peças pelo PDF');
reset role;

select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
-- linhas de um pedido em PDF: produto existente com cor nova (pelo código da marca), tamanho novo, produto novo e uma linha inválida
insert into r select 'pedido', catalog.apply_brand_items('[
  {"reference": "DEMO-LEG01", "color_code": "390", "color_name": "Azul Jeans", "size": "P", "wholesale_cost": 205, "supplier_sku": "DEMO-LEG01390P"},
  {"reference": "DEMO-LEG01", "color_code": "390", "color_name": "Azul Jeans", "size": "M", "wholesale_cost": 205},
  {"reference": "DEMO-LEG01", "color_code": "PRT", "color_name": "Preto", "size": "XGG"},
  {"reference": "PDF-NOVO", "name": "Macacão do PDF", "color_code": "323", "color_name": "Marrom", "size": "M", "price": 629, "composition": "90% Poliamida / 10% Elastano"},
  {"reference": "PDF-SEM-NOME", "color_code": "PRT", "size": "M"}
]');
select is(jsonb_array_length((select v -> 'items' from r where k = 'pedido')), 4, 'quatro linhas gravadas');
select is((select v -> 'erros' -> 0 ->> 'i' from r where k = 'pedido'), '5', 'produto novo sem nome volta como erro, sem barrar as outras');
select is((select v ->> 'cores_novas' from r where k = 'pedido'), '2', 'cores novas pelo código da marca (390 e 323)');
select is((select name from catalog.colors where code = '390'), 'Azul Jeans', 'cor nova leva o nome do PDF');
select ok(exists (select 1 from catalog.variants where sku = 'DEMO-LEG01390P' and supplier_sku = 'DEMO-LEG01390P'), 'SKU no padrão modelo + cor + tamanho');
select ok(exists (select 1 from catalog.variants where sku = 'DEMO-LEG01PRTXGG'), 'tamanho novo de cor existente');
select is((select wholesale_cost from catalog.products where reference_code = 'DEMO-LEG01'), 205.00, 'guarda o preço de atacado');
select is((select name from catalog.products where reference_code = 'DEMO-LEG01'), 'Legging Demo Sculpt', 'não renomeia produto existente');
select is((select composition from catalog.products where reference_code = 'PDF-NOVO'), '90% Poliamida / 10% Elastano', 'produto novo com a composição');
select is(catalog.current_price((select id from catalog.variants where sku = 'PDF-NOVO323M')), 629.00, 'e com o preço de venda');

-- reimportar não duplica nem troca o preço que já existe
insert into r select 'de-novo', catalog.apply_brand_items('[
  {"reference": "PDF-NOVO", "color_name": "marrom", "size": "M", "price": 999, "backorder": true}
]');
select is((select v ->> 'variantes_novas' from r where k = 'de-novo'), '0', 'reimportar não duplica (cor achada pelo nome)');
select is(catalog.current_price((select id from catalog.variants where sku = 'PDF-NOVO323M')), 629.00, 'nem troca o preço existente');
select ok((select backorder from catalog.products where reference_code = 'PDF-NOVO'), 'libera para encomenda quando pedido');

-- cor e produto escolhidos na tela (catálogo em PDF sem código)
insert into r select 'catalogo', catalog.apply_brand_items(jsonb_build_array(jsonb_build_object(
  'product_id', (select id from catalog.products where reference_code = 'DEMO-LEG01'), 'color_id', '00000000-0000-4000-8000-000000000302', 'size', 'PP', 'wholesale_cost', 187)));
select is((select (v -> 'items' -> 0 ->> 'variant_id')::uuid from r where k = 'catalogo'),
  (select id from catalog.variants where product_id = (select id from catalog.products where reference_code = 'DEMO-LEG01') and color_id = '00000000-0000-4000-8000-000000000302' and size = 'PP'),
  'produto e cor escolhidos na tela (a variação existente é reaproveitada)');
reset role;

-- encomenda usa o preço de atacado quando a peça não tem custo
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select is(sales.backorder_cost((select id from catalog.variants where sku = 'DEMO-LEG01390P'), '00000000-0000-4000-8000-0000000000a1'), '{"source": "WHOLESALE", "cost": 187.00}'::jsonb, 'peça sem custo: preço de atacado da marca');
reset role;

select * from finish();
rollback;
