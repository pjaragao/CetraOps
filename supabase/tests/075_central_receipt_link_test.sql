begin;
create extension if not exists pgtap with schema extensions;
select plan(9);

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
create temp table kv (k text primary key, v jsonb);
grant all on ids, kv to authenticated;

-- ---------- Preparação (dono do banco): uma NF-e em recebimento com 3 itens ----------
insert into ids select 'var', id from catalog.variants where product_id = '00000000-0000-4000-8000-000000000401' and size = 'M' limit 1;
insert into ids select 'forn', id from crm.parties order by created_at limit 1;
insert into ids values ('rc', '00000000-0000-4000-8000-0000000075a1'), ('i1', '00000000-0000-4000-8000-0000000075b1'),
                       ('i2', '00000000-0000-4000-8000-0000000075b2'), ('i3', '00000000-0000-4000-8000-0000000075b3');
insert into purch.receipts (id, org_id, legal_entity_id, location_id, supplier_party_id, number, nf_total)
values ((select v from ids where k = 'rc'), '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000e1',
        '00000000-0000-4000-8000-0000000000b1', (select v from ids where k = 'forn'), '7501', 300);
insert into purch.receipt_items (id, org_id, receipt_id, n_item, supplier_cprod, description, ncm, qty_nfe, unit_cost_nfe, item_total) values
  ((select v from ids where k = 'i1'), '00000000-0000-4000-8000-000000000001', (select v from ids where k = 'rc'), 1, 'X1', 'PECA JA CADASTRADA M', '61046200', 1, 100, 100),
  ((select v from ids where k = 'i2'), '00000000-0000-4000-8000-000000000001', (select v from ids where k = 'rc'), 2, 'T075PRP', 'LEGGING TESTE PRETO P', '61046200', 1, 100, 100),
  ((select v from ids where k = 'i3'), '00000000-0000-4000-8000-000000000001', (select v from ids where k = 'rc'), 3, 'T075PRM', 'LEGGING TESTE PRETO M', '61046200', 1, 100, 100);

-- ---------- Vendedora não liga nota ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');
select throws_ok($$ select ai.assistant_propose(jsonb_build_object('tool', 'vincular_nota', 'args', jsonb_build_object('receipt_id', (select v from ids where k = 'rc'), 'itens', '[]'::jsonb))) $$,
                 '42501', null, 'vendedora sem purch.write não propõe o vínculo da nota');

-- ---------- Sócio: liga um item a peça existente e cria um produto novo com 2 variações ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
insert into ids select 'a', (ai.assistant_propose(jsonb_build_object('tool', 'vincular_nota', 'summary', 'Vincular NF-e 7501', 'preview', '{}'::jsonb, 'args', jsonb_build_object(
  'receipt_id', (select v from ids where k = 'rc'), 'itens', jsonb_build_array(
    jsonb_build_object('item_id', (select v from ids where k = 'i1'), 'variant_id', (select v from ids where k = 'var')),
    jsonb_build_object('item_id', (select v from ids where k = 'i2'), 'reference', 'T075', 'name', 'Legging Teste', 'gender', 'FEM', 'color', 'Preto', 'size', 'P', 'price', 199),
    jsonb_build_object('item_id', (select v from ids where k = 'i3'), 'reference', 'T075', 'name', 'Legging Teste', 'gender', 'FEM', 'color', 'Preto', 'size', 'M', 'price', 199)))))).id;
select is((select count(*)::int from purch.receipt_items where receipt_id = (select v from ids where k = 'rc') and variant_id is not null), 0, 'nada muda antes do clique');
insert into kv select 'r', ai.assistant_execute((select v from ids where k = 'a'));
select is((select v ->> 'ok' from kv where k = 'r'), 'true', 'a pessoa confirma e o vínculo acontece');
select is((select count(*)::int from catalog.products where reference_code = 'T075'), 1, 'a mesma referência vira UM produto (não um por linha da nota)');
select is((select count(*)::int from catalog.variants v join catalog.products p on p.id = v.product_id where p.reference_code = 'T075'), 2, 'com as duas variações (P e M)');
select is((select count(*)::int from purch.receipt_items where receipt_id = (select v from ids where k = 'rc') and variant_id is not null), 3, 'os 3 itens ficam ligados');
select is((select variant_id from purch.receipt_items where id = (select v from ids where k = 'i1')), (select v from ids where k = 'var'), 'o item 1 vai para a peça escolhida');
select is((select status from purch.receipts where id = (select v from ids where k = 'rc')), 'PENDING_CHECK', 'a nota não é lançada no estoque pelo cartão');
select is((select v -> 'result' ->> 'href' from kv where k = 'r'), '/produtos/recebimento/' || (select v from ids where k = 'rc'), 'o cartão leva ao recebimento');

select * from finish();
rollback;
