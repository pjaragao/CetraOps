begin;
create extension if not exists pgtap with schema extensions;
select plan(61);

create or replace function pg_temp.login(p_user uuid) returns void language plpgsql as $$
declare m record;
begin
  select id, org_id into m from core.members where user_id = p_user;
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated',
    'app_metadata', json_build_object('org_id', m.org_id, 'member_id', m.id))::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
grant execute on function pg_temp.login(uuid) to authenticated, anon;
create temp table ids (k text primary key, v uuid);
grant all on ids to authenticated;
create or replace function pg_temp.v(p text) returns uuid language sql as $$ select v from ids where k = p $$;
grant execute on function pg_temp.v(text) to authenticated;
create or replace function pg_temp.onhand(p_loc uuid, p_var uuid) returns numeric language sql as $$
  select coalesce((select on_hand from inv.stock_levels where location_id = p_loc and variant_id = p_var), 0) $$;
grant execute on function pg_temp.onhand(uuid, uuid) to authenticated;

-- ---------- Preparação ----------
insert into ids select 'm', id from catalog.variants where product_id = '00000000-0000-4000-8000-000000000401' and size = 'M' limit 1;
insert into ids select 'g', id from catalog.variants where product_id = '00000000-0000-4000-8000-000000000401' and size = 'G' limit 1;
insert into ids values ('sale', '00000000-0000-4000-8000-0000000000b1'), ('store', '00000000-0000-4000-8000-0000000000a1');
with x as (insert into inv.locations (org_id, store_id, legal_entity_id, name, kind)
  select org_id, id, legal_entity_id, 'Estoque de teste 066', 'BACKROOM' from core.stores where id = '00000000-0000-4000-8000-0000000000a1' returning id)
insert into ids select 'loc', id from x;
insert into ids select 'cli', id from crm.parties where kind = 'PERSON' and org_id = '00000000-0000-4000-8000-000000000001' order by created_at limit 1;
insert into inv.movements (org_id, variant_id, location_id, qty, unit_cost, movement_type)
values ('00000000-0000-4000-8000-000000000001', pg_temp.v('m'), pg_temp.v('loc'), 10, 40, 'PURCHASE_RECEIPT');

-- ---------- Contagem ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');   -- vendedora: conta, mas não lança
insert into ids select 'cnt', (inv.start_count(pg_temp.v('loc'), 'FULL', 'teste')).id;
select throws_ok($$ select inv.start_count(pg_temp.v('loc'), 'FULL') $$, 'P0301', null, 'uma contagem aberta por local');
select is((inv.count_item(pg_temp.v('cnt'), pg_temp.v('m'), 1)).counted, 1.000, 'bipe soma 1');
select is((inv.count_item(pg_temp.v('cnt'), pg_temp.v('m'), 1)).counted, 2.000, 'bipe de novo soma');
select is((inv.count_item(pg_temp.v('cnt'), pg_temp.v('m'), 7, 'SET')).counted, 7.000, 'digitar fixa a quantidade');
select is((inv.count_item(pg_temp.v('cnt'), pg_temp.v('g'), 3, 'SET', 35)).counted, 3.000, 'peça nova com custo');
select throws_ok($$ select inv.count_item(pg_temp.v('cnt'), pg_temp.v('m'), 1.5) $$, 'P0301', null, 'quantidade fracionada recusada');
select throws_ok($$ select inv.post_count(pg_temp.v('cnt')) $$, '42501', null, 'a vendedora não lança a contagem');
select throws_ok($$ select inv.adjust_stock(jsonb_build_object('location_id', pg_temp.v('loc'), 'reason', 'LOSS', 'notes', 'sumiu', 'items', '[]'::jsonb)) $$, '42501', null, 'nem faz ajuste avulso');
reset role;

select pg_temp.login('00000000-0000-4000-8000-0000000000f1');   -- sócia
select is(inv.post_count(pg_temp.v('cnt')), 2, 'lança: duas peças ajustadas');
select is(pg_temp.onhand(pg_temp.v('loc'), pg_temp.v('m')), 7.000, 'M ficou com o contado (10 → 7)');
select is(pg_temp.onhand(pg_temp.v('loc'), pg_temp.v('g')), 3.000, 'G entrou com 3');
select is((select movement_type::text from inv.movements where source_id = pg_temp.v('cnt') and variant_id = pg_temp.v('g')), 'INITIAL_BALANCE', 'primeira entrada da peça é estoque inicial');
select is((select last_cost from inv.item_costs where variant_id = pg_temp.v('g')), 35.0000, 'e o custo informado entra no custo médio da peça');
select is((select expected from inv.count_items where count_id = pg_temp.v('cnt') and variant_id = pg_temp.v('m')), 10.000, 'guarda o saldo esperado');
select throws_ok($$ select inv.post_count(pg_temp.v('cnt')) $$, 'P0301', null, 'não lança duas vezes');

