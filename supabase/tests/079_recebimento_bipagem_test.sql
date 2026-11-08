begin;
create extension if not exists pgtap with schema extensions;
select plan(20);

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

-- ---------- Preparação: NF-e em recebimento com 5 linhas ----------
insert into ids select 'var', id from catalog.variants where product_id = '00000000-0000-4000-8000-000000000401' order by size limit 1;
insert into ids select 'outra', id from catalog.variants where id <> (select v from ids where k = 'var') and active order by sku limit 1;
insert into ids select 'forn', id from crm.parties order by created_at limit 1;
insert into ids values ('rc', '00000000-0000-4000-8000-0000000079a1'), ('i1', '00000000-0000-4000-8000-0000000079b1'), ('i2', '00000000-0000-4000-8000-0000000079b2'),
                       ('i3', '00000000-0000-4000-8000-0000000079b3'), ('i4', '00000000-0000-4000-8000-0000000079b4'), ('i5', '00000000-0000-4000-8000-0000000079b5');
insert into purch.receipts (id, org_id, legal_entity_id, location_id, supplier_party_id, number, nf_total, status)
values ((select v from ids where k = 'rc'), '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000e1',
        '00000000-0000-4000-8000-0000000000b1', (select v from ids where k = 'forn'), '7901', 800, 'CHECKED');
insert into purch.receipt_items (id, org_id, receipt_id, n_item, supplier_cprod, cean, description, qty_nfe, item_total, variant_id) values
  ((select v from ids where k = 'i1'), '00000000-0000-4000-8000-000000000001', (select v from ids where k = 'rc'), 1, 'A1', '7891234567895', 'PECA EAN', 2, 200, null),
  ((select v from ids where k = 'i2'), '00000000-0000-4000-8000-000000000001', (select v from ids where k = 'rc'), 2, 'CP-079', null, 'PECA CPROD', 3, 300, null),
  ((select v from ids where k = 'i3'), '00000000-0000-4000-8000-000000000001', (select v from ids where k = 'rc'), 3, 'A3', 'SEM GTIN', 'PECA LIGADA', 1, 100, (select v from ids where k = 'var')),
  ((select v from ids where k = 'i4'), '00000000-0000-4000-8000-000000000001', (select v from ids where k = 'rc'), 4, 'A4', '7891111111110', 'MESMA PECA L1', 1, 100, null),
  ((select v from ids where k = 'i5'), '00000000-0000-4000-8000-000000000001', (select v from ids where k = 'rc'), 5, 'A5', '7891111111110', 'MESMA PECA L2', 1, 100, null);

-- ---------- Vendedora não bipa entrada ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');
select throws_ok($$ select purch.scan_receipt_code((select v from ids where k = 'rc'), '7891234567895') $$, '42501', null, 'sem purch.write não bipa a entrada');

-- ---------- Sócio bipa ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
insert into kv select 'a', purch.scan_receipt_code((select v from ids where k = 'rc'), ' 7891234567895 ');
select is((select v ->> 'status' from kv where k = 'a'), 'OK', 'EAN da nota: lida e somada');
select is((select (v ->> 'qty_counted')::numeric from kv where k = 'a'), 1::numeric, 'o item fica com 1 conferida');
select is((select status from purch.receipts where id = (select v from ids where k = 'rc')), 'PENDING_CHECK', 'bipar reabre a conferência confirmada');
select purch.scan_receipt_code((select v from ids where k = 'rc'), '7891234567895');
insert into kv select 'b', purch.scan_receipt_code((select v from ids where k = 'rc'), '7891234567895');
select is((select v ->> 'status' from kv where k = 'b'), 'EXCESS', 'passou da nota: sobra');
select is((select qty_counted from purch.receipt_items where id = (select v from ids where k = 'i1')), 2::numeric, 'a sobra não entra na contagem');

insert into kv select 'c', purch.scan_receipt_code((select v from ids where k = 'rc'), 'cp-079', 5);
select is((select v ->> 'status' from kv where k = 'c'), 'PARTIAL_EXCESS', 'código do fornecedor (sem diferenciar maiúsculas) com ×5 em item de 3');
select is((select array[(v ->> 'added')::numeric, (v ->> 'excess')::numeric] from kv where k = 'c'), array[3, 2]::numeric[], 'soma 3 e avisa 2 a mais');

insert into kv select 'd', purch.scan_receipt_code((select v from ids where k = 'rc'), (select lower(sku) from catalog.variants where id = (select v from ids where k = 'var')));
select is((select v ->> 'item_id' from kv where k = 'd'), (select v::text from ids where k = 'i3'), 'SKU da etiqueta acha o item ligado à peça');
select ok((select v ->> 'label' from kv where k = 'd') is not null, 'devolve nome · cor · tamanho da peça');

select purch.scan_receipt_code((select v from ids where k = 'rc'), '7891111111110');
insert into kv select 'e', purch.scan_receipt_code((select v from ids where k = 'rc'), '7891111111110');
select is((select v ->> 'item_id' from kv where k = 'e'), (select v::text from ids where k = 'i5'), 'mesma peça em duas linhas: enche a primeira e passa para a segunda');

select is((select purch.scan_receipt_code((select v from ids where k = 'rc'), 'NAO-EXISTE-079') ->> 'status'), 'UNKNOWN', 'código desconhecido');
select is((select purch.scan_receipt_code((select v from ids where k = 'rc'), (select sku from catalog.variants where id = (select v from ids where k = 'outra'))) ->> 'status'),
          'NOT_IN_NOTE', 'peça do catálogo que não está na nota');
select throws_ok($$ select purch.scan_receipt_code((select v from ids where k = 'rc'), '') $$, 'P0086', null, 'código vazio é recusado');

-- ---------- Ajustes +/− e desfazer ----------
select is((select (purch.bump_receipt_item((select v from ids where k = 'i2'), -1) ->> 'qty_counted')::numeric), 2::numeric, 'menos uma peça');
select throws_ok($$ select purch.bump_receipt_item((select v from ids where k = 'i2'), 2) $$, 'P0085', null, '+ não passa da quantidade da nota');
select is((select (purch.bump_receipt_item((select v from ids where k = 'i2'), -10) ->> 'qty_counted')::numeric), 0::numeric, '− para no zero');
select throws_ok($$ select purch.bump_receipt_item((select v from ids where k = 'i2'), 0) $$, 'P0086', null, 'delta zero é recusado');

-- ---------- Nota já lançada ----------
reset role;
update purch.receipts set status = 'POSTED' where id = (select v from ids where k = 'rc');
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select throws_ok($$ select purch.scan_receipt_code((select v from ids where k = 'rc'), '7891234567895') $$, 'P0083', null, 'nota lançada não recebe leitura');
select throws_ok($$ select purch.bump_receipt_item((select v from ids where k = 'i1'), -1) $$, 'P0083', null, 'nem ajuste');

select * from finish();
rollback;
