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
insert into ids select 'owner', id from core.roles where key = 'owner' and org_id = '00000000-0000-4000-8000-000000000001';
insert into ids select 'seller', id from core.roles where key = 'seller' and org_id = '00000000-0000-4000-8000-000000000001';

select is((select name from core.roles where id = (select v from ids where k = 'owner')), 'Administrador(a) — acesso total', 'perfil de acesso total não se chama mais "Sócio(a)"');
select is((select count(*)::int from core.members where party_id is null), 0, 'todo usuário existente ficou ligado a uma pessoa do cadastro');

-- sócia no cadastro, ainda sem acesso
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
insert into ids select 'luisa', (crm.create_party('{"display_name":"Luisa Sócia","roles":["SHAREHOLDER"]}')).id;
select is(core.party_access((select v from ids where k = 'luisa')), null, 'ser sócia no cadastro não dá acesso ao sistema');
select lives_ok($$ insert into ids select 'm_luisa', core.create_user(jsonb_build_object('party_id', (select v from ids where k = 'luisa'), 'email', 'luisa@centralops.test', 'display_name', 'Luisa', 'password', 'provisoria123',
  'roles', jsonb_build_array((select v from ids where k = 'owner')), 'all_stores', true)) $$, 'dá acesso a partir do cadastro');
select is((select party_id from core.members where id = (select v from ids where k = 'm_luisa')), (select v from ids where k = 'luisa'), 'usuário ligado à pessoa escolhida');
select ok(exists (select 1 from crm.party_contact_points where party_id = (select v from ids where k = 'luisa') and type = 'EMAIL' and value_normalized = 'luisa@centralops.test'), 'o e-mail de acesso entra nos contatos da pessoa');
select is((core.party_access((select v from ids where k = 'luisa')) ->> 'superuser')::boolean, true, 'a ficha da pessoa mostra o acesso total');
select throws_ok($$ select core.create_user(jsonb_build_object('party_id', (select v from ids where k = 'luisa'), 'email', 'outra@centralops.test', 'display_name', 'Outra', 'password', 'provisoria123',
  'roles', jsonb_build_array((select v from ids where k = 'seller')), 'all_stores', true)) $$, 'P0421', null, 'uma pessoa tem um só usuário');

-- sem indicar a pessoa: acha pelo e-mail
insert into ids select 'bia', (crm.create_party('{"display_name":"Bia Vendedora","emails":["bia@centralops.test"],"roles":["CUSTOMER"]}')).id;
select lives_ok($$ insert into ids select 'm_bia', core.create_user(jsonb_build_object('email', 'Bia@centralops.test', 'display_name', 'Bia', 'password', 'provisoria123',
  'roles', jsonb_build_array((select v from ids where k = 'seller')), 'all_stores', true)) $$, 'cria usuário sem indicar a pessoa');
select is((select party_id from core.members where id = (select v from ids where k = 'm_bia')), (select v from ids where k = 'bia'), 'vínculo achado pelo e-mail');

-- e-mail desconhecido: cria a pessoa
select lives_ok($$ insert into ids select 'm_novo', core.create_user(jsonb_build_object('email', 'novo-usuario@centralops.test', 'display_name', 'Carla Nova', 'password', 'provisoria123',
  'roles', jsonb_build_array((select v from ids where k = 'seller')), 'all_stores', true)) $$, 'cria usuário com e-mail que não está no cadastro');
select is((select p.display_name from core.members m join crm.parties p on p.id = m.party_id where m.id = (select v from ids where k = 'm_novo')), 'Carla Nova', 'a pessoa é criada no cadastro');

select * from finish();
rollback;