-- contagem completa zera o que não foi contado
insert into ids select 'cnt2', (inv.start_count(pg_temp.v('loc'), 'FULL')).id;
select inv.count_item(pg_temp.v('cnt2'), pg_temp.v('m'), 7, 'SET');
select inv.post_count(pg_temp.v('cnt2'));
select is(pg_temp.onhand(pg_temp.v('loc'), pg_temp.v('g')), 0.000, 'completa: o G não contado foi zerado');
-- parcial só mexe no contado
insert into ids select 'cnt3', (inv.start_count(pg_temp.v('loc'), 'CYCLE')).id;
select inv.count_item(pg_temp.v('cnt3'), pg_temp.v('g'), 2, 'SET');
select inv.post_count(pg_temp.v('cnt3'));
select is(pg_temp.onhand(pg_temp.v('loc'), pg_temp.v('m')), 7.000, 'parcial: o M não contado ficou como estava');
select is(pg_temp.onhand(pg_temp.v('loc'), pg_temp.v('g')), 2.000, 'e o G contado foi ajustado');
-- cancelar
insert into ids select 'cnt4', (inv.start_count(pg_temp.v('loc'), 'CYCLE')).id;
select lives_ok($$ select inv.cancel_count(pg_temp.v('cnt4')) $$, 'cancela contagem aberta');
select throws_ok($$ insert into inv.counts (org_id, location_id, kind) values ('00000000-0000-4000-8000-000000000001', pg_temp.v('loc'), 'FULL') $$, '42501', null, 'contagem só pelas funções');

-- ---------- Ajuste avulso ----------
select throws_ok($$ select inv.adjust_stock(jsonb_build_object('location_id', pg_temp.v('loc'), 'reason', 'LOSS', 'notes', '', 'items', jsonb_build_array(jsonb_build_object('variant_id', pg_temp.v('m'), 'qty', 1)))) $$, 'P0303', null, 'ajuste exige motivo escrito');
select is(inv.adjust_stock(jsonb_build_object('location_id', pg_temp.v('loc'), 'reason', 'DAMAGE', 'notes', 'costura aberta', 'items', jsonb_build_array(jsonb_build_object('variant_id', pg_temp.v('m'), 'qty', 1)))), 1, 'avaria baixa uma peça');
select is(pg_temp.onhand(pg_temp.v('loc'), pg_temp.v('m')), 6.000, 'sempre como saída, mesmo com quantidade positiva');
select throws_ok($$ select inv.adjust_stock(jsonb_build_object('location_id', pg_temp.v('loc'), 'reason', 'LOSS', 'notes', 'teste', 'items', jsonb_build_array(jsonb_build_object('variant_id', pg_temp.v('m'), 'qty', 99)))) $$, 'P0002', null, 'não deixa o estoque negativo');

-- ---------- Importação com quantidade e custo ----------
select is((catalog.import_rows('[{"reference_code":"T066","name":"Top teste","gender":"FEM","color":"Preto","size":"P","price":"199.90","qty":"4","cost":"60","brand":"SIÉ","collection":"Drop teste"}]', pg_temp.v('sale')) ->> 'estoque')::int, 1, 'importa a peça com estoque');
insert into ids select 'imp', v.id from catalog.variants v join catalog.products p on p.id = v.product_id where p.reference_code = 'T066';
select is(pg_temp.onhand(pg_temp.v('sale'), pg_temp.v('imp')), 4.000, 'saldo = quantidade da planilha');
select is((catalog.import_rows('[{"reference_code":"T066","name":"Top teste","gender":"FEM","color":"Preto","size":"P","qty":"4"}]', pg_temp.v('sale')) ->> 'estoque')::int, 0, 'reimportar a mesma quantidade não soma');
select is((select avg_cost from inv.item_costs where variant_id = pg_temp.v('imp')), 60.0000, 'custo da planilha');
select is((select b.name || '/' || c.name from catalog.products p join catalog.brands b on b.id = p.brand_id join catalog.collections c on c.id = p.collection_id where p.reference_code = 'T066'), 'SIÉ/Drop teste', 'marca e coleção criadas');
select is(jsonb_array_length(catalog.import_rows('[{"reference_code":"T067","name":"X","gender":"FEM","color":"Preto","size":"P","qty":"-1"}]', pg_temp.v('loc')) -> 'erros'), 1, 'quantidade negativa vira erro da linha');
reset role;

