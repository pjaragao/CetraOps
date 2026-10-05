begin;
create extension if not exists pgtap with schema extensions;
select plan(11);

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
insert into ids select 'celesc', id from crm.parties where cnpj = '08336783000190';
insert into ids select 'receita', id from crm.parties where cnpj = '00394460005887';
insert into ids select 'le', id from core.legal_entities where org_id = '00000000-0000-4000-8000-000000000001' order by created_at limit 1;

-- Favorecidos padrão
select is((select count(*)::int from crm.parties where 'favorecido-padrao' = any (tags)), 14, 'catorze favorecidos padrão');
select is((select payee_kind || '/' || (select code from fin.chart_accounts a where a.id = p.default_chart_account_id) from crm.parties p where id = (select v from ids where k = 'celesc')), 'UTILITY/7.2.07', 'CELESC: concessionária, energia');
select is((select payee_kind || '/' || (select code from fin.chart_accounts a where a.id = p.default_chart_account_id) from crm.parties p where id = (select v from ids where k = 'receita')), 'TAX_FEDERAL/2.1.4.01', 'Receita: tributo federal, DAS a recolher');
select is(private.seed_default_payees('00000000-0000-4000-8000-000000000001'), 0, 'rodar de novo não duplica');
select ok(exists (select 1 from crm.party_roles where party_id = (select v from ids where k = 'celesc') and role = 'SUPPLIER'), 'favorecido aparece como fornecedor');

-- Título sem conta: usa a categoria padrão; recebedor diferente
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
insert into ids select 'bank', (crm.create_party('{"kind":"COMPANY","display_name":"Banco Intermediador Teste","cnpj":"11.222.333/0001-81","roles":["SUPPLIER"]}')).id;
insert into ids select 't1', (fin.create_title(jsonb_build_object('direction', 'PAYABLE', 'legal_entity_id', (select v from ids where k = 'le'), 'party_id', (select v from ids where k = 'celesc'),
  'receiver_party_id', (select v from ids where k = 'bank'), 'description', 'Energia out/26', 'competence_date', '2026-10-01',
  'installments', jsonb_build_array(jsonb_build_object('due_date', '2026-10-20', 'amount', 350))))).id;
reset role;
select is((select code from fin.chart_accounts a join fin.titles t on t.chart_account_id = a.id where t.id = (select v from ids where k = 't1')), '7.2.07', 'sem conta escolhida, usa a categoria padrão do favorecido');
select is((select receiver_party_id from fin.titles where id = (select v from ids where k = 't1')), (select v from ids where k = 'bank'), 'recebedor diferente gravado');
select is((select receiver_name from fin.v_open_installments where title_id = (select v from ids where k = 't1') limit 1), 'Banco Intermediador Teste', 'parcelas em aberto mostram o recebedor');
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select lives_ok($$ select fin.set_title_receiver((select v from ids where k = 't1'), (select v from ids where k = 'celesc')) $$, 'troca o recebedor');
reset role;
select is((select receiver_party_id from fin.titles where id = (select v from ids where k = 't1')), null, 'recebedor igual ao fornecedor vira "o mesmo"');
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');   -- vendedora sem fin.write
select throws_ok($$ select fin.set_title_receiver((select v from ids where k = 't1'), null) $$, '42501', null, 'sem permissão do financeiro não altera');

select * from finish();
rollback;
