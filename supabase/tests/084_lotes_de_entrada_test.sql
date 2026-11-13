begin;
create extension if not exists pgtap with schema extensions;
select plan(12);

create or replace function pg_temp.login(p_user uuid) returns void language plpgsql as $$
declare m record;
begin
  select id, org_id into m from core.members where user_id = p_user;
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated',
    'app_metadata', json_build_object('org_id', m.org_id, 'member_id', m.id))::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
grant execute on function pg_temp.login(uuid) to authenticated, anon;
create temp table kv (k text primary key, v jsonb);
grant all on kv to authenticated;

-- ---------- Preparação: três notas do mesmo fornecedor; a C já lançada ----------
insert into purch.receipts (id, org_id, legal_entity_id, location_id, supplier_party_id, number, nf_total, status)
select v.id, '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000b1',
       (select id from crm.parties order by created_at limit 1), v.num, 300, v.st
  from (values ('00000000-0000-4000-8000-0000000084a1'::uuid, '8401', 'PENDING_CHECK'), ('00000000-0000-4000-8000-0000000084a2'::uuid, '8402', 'PENDING_CHECK'),
               ('00000000-0000-4000-8000-0000000084a3'::uuid, '8403', 'POSTED')) v(id, num, st);
insert into purch.receipt_items (id, org_id, receipt_id, n_item, supplier_cprod, description, qty_nfe, qty_counted, item_total) values
  ('00000000-0000-4000-8000-0000000084b1', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000084a1', 1, 'L1-084', 'ITEM A', 4, 1, 400),
  ('00000000-0000-4000-8000-0000000084b2', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000084a2', 1, 'L2-084', 'ITEM B', 2, 2, 200);

-- ---------- Vendedora não abre lote ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');
select throws_ok($$ select purch.open_receipt_batch(array['00000000-0000-4000-8000-0000000084a1'::uuid, '00000000-0000-4000-8000-0000000084a2'::uuid]) $$, '42501', null, 'sem purch.write não abre lote');

-- ---------- Sócio: o lote fica salvo ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
insert into kv select 'b1', to_jsonb(purch.open_receipt_batch(array['00000000-0000-4000-8000-0000000084a1'::uuid, '00000000-0000-4000-8000-0000000084a2'::uuid]));
select ok((select v #>> '{}' from kv where k = 'b1') is not null, 'abre o lote com as duas notas');
select is(to_jsonb(purch.open_receipt_batch(array['00000000-0000-4000-8000-0000000084a1'::uuid, '00000000-0000-4000-8000-0000000084a2'::uuid])), (select v from kv where k = 'b1'), 'marcar as mesmas notas de novo reabre o MESMO lote');
select is(to_jsonb(purch.open_receipt_batch(array['00000000-0000-4000-8000-0000000084a2'::uuid, '00000000-0000-4000-8000-0000000084a1'::uuid])), (select v from kv where k = 'b1'), 'a ordem em que as notas foram marcadas não importa');
select throws_ok($$ select purch.open_receipt_batch(array['00000000-0000-4000-8000-0000000084a1'::uuid]) $$, 'P0086', null, 'um lote precisa de pelo menos 2 notas');
select throws_ok($$ select purch.open_receipt_batch(array['00000000-0000-4000-8000-0000000084a1'::uuid, '00000000-0000-4000-8000-0000000084a3'::uuid]) $$, 'P0086', null, 'nota já lançada não conta para o lote');
select is(jsonb_array_length(purch.get_receipt_batch((select (v #>> '{}')::uuid from kv where k = 'b1')) -> 'receipt_ids'), 2, 'o lote guarda as duas notas');

-- ---------- Lista de recebimentos ----------
select is(jsonb_array_length(purch.receipt_batches_overview()), 1, 'o lote aparece na lista enquanto não for finalizado');
select is(jsonb_array_length(purch.receipt_batches_overview() -> 0 -> 'notes'), 2, 'com o andamento das duas notas');
select is((select sum((n ->> 'counted')::numeric) from jsonb_array_elements(purch.receipt_batches_overview() -> 0 -> 'notes') n), 3::numeric, 'e quanto já foi bipado (1 + 2)');

-- ---------- Finalizar ----------
select purch.finish_receipt_batch((select (v #>> '{}')::uuid from kv where k = 'b1'));
select is(jsonb_array_length(purch.receipt_batches_overview()), 0, 'lote finalizado sai da lista');

-- ---------- Lançadas todas: o lote some sozinho ----------
insert into kv select 'b2', to_jsonb(purch.open_receipt_batch(array['00000000-0000-4000-8000-0000000084a1'::uuid, '00000000-0000-4000-8000-0000000084a2'::uuid]));
reset role;
update purch.receipts set status = 'POSTED' where id in ('00000000-0000-4000-8000-0000000084a1', '00000000-0000-4000-8000-0000000084a2');
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select is(jsonb_array_length(purch.receipt_batches_overview()), 0, 'lote cujas notas foram todas lançadas encerra sozinho');

select * from finish();
rollback;
