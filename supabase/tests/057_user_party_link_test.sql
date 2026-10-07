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
-- a pessoa já existe no cadastro (sócia); o usuário nasce sem ela e ganha uma pessoa automática
insert into ids select 'luisa', crm.quick_customer('48999990201', 'Luisa Teste Vinculo', false);
insert into ids select 'user', core.create_user(jsonb_build_object('email', 'luisa.vinculo@example.com', 'display_name', 'Luisa Teste Vinculo', 'password', 'Senha12345', 'roles', jsonb_build_array((select id from core.roles order by is_superuser desc limit 1)), 'all_stores', true));
select isnt((select party_id from core.members where id = (select v from ids where k = 'user')), (select v from ids where k = 'luisa'), 'usuário criado sem pessoa nasce com uma pessoa automática');

select lives_ok($$ select core.link_user_party((select v from ids where k = 'user'), (select v from ids where k = 'luisa')) $$, 'liga o usuário à pessoa do cadastro');
select is((select party_id from core.members where id = (select v from ids where k = 'user')), (select v from ids where k = 'luisa'), 'usuário aponta para a pessoa escolhida');
select is((select count(*)::int from crm.parties where org_id = (select org_id from core.members where id = (select v from ids where k = 'user')) and merged_into_id is null and display_name = 'Luisa Teste Vinculo'), 1, 'a duplicidade criada com o usuário foi mesclada');
select throws_ok($$ select core.create_user(jsonb_build_object('email', 'outra.vinculo@example.com', 'display_name', 'Outra', 'password', 'Senha12345', 'roles', jsonb_build_array((select id from core.roles order by is_superuser desc limit 1)), 'all_stores', true, 'party_id', (select v from ids where k = 'luisa'))) $$, 'P0421', 'Esta pessoa já tem um usuário no sistema', 'a mesma pessoa não ganha dois usuários');

select * from finish();
rollback;
