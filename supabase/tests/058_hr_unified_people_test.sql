begin;
create extension if not exists pgtap with schema extensions;
select plan(5);

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

select pg_temp.login('00000000-0000-4000-8000-0000000000f1');   -- sócio (administrador)
insert into ids select 'p', crm.quick_customer('48999990301', 'Luisa Teste RH', false);
insert into ids select 'p2', crm.quick_customer('48999990302', 'Joana Teste RH', false);
select crm.set_cpf((select v from ids where k = 'p2'), '16899535009');

-- admitir pessoa que já está no cadastro: usa a mesma pessoa e leva o CPF para o cadastro
select lives_ok($$ insert into ids select 'e1', (hr.create_employee(jsonb_build_object('legal_entity_id', '00000000-0000-4000-8000-0000000000e1', 'party_id', (select v from ids where k = 'p'),
  'cpf', '39053344705', 'salary', 2000, 'hire_date', private.today_sp(), 'job_title', 'Vendedora', 'contract_type', 'CLT'))).id $$, 'admite a pessoa que já está no cadastro');
select is((select party_id from hr.employees where id = (select v from ids where k = 'e1')), (select v from ids where k = 'p'), 'o colaborador aponta para a pessoa existente');
select is((crm.find_by_cpf('39053344705')) ->> 'party_id', (select v::text from ids where k = 'p'), 'o CPF da admissão passa a achar a pessoa no cadastro');

-- sem party_id: acha pela CPF que já está no cadastro, em vez de criar outra pessoa
select lives_ok($$ insert into ids select 'e2', (hr.create_employee(jsonb_build_object('legal_entity_id', '00000000-0000-4000-8000-0000000000e1', 'name', 'Joana Outro Nome',
  'cpf', '16899535009', 'salary', 2000, 'hire_date', private.today_sp(), 'job_title', 'Vendedora', 'contract_type', 'CLT'))).id $$, 'admite sem escolher a pessoa');
select is((select party_id from hr.employees where id = (select v from ids where k = 'e2')), (select v from ids where k = 'p2'), 'reaproveita a pessoa que já tinha o mesmo CPF');

select * from finish();
rollback;
