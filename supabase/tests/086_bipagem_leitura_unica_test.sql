begin;
create extension if not exists pgtap with schema extensions;
select plan(10);

create or replace function pg_temp.login(p_user uuid) returns void language plpgsql as $$
declare m record;
begin
  select id, org_id into m from core.members where user_id = p_user;
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated',
    'app_metadata', json_build_object('org_id', m.org_id, 'member_id', m.id))::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create or replace function pg_temp.anon() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform set_config('role', 'anon', true);
end $$;
grant execute on function pg_temp.login(uuid), pg_temp.anon() to authenticated, anon;
create temp table kv (k text primary key, v jsonb);
grant all on kv to authenticated, anon;

-- Nota com uma peça que pede 10; nenhuma contada
insert into purch.receipts (id, org_id, legal_entity_id, location_id, supplier_party_id, number, nf_total, status)
values ('00000000-0000-4000-8000-0000000086a1', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000b1',
        (select id from crm.parties order by created_at limit 1), '8601', 1000, 'PENDING_CHECK');
insert into purch.receipt_items (id, org_id, receipt_id, n_item, supplier_cprod, cean, description, qty_nfe, item_total) values
  ('00000000-0000-4000-8000-0000000086b1', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000086a1', 1, 'U1-086', '7891234500090', 'PECA UNICA', 10, 1000);

select pg_temp.login('00000000-0000-4000-8000-0000000000f1');

-- ---------- Bipar: o mesmo id reenviado não soma de novo ----------
insert into kv select 's1', purch.scan_receipts_code(array['00000000-0000-4000-8000-0000000086a1'::uuid], '7891234500090', 1, '00000000-0000-4000-8000-00000000c0a1');
select is((select v ->> 'status' from kv where k = 's1'), 'OK', 'primeira leitura com id soma');
insert into kv select 's1b', purch.scan_receipts_code(array['00000000-0000-4000-8000-0000000086a1'::uuid], '7891234500090', 1, '00000000-0000-4000-8000-00000000c0a1');
select is((select (v ->> 'duplicate')::boolean from kv where k = 's1b'), true, 'o mesmo id de novo é reconhecido como reenvio');
select is((select qty_counted from purch.receipt_items where id = '00000000-0000-4000-8000-0000000086b1'), 1::numeric, 'e NÃO soma outra vez (continua 1)');
select is((select v ->> 'event_id' from kv where k = 's1b'), (select v ->> 'event_id' from kv where k = 's1'), 'devolve o mesmo resultado de antes');
select purch.scan_receipts_code(array['00000000-0000-4000-8000-0000000086a1'::uuid], '7891234500090', 1, '00000000-0000-4000-8000-00000000c0a2');
select is((select qty_counted from purch.receipt_items where id = '00000000-0000-4000-8000-0000000086b1'), 2::numeric, 'outro id é outra leitura: soma');
select purch.scan_receipts_code(array['00000000-0000-4000-8000-0000000086a1'::uuid], '7891234500090');
select is((select qty_counted from purch.receipt_items where id = '00000000-0000-4000-8000-0000000086b1'), 3::numeric, 'sem id continua funcionando como antes');

-- ---------- Revisar: mesma regra ----------
insert into kv select 'r1', purch.review_receipts_code(array['00000000-0000-4000-8000-0000000086a1'::uuid], '7891234500090', 1, '00000000-0000-4000-8000-00000000c0b1');
select is((select v ->> 'status' from kv where k = 'r1'), 'OK', 'releitura com id confere');
select purch.review_receipts_code(array['00000000-0000-4000-8000-0000000086a1'::uuid], '7891234500090', 1, '00000000-0000-4000-8000-00000000c0b1');
select is((select qty_reviewed from purch.receipt_items where id = '00000000-0000-4000-8000-0000000086b1'), 1::numeric, 'releitura reenviada não confere duas vezes');

-- ---------- Celular do link ----------
insert into kv select 'link', purch.create_scan_link('00000000-0000-4000-8000-0000000086a1', 'Celular da Ana', 4);
select pg_temp.anon();
select public.receipt_link_scan((select v ->> 'token' from kv where k = 'link'), '7891234500090', 1, '00000000-0000-4000-8000-00000000c0c1');
select public.receipt_link_scan((select v ->> 'token' from kv where k = 'link'), '7891234500090', 1, '00000000-0000-4000-8000-00000000c0c1');
reset role;
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select is((select qty_counted from purch.receipt_items where id = '00000000-0000-4000-8000-0000000086b1'), 4::numeric, 'o celular que reenviou a leitura (rede lenta) soma uma vez só');

-- ---------- Os ids guardados não são lidos pela API ----------
select throws_ok($$ select * from purch.scan_dedup $$, '42501', null, 'a tabela de ids das leituras não pode ser lida pela API');

select * from finish();
rollback;
