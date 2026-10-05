-- =====================================================================
-- Administrador inicial: garante que sempre exista um jeito de entrar no sistema.
-- private.ensure_initial_admin(e-mail, hash bcrypt da senha provisória):
--   • se a empresa não tem nenhum sócio ativo → cria (ou reaproveita) a conta do e-mail, vincula como Sócio(a) com todas as lojas,
--     reativa se estava suspensa e define a senha provisória (troca obrigatória no 1º acesso);
--   • se a conta do e-mail existe no login mas não está vinculada à empresa → vincula do mesmo jeito;
--   • nos demais casos não mexe em nada (não troca senha de quem já usa o sistema).
-- Roda nesta migration (bancos que já têm a empresa) e no seed supabase/seed/08_initial_admin.sql (bancos novos e a cada deploy).
-- No repositório fica só o HASH da senha provisória, nunca a senha.
-- =====================================================================

create or replace function private.ensure_initial_admin(p_email text, p_password_hash text,
  p_org uuid default '00000000-0000-4000-8000-000000000001') returns text
language plpgsql security definer set search_path = '' as $$
declare v_email text := lower(trim(p_email)); v_user uuid; v_member uuid; v_role uuid; v_store uuid; v_has_owner boolean;
begin
  if not exists (select 1 from core.orgs where id = p_org) then return 'NO_ORG'; end if;
  select exists (select 1 from core.members m join core.member_roles mr on mr.member_id = m.id join core.roles r on r.id = mr.role_id
                 where m.org_id = p_org and m.status = 'ACTIVE' and r.is_superuser) into v_has_owner;
  select id into v_user from auth.users where lower(email) = v_email;
  if v_user is not null then select id into v_member from core.members where user_id = v_user; end if;
  if v_has_owner and (v_user is null or v_member is not null) then return 'OK'; end if;   -- já há como entrar

  select id into v_role from core.roles where org_id = p_org and is_superuser order by key = 'owner' desc limit 1;
  if v_role is null then
    insert into core.roles (org_id, key, name, is_superuser) values (p_org, 'owner', 'Sócio(a)', true) returning id into v_role;
  end if;
  select id into v_store from core.stores where org_id = p_org order by status = 'ACTIVE' desc, created_at limit 1;

  if v_user is null then
    v_user := gen_random_uuid();
    insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                            confirmation_token, recovery_token, email_change, email_change_token_new)
    values ('00000000-0000-0000-0000-000000000000', v_user, 'authenticated', 'authenticated', v_email, p_password_hash, now(),
            '{"provider": "email", "providers": ["email"]}', '{}', now(), now(), '', '', '', '');
  else
    update auth.users set encrypted_password = p_password_hash, email_confirmed_at = coalesce(email_confirmed_at, now()), banned_until = null, updated_at = now() where id = v_user;
  end if;
  if not exists (select 1 from auth.identities where user_id = v_user and provider = 'email') then
    insert into auth.identities (id, user_id, provider_id, identity_data, provider, created_at, updated_at)
    values (gen_random_uuid(), v_user, v_user::text, jsonb_build_object('sub', v_user::text, 'email', v_email, 'email_verified', true), 'email', now(), now());
  end if;

  if v_member is null then
    insert into core.members (org_id, user_id, display_name, default_store_id, must_change_password)
    values (p_org, v_user, initcap(split_part(v_email, '@', 1)), v_store, true) returning id into v_member;
  else
    update core.members set status = 'ACTIVE', must_change_password = true, default_store_id = coalesce(default_store_id, v_store) where id = v_member;
  end if;
  insert into core.member_roles (member_id, role_id) values (v_member, v_role) on conflict do nothing;
  if not exists (select 1 from core.member_store_access where member_id = v_member and all_stores) then
    insert into core.member_store_access (member_id, all_stores) values (v_member, true);
  end if;
  begin
    insert into audit.log (org_id, actor_type, action, table_name, record_id, after)
    values (p_org, 'SYSTEM', 'INITIAL_ADMIN_ENSURED', 'core.members', v_member::text, jsonb_build_object('email', v_email));
  exception when others then null; end;
  return 'CREATED';
end $$;

-- Senha provisória padrão do administrador inicial (só o hash bcrypt). Trocar no 1º acesso é obrigatório.
select private.ensure_initial_admin('pjaragaojr@gmail.com', '$2a$10$s6MPTgNmcYTdmG.auwsrm.UpNqmhCKZQjminTZQ03ZrCl/qyhwKj6');

insert into private.internal_functions (fqname) values ('private.ensure_initial_admin') on conflict do nothing;
select private.lock_functions();
