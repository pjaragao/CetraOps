-- =====================================================================
-- Usuário do sistema × pessoa do cadastro: dois conceitos, um vínculo.
-- • "Sócio(a) da empresa" (crm.party_roles SHAREHOLDER) é um fato societário: pró-labore, lucros, contrato social. Não dá acesso.
-- • "Administrador(a) — acesso total" (core.roles is_superuser) é o que a pessoa pode fazer no sistema.
-- Todo usuário (core.members) aponta para a sua pessoa no cadastro (party_id). Se ninguém indicar, o vínculo é achado pelo
-- e-mail (ou pela admissão no RH) e, sem achar, a pessoa é criada com o e-mail de acesso como contato.
-- A ficha da pessoa mostra o acesso; a tela de usuários mostra a pessoa. Marcar alguém como sócio só sugere o perfil de acesso total.
-- =====================================================================

alter table core.members add column if not exists party_id uuid references crm.parties(id) on delete set null;
create unique index if not exists members_party_uq on core.members (party_id) where party_id is not null;

-- O perfil de acesso total deixa de se chamar "Sócio(a)" (o nome confundia com o papel societário do cadastro)
update core.roles set name = 'Administrador(a) — acesso total' where is_superuser and name in ('Sócio(a)', 'Sócio', 'Sócia', 'Sócios');

-- Acha ou cria a pessoa do usuário. Não troca um vínculo já feito.
create or replace function private.link_member_party(p_member uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare m core.members; v_email text; v_party uuid;
begin
  select * into m from core.members where id = p_member;
  if m.id is null then return null; end if;
  if m.party_id is not null then return m.party_id; end if;
  select lower(email) into v_email from auth.users where id = m.user_id;
  -- 1) admissão no RH ligada a este usuário
  select e.party_id into v_party from hr.employees e where e.member_id = m.id and e.party_id is not null
    and not exists (select 1 from core.members x where x.party_id = e.party_id) limit 1;
  -- 2) pessoa com o mesmo e-mail
  if v_party is null and v_email is not null then
    select c.party_id into v_party from crm.party_contact_points c join crm.parties p on p.id = c.party_id
    where c.org_id = m.org_id and c.type = 'EMAIL' and c.value_normalized = v_email and p.kind = 'PERSON' and p.merged_into_id is null
      and not exists (select 1 from core.members x where x.party_id = c.party_id) limit 1;
  end if;
  -- 3) cria a pessoa
  if v_party is null then
    insert into crm.parties (org_id, kind, display_name, source) values (m.org_id, 'PERSON', m.display_name, 'USUARIO') returning id into v_party;
    if v_email is not null then
      begin perform private.add_contact(m.org_id, v_party, 'EMAIL', v_email, true); exception when others then null; end;
    end if;
  end if;
  update core.members set party_id = v_party where id = m.id;
  return v_party;
end $$;

create or replace function private.trg_member_party() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.link_member_party(new.id);
  return null;
end $$;
create trigger trg_member_party after insert on core.members for each row when (new.party_id is null) execute function private.trg_member_party();

-- Usuários que já existem
select private.link_member_party(id) from core.members where party_id is null;

-- ---------------------------------------------------------------------
-- Criar usuário: aceita a pessoa do cadastro (party_id). Sem ela, o vínculo é automático (gatilho acima).
-- ---------------------------------------------------------------------
create or replace function core.create_user(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); v_email text := lower(trim(coalesce(p ->> 'email', ''))); v_name text := trim(coalesce(p ->> 'display_name', ''));
        v_user uuid; v_member uuid; v_party uuid := nullif(p ->> 'party_id', '')::uuid;
