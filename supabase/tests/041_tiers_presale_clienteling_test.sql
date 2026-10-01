begin;
create extension if not exists pgtap with schema extensions;
select plan(13);

create or replace function pg_temp.login(p_user uuid) returns void language plpgsql as $$
declare m record;
begin
  select id, org_id into m from core.members where user_id = p_user;
  perform set_config('request.jwt.claims', json_build_object(
    'sub', p_user, 'role', 'authenticated',
    'app_metadata', json_build_object('org_id', m.org_id, 'member_id', m.id))::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
grant execute on function pg_temp.login(uuid) to authenticated, anon;
create temp table ids (k text primary key, v uuid);
grant all on ids to authenticated;

insert into ids select 'vip', crm.resolve_identity('00000000-0000-4000-8000-000000000001', 'WHATSAPP', '+55 48 91111-0001', 'Vânia Nível', 'TEST');
update crm.parties set tier = 'VIP', tier_manual = true, sizes = '{"bottom":"M","top":"m"}', gender = 'F' where id = (select v from ids where k = 'vip');
-- novidade recebida nos últimos 30 dias (legging) e já comprou o top
insert into inv.movements (org_id, occurred_at, variant_id, location_id, qty, unit_cost, total_cost, movement_type)
select '00000000-0000-4000-8000-000000000001', now() - interval '3 days', v.id, '00000000-0000-4000-8000-0000000000b1', 1, 100, 100, 'PURCHASE_RECEIPT'
from catalog.variants v where v.product_id in ('00000000-0000-4000-8000-000000000401', '00000000-0000-4000-8000-000000000402', '00000000-0000-4000-8000-000000000403') and v.size = 'M';
insert into sales.orders (id, org_id, legal_entity_id, store_id, location_id, number, channel, status, party_id, subtotal, discount_total, total, cost_total, idempotency_key)
values ('00000000-0000-4000-8000-0000000009d9', '00000000-0000-4000-8000-000000000001', (select id from core.legal_entities limit 1), '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1',
        'NIV-1', 'POS', 'PAID', (select v from ids where k = 'vip'), 289, 0, 289, 110, 'niv-1');
insert into sales.order_items (org_id, order_id, variant_id, qty, list_price, unit_price, total, unit_cost_snapshot)
select '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000009d9', id, 1, 289, 289, 289, 110 from catalog.variants where product_id = '00000000-0000-4000-8000-000000000402' and size = 'M' limit 1;

select pg_temp.login('00000000-0000-4000-8000-0000000000f2');   -- vendedora
select ok(jsonb_array_length(crm.tier_benefits() -> 'VIP') > 0, 'benefícios padrão por nível');
select throws_ok($$ select crm.save_tier_benefits('{"VIP":["Pré-venda"]}') $$, '42501', null, 'só sócios mudam os benefícios');
-- para ela agora
select ok((select bool_and(x ->> 'size' = 'M') from jsonb_array_elements(crm.for_her_now((select v from ids where k = 'vip')) -> 'arrivals') x), 'novidades só no tamanho dela');
select ok(not exists (select 1 from jsonb_array_elements(crm.for_her_now((select v from ids where k = 'vip')) -> 'arrivals') x where x ->> 'product_id' = '00000000-0000-4000-8000-000000000402'), 'não sugere o que ela já comprou');
select ok(not exists (select 1 from jsonb_array_elements(crm.for_her_now((select v from ids where k = 'vip')) -> 'arrivals') x where x ->> 'product_id' = '00000000-0000-4000-8000-000000000403'), 'respeita a linha feminina');
select is(crm.for_her_now((select v from ids where k = 'vip')) ->> 'last_purchase', 'Top Demo Strappy', 'última compra');
select is((crm.for_her_now((select v from ids where k = 'vip')) -> 'benefits') ->> 0, 'Pré-venda dos drops 48 h antes', 'benefícios do nível dela');

select pg_temp.login('00000000-0000-4000-8000-0000000000f1');   -- sócio
select lives_ok($$ select crm.save_tier_benefits('{"VIP":["Pré-venda 72 h antes","Café com a sócia"]}') $$, 'sócio muda os benefícios VIP');
select is(crm.tier_benefits() -> 'VIP' ->> 1, 'Café com a sócia', 'benefício novo gravado');
select ok(jsonb_array_length(crm.tier_benefits() -> 'STANDARD') > 0, 'os outros níveis continuam');

-- pré-venda
select lives_ok($$ insert into ids select 'ev', (mkt.save_event(jsonb_build_object('kind', 'DROP', 'name', 'Drop Teste VIP', 'starts_at', now() + interval '10 days', 'store_id', '00000000-0000-4000-8000-0000000000a1'))).id $$, 'cria o drop');
select throws_ok($$ select mkt.set_event_presale((select v from ids where k = 'ev'), now() + interval '8 days', now() + interval '7 days') $$, 'P0370', null, 'abertura antes da pré-venda é recusada');
select ok(mkt.invite_vips((select v from ids where k = 'ev')) >= 1, 'convida as VIPs para a pré-venda');

select * from finish();
rollback;
