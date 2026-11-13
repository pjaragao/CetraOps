begin;
create extension if not exists pgtap with schema extensions;
select plan(6);

create or replace function pg_temp.login(p_user uuid) returns void language plpgsql as $$
declare m record;
begin
  select id, org_id into m from core.members where user_id = p_user;
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated',
    'app_metadata', json_build_object('org_id', m.org_id, 'member_id', m.id))::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
grant execute on function pg_temp.login(uuid) to authenticated, anon;

-- Sete notas do mesmo fornecedor:
--  R1, R2, R3: bipadas JUNTAS (a peça X está em R1 e R2, a peça Y em R2 e R3) → um lote só (R1+R2+R3)
--  R4: bipada sozinha → sem lote
--  R6, R7: sem leitura, mas um link de celular cobria as duas → lote (R6+R7)
insert into purch.receipts (id, org_id, legal_entity_id, location_id, supplier_party_id, number, nf_total, status)
select v.id, '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000b1',
       (select id from crm.parties order by created_at limit 1), v.num, 100, 'PENDING_CHECK'
  from (values ('00000000-0000-4000-8000-0000000087a1'::uuid, '8701'), ('00000000-0000-4000-8000-0000000087a2'::uuid, '8702'), ('00000000-0000-4000-8000-0000000087a3'::uuid, '8703'),
               ('00000000-0000-4000-8000-0000000087a4'::uuid, '8704'), ('00000000-0000-4000-8000-0000000087a6'::uuid, '8706'), ('00000000-0000-4000-8000-0000000087a7'::uuid, '8707')) v(id, num);
insert into purch.receipt_items (id, org_id, receipt_id, n_item, supplier_cprod, cean, description, qty_nfe, item_total) values
  ('00000000-0000-4000-8000-0000000087b1', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000087a1', 1, 'X-087', '7891234500871', 'PECA X NA 1', 2, 100),
  ('00000000-0000-4000-8000-0000000087b2', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000087a2', 1, 'X-087', '7891234500871', 'PECA X NA 2', 2, 100),
  ('00000000-0000-4000-8000-0000000087b3', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000087a2', 2, 'Y-087', '7891234500872', 'PECA Y NA 2', 2, 100),
  ('00000000-0000-4000-8000-0000000087b4', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000087a3', 1, 'Y-087', '7891234500872', 'PECA Y NA 3', 2, 100),
  ('00000000-0000-4000-8000-0000000087b5', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000087a4', 1, 'Z-087', '7891234500873', 'PECA Z NA 4', 2, 100);

select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select purch.scan_receipts_code(array['00000000-0000-4000-8000-0000000087a1'::uuid, '00000000-0000-4000-8000-0000000087a2'::uuid, '00000000-0000-4000-8000-0000000087a3'::uuid], '7891234500871');
select purch.scan_receipts_code(array['00000000-0000-4000-8000-0000000087a1'::uuid, '00000000-0000-4000-8000-0000000087a2'::uuid, '00000000-0000-4000-8000-0000000087a3'::uuid], '7891234500872');
select purch.scan_receipts_code(array['00000000-0000-4000-8000-0000000087a4'::uuid], '7891234500873');
select purch.create_scan_link('00000000-0000-4000-8000-0000000087a6', 'Celular', 4, array['00000000-0000-4000-8000-0000000087a7'::uuid]);

-- ---------- Recupera os lotes (como dono do banco, como a migração) ----------
reset role;
select ok(private.backfill_receipt_batches() >= 2, 'recupera os lotes que estavam em andamento');
select is((select cardinality(receipt_ids) from purch.receipt_batches where receipt_ids @> array['00000000-0000-4000-8000-0000000087a1'::uuid] and status = 'OPEN'), 3, 'as 3 notas bipadas juntas voltam como um lote só (R1+R2+R3, ligadas pelas peças em comum)');
select is((select count(*)::int from purch.receipt_batches where receipt_ids @> array['00000000-0000-4000-8000-0000000087a4'::uuid]), 0, 'nota bipada sozinha não vira lote');
select is((select cardinality(receipt_ids) from purch.receipt_batches where receipt_ids @> array['00000000-0000-4000-8000-0000000087a6'::uuid] and status = 'OPEN'), 2, 'link do celular que cobria 2 notas também volta como lote');
select is(private.backfill_receipt_batches(), 0, 'rodar de novo não duplica');

-- aparece na lista
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select ok(exists (select 1 from jsonb_array_elements(purch.receipt_batches_overview()) b where jsonb_array_length(b -> 'notes') = 3), 'e aparece em "Entradas em andamento"');

select * from finish();
rollback;