-- ---------- Malinha ----------
insert into inv.movements (org_id, variant_id, location_id, qty, unit_cost, movement_type)
values ('00000000-0000-4000-8000-000000000001', pg_temp.v('m'), pg_temp.v('sale'), 10, 40, 'PURCHASE_RECEIPT');
create temp table base as select pg_temp.onhand(pg_temp.v('sale'), pg_temp.v('m')) as m;
grant select on base to authenticated;
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');   -- vendedora monta a malinha
select throws_ok($$ select inv.create_loan(jsonb_build_object('store_id', pg_temp.v('store'), 'kind', 'TRY_ON', 'items', jsonb_build_array(jsonb_build_object('variant_id', pg_temp.v('m'), 'qty', 1)))) $$, 'P0305', null, 'malinha exige cliente');
select throws_ok($$ select inv.create_loan(jsonb_build_object('store_id', pg_temp.v('store'), 'kind', 'TRY_ON', 'party_id', pg_temp.v('cli'), 'items', jsonb_build_array(jsonb_build_object('variant_id', pg_temp.v('m'), 'qty', 50)))) $$, 'P0306', null, 'não leva mais do que tem');
insert into ids select 'mal', (inv.create_loan(jsonb_build_object('store_id', pg_temp.v('store'), 'kind', 'TRY_ON', 'party_id', pg_temp.v('cli'), 'due_days', 2,
  'items', jsonb_build_array(jsonb_build_object('variant_id', pg_temp.v('m'), 'qty', 3), jsonb_build_object('variant_id', pg_temp.v('imp'), 'qty', 1))))).id;
select matches((select number from inv.loans where id = pg_temp.v('mal')), '^MAL-', 'numeração própria da malinha');
select is(pg_temp.onhand(pg_temp.v('sale'), pg_temp.v('m')), (select m - 3 from base), 'as peças saem do balcão');
select is((select sum(on_hand) from inv.stock_levels sl join inv.locations l on l.id = sl.location_id where l.kind = 'WITH_CUSTOMER' and l.store_id = pg_temp.v('store')), 4.000, 'e ficam em "Malinhas com clientes"');
select is((select is_sellable from inv.locations where kind = 'WITH_CUSTOMER' and store_id = pg_temp.v('store')), false, 'local fora da loja não é vendável');
insert into ids select 'it_m', id from inv.loan_items where loan_id = pg_temp.v('mal') and variant_id = pg_temp.v('m');
insert into ids select 'it_i', id from inv.loan_items where loan_id = pg_temp.v('mal') and variant_id = pg_temp.v('imp');
select throws_ok($$ select inv.settle_loan(pg_temp.v('mal'), jsonb_build_array(jsonb_build_object('item_id', pg_temp.v('it_m'), 'returned', 4))) $$, 'P0305', null, 'não devolve mais do que levou');
select throws_ok($$ select inv.settle_loan(pg_temp.v('mal'), jsonb_build_array(jsonb_build_object('item_id', pg_temp.v('it_m'), 'gifted', 1))) $$, 'P0305', null, 'brinde não vale em malinha de cliente');
select is(jsonb_array_length(inv.settle_loan(pg_temp.v('mal'), jsonb_build_array(jsonb_build_object('item_id', pg_temp.v('it_m'), 'returned', 2, 'sold', 1))) -> 'sold'), 1, 'acerto parcial devolve o que foi vendido para o PDV');
select is((select status from inv.loans where id = pg_temp.v('mal')), 'OPEN', 'com peça pendente, continua aberta');
select is(pg_temp.onhand(pg_temp.v('sale'), pg_temp.v('m')), (select m from base), 'devolvida e vendida voltam ao balcão (a venda baixa no PDV)');
select is((inv.settle_loan(pg_temp.v('mal'), jsonb_build_array(jsonb_build_object('item_id', pg_temp.v('it_i'), 'lost', 1))) -> 'loan' ->> 'status'), 'CLOSED', 'última peça acertada encerra a malinha');
select is((select qty::int from inv.movements where source_id = pg_temp.v('mal') and movement_type = 'LOSS'), -1, 'peça que não voltou sai como perda');
select throws_ok($$ select inv.settle_loan(pg_temp.v('mal'), '[]') $$, 'P0305', null, 'malinha encerrada não aceita acerto');

