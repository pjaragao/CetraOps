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

select pg_temp.login('00000000-0000-4000-8000-0000000000f2');   -- vendedora: crm.write, sem crm.sensitive

-- Inscrição estadual
insert into ids select 'emp', (crm.create_party('{"kind":"COMPANY","display_name":"Fornecedor IE","cnpj":"73.184.529/0001-86","ie":"258.000.111","roles":["SUPPLIER"]}')).id;
select is((select ie from crm.parties where id = (select v from ids where k = 'emp')), '258000111', 'IE do cadastro novo fica só com os dígitos');
select is((crm.update_party_identity((select v from ids where k = 'emp'), '{"ie":"isento"}')).ie, 'ISENTO', 'ISENTO é aceito');
select throws_ok($$ select crm.update_party_identity((select v from ids where k = 'emp'), '{"ie":"ABC-1"}') $$, 'P0390', null, 'IE com letras é recusada');
select is((crm.update_party_identity((select v from ids where k = 'emp'), '{"ie":""}')).ie, null, 'IE vazia apaga');
select crm.save_registry((select v from ids where k = 'emp'), '{"cnpj":"73184529000186","legal_name":"FORNECEDOR IE LTDA","address":{"uf":"SC"},
  "state_registrations":[{"ie":"111","uf":"SP","active":true},{"ie":"222","uf":"SC","active":false},{"ie":"333.444","uf":"SC","active":true}]}');
select is((select ie from crm.parties where id = (select v from ids where k = 'emp')), '333444', 'consulta de CNPJ preenche a IE ativa da UF do endereço');
select crm.save_registry((select v from ids where k = 'emp'), '{"cnpj":"73184529000186","legal_name":"FORNECEDOR IE LTDA","state_registrations":[{"ie":"999","uf":"SC","active":true}]}');
select is((select ie from crm.parties where id = (select v from ids where k = 'emp')), '333444', 'IE já preenchida não é sobrescrita');

-- CPF na ficha
insert into ids select 'pes', (crm.create_party('{"display_name":"Pessoa CPF Ficha"}')).id;
select is(crm.party_cpf_masked((select v from ids where k = 'pes')), null, 'sem CPF, nada a mostrar');
select crm.set_cpf((select v from ids where k = 'pes'), '390.533.447-05');
select is(crm.party_cpf_masked((select v from ids where k = 'pes')), '***.***.*47-05', 'quem lê o cadastro vê só o final');
select throws_ok($$ select crm.reveal_cpf((select v from ids where k = 'pes')) $$, '42501', null, 'CPF completo exige crm.sensitive');

select pg_temp.login('00000000-0000-4000-8000-0000000000f1');   -- sócio: acesso total
select is(crm.reveal_cpf((select v from ids where k = 'pes')), '39053344705', 'com crm.sensitive o CPF completo aparece');
reset role;
select ok(exists (select 1 from audit.log where action = 'CPF_VIEWED' and record_id = (select v from ids where k = 'pes')::text), 'e a consulta fica registrada');

select * from finish();
rollback;
