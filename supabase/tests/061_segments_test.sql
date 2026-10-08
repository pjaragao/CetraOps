begin;
create extension if not exists pgtap with schema extensions;
select plan(24);

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

select pg_temp.login('00000000-0000-4000-8000-0000000000f1');   -- sócio
insert into ids select 'lead', crm.quick_customer('48999990201', 'Lead Nova (seg)', true);
insert into ids select 'cli', crm.quick_customer('48999990202', 'Cliente Antiga (seg)', false);
insert into ids select 'func', crm.quick_customer('48999990203', 'Funcionária (seg)', true);
insert into ids select 'anon', crm.quick_customer('48999990204', 'Anonimizada (seg)', true);
reset role;

-- cenário: a lead é nova e nunca comprou; a cliente comprou (tamanho M) há 90 dias e entrou há 40; funcionária e anonimizada nunca entram
update crm.parties set tags = array['teste-seg'], source = 'teste-seg' where id in (select v from ids);
update crm.parties set anonymized_at = now() where id = (select v from ids where k = 'anon');
insert into crm.party_roles (party_id, org_id, role) select v, (select org_id from crm.parties where id = v), 'EMPLOYEE' from ids where k = 'func' on conflict do nothing;
update crm.parties set created_at = now() - interval '40 days', first_purchase_at = now() - interval '90 days', last_purchase_at = now() - interval '90 days', lifecycle_stage = 'CUSTOMER' where id = (select v from ids where k = 'cli');
insert into inv.locations (id, org_id, store_id, legal_entity_id, name, kind) select '00000000-0000-4000-8000-0000000061d1', '00000000-0000-4000-8000-000000000001', (select id from core.stores limit 1), (select id from core.legal_entities limit 1), 'Loja (teste segmentos)', 'SALES_FLOOR'
  where not exists (select 1 from inv.locations);
insert into catalog.products (id, org_id, reference_code, name, gender) values ('00000000-0000-4000-8000-0000000061a1', '00000000-0000-4000-8000-000000000001', 'SEG-61', 'Produto segmento', 'FEM') on conflict do nothing;
insert into catalog.variants (id, org_id, product_id, size, sku) values ('00000000-0000-4000-8000-0000000061b1', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000061a1', 'M', 'SEG-61-M') on conflict do nothing;
insert into sales.orders (id, org_id, legal_entity_id, store_id, location_id, number, channel, status, party_id, subtotal, discount_total, total, cost_total, idempotency_key, created_at)
values ('00000000-0000-4000-8000-0000000061c1', '00000000-0000-4000-8000-000000000001', (select id from core.legal_entities limit 1), (select id from core.stores limit 1), (select id from inv.locations limit 1),
        'SEG-1', 'POS', 'PAID', (select v from ids where k = 'cli'), 200, 0, 200, 80, 'seg-1', now() - interval '90 days');
insert into sales.order_items (org_id, order_id, variant_id, qty, list_price, unit_price, total, unit_cost_snapshot)
values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000061c1', '00000000-0000-4000-8000-0000000061b1', 1, 200, 200, 200, 80);

select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
create or replace function pg_temp.names(d jsonb) returns text language sql as $$
  select coalesce(string_agg(p.display_name, ' | ' order by p.display_name), '') from crm.audience(d) a join crm.parties p on p.id = a.party_id $$;
grant execute on function pg_temp.names(jsonb) to authenticated;

select is(pg_temp.names('{"tags":["teste-seg"]}'), 'Cliente Antiga (seg) | Lead Nova (seg)', 'funcionária e anonimizada nunca entram');
select is(pg_temp.names('{"tags":["teste-seg"],"lifecycle":["LEAD"]}'), 'Lead Nova (seg)', 'o filtro antigo (estágio) continua valendo');
select is(pg_temp.names('{"tags":["teste-seg"],"never_bought":true}'), 'Lead Nova (seg)', 'nunca comprou');
select is(pg_temp.names('{"tags":["teste-seg"],"never_bought":false}'), 'Cliente Antiga (seg)', 'já comprou');
select is(pg_temp.names('{"tags":["teste-seg"],"inactive_days":60,"inactive_max_days":120}'), 'Cliente Antiga (seg)', 'sem comprar entre 60 e 120 dias (a lead nunca comprou e fica de fora da faixa)');
select is(pg_temp.names('{"tags":["teste-seg"],"inactive_days":100}'), 'Lead Nova (seg)', 'sem comprar há mais de 100 dias: só quem nunca comprou');
select is(pg_temp.names('{"tags":["teste-seg"],"orders_min":1}'), 'Cliente Antiga (seg)', 'ao menos 1 pedido pago');
select is(pg_temp.names('{"tags":["teste-seg"],"spent_min":150}'), 'Cliente Antiga (seg)', 'gastou ao menos R$ 150');
select is(pg_temp.names('{"tags":["teste-seg"],"spent_min":250}'), '', 'gastou ao menos R$ 250: ninguém');
select is(pg_temp.names('{"tags":["teste-seg"],"spent_min":150,"period_days":30}'), '', 'o gasto respeita o período (compra de 90 dias fica fora de 30)');
select is(pg_temp.names('{"tags":["teste-seg"],"bought_sizes":["m"]}'), 'Cliente Antiga (seg)', 'comprou tamanho M');
select is(pg_temp.names('{"tags":["teste-seg"],"bought_sizes":["GG"]}'), '', 'ninguém comprou GG');
select is(pg_temp.names('{"tags":["teste-seg"],"bought_products":["00000000-0000-4000-8000-0000000061a1"]}'), 'Cliente Antiga (seg)', 'comprou o produto');
select is(pg_temp.names('{"tags":["teste-seg"],"created_within_days":7}'), 'Lead Nova (seg)', 'entrou há até 7 dias');
select is(pg_temp.names('{"tags":["teste-seg"],"created_older_than_days":30}'), 'Cliente Antiga (seg)', 'entrou há mais de 30 dias');
select is(pg_temp.names('{"tags":["teste-seg"],"exclude":{"never_bought":true}}'), 'Cliente Antiga (seg)', '"exclude" tira quem casa');
select is(pg_temp.names('{"sources":["TESTE-SEG"],"reachable_whatsapp":true}'), 'Lead Nova (seg)', 'alcançável no WhatsApp = telefone + consentimento');

select throws_ok($$select * from crm.audience('{"filtro_que_nao_existe":1}')$$, 'P0190', null, 'filtro desconhecido dá erro claro');
select throws_ok($$select * from crm.audience('{"bought_products":["abc"]}')$$, 'P0190', null, 'identificador inválido dá erro claro');

-- públicos salvos
insert into ids select 'seg', (mkt.save_segment('{"name":"Teste seg: clientes antigas","definition":{"tags":["teste-seg"],"never_bought":false}}')).id;
select is((select cached_count from mkt.segments where id = (select v from ids where k = 'seg')), 1, 'o público salvo guarda a contagem');
select is(pg_temp.names(jsonb_build_object('tags', array['teste-seg'], 'segment_id', (select v from ids where k = 'seg'))), 'Cliente Antiga (seg)', 'um público pode usar outro (segment_id)');

select is((mkt.segment_preview('{"tags":["teste-seg"]}') ->> 'whatsapp')::int, 1, 'prévia: 1 alcançável no WhatsApp (a cliente não deu consentimento)');
select is((mkt.segment_preview('{"tags":["teste-seg"]}') ->> 'no_consent')::int, 1, 'prévia: 1 sem consentimento');

select lives_ok($$select mkt.delete_segment((select v from ids where k = 'seg'))$$, 'exclui o público salvo');

select * from finish();
rollback;
