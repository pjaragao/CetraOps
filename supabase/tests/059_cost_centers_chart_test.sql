begin;
create extension if not exists pgtap with schema extensions;
select plan(12);

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

-- centros de custo padrão de varejo de vestuário
select ok((select count(*) = 22 from core.cost_centers where org_id = '00000000-0000-4000-8000-000000000001'
           and code in ('ADM', 'ADM-FIN', 'ADM-RH', 'ADM-TI', 'COM', 'COM-LOJAS', 'COM-ECOM', 'COM-SOCIAL', 'COM-B2B', 'MKT', 'MKT-MIDIA', 'MKT-EVENTOS', 'PROD', 'PROD-COLECAO', 'PROD-ESTOQUE',
                        'FIN', 'FIN-TARIFAS', 'FIN-ADQUIRENCIA', 'FIN-ANTECIPACAO', 'FIN-JUROS', 'FIN-IOF', 'FIN-OUTROS')),
  'organização nasce com os centros de custo padrão');
select is((select p.code from core.cost_centers c join core.cost_centers p on p.id = c.parent_id where c.org_id = '00000000-0000-4000-8000-000000000001' and c.code = 'COM-LOJAS'), 'COM', 'lojas físicas ficam dentro de comercial');

-- loja nova já nasce com centro de custo, dentro de "Lojas físicas"
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');   -- sócio (administrador)
with s as (insert into core.stores (org_id, legal_entity_id, code, name, format, status)
  values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000e1', 'CENTRO', 'Loja Centro (teste)', 'SHOP_IN_SHOP', 'ACTIVE') returning id)
insert into ids select 'loja', id from s;
select ok((select c.kind = 'STORE' and c.code = 'LOJA-CENTRO' and p.code = 'COM-LOJAS' from core.stores s join core.cost_centers c on c.id = s.cost_center_id join core.cost_centers p on p.id = c.parent_id
           where s.id = (select v from ids where k = 'loja')), 'loja nova vira centro de custo (LOJA-CENTRO) dentro de Lojas físicas');
select throws_ok($$ select core.set_cost_center_archived((select cost_center_id from core.stores where id = (select v from ids where k = 'loja')), true) $$, 'P0492', null, 'não arquiva o centro de custo de loja ativa');

-- centros de custo editáveis
insert into ids select 'cc', (core.save_cost_center('{"code": "mkt-influ", "name": "Influenciadores", "kind": "POOL"}'::jsonb || jsonb_build_object('parent_id', (select id from core.cost_centers where org_id = '00000000-0000-4000-8000-000000000001' and code = 'MKT')))).id;
select is((select code from core.cost_centers where id = (select v from ids where k = 'cc')), 'MKT-INFLU', 'cria centro de custo (código em maiúsculas)');
select throws_ok($$ select core.save_cost_center(jsonb_build_object('id', (select id from core.cost_centers where org_id = '00000000-0000-4000-8000-000000000001' and code = 'MKT'), 'code', 'MKT', 'name', 'Marketing', 'kind', 'POOL', 'parent_id', (select v from ids where k = 'cc'))) $$,
  'P0490', null, 'um centro de custo não fica dentro dele mesmo');

-- plano de contas editável
insert into ids select 'acc', (fin.save_chart_account(jsonb_build_object('code', '1.1.1.90', 'name', 'Banco de teste — conta corrente', 'kind', 'ANALYTIC',
  'parent_id', (select id from fin.chart_accounts where org_id = '00000000-0000-4000-8000-000000000001' and code = '1.1.1')))).id;
select ok((select "group" = 'ASSET' and nature = 'DEBIT' from fin.chart_accounts where id = (select v from ids where k = 'acc')), 'nova conta herda grupo e natureza da conta-mãe');
select throws_ok($$ select fin.save_chart_account(jsonb_build_object('code', '2.9.99', 'name', 'Fora da mãe', 'kind', 'ANALYTIC', 'parent_id', (select id from fin.chart_accounts where org_id = '00000000-0000-4000-8000-000000000001' and code = '1.1.1'))) $$,
  'P0490', null, 'o código precisa começar com o da conta-mãe');
select lives_ok($$ select fin.save_chart_account(jsonb_build_object('id', a.id, 'code', a.code, 'name', 'Caixa da loja (renomeado)', 'kind', a.kind, 'parent_id', a.parent_id))
                   from fin.chart_accounts a where a.org_id = '00000000-0000-4000-8000-000000000001' and a.code = '1.1.1.01' $$, 'conta em uso pode mudar de nome');
select throws_ok($$ select fin.save_chart_account(jsonb_build_object('id', a.id, 'code', '1.1.1.91', 'name', a.name, 'kind', a.kind, 'parent_id', a.parent_id))
                   from fin.chart_accounts a where a.org_id = '00000000-0000-4000-8000-000000000001' and a.code = '1.1.1.01' $$, 'P0492', null, 'conta em uso não muda de código');
select throws_ok($$ select fin.set_chart_account_archived((select id from fin.chart_accounts where org_id = '00000000-0000-4000-8000-000000000001' and code = '1.1.1.01'), true) $$,
  'P0492', null, 'conta usada pelos lançamentos automáticos não é arquivada');
select lives_ok($$ select fin.set_chart_account_archived((select v from ids where k = 'acc'), true) $$, 'conta sem uso é arquivada');

select * from finish();
rollback;
