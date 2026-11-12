begin;
create extension if not exists pgtap with schema extensions;
select plan(33);

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

-- ---------- Preparação: três notas do mesmo fornecedor (três caixas do mesmo pedido) ----------
-- A (NF 100) e B (NF 101) trazem a mesma peça (EAN 7891234500081) e o par P2; C (NF 102) traz uma peça só dela.
insert into purch.receipts (id, org_id, legal_entity_id, location_id, supplier_party_id, number, nf_total, status)
select v.id, '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000b1',
       (select id from crm.parties order by created_at limit 1), v.num, 300, 'PENDING_CHECK'
  from (values ('00000000-0000-4000-8000-0000000081a1'::uuid, '8101'), ('00000000-0000-4000-8000-0000000081a2'::uuid, '8102'),
               ('00000000-0000-4000-8000-0000000081a3'::uuid, '8103')) v(id, num);
insert into purch.receipt_items (id, org_id, receipt_id, n_item, supplier_cprod, cean, description, qty_nfe, item_total) values
  ('00000000-0000-4000-8000-0000000081b1', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000081a1', 1, 'G-081',  '7891234500081', 'PECA G NA NOTA A', 2, 200),
  ('00000000-0000-4000-8000-0000000081b2', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000081a1', 2, 'P2-081', null,            'PECA P2 NA NOTA A', 1, 100),
  ('00000000-0000-4000-8000-0000000081b3', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000081a2', 1, 'G-081',  '7891234500081', 'PECA G NA NOTA B', 3, 300),
  ('00000000-0000-4000-8000-0000000081b4', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000081a2', 2, 'P2-081', null,            'PECA P2 NA NOTA B', 1, 100),
  ('00000000-0000-4000-8000-0000000081b5', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000081a3', 1, 'ONLYC-081', null,        'PECA SO DA NOTA C', 2, 200);

-- ---------- Vendedora não bipa ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');
select throws_ok($$ select purch.scan_receipts_code(array['00000000-0000-4000-8000-0000000081a1'::uuid, '00000000-0000-4000-8000-0000000081a2'::uuid], '7891234500081') $$,
                 '42501', null, 'sem purch.write não bipa várias notas');

-- ---------- Sócio: a peça entra na nota que ainda precisa dela ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
insert into kv select 'a', purch.scan_receipts_code(array['00000000-0000-4000-8000-0000000081a1'::uuid, '00000000-0000-4000-8000-0000000081a2'::uuid], '7891234500081');
select is((select v ->> 'status' from kv where k = 'a'), 'OK', 'primeira leitura: lida e somada');
select is((select v -> 'allocations' -> 0 ->> 'receipt_id' from kv where k = 'a'), '00000000-0000-4000-8000-0000000081a1', 'enche primeiro a nota que vem antes na ordem escolhida');

-- 3 peças de uma vez: 1 fecha a nota A (2/2) e 2 vão para a B
insert into kv select 'b', purch.scan_receipts_code(array['00000000-0000-4000-8000-0000000081a1'::uuid, '00000000-0000-4000-8000-0000000081a2'::uuid], '7891234500081', 3);
select is((select v ->> 'status' from kv where k = 'b'), 'OK', 'leitura de 3 cabe nas duas notas');
select is((select jsonb_array_length(v -> 'allocations') from kv where k = 'b'), 2, 'distribuída em duas notas');
select is((select qty_counted from purch.receipt_items where id = '00000000-0000-4000-8000-0000000081b1'), 2::numeric, 'nota A completa (2/2)');
select is((select qty_counted from purch.receipt_items where id = '00000000-0000-4000-8000-0000000081b3'), 2::numeric, 'nota B recebeu as outras 2');
select is((select (v ->> 'qty_counted')::numeric from kv where k = 'b'), 4::numeric, 'o resultado traz o total da peça nas notas juntas (4)');
select is((select (v ->> 'qty_nfe')::numeric from kv where k = 'b'), 5::numeric, '… de 5 que as notas pedem');

-- passou do total das notas: entra o que cabe e o resto vira sobra
insert into kv select 'c', purch.scan_receipts_code(array['00000000-0000-4000-8000-0000000081a1'::uuid, '00000000-0000-4000-8000-0000000081a2'::uuid], '7891234500081', 3);
select is((select v ->> 'status' from kv where k = 'c'), 'PARTIAL_EXCESS', 'passou do total: soma em parte');
select is((select (v ->> 'added')::numeric || '/' || (v ->> 'excess')::numeric from kv where k = 'c'), '1/2', 'entra 1 e avisa 2 a mais');
select is((select purch.scan_receipts_code(array['00000000-0000-4000-8000-0000000081a1'::uuid, '00000000-0000-4000-8000-0000000081a2'::uuid], '7891234500081') ->> 'status'), 'EXCESS', 'tudo completo: sobra');

-- a ordem escolhida decide quem enche primeiro
insert into kv select 'd', purch.scan_receipts_code(array['00000000-0000-4000-8000-0000000081a2'::uuid, '00000000-0000-4000-8000-0000000081a1'::uuid], 'P2-081');
select is((select v -> 'allocations' -> 0 ->> 'receipt_id' from kv where k = 'd'), '00000000-0000-4000-8000-0000000081a2', 'ordem [B, A]: a peça vai para a B');

-- nota fora do grupo não recebe; dentro do grupo recebe
select is((select purch.scan_receipts_code(array['00000000-0000-4000-8000-0000000081a1'::uuid, '00000000-0000-4000-8000-0000000081a2'::uuid], 'ONLYC-081') ->> 'status'), 'UNKNOWN', 'peça só da nota C não entra quando C não está no grupo');
select is((select purch.scan_receipts_code(array['00000000-0000-4000-8000-0000000081a1'::uuid, '00000000-0000-4000-8000-0000000081a2'::uuid, '00000000-0000-4000-8000-0000000081a3'::uuid], 'ONLYC-081') ->> 'status'), 'OK', 'e entra na C quando ela está no grupo');

select ok((select count(*) from purch.receipt_scan_events where receipt_id in ('00000000-0000-4000-8000-0000000081a1', '00000000-0000-4000-8000-0000000081a2', '00000000-0000-4000-8000-0000000081a3') and result ? 'allocations') >= 5,
          'cada leitura fica no registro, com a distribuição');

-- bipar reabre a conferência confirmada
reset role;
update purch.receipts set status = 'CHECKED' where id = '00000000-0000-4000-8000-0000000081a1';
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select purch.scan_receipts_code(array['00000000-0000-4000-8000-0000000081a1'::uuid, '00000000-0000-4000-8000-0000000081a2'::uuid], 'P2-081');
select is((select status from purch.receipts where id = '00000000-0000-4000-8000-0000000081a1'), 'PENDING_CHECK', 'bipar reabre a conferência da nota que recebeu a peça');

-- nota já lançada
reset role;
update purch.receipts set status = 'POSTED' where id = '00000000-0000-4000-8000-0000000081a3';
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select throws_ok($$ select purch.scan_receipts_code(array['00000000-0000-4000-8000-0000000081a3'::uuid], 'ONLYC-081') $$, 'P0083', null, 'só notas já lançadas: recusa');
select is((select purch.scan_receipts_code(array['00000000-0000-4000-8000-0000000081a1'::uuid, '00000000-0000-4000-8000-0000000081a2'::uuid, '00000000-0000-4000-8000-0000000081a3'::uuid], 'ONLYC-081') ->> 'status'), 'UNKNOWN',
          'nota lançada no meio do grupo é ignorada, o resto segue');

-- ---------- Acompanhamento das notas juntas ----------
select is((select jsonb_array_length(purch.receipts_scan_feed(array['00000000-0000-4000-8000-0000000081a1'::uuid, '00000000-0000-4000-8000-0000000081a2'::uuid], 0) -> 'items')), 4, 'o acompanhamento traz os itens das duas notas');
select throws_ok($$ select purch.receipts_scan_feed(array['00000000-0000-4000-8000-0000000081a1'::uuid, '00000000-0000-4000-8000-0000000081ff'::uuid], 0) $$, null, 'Recebimento não encontrado', 'nota que não existe é recusada');

-- ---------- Link do celular cobrindo várias notas ----------
select throws_ok($$ select purch.create_scan_link('00000000-0000-4000-8000-0000000081a1', 'x', 4, array['00000000-0000-4000-8000-0000000081a3'::uuid]) $$, 'P0083', null, 'não junta nota já lançada ao link');
insert into kv select 'link', purch.create_scan_link('00000000-0000-4000-8000-0000000081a1', 'Celular da Ana', 4, array['00000000-0000-4000-8000-0000000081a2'::uuid]);
select is(length((select v ->> 'token' from kv where k = 'link')), 24, 'link gerado para as duas notas');

select pg_temp.anon();
select is((select jsonb_array_length(public.receipt_link_open((select v ->> 'token' from kv where k = 'link')) -> 'notes')), 2, 'celular abre as duas notas');
select is((select jsonb_array_length(public.receipt_link_open((select v ->> 'token' from kv where k = 'link')) -> 'items')), 4, 'com os itens das duas');
select throws_ok($$ select public.receipt_link_bump((select v ->> 'token' from kv where k = 'link'), '00000000-0000-4000-8000-0000000081b5', 1) $$, null, 'Item não encontrado', 'não mexe em item de nota fora do link');
select is((public.receipt_link_bump((select v ->> 'token' from kv where k = 'link'), '00000000-0000-4000-8000-0000000081b1', -1) ->> 'qty_counted')::numeric, 1::numeric, 'celular tira uma peça da nota A');
insert into kv select 'scan', public.receipt_link_scan((select v ->> 'token' from kv where k = 'link'), '7891234500081', 1);
select is((select v ->> 'status' from kv where k = 'scan'), 'OK', 'celular bipa nas duas notas');
select is((select v -> 'allocations' -> 0 ->> 'item_id' from kv where k = 'scan'), '00000000-0000-4000-8000-0000000081b1', 'e a peça volta para a nota que ficou faltando');
select is((select jsonb_array_length(public.receipt_link_feed((select v ->> 'token' from kv where k = 'link'), 0) -> 'items')), 4, 'celular acompanha as quantidades das duas notas');

reset role;
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select is((select jsonb_array_length(purch.receipts_scan_feed(array['00000000-0000-4000-8000-0000000081a1'::uuid, '00000000-0000-4000-8000-0000000081a2'::uuid], 0) -> 'links')), 1, 'o computador vê o celular ligado às duas notas');
select is(purch.revoke_scan_link('00000000-0000-4000-8000-0000000081a2'), 1, 'encerra o link também pela outra nota do grupo');
select pg_temp.anon();
select throws_ok($$ select public.receipt_link_scan((select v ->> 'token' from kv where k = 'link'), '7891234500081') $$, 'P0090', null, 'link encerrado para de funcionar');

select * from finish();
rollback;
