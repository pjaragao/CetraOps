begin;
create extension if not exists pgtap with schema extensions;
select plan(31);

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

-- ---------- Preparação ----------
-- Nota R: item 1 pede 3 da peça A (R$ 100 cada, nenhuma contada) · item 2 pede 1 de outra peça (já contada).
-- Nota R2: pede 2 da peça B, ainda sem contagem (para vincular a entrada sem NF).
-- Chegaram 2 peças B que NÃO estão na nota R: ficam como "fora da nota".
insert into kv select 'va', to_jsonb(id) from (select id from catalog.variants where active order by sku limit 1) x;
insert into kv select 'vb', to_jsonb(id) from (select id from catalog.variants where active order by sku offset 1 limit 1) x;
insert into purch.receipts (id, org_id, legal_entity_id, location_id, supplier_party_id, number, nf_total, status)
select v.id, '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000b1',
       (select id from crm.parties order by created_at limit 1), v.num, 400, 'PENDING_CHECK'
  from (values ('00000000-0000-4000-8000-0000000085a1'::uuid, '8501'), ('00000000-0000-4000-8000-0000000085a2'::uuid, '8502')) v(id, num);
insert into purch.receipt_items (id, org_id, receipt_id, n_item, supplier_cprod, description, qty_nfe, qty_counted, unit_cost_nfe, item_total, landed_unit_cost, variant_id) values
  ('00000000-0000-4000-8000-0000000085b1', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000085a1', 1, 'F1-085', 'ITEM FALTANTE', 3, 0, 100, 300, 100, (select (v #>> '{}')::uuid from kv where k = 'va')),
  ('00000000-0000-4000-8000-0000000085b2', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000085a1', 2, 'F2-085', 'ITEM CONTADO', 1, 1, 100, 100, 100, null),
  ('00000000-0000-4000-8000-0000000085b3', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000085a2', 1, 'J1-085', 'ITEM DA OUTRA NOTA', 2, 0, 50, 100, 50, (select (v #>> '{}')::uuid from kv where k = 'vb'));

-- ---------- Vendedora não resolve ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');
select throws_ok($$ select purch.resolve_extra(jsonb_build_object('action', 'RETURN', 'events', jsonb_build_array(1))) $$, '42501', null, 'sem purch.write não dá destino à sobra');

-- ---------- Sócio ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select purch.scan_receipts_code(array['00000000-0000-4000-8000-0000000085a1'::uuid], (select sku from catalog.variants where id = (select (v #>> '{}')::uuid from kv where k = 'vb')), 2);
insert into kv select 'ev', e -> 'events' from jsonb_array_elements(purch.receipts_extras(array['00000000-0000-4000-8000-0000000085a1'::uuid])) e limit 1;
select is((select (e ->> 'qty')::numeric from jsonb_array_elements(purch.receipts_extras(array['00000000-0000-4000-8000-0000000085a1'::uuid])) e), 2::numeric, 'a peça fora da nota ficou pendente (2)');

-- ===== COMPENSAR com um faltante =====
insert into kv select 'c1', purch.resolve_extra(jsonb_build_object('action', 'COMPENSATE', 'events', (select v from kv where k = 'ev'), 'qty', 1,
                                                                    'target_item_id', '00000000-0000-4000-8000-0000000085b1'));
select is((select v ->> 'status' from kv where k = 'c1'), 'DONE', 'compensar conclui na hora');
select is((select qty_nfe || '/' || item_total from purch.receipt_items where id = '00000000-0000-4000-8000-0000000085b1'), '2.000/200.00', 'a linha que faltava perde a parte compensada (3 → 2, R$ 300 → 200)');
select is((select qty_nfe || '/' || qty_counted || '/' || item_total from purch.receipt_items where compensation_id = (select (v ->> 'id')::uuid from kv where k = 'c1')), '1.000/1.000/100.00', 'a parte compensada vira uma linha própria, já contada, no mesmo valor');
select is((select variant_id from purch.receipt_items where compensation_id = (select (v ->> 'id')::uuid from kv where k = 'c1')), (select (v #>> '{}')::uuid from kv where k = 'vb'), 'com a peça que veio de verdade');
select is((select sum(item_total) from purch.receipt_items where receipt_id = '00000000-0000-4000-8000-0000000085a1'), 400::numeric, 'a soma da nota não muda (a nota continua fechando)');
select is((select (e ->> 'qty')::numeric from jsonb_array_elements(purch.receipts_extras(array['00000000-0000-4000-8000-0000000085a1'::uuid])) e), 1::numeric, 'sobra 1 pendente (2 − 1)');
select throws_ok($$ select purch.resolve_extra(jsonb_build_object('action', 'COMPENSATE', 'events', (select v from kv where k = 'ev'), 'qty', 1, 'target_item_id', '00000000-0000-4000-8000-0000000085b2')) $$,
                 'P0086', null, 'não compensa item que não está faltando');

-- reabrir: volta tudo
select purch.reopen_extra_resolution((select (v ->> 'id')::uuid from kv where k = 'c1'));
select is((select qty_nfe || '/' || item_total from purch.receipt_items where id = '00000000-0000-4000-8000-0000000085b1'), '3.000/300.00', 'reabrir devolve a linha original (3, R$ 300)');
select is((select count(*)::int from purch.receipt_items where receipt_id = '00000000-0000-4000-8000-0000000085a1'), 2, 'e some a linha da compensação');
select is((select (e ->> 'qty')::numeric from jsonb_array_elements(purch.receipts_extras(array['00000000-0000-4000-8000-0000000085a1'::uuid])) e), 2::numeric, 'a sobra volta a aparecer com as 2 peças');

-- ===== DEVOLVER =====
update kv set v = (select e -> 'events' from jsonb_array_elements(purch.receipts_extras(array['00000000-0000-4000-8000-0000000085a1'::uuid])) e limit 1) where k = 'ev';
insert into kv select 'r1', purch.resolve_extra(jsonb_build_object('action', 'RETURN', 'events', (select v from kv where k = 'ev'), 'qty', 1, 'note', 'devolver na próxima visita'));
select is((select v ->> 'status' from kv where k = 'r1'), 'OPEN', 'devolução fica "a devolver"');
select is((select (e ->> 'qty')::numeric from jsonb_array_elements(purch.receipts_extras(array['00000000-0000-4000-8000-0000000085a1'::uuid])) e), 1::numeric, 'a peça devolvida sai das pendentes');
select purch.mark_extra_returned((select (v ->> 'id')::uuid from kv where k = 'r1'));
select is((select status from purch.extra_resolutions where id = (select (v ->> 'id')::uuid from kv where k = 'r1')), 'DONE', 'marcar devolvida conclui');

-- ===== ENTRADA SEM NF =====
insert into kv select 'onhand0', to_jsonb(coalesce((select on_hand from inv.stock_levels where location_id = '00000000-0000-4000-8000-0000000000b1' and variant_id = (select (v #>> '{}')::uuid from kv where k = 'vb')), 0));
update kv set v = (select e -> 'events' from jsonb_array_elements(purch.receipts_extras(array['00000000-0000-4000-8000-0000000085a1'::uuid])) e limit 1) where k = 'ev';
insert into kv select 'e1', purch.resolve_extra(jsonb_build_object('action', 'ENTRY_NO_NF', 'events', (select v from kv where k = 'ev'), 'qty', 1));
select is((select v ->> 'status' from kv where k = 'e1'), 'OPEN', 'entrada sem NF fica "a definir", sem prazo');
select is(coalesce((select on_hand from inv.stock_levels where location_id = '00000000-0000-4000-8000-0000000000b1' and variant_id = (select (v #>> '{}')::uuid from kv where k = 'vb')), 0),
          (select (v #>> '{}')::numeric + 1 from kv where k = 'onhand0'), 'a peça entrou no estoque do local do recebimento');
select purch.define_no_nf_entry((select (v ->> 'id')::uuid from kv where k = 'e1'), 'GIFT', 'ação da marca');
select is((select destination || '/' || status from purch.extra_resolutions where id = (select (v ->> 'id')::uuid from kv where k = 'e1')), 'GIFT/DONE', 'definida como presente da marca');
select ok(exists (select 1 from inv.movements where source_id = (select (v ->> 'id')::uuid from kv where k = 'e1') and movement_type = 'SPONSORSHIP_IN_KIND' and qty = 1 and total_cost = 0), 'entra como patrocínio em espécie, custo zero');
select is(coalesce((select on_hand from inv.stock_levels where location_id = '00000000-0000-4000-8000-0000000000b1' and variant_id = (select (v #>> '{}')::uuid from kv where k = 'vb')), 0),
          (select (v #>> '{}')::numeric + 1 from kv where k = 'onhand0'), 'reclassificar não mexe no saldo');
select purch.reopen_extra_resolution((select (v ->> 'id')::uuid from kv where k = 'e1'));
select is(coalesce((select on_hand from inv.stock_levels where location_id = '00000000-0000-4000-8000-0000000000b1' and variant_id = (select (v #>> '{}')::uuid from kv where k = 'vb')), 0),
          (select (v #>> '{}')::numeric from kv where k = 'onhand0'), 'reabrir tira a peça do estoque de novo');

-- NF a lançar depois e vínculo com a nota que chegou
update kv set v = (select e -> 'events' from jsonb_array_elements(purch.receipts_extras(array['00000000-0000-4000-8000-0000000085a1'::uuid])) e limit 1) where k = 'ev';
insert into kv select 'e2', purch.resolve_extra(jsonb_build_object('action', 'ENTRY_NO_NF', 'events', (select v from kv where k = 'ev'), 'qty', 1));
select purch.define_no_nf_entry((select (v ->> 'id')::uuid from kv where k = 'e2'), 'NF_LATER');
select purch.link_no_nf_entry((select (v ->> 'id')::uuid from kv where k = 'e2'), '00000000-0000-4000-8000-0000000085a2');
select is((select qty_counted from purch.receipt_items where id = '00000000-0000-4000-8000-0000000085b3'), 1::numeric, 'vincular conta a peça no item da nota que chegou (o estoque entra pelo lançamento dela)');
select is(coalesce((select on_hand from inv.stock_levels where location_id = '00000000-0000-4000-8000-0000000000b1' and variant_id = (select (v #>> '{}')::uuid from kv where k = 'vb')), 0),
          (select (v #>> '{}')::numeric from kv where k = 'onhand0'), 'e a entrada provisória sai do estoque (sem contar duas vezes)');
select throws_ok($$ select purch.reopen_extra_resolution((select (v ->> 'id')::uuid from kv where k = 'e2')) $$, 'P0083', null, 'entrada já vinculada a uma NF não reabre');

-- ===== LIXEIRA (30 dias) E QUANTIDADE =====
select purch.scan_receipts_code(array['00000000-0000-4000-8000-0000000085a1'::uuid], (select sku from catalog.variants where id = (select (v #>> '{}')::uuid from kv where k = 'vb')), 3);
update kv set v = (select e -> 'events' from jsonb_array_elements(purch.receipts_extras(array['00000000-0000-4000-8000-0000000085a1'::uuid])) e limit 1) where k = 'ev';
select is(purch.discard_scan_extras(array(select x::bigint from jsonb_array_elements_text((select v from kv where k = 'ev')) x)), 1, 'apagar leva a sobra para a lixeira');
select is(jsonb_array_length(purch.receipts_extras(array['00000000-0000-4000-8000-0000000085a1'::uuid])), 0, 'e ela sai das pendentes');
select is(jsonb_array_length(purch.extras_overview(array['00000000-0000-4000-8000-0000000085a1'::uuid]) -> 'trash'), 1, 'e aparece na lixeira');
select is(purch.restore_extras(array(select x::bigint from jsonb_array_elements_text((select v from kv where k = 'ev')) x)), 1, 'restaurar traz de volta');
select is(purch.set_extra_qty(array(select x::bigint from jsonb_array_elements_text((select v from kv where k = 'ev')) x), 5), 5::numeric, 'editar a quantidade para mais (3 → 5)');
select is(purch.set_extra_qty(array(select x::bigint from jsonb_array_elements_text((select v from kv where k = 'ev')) x), 2), 2::numeric, 'e para menos (5 → 2)');
select is(purch.set_extra_qty(array(select x::bigint from jsonb_array_elements_text((select v from kv where k = 'ev')) x), 0) = 0 and jsonb_array_length(purch.receipts_extras(array['00000000-0000-4000-8000-0000000085a1'::uuid])) = 0, true, 'quantidade zero apaga (vai para a lixeira)');

select * from finish();
rollback;
