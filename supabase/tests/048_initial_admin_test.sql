begin;
create extension if not exists pgtap with schema extensions;
select plan(10);

-- 1) Já existe sócio ativo e o e-mail não tem conta: nada muda
select is(private.ensure_initial_admin('ninguem@sie.test', extensions.crypt('Trocar@123', extensions.gen_salt('bf'))), 'OK', 'com sócio ativo, não cria conta nova');
select is((select count(*)::int from auth.users where email = 'ninguem@sie.test'), 0, 'nenhuma conta criada');

-- 2) Conta existe no login mas sem vínculo com a empresa (o erro "conta não vinculada"): vincula como sócio
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, created_at, updated_at, confirmation_token, recovery_token, email_change, email_change_token_new)
values ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-0000000000e9', 'authenticated', 'authenticated', 'semvinculo@sie.test', 'x', null, '{"provider":"email","providers":["email"]}', now(), now(), '', '', '', '');
select is(private.ensure_initial_admin('SemVinculo@sie.test', extensions.crypt('Trocar@123', extensions.gen_salt('bf'))), 'CREATED', 'conta sem vínculo é vinculada');
select ok(exists (select 1 from core.members m join core.member_roles mr on mr.member_id = m.id join core.roles r on r.id = mr.role_id
                  where m.user_id = '00000000-0000-4000-8000-0000000000e9' and r.is_superuser and m.status = 'ACTIVE' and m.must_change_password), 'vira sócio ativo com troca de senha obrigatória');
select ok((select encrypted_password = extensions.crypt('Trocar@123', encrypted_password) and email_confirmed_at is not null from auth.users where id = '00000000-0000-4000-8000-0000000000e9'), 'senha provisória definida e e-mail confirmado');
select ok(exists (select 1 from core.member_store_access a join core.members m on m.id = a.member_id where m.user_id = '00000000-0000-4000-8000-0000000000e9' and a.all_stores), 'acesso a todas as lojas');
select is(private.ensure_initial_admin('semvinculo@sie.test', 'outro-hash'), 'OK', 'depois de vinculado, não troca mais a senha');

-- 3) Ninguém consegue entrar (todos os sócios suspensos): cria o administrador inicial
update core.members set status = 'SUSPENDED' where id in (select mr.member_id from core.member_roles mr join core.roles r on r.id = mr.role_id where r.is_superuser);
select is(private.ensure_initial_admin('novo-admin@sie.test', extensions.crypt('Trocar@123', extensions.gen_salt('bf'))), 'CREATED', 'sem sócio ativo, cria o administrador');
select ok(exists (select 1 from auth.identities i join auth.users u on u.id = i.user_id where u.email = 'novo-admin@sie.test' and i.provider = 'email'), 'login por e-mail e senha criado');
select is(private.active_superusers('00000000-0000-4000-8000-000000000001'), 1, 'volta a existir um sócio ativo');

select * from finish();
rollback;
