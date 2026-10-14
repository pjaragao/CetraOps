begin;
create extension if not exists pgtap with schema extensions;
select plan(17);

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
insert into ids select 'f1', id from core.members where user_id = '00000000-0000-4000-8000-0000000000f1';

select ok(not has_function_privilege('authenticated', 'private.catalog_source(text, text)', 'execute'), 'a tela não escolhe a origem direto');

select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select throws_ok($$ insert into catalog.source_log (org_id, entity, entity_id, action, source) values ('00000000-0000-4000-8000-000000000001', 'PRODUCT', gen_random_uuid(), 'INSERT', 'SITE') $$,
  '42501', null, 'o histórico não é gravado por fora');
-- pedido em PDF: origem, arquivo e usuário
select lives_ok($$ select catalog.apply_brand_items('[{"reference": "DEMO-LEG01", "color_code": "390", "color_name": "Azul Jeans", "size": "P", "wholesale_cost": 205,
  "source": "PDF_PEDIDO", "document": "PEDIDO.PDF · orçamento 11933"}]') $$, 'grava pelo pedido em PDF');
select is((select source from catalog.variants where sku = 'DEMO-LEG01390P'), 'PDF_PEDIDO', 'variação nasce com a origem');
select is((select source_ref from catalog.variants where sku = 'DEMO-LEG01390P'), 'PEDIDO.PDF · orçamento 11933', 'e o arquivo');
select is((select source_by from catalog.variants where sku = 'DEMO-LEG01390P'), (select v from ids where k = 'f1'), 'e o usuário');
select ok((select source_at from catalog.variants where sku = 'DEMO-LEG01390P') is not null, 'e a data');
select is((select source from catalog.colors where code = '390'), 'PDF_PEDIDO', 'cor nova também');
select is((select changes -> 'wholesale_cost' ->> 'para' from catalog.source_log where entity = 'PRODUCT' and action = 'UPDATE' and source = 'PDF_PEDIDO' order by id desc limit 1),
  '205.00', 'o preço de atacado fica no histórico (de → para)');
select is((select (apply ->> 'erros')::jsonb -> 0 ->> 'erro' from (select catalog.apply_brand_items('[{"reference": "DEMO-LEG01", "color_code": "PRT", "size": "P", "source": "SITE"}]') as apply) x),
  'origem inválida', 'a tela não se passa pelo site');

-- alteração pela tela: MANUAL com usuário, campo a campo; sem mudança não registra
select set_config('catalog.source', '', true), set_config('catalog.source_ref', '', true);   -- nova chamada (no app cada chamada é uma transação)
update catalog.products set composition = 'Teste de origem' where reference_code = 'DEMO-LEG01';
select is((select source || ':' || (member_id = (select v from ids where k = 'f1'))::text from catalog.source_log where entity = 'PRODUCT' order by id desc limit 1), 'MANUAL:true', 'alteração pela tela fica como manual, com o usuário');
select is((select changes -> 'composition' ->> 'para' from catalog.source_log where entity = 'PRODUCT' order by id desc limit 1), 'Teste de origem', 'com o valor novo');
select is((select count(*)::int from (select catalog.apply_brand_items('[{"reference": "DEMO-LEG01", "color_code": "390", "size": "P", "source": "PDF_PEDIDO"}]')) x), 1, 'reimportar a mesma linha');
select is((select count(*)::int from catalog.source_log where entity = 'VARIANT' and entity_id = (select id from catalog.variants where sku = 'DEMO-LEG01390P')), 1, 'não gera histórico sem mudança');
update catalog.variants set source = 'SITE' where sku = 'DEMO-LEG01390P';
select is((select source from catalog.variants where sku = 'DEMO-LEG01390P'), 'PDF_PEDIDO', 'a origem não muda depois da inclusão');

-- planilha
select lives_ok($$ select catalog.import_rows('[{"reference_code": "PLAN-01", "name": "Peça da planilha", "gender": "FEM", "color": "Preto", "size": "M", "document": "estoque.csv"}]') $$, 'importa planilha');
reset role;
select is((select source || ' · ' || source_ref from catalog.products where reference_code = 'PLAN-01'), 'PLANILHA · estoque.csv', 'produto da planilha com o arquivo');

select * from finish();
rollback;
