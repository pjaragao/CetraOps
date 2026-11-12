begin;
create extension if not exists pgtap with schema extensions;
select plan(13);

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

-- ---------- Preparação: uma nota com duas peças e outra nota só para provar o isolamento ----------
insert into purch.receipts (id, org_id, legal_entity_id, location_id, supplier_party_id, number, nf_total, status)
select v.id, '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000b1',
       (select id from crm.parties order by created_at limit 1), v.num, 300, 'PENDING_CHECK'
  from (values ('00000000-0000-4000-8000-0000000082a1'::uuid, '8201'), ('00000000-0000-4000-8000-0000000082a2'::uuid, '8202')) v(id, num);
insert into purch.receipt_items (id, org_id, receipt_id, n_item, supplier_cprod, cean, description, qty_nfe, item_total) values
  ('00000000-0000-4000-8000-0000000082b1', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000082a1', 1, 'S1-082', '7891234500082', 'PECA S1', 1, 100),
  ('00000000-0000-4000-8000-0000000082b2', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000082a1', 2, 'S2-082', '7891234500083', 'PECA S2', 2, 200);
-- leitura de outra nota (não pode ser resolvida pelo link da primeira)
with ins as (
  insert into purch.receipt_scan_events (org_id, receipt_id, code, qty, result)
  values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000082a2', 'OUTRA', 1, '{"status":"UNKNOWN","code":"OUTRA"}') returning id)
insert into kv select 'other', to_jsonb(id) from ins;

-- ---------- Vendedora não resolve sobra ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');
select throws_ok($$ select purch.discard_scan_extras(array[1::bigint]) $$, '42501', null, 'sem purch.write não resolve sobra');

-- ---------- Sócio bipa: a nota recebe o que cabe e o resto fica guardado como sobra ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select purch.scan_receipt_code('00000000-0000-4000-8000-0000000082a1', '7891234500082');                      -- ok (1/1)
insert into kv select 'e1', purch.scan_receipt_code('00000000-0000-4000-8000-0000000082a1', '7891234500082', 2);  -- sobra de 2
select purch.scan_receipt_code('00000000-0000-4000-8000-0000000082a1', '7891234500082');                      -- sobra de 1
select purch.scan_receipt_code('00000000-0000-4000-8000-0000000082a1', '7891234500083', 3);                   -- cabem 2, sobra 1
select purch.scan_receipt_code('00000000-0000-4000-8000-0000000082a1', 'ZZZ-082', 2);                         -- código desconhecido
select purch.scan_receipt_code('00000000-0000-4000-8000-0000000082a1', (select sku from catalog.variants where active order by sku limit 1));   -- peça do catálogo fora da nota

select is(jsonb_array_length(purch.receipts_extras(array['00000000-0000-4000-8000-0000000082a1'::uuid])), 4, 'as sobras ficam guardadas: 4 pendências (sobra, sobra, desconhecida, fora da nota)');
select is((select (e ->> 'qty')::numeric from jsonb_array_elements(purch.receipts_extras(array['00000000-0000-4000-8000-0000000082a1'::uuid])) e
            where e ->> 'kind' = 'EXCESS' and jsonb_array_length(e -> 'events') = 2), 3::numeric, 'a mesma peça lida a mais várias vezes soma numa linha só (2 + 1)');
select is((select (e ->> 'qty')::numeric from jsonb_array_elements(purch.receipts_extras(array['00000000-0000-4000-8000-0000000082a1'::uuid])) e
            where e ->> 'kind' = 'EXCESS' and jsonb_array_length(e -> 'events') = 1), 1::numeric, 'leitura que coube em parte guarda só o que passou (1)');
select is((select (e ->> 'qty')::numeric from jsonb_array_elements(purch.receipts_extras(array['00000000-0000-4000-8000-0000000082a1'::uuid])) e where e ->> 'kind' = 'UNKNOWN'), 2::numeric, 'código desconhecido ×2');
select is((select (e ->> 'qty')::numeric from jsonb_array_elements(purch.receipts_extras(array['00000000-0000-4000-8000-0000000082a1'::uuid])) e where e ->> 'kind' = 'NOT_IN_NOTE'), 1::numeric, 'peça fora da nota ×1');
select is(jsonb_array_length(purch.receipt_scan_feed('00000000-0000-4000-8000-0000000082a1', 0) -> 'extras'), 4, 'o acompanhamento da nota traz as sobras');
select is(jsonb_array_length(purch.receipts_scan_feed(array['00000000-0000-4000-8000-0000000082a1'::uuid], 0) -> 'extras'), 4, 'e o das notas juntas também');

-- ---------- Resolver ----------
insert into kv select 'unk', e -> 'events' from jsonb_array_elements(purch.receipts_extras(array['00000000-0000-4000-8000-0000000082a1'::uuid])) e where e ->> 'kind' = 'UNKNOWN';
select is(purch.discard_scan_extras(array[((select v from kv where k = 'e1') ->> 'event_id')::bigint]), 1, 'resolver a leitura de 2 a mais');
select is((select count(*)::int from jsonb_array_elements(purch.receipts_extras(array['00000000-0000-4000-8000-0000000082a1'::uuid])) e where e ->> 'kind' = 'EXCESS' and (e ->> 'qty')::numeric = 1), 2,
          'a sobra resolvida sai e as outras ficam (duas linhas de 1)');
select is(purch.discard_scan_extras(array[((select v from kv where k = 'e1') ->> 'event_id')::bigint]), 0, 'resolver de novo não faz nada');

-- ---------- Celular do link ----------
insert into kv select 'link', purch.create_scan_link('00000000-0000-4000-8000-0000000082a1', 'Celular da Ana', 4);
select pg_temp.anon();
select is(public.receipt_link_discard((select v ->> 'token' from kv where k = 'link'), array(select x::bigint from jsonb_array_elements_text((select v from kv where k = 'unk')) x)), 1, 'o celular resolve a leitura desconhecida');
select is(public.receipt_link_discard((select v ->> 'token' from kv where k = 'link'), array[(select (v #>> '{}')::bigint from kv where k = 'other')]), 0, 'e não resolve leitura de outra nota');

select * from finish();
rollback;
