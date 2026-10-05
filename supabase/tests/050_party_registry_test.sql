begin;
create extension if not exists pgtap with schema extensions;
select plan(9);

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

select pg_temp.login('00000000-0000-4000-8000-0000000000f2');   -- vendedora (crm.write)
insert into ids select 'emp', (crm.create_party('{"kind":"COMPANY","display_name":"Caixa Teste","cnpj":"00.360.305/0001-04","roles":["SUPPLIER"]}')).id;
insert into ids select 'pes', (crm.create_party('{"display_name":"Pessoa Teste Receita"}')).id;

select throws_ok($$ select crm.save_registry((select v from ids where k = 'pes'), '{"cnpj":"00360305000104","legal_name":"X"}') $$, 'P0430', null, 'pessoa física não tem dados da Receita');
select throws_ok($$ select crm.save_registry((select v from ids where k = 'emp'), '{"cnpj":"11222333000181","legal_name":"OUTRA"}') $$, 'P0430', null, 'consulta de outro CNPJ é recusada');
select lives_ok($$ select crm.save_registry((select v from ids where k = 'emp'), jsonb_build_object(
  'cnpj', '00360305000104', 'legal_name', 'CAIXA ECONOMICA FEDERAL', 'situation', 'Ativa', 'phones', jsonb_build_array('6130000000'), 'email', 'contato-teste@caixa.test',
  'address', jsonb_build_object('cep', '70092900', 'street', 'SETOR SBS', 'number', 'S/N', 'district', 'ASA SUL', 'city', 'Brasília', 'uf', 'DF', 'ibge', '5300108'),
  'cnae_main', jsonb_build_object('code', '6423900', 'description', 'Caixas econômicas'), 'sources', jsonb_build_array('BrasilAPI'))) $$, 'grava o retrato da Receita');
select is((select registry ->> 'situation' from crm.parties where id = (select v from ids where k = 'emp')), 'Ativa', 'retrato guardado no cadastro');
select ok((select registry_at is not null from crm.parties where id = (select v from ids where k = 'emp')), 'com a data da consulta');
select is((select legal_name from crm.parties where id = (select v from ids where k = 'emp')), 'CAIXA ECONOMICA FEDERAL', 'razão social vazia é preenchida');
select ok(exists (select 1 from crm.party_addresses where party_id = (select v from ids where k = 'emp') and cep = '70092900' and is_default), 'endereço preenchido quando não havia nenhum');
select ok(exists (select 1 from crm.party_contact_points where party_id = (select v from ids where k = 'emp') and type = 'EMAIL'), 'e-mail entra nos contatos');
-- não apaga o que já foi digitado
update crm.parties set legal_name = 'Razão digitada à mão' where id = (select v from ids where k = 'emp');
select crm.save_registry((select v from ids where k = 'emp'), '{"cnpj":"00360305000104","legal_name":"CAIXA ECONOMICA FEDERAL","situation":"Ativa"}');
select is((select legal_name from crm.parties where id = (select v from ids where k = 'emp')), 'Razão digitada à mão', 'o que foi digitado não é sobrescrito');

select * from finish();
rollback;