-- ---------- Peças em campanha ----------
insert into ids select 'cmp', (inv.create_loan(jsonb_build_object('store_id', pg_temp.v('store'), 'kind', 'CAMPAIGN', 'purpose', 'Ensaio de fotos do drop', 'due_days', 5,
  'items', jsonb_build_array(jsonb_build_object('variant_id', pg_temp.v('m'), 'qty', 2))))).id;
insert into ids select 'it_c', id from inv.loan_items where loan_id = pg_temp.v('cmp');
select is((inv.settle_loan(pg_temp.v('cmp'), jsonb_build_array(jsonb_build_object('item_id', pg_temp.v('it_c'), 'returned', 1, 'gifted', 1))) -> 'loan' ->> 'status'), 'CLOSED', 'campanha: uma volta e uma fica de brinde');
select is((select qty::int from inv.movements where source_id = pg_temp.v('cmp') and movement_type = 'MARKETING_GIFT'), -1, 'brinde sai como marketing');
select throws_ok($$ insert into inv.loans (org_id, store_id, number, kind, from_location_id, out_location_id, due_at) values ('00000000-0000-4000-8000-000000000001', pg_temp.v('store'), 'X', 'CAMPAIGN', pg_temp.v('loc'), pg_temp.v('loc'), now()) $$, '42501', null, 'saídas só pelas funções');
reset role;

-- vencida avisa uma vez
update inv.loans set due_at = now() - interval '1 hour', status = 'OPEN' where id = pg_temp.v('cmp');
select ok(private.sweep_overdue_loans() >= 1, 'vencida gera aviso');
select is(private.sweep_overdue_loans(), 0, 'e não avisa de novo');

-- ---------- Rotina da loja ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');
select is((select count(*)::int from jsonb_array_elements(sales.routine_status(pg_temp.v('store'), 'OPENING') -> 'items') i where (i ->> 'auto')::boolean), 3, 'abertura tem itens automáticos');
select is((select (i ->> 'ok')::boolean from jsonb_array_elements(sales.routine_status(pg_temp.v('store'), 'OPENING') -> 'items') i where i ->> 'key' = 'auto_malinhas'), false, 'malinha vencida aparece como pendente');
select lives_ok($$ select sales.routine_check(pg_temp.v('store'), 'OPENING', 'maquininha', true) $$, 'marca item manual');
select is((select (i ->> 'ok')::boolean from jsonb_array_elements(sales.routine_status(pg_temp.v('store'), 'OPENING') -> 'items') i where i ->> 'key' = 'maquininha'), true, 'item marcado aparece feito');
select throws_ok($$ select sales.routine_check(pg_temp.v('store'), 'OPENING', 'nao_existe', true) $$, 'P0307', null, 'item fora do modelo recusado');
select throws_ok($$ select sales.save_routine_template('{"opening":[],"closing":[]}') $$, '42501', null, 'só administrador muda o modelo');
select ok(jsonb_array_length(sales.routine_complete(pg_temp.v('store'), 'CLOSING', 'tudo ok') -> 'pending') >= 1, 'fechar registra o que ficou pendente');
reset role;
select ok((select count(*) from core.notifications where kind = 'STORE_CLOSED') >= 1, 'fechamento avisa quem administra');

-- ---------- Avisos sem repetição ----------
select is(core.notify('00000000-0000-4000-8000-000000000001', 'TESTE_066', 'Mesmo aviso', '{}', 'core.admin') > 0, true, 'primeiro aviso é criado');
select is(core.notify('00000000-0000-4000-8000-000000000001', 'TESTE_066', 'Mesmo aviso', '{}', 'core.admin'), 0, 'o repetido não cria outro');
select is((select max((payload ->> 'repeticoes')::int) from core.notifications where kind = 'TESTE_066'), 2, 'conta as repetições');

-- ---------- Nenhuma função dos schemas expostos executável sem login ----------
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('core','crm','catalog','inv','sales','fin','fiscal','omni','ai','hr','comm','purch','mkt','aff')
    and p.prosecdef and has_function_privilege('anon', p.oid, 'execute')), 0, 'anon não executa função alguma (inclusive mkt e aff)');

select * from finish();
rollback;
