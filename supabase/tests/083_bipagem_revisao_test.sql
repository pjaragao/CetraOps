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
create or replace function pg_temp.anon() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform set_config('role', 'anon', true);
end $$;
grant execute on function pg_temp.login(uuid), pg_temp.anon() to authenticated, anon;
create temp table kv (k text primary key, v jsonb);
grant all on kv to authenticated, anon;

-- ---------- Preparação ----------
-- Nota R: peça A pede 3 e já tem 2 bipadas · peça B pede 2 e não foi bipada · peça C pede 1 e já tem 1.
-- Nota R2: a mesma peça A (pede 2, 1 bipada).
insert into purch.receipts (id, org_id, legal_entity_id, location_id, supplier_party_id, number, nf_total, status)
select v.id, '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000b1',
       (select id from crm.parties order by created_at limit 1), v.num, 300, 'PENDING_CHECK'
  from (values ('00000000-0000-4000-8000-0000000083a1'::uuid, '8301'), ('00000000-0000-4000-8000-0000000083a2'::uuid, '8302')) v(id, num);
insert into purch.receipt_items (id, org_id, receipt_id, n_item, supplier_cprod, cean, description, qty_nfe, qty_counted, item_total) values
  ('00000000-0000-4000-8000-0000000083b1', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000083a1', 1, 'RA-083', '7891234500084', 'PECA A', 3, 2, 300),
  ('00000000-0000-4000-8000-0000000083b2', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000083a1', 2, 'RB-083', '7891234500085', 'PECA B', 2, null, 200),
  ('00000000-0000-4000-8000-0000000083b3', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000083a1', 3, 'RC-083', '7891234500086', 'PECA C', 1, 1, 100),
  ('00000000-0000-4000-8000-0000000083b4', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000083a2', 1, 'RA-083', '7891234500084', 'PECA A NA OUTRA', 2, 1, 200);

-- ---------- Vendedora não revisa ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');
select throws_ok($$ select purch.review_receipts_code(array['00000000-0000-4000-8000-0000000083a1'::uuid], '7891234500084') $$, '42501', null, 'sem purch.write não revisa');

-- ---------- Sócio revisa: bipa de novo e compara com o que foi lançado ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
insert into kv select 'a1', purch.review_receipts_code(array['00000000-0000-4000-8000-0000000083a1'::uuid], '7891234500084');
select is((select v ->> 'status' from kv where k = 'a1'), 'OK', 'primeira releitura confere');
select is((select (v ->> 'qty_reviewed')::numeric || '/' || (v ->> 'qty_counted')::numeric from kv where k = 'a1'), '1/2', 'mostra revisadas/contadas (1/2)');
select purch.review_receipts_code(array['00000000-0000-4000-8000-0000000083a1'::uuid], '7891234500084');
-- a nota ainda aceita mais 1 da peça A (3 pedidas, 2 contadas): a 3ª leitura é só aviso, não vira sobra
select is((select purch.review_receipts_code(array['00000000-0000-4000-8000-0000000083a1'::uuid], '7891234500084') ->> 'status'), 'OVER', 'bipou mais vezes do que foi lançado, mas cabe na nota: só avisa');
select is((select qty_counted from purch.receipt_items where id = '00000000-0000-4000-8000-0000000083b1'), 2::numeric, 'a revisão não muda a contagem');
select is((select purch.review_receipts_code(array['00000000-0000-4000-8000-0000000083a1'::uuid], '7891234500085') ->> 'status'), 'NOT_COUNTED', 'peça da nota que não tinha sido bipada');

-- ---------- Sobras e peças fora da NF: a revisão confere e guarda separado dos itens ----------
-- peça C: pede 1, 1 contada; releitura de 2 → confere 1 e a outra chegou além da nota: vira sobra registrada
insert into kv select 'c', purch.review_receipts_code(array['00000000-0000-4000-8000-0000000083a1'::uuid], '7891234500086', 2);
select is((select v ->> 'status' from kv where k = 'c'), 'EXTRA_OK', 'a peça que passou da nota fica registrada como sobra');
select is((select (v ->> 'added')::numeric || '/' || (v -> 'extra' ->> 'qty') from kv where k = 'c'), '1/1', '1 confere na nota e 1 vai para a sobra');
-- código que ninguém conhece: registrado como fora da NF
insert into kv select 'u', purch.review_receipts_code(array['00000000-0000-4000-8000-0000000083a1'::uuid], 'ZZZ-083');
select is((select v ->> 'status' || '/' || (v -> 'extra' ->> 'kind') from kv where k = 'u'), 'EXTRA_OK/UNKNOWN', 'código desconhecido na revisão fica registrado (não se perde)');
-- sobra que já estava registrada: a releitura confere
select purch.scan_receipts_code(array['00000000-0000-4000-8000-0000000083a1'::uuid], 'ZZZ2-083', 2);
insert into kv select 'z', purch.review_receipts_code(array['00000000-0000-4000-8000-0000000083a1'::uuid], 'ZZZ2-083');
select is((select (v -> 'extra' ->> 'reviewed') || '/' || (v -> 'extra' ->> 'qty') from kv where k = 'z'), '1/2', 'releitura de sobra já registrada confere 1 de 2');
select purch.review_receipts_code(array['00000000-0000-4000-8000-0000000083a1'::uuid], 'ZZZ2-083');
select is((select (e ->> 'reviewed')::numeric from jsonb_array_elements(purch.receipts_extras(array['00000000-0000-4000-8000-0000000083a1'::uuid])) e where e ->> 'code' = 'ZZZ2-083'), 2::numeric, 'a lista de sobras traz quanto já foi conferido');
insert into kv select 'n', purch.review_receipts_code(array['00000000-0000-4000-8000-0000000083a1'::uuid], (select sku from catalog.variants where active order by sku limit 1));
select is((select v -> 'extra' ->> 'kind' from kv where k = 'n'), 'NOT_IN_NOTE', 'peça do catálogo que não está na nota também fica registrada');

-- várias notas: a peça A já está toda revisada na R, então a releitura vai para a R2
insert into kv select 'g', purch.review_receipts_code(array['00000000-0000-4000-8000-0000000083a1'::uuid, '00000000-0000-4000-8000-0000000083a2'::uuid], '7891234500084');
select is((select v -> 'allocations' -> 0 ->> 'receipt_id' from kv where k = 'g'), '00000000-0000-4000-8000-0000000083a2', 'várias notas: confere na nota que ainda tem contagem por revisar');

-- não mexe no andamento da nota
reset role;
update purch.receipts set status = 'CHECKED' where id = '00000000-0000-4000-8000-0000000083a1';
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select purch.review_receipts_code(array['00000000-0000-4000-8000-0000000083a1'::uuid], '7891234500086');
select is((select status from purch.receipts where id = '00000000-0000-4000-8000-0000000083a1'), 'CHECKED', 'a revisão não reabre a conferência');
select ok((purch.receipt_scan_feed('00000000-0000-4000-8000-0000000083a1', 0) -> 'items' -> 0) ? 'qty_reviewed', 'o acompanhamento traz o que já foi revisado');

-- zerar
select is(purch.reset_receipts_review(array['00000000-0000-4000-8000-0000000083a1'::uuid, '00000000-0000-4000-8000-0000000083a2'::uuid]), 3, 'zerar a revisão limpa as 3 linhas de itens revisadas');
select is((select coalesce(sum(qty_reviewed), 0) from purch.receipt_items where receipt_id in ('00000000-0000-4000-8000-0000000083a1', '00000000-0000-4000-8000-0000000083a2')), 0::numeric, 'a contagem segue igual: só a revisão dos itens zera');
select is((select coalesce(sum(reviewed_qty), 0) from purch.receipt_scan_events where receipt_id in ('00000000-0000-4000-8000-0000000083a1', '00000000-0000-4000-8000-0000000083a2')), 0::numeric, 'e a revisão das sobras também');

-- ---------- Celular do link ----------
insert into kv select 'link', purch.create_scan_link('00000000-0000-4000-8000-0000000083a1', 'Celular da Ana', 4);
select pg_temp.anon();
select is((select public.receipt_link_review((select v ->> 'token' from kv where k = 'link'), '7891234500084') ->> 'status'), 'OK', 'o celular também revisa pelo link');
select is(public.receipt_link_review_reset((select v ->> 'token' from kv where k = 'link')), 1, 'e zera a revisão pelo link');

select * from finish();
rollback;