begin
  perform private.require_perm('core.admin');
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'E-mail inválido' using errcode = 'P0420'; end if;
  if length(v_name) < 2 then raise exception 'Informe o nome da pessoa' using errcode = 'P0420'; end if;
  if v_party is not null then
    if not exists (select 1 from crm.parties where id = v_party and org_id = v_org and kind = 'PERSON' and merged_into_id is null) then raise exception 'Pessoa do cadastro não encontrada' using errcode = 'P0422'; end if;
    if exists (select 1 from core.members where party_id = v_party) then raise exception 'Esta pessoa já tem um usuário no sistema' using errcode = 'P0421'; end if;
  end if;
  perform private.check_password(p ->> 'password');
  select id into v_user from auth.users where lower(email) = v_email;
  if v_user is not null then
    if exists (select 1 from core.members where user_id = v_user) then raise exception 'Este e-mail já é usuário do sistema' using errcode = 'P0421'; end if;
    update auth.users set encrypted_password = extensions.crypt(p ->> 'password', extensions.gen_salt('bf')), email_confirmed_at = coalesce(email_confirmed_at, now()), banned_until = null, updated_at = now() where id = v_user;
  else
    v_user := gen_random_uuid();
    insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                            confirmation_token, recovery_token, email_change, email_change_token_new)
    values ('00000000-0000-0000-0000-000000000000', v_user, 'authenticated', 'authenticated', v_email, extensions.crypt(p ->> 'password', extensions.gen_salt('bf')), now(),
            '{"provider": "email", "providers": ["email"]}', jsonb_build_object('name', v_name), now(), now(), '', '', '', '');
    insert into auth.identities (id, user_id, provider_id, identity_data, provider, created_at, updated_at)
    values (gen_random_uuid(), v_user, v_user::text, jsonb_build_object('sub', v_user::text, 'email', v_email, 'email_verified', true), 'email', now(), now());
  end if;
  insert into core.members (org_id, user_id, display_name, must_change_password, party_id) values (v_org, v_user, v_name, true, v_party) returning id into v_member;
  if v_party is not null then
    begin perform private.add_contact(v_org, v_party, 'EMAIL', v_email, false); exception when others then null; end;   -- o e-mail de acesso fica no cadastro
  end if;
  perform private.apply_member_access(v_member, p);
  perform private.audit_admin('USER_CREATED', 'core.members', v_member, jsonb_build_object('email', v_email, 'name', v_name, 'roles', p -> 'roles', 'party_id', v_party));
  return v_member;
end $$;

-- Lista de usuários com a pessoa do cadastro (e se ela é sócia da empresa)
create or replace function core.admin_users() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := private.org_id();
begin
  perform private.require_perm('core.admin');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', m.id, 'user_id', m.user_id, 'display_name', m.display_name, 'email', u.email, 'status', m.status,
      'last_sign_in_at', u.last_sign_in_at, 'created_at', m.created_at, 'default_store_id', m.default_store_id, 'must_change_password', m.must_change_password,
      'roles', coalesce((select jsonb_agg(mr.role_id) from core.member_roles mr where mr.member_id = m.id), '[]'),
      'all_stores', exists (select 1 from core.member_store_access a where a.member_id = m.id and a.all_stores),
      'stores', coalesce((select jsonb_agg(a.store_id) from core.member_store_access a where a.member_id = m.id and a.store_id is not null), '[]'),
      'employee', (select jsonb_build_object('id', e.id, 'name', p.display_name) from hr.employees e join crm.parties p on p.id = e.party_id where e.member_id = m.id limit 1),
      'party', (select jsonb_build_object('id', p.id, 'name', p.display_name, 'shareholder', exists (select 1 from crm.party_roles r where r.party_id = p.id and r.role = 'SHAREHOLDER'))
                from crm.parties p where p.id = m.party_id)
    ) order by m.status, m.display_name)
    from core.members m join auth.users u on u.id = m.user_id where m.org_id = v_org), '[]');
end $$;

-- Acesso ao sistema de uma pessoa do cadastro (ficha da pessoa; só administração)
create or replace function core.party_access(p_party uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r jsonb;
begin
  perform private.require_perm('core.admin');
  select jsonb_build_object('member_id', m.id, 'email', u.email, 'status', m.status, 'must_change_password', m.must_change_password, 'last_sign_in_at', u.last_sign_in_at,
           'roles', coalesce((select jsonb_agg(ro.name order by ro.is_superuser desc, ro.name) from core.member_roles mr join core.roles ro on ro.id = mr.role_id where mr.member_id = m.id), '[]'),
           'superuser', exists (select 1 from core.member_roles mr join core.roles ro on ro.id = mr.role_id where mr.member_id = m.id and ro.is_superuser))
    into r
  from core.members m join auth.users u on u.id = m.user_id where m.party_id = p_party and m.org_id = private.org_id();
  return r;
end $$;

insert into private.internal_functions (fqname) values ('private.link_member_party'), ('private.trg_member_party') on conflict do nothing;
select private.lock_functions();
