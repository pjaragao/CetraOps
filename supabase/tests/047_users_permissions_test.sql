begin;
create extension if not exists pgtap with schema extensions;
select plan(26);

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
insert into ids select 'seller', id from core.roles where key = 'seller' and org_id = '00000000-0000-4000-8000-000000000001';
insert into ids select 'owner', id from core.roles where key = 'owner' and org_id = '00000000-0000-4000-8000-000000000001';

-- ---------- Quem pode ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');   -- vendedora
select throws_ok($$ select core.admin_users() $$, '42501', null, 'vendedora não vê usuários');
select throws_ok($$ select core.create_user('{"email":"x@centralops.test","display_name":"X","password":"abcd1234"}') $$, '42501', null, 'vendedora não cria usuário');

-- ---------- Criar usuário ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');   -- sócio
select ok(jsonb_array_length(core.admin_users()) >= 2, 'sócio vê a lista de usuários');
select throws_ok($$ select core.create_user(jsonb_build_object('email', 'socia@centralops.test', 'display_name', 'Sócia Teste', 'password', 'curta', 'roles', jsonb_build_array((select v from ids where k = 'owner')), 'all_stores', true)) $$,
  'P0420', null, 'senha provisória fraca é recusada');
select throws_ok($$ select core.create_user(jsonb_build_object('email', 'socia@centralops.test', 'display_name', 'Sócia Teste', 'password', 'provisoria123', 'roles', '[]'::jsonb, 'all_stores', true)) $$,
  'P0420', null, 'precisa de ao menos um perfil');
select lives_ok($$ insert into ids select 'socia', core.create_user(jsonb_build_object('email', 'Socia@CENTRALOPS.test', 'display_name', 'Sócia Teste', 'password', 'provisoria123', 'roles', jsonb_build_array((select v from ids where k = 'owner')), 'all_stores', true)) $$,
  'cria a sócia com senha provisória');
reset role;
select is((select email from auth.users u join core.members m on m.user_id = u.id where m.id = (select v from ids where k = 'socia')), 'socia@centralops.test', 'conta de login criada com o e-mail em minúsculas');
select ok((select encrypted_password = extensions.crypt('provisoria123', encrypted_password) and email_confirmed_at is not null from auth.users u join core.members m on m.user_id = u.id where m.id = (select v from ids where k = 'socia')), 'senha guardada com hash e e-mail confirmado');
select ok(exists (select 1 from auth.identities i join core.members m on m.user_id = i.user_id where m.id = (select v from ids where k = 'socia') and i.provider = 'email'), 'identidade de e-mail criada (login por senha)');
select is((select must_change_password from core.members where id = (select v from ids where k = 'socia')), true, 'troca de senha exigida no 1º acesso');
select ok(exists (select 1 from core.member_store_access where member_id = (select v from ids where k = 'socia') and all_stores), 'acesso a todas as lojas');
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select throws_ok($$ select core.create_user(jsonb_build_object('email', 'socia@centralops.test', 'display_name', 'Outra', 'password', 'provisoria123', 'roles', jsonb_build_array((select v from ids where k = 'owner')), 'all_stores', true)) $$,
  'P0421', null, 'e-mail repetido é recusado');

-- ---------- Perfis ----------
select throws_ok($$ select core.save_role('{"name":"Gerente","permissions":["sales.read","inventar.tudo"]}') $$, 'P0420', null, 'permissão inexistente é recusada');
select lives_ok($$ insert into ids select 'gerente', (core.save_role('{"name":"Gerente de loja","permissions":["sales.read","sales.write","crm.read","hr.read"]}')).id $$, 'cria um perfil com permissões escolhidas');
select is((select array_agg(permission_key order by permission_key) from core.role_permissions where role_id = (select v from ids where k = 'gerente')), array['crm.read', 'hr.read', 'sales.read', 'sales.write'], 'permissões gravadas');
select lives_ok($$ select core.save_role(jsonb_build_object('id', (select v from ids where k = 'gerente'), 'name', 'Gerente de loja', 'permissions', jsonb_build_array('sales.read', 'crm.read'))) $$, 'edita as permissões do perfil');
select is((select count(*)::int from core.role_permissions where role_id = (select v from ids where k = 'gerente')), 2, 'permissões retiradas saem do perfil');
select throws_ok($$ select core.delete_role((select v from ids where k = 'owner')) $$, 'P0421', null, 'perfil de sócio não pode ser apagado');

-- ---------- Editar, suspender ----------
select lives_ok($$ select core.update_user((select v from ids where k = 'socia'), jsonb_build_object('display_name', 'Sócia Teste', 'roles', jsonb_build_array((select v from ids where k = 'gerente')), 'all_stores', false, 'stores', jsonb_build_array('00000000-0000-4000-8000-0000000000a1'))) $$, 'troca o perfil e as lojas');
select throws_ok($$ select core.delete_role((select v from ids where k = 'gerente')) $$, 'P0421', null, 'perfil em uso não pode ser apagado');
select throws_ok($$ select core.update_user((select id from core.members where user_id = '00000000-0000-4000-8000-0000000000f1'), jsonb_build_object('display_name', 'Sócio (teste)', 'roles', jsonb_build_array((select v from ids where k = 'seller')), 'all_stores', true)) $$,
  'P0421', null, 'ninguém tira o próprio acesso de administração');
select throws_ok($$ select core.set_user_status((select id from core.members where user_id = '00000000-0000-4000-8000-0000000000f1'), false) $$, 'P0421', null, 'ninguém suspende a si mesmo');
select lives_ok($$ select core.set_user_status((select v from ids where k = 'socia'), false) $$, 'suspende um usuário');
reset role;
select ok((select banned_until > now() + interval '50 years' from auth.users u join core.members m on m.user_id = u.id where m.id = (select v from ids where k = 'socia')), 'suspenso não consegue entrar');
update core.members set status = 'ACTIVE' where id = (select v from ids where k = 'socia');

-- ---------- Minha conta ----------
select pg_temp.login((select user_id from core.members where id = (select v from ids where k = 'socia')));
select throws_ok($$ select core.change_my_password('errada123', 'novaSenha2026') $$, 'P0420', null, 'senha atual errada é recusada');
select lives_ok($$ select core.change_my_password('provisoria123', 'novaSenha2026') $$, 'a pessoa troca a própria senha');

select * from finish();
rollback;
