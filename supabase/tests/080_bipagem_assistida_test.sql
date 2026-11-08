begin;
create extension if not exists pgtap with schema extensions;
select plan(18);

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

insert into purch.receipts (id, org_id, legal_entity_id, location_id, supplier_party_id, number, nf_total, status)
values ('00000000-0000-4000-8000-0000000080a1', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000e1',
        '00000000-0000-4000-8000-0000000000b1', (select id from crm.parties order by created_at limit 1), '8001', 300, 'PENDING_CHECK');
insert into purch.receipt_items (id, org_id, receipt_id, n_item, supplier_cprod, cean, description, qty_nfe, item_total) values
  ('00000000-0000-4000-8000-0000000080b1', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000080a1', 1, 'L-080', '7891234500080', 'PECA LINK', 3, 300);

insert into kv select 'outro', to_jsonb(id) from purch.receipt_items where receipt_id <> '00000000-0000-4000-8000-0000000080a1' limit 1;

-- ---------- vendedora não gera link ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');
select throws_ok($$ select purch.create_scan_link('00000000-0000-4000-8000-0000000080a1', 'x') $$, '42501', null, 'sem purch.write não gera link');

-- ---------- sócio gera ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
insert into kv select 'link', purch.create_scan_link('00000000-0000-4000-8000-0000000080a1', 'Celular da Ana', 4);
select is(length((select v ->> 'token' from kv where k = 'link')), 24, 'código do link com 24 caracteres');
select throws_ok($$ select token_hash from purch.receipt_scan_links $$, '42501', null, 'o hash não pode ser lido pela API');
select is((select v -> 'links' -> 0 ->> 'label' from (select purch.receipt_scan_feed('00000000-0000-4000-8000-0000000080a1') v) f), 'Celular da Ana', 'o computador vê o link ativo');

-- ---------- celular sem login ----------
select pg_temp.anon();
select throws_ok($$ select purch.scan_receipt_code('00000000-0000-4000-8000-0000000080a1', '7891234500080') $$, '42501', null, 'anônimo não chama a função de quem está logado');
select throws_ok($$ select public.receipt_link_open('AAAAAAAAAAAAAAAAAAAAAAAA') $$, 'P0090', null, 'código errado é recusado');
select is((select jsonb_array_length(public.receipt_link_open((select v ->> 'token' from kv where k = 'link')) -> 'items')), 1, 'celular abre a nota com os itens');
insert into kv select 'scan', public.receipt_link_scan((select v ->> 'token' from kv where k = 'link'), '7891234500080', 2);
select is((select v ->> 'status' from kv where k = 'scan'), 'OK', 'celular bipa pelo link');
select is((select (v ->> 'qty_counted')::numeric from kv where k = 'scan'), 2::numeric, 'soma na nota');
select is((select (public.receipt_link_bump((select v ->> 'token' from kv where k = 'link'), '00000000-0000-4000-8000-0000000080b1', -1) ->> 'qty_counted')::numeric), 1::numeric, 'celular ajusta com −');
select throws_ok($$ select public.receipt_link_bump((select v ->> 'token' from kv where k = 'link'), (select (v #>> '{}')::uuid from kv where k = 'outro'), 1) $$,
                 null, 'Item não encontrado', 'não mexe em item de outra nota');

-- ---------- computador acompanha ----------
reset role;
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
insert into kv select 'feed', purch.receipt_scan_feed('00000000-0000-4000-8000-0000000080a1', 0);
select is((select jsonb_array_length(v -> 'events') from kv where k = 'feed'), 2, 'as leituras do celular aparecem no computador');
select ok((select (v -> 'events' -> 0 ->> 'by_link')::boolean from kv where k = 'feed'), 'marcadas como vindas do link');
select ok((select (v -> 'links' -> 0 ->> 'last_seen_at') is not null from kv where k = 'feed'), 'e o celular aparece como ligado');
select is((select jsonb_array_length(purch.receipt_scan_feed('00000000-0000-4000-8000-0000000080a1', (select (v ->> 'last_event')::bigint from kv where k = 'feed')) -> 'events')), 0, 'depois da última, nada novo');
select ok((purch.scan_receipt_code('00000000-0000-4000-8000-0000000080a1', 'L-080') ->> 'event_id') is not null, 'leitura de quem está logado também entra no registro');

-- ---------- encerrar e vencer ----------
select is(purch.revoke_scan_link('00000000-0000-4000-8000-0000000080a1'), 1, 'encerra o link');
select pg_temp.anon();
select throws_ok($$ select public.receipt_link_scan((select v ->> 'token' from kv where k = 'link'), '7891234500080') $$, 'P0090', 'Este link foi encerrado no computador', 'link encerrado para de funcionar');

select * from finish();
rollback;
