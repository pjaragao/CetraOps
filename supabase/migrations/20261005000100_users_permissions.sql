-- =====================================================================
-- Usuários do sistema e permissões (Configurações › Usuários & permissões).
-- • Catálogo das permissões com nome e explicação em português (a tela monta os perfis a partir dele).
-- • Perfis (papéis): criar, renomear, escolher permissões, apagar perfil sem ninguém. O perfil "Sócio(a)" tem tudo e não é editável.
-- • Usuários: criar com e-mail e senha provisória (a pessoa troca no primeiro acesso), perfis, lojas, loja padrão,
--   suspender/reativar (bloqueia o login e derruba as sessões) e redefinir a senha provisória.
-- • Proteções: ninguém suspende a si mesmo nem tira o próprio acesso de administração; sempre sobra ao menos um sócio ativo.
-- A conta de login é criada direto no Supabase Auth (mesmo formato do cadastro por e-mail), sem precisar da chave de serviço no servidor web.
-- Códigos de erro: P0420 dado inválido · P0421 situação não permite · P0422 não encontrado.
-- =====================================================================

create table core.permission_catalog (
  key text primary key,
  area text not null,
  label text not null,
  description text not null,
  position int not null default 0
);
alter table core.permission_catalog enable row level security;
create policy p_read on core.permission_catalog for select to authenticated using (true);
grant select on core.permission_catalog to authenticated;

insert into core.permission_catalog (key, area, label, description, position) values
  ('core.read',          'Configurações', 'Ver configurações',              'Ver empresas, lojas, contas e parâmetros (sem alterar).', 10),
  ('core.admin',         'Configurações', 'Administrar o sistema',          'Alterar configurações, usuários e permissões. Dê só a quem administra.', 11),
  ('crm.read',           'Clientes',      'Ver clientes',                   'Fichas, histórico, tarefas, casos, funis e cadastros de pessoas e empresas.', 20),
  ('crm.write',          'Clientes',      'Editar clientes',                'Cadastrar e editar pessoas, tarefas, casos, eventos, réguas e campanhas.', 21),
  ('crm.sensitive',      'Clientes',      'Ver dados sensíveis de clientes', 'Ver CPF completo e dados pessoais protegidos (fica registrado).', 22),
  ('omni.read',          'Atendimento',   'Ver conversas',                  'Caixa de entrada, avisos e desempenho do atendimento.', 30),
  ('omni.write',         'Atendimento',   'Atender e configurar',           'Responder, assumir conversas, templates, automações e regras de atendimento.', 31),
  ('sales.read',         'Vendas',        'Ver vendas',                     'Pedidos, caixa, trocas e relatórios de vendas.', 40),
  ('sales.write',        'Vendas',        'Vender',                         'Usar o PDV, criar pedidos, reservas, trocas e links de pagamento.', 41),
  ('sales.discount',     'Vendas',        'Dar desconto acima do padrão',   'Aplicar descontos além do limite comum da vendedora.', 42),
  ('catalog.read',       'Produtos',      'Ver produtos',                   'Catálogo, preços e grades.', 50),
  ('catalog.write',      'Produtos',      'Editar produtos',                'Cadastrar produtos, variações e preços.', 51),
  ('inv.read',           'Estoque',       'Ver estoque',                    'Saldos, movimentações e transferências.', 55),
  ('inv.write',          'Estoque',       'Movimentar estoque',             'Ajustes, contagens, transferências e recebimentos.', 56),
  ('purch.read',         'Compras',       'Ver compras',                    'Pedidos de compra, fornecedores e reposição.', 60),
  ('purch.write',        'Compras',       'Fazer compras',                  'Criar e receber pedidos de compra.', 61),
  ('purch.approve',      'Compras',       'Aprovar compras',                'Aprovar pedidos de compra.', 62),
  ('fin.read',           'Financeiro',    'Ver financeiro',                 'Contas a pagar e receber, caixa, DRE e conciliação.', 70),
  ('fin.write',          'Financeiro',    'Lançar no financeiro',           'Lançar títulos, baixas, conciliar e importar extratos.', 71),
  ('fin.approve',        'Financeiro',    'Aprovar pagamentos',             'Aprovar contas a pagar e fechar períodos.', 72),
  ('fiscal.read',        'Fiscal',        'Ver fiscal',                     'Notas emitidas e recebidas, apuração do Simples.', 80),
  ('fiscal.write',       'Fiscal',        'Emitir e manifestar notas',      'Emitir, cancelar e manifestar notas fiscais.', 81),
  ('hr.read',            'Equipe',        'Ver equipe',                     'Colaboradores, escalas, ponto e férias.', 90),
  ('hr.write',           'Equipe',        'Gerir equipe',                   'Admitir, editar escalas, ponto, férias e freelancers.', 91),
  ('hr.sensitive',       'Equipe',        'Ver dados pessoais da equipe',   'CPF, documentos, dados bancários e salário individual.', 92),
  ('hr.payroll.read',    'Equipe',        'Ver folha',                      'Folha de pagamento, encargos e pró-labore.', 93),
  ('hr.payroll.write',   'Equipe',        'Calcular folha',                 'Calcular e ajustar a folha.', 94),
  ('hr.payroll.approve', 'Equipe',        'Aprovar folha',                  'Aprovar a folha e gerar as contas a pagar.', 95),
  ('ai.read',            'Inteligência',  'Ver inteligência',               'Sugestões, personas, base de conhecimento e custos da IA.', 100),
  ('ai.write',           'Inteligência',  'Configurar a IA',                'Personas, base de conhecimento, modelos e avaliações.', 101)
on conflict (key) do update set area = excluded.area, label = excluded.label, description = excluded.description, position = excluded.position;

alter table core.members add column if not exists must_change_password boolean not null default false;

-- ---------------------------------------------------------------------
-- Leitura: usuários com e-mail, último acesso, perfis e lojas (só administração)
-- ---------------------------------------------------------------------
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
      'employee', (select jsonb_build_object('id', e.id, 'name', p.display_name) from hr.employees e join crm.parties p on p.id = e.party_id where e.member_id = m.id limit 1)
    ) order by m.status, m.display_name)
    from core.members m join auth.users u on u.id = m.user_id where m.org_id = v_org), '[]');
end $$;

-- ---------------------------------------------------------------------
-- Proteções
-- ---------------------------------------------------------------------
-- Quantos sócios (perfil com tudo) ativos sobram se aplicarmos a mudança
create or replace function private.active_superusers(p_org uuid) returns int
language sql stable security definer set search_path = '' as $$
  select count(distinct m.id)::int from core.members m join core.member_roles mr on mr.member_id = m.id join core.roles r on r.id = mr.role_id
  where m.org_id = p_org and m.status = 'ACTIVE' and r.is_superuser
$$;

create or replace function private.member_is_admin(p_member uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from core.member_roles mr join core.roles r on r.id = mr.role_id
                 left join core.role_permissions rp on rp.role_id = r.id and rp.permission_key = 'core.admin'
                 where mr.member_id = p_member and (r.is_superuser or rp.role_id is not null))
$$;

create or replace function private.check_password(p text) returns void
language plpgsql immutable set search_path = '' as $$
begin
  if length(coalesce(p, '')) < 8 then raise exception 'A senha provisória precisa ter ao menos 8 caracteres' using errcode = 'P0420'; end if;
  if p !~ '[0-9]' or p !~ '[A-Za-zÀ-ú]' then raise exception 'A senha provisória precisa ter letras e números' using errcode = 'P0420'; end if;
end $$;

-- ---------------------------------------------------------------------
-- Perfis (papéis)
-- p = {id?, name, permissions: [keys]}
-- ---------------------------------------------------------------------
create or replace function core.save_role(p jsonb) returns core.roles
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); r core.roles; v_name text := trim(coalesce(p ->> 'name', '')); v_perms text[]; v_bad text; v_key text;
begin
  perform private.require_perm('core.admin');
  if length(v_name) < 3 then raise exception 'Dê um nome ao perfil (ao menos 3 letras)' using errcode = 'P0420'; end if;
  v_perms := array(select distinct jsonb_array_elements_text(coalesce(p -> 'permissions', '[]')));
  select k into v_bad from unnest(v_perms) k where not exists (select 1 from core.permission_catalog c where c.key = k) limit 1;
  if v_bad is not null then raise exception 'Permissão desconhecida: %', v_bad using errcode = 'P0420'; end if;
  if nullif(p ->> 'id', '') is not null then
    select * into r from core.roles where id = (p ->> 'id')::uuid and org_id = v_org;
    if r.id is null then raise exception 'Perfil não encontrado' using errcode = 'P0422'; end if;
    if exists (select 1 from core.roles x where x.org_id = v_org and lower(x.name) = lower(v_name) and x.id <> r.id) then raise exception 'Já existe um perfil com esse nome' using errcode = 'P0420'; end if;
    update core.roles set name = v_name where id = r.id returning * into r;
    if r.is_superuser then return r; end if;                                -- sócio: tem tudo, não há o que escolher
    -- quem edita não pode tirar do próprio perfil a administração se ficaria sem ela
    if not ('core.admin' = any (v_perms)) and exists (select 1 from core.member_roles mr where mr.role_id = r.id and mr.member_id = private.member_id())
       and not exists (select 1 from core.member_roles mr join core.roles x on x.id = mr.role_id left join core.role_permissions rp on rp.role_id = x.id and rp.permission_key = 'core.admin'
                       where mr.member_id = private.member_id() and x.id <> r.id and (x.is_superuser or rp.role_id is not null)) then
      raise exception 'Você perderia o acesso à administração: mantenha "Administrar o sistema" neste perfil' using errcode = 'P0421';
    end if;
    delete from core.role_permissions where role_id = r.id and permission_key <> all (v_perms);
  else
    if exists (select 1 from core.roles x where x.org_id = v_org and lower(x.name) = lower(v_name)) then raise exception 'Já existe um perfil com esse nome' using errcode = 'P0420'; end if;
    v_key := left(regexp_replace(lower(private.norm(v_name)), '[^a-z0-9]+', '_', 'g'), 30);
    while exists (select 1 from core.roles where org_id = v_org and key = v_key) loop v_key := left(v_key, 26) || '_' || substr(md5(random()::text), 1, 3); end loop;
    insert into core.roles (org_id, key, name) values (v_org, v_key, v_name) returning * into r;
  end if;
  insert into core.role_permissions (role_id, permission_key) select r.id, k from unnest(v_perms) k on conflict do nothing;
  perform private.audit_admin('ROLE_SAVED', 'core.roles', r.id, jsonb_build_object('name', r.name, 'permissions', to_jsonb(v_perms)));
  return r;
end $$;

create or replace function core.delete_role(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r core.roles;
begin
  perform private.require_perm('core.admin');
  select * into r from core.roles where id = p_id and org_id = private.org_id();
  if r.id is null then raise exception 'Perfil não encontrado' using errcode = 'P0422'; end if;
  if r.is_superuser then raise exception 'O perfil de sócio não pode ser apagado' using errcode = 'P0421'; end if;
  if exists (select 1 from core.member_roles where role_id = p_id) then raise exception 'Há usuários com este perfil: troque o perfil deles antes de apagar' using errcode = 'P0421'; end if;
  delete from core.roles where id = p_id;
  perform private.audit_admin('ROLE_DELETED', 'core.roles', p_id, jsonb_build_object('name', r.name));
end $$;

-- ---------------------------------------------------------------------
-- Usuários
-- ---------------------------------------------------------------------
create or replace function private.audit_admin(p_action text, p_table text, p_id uuid, p_after jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into audit.log (org_id, actor_type, actor_id, action, table_name, record_id, after)
  values (private.org_id(), 'USER', private.member_id(), p_action, p_table, p_id::text, p_after);
exception when others then null;   -- auditoria nunca impede a operação
end $$;

-- Aplica perfis, lojas e loja padrão (usado ao criar e ao editar). Valida tudo antes de gravar.
create or replace function private.apply_member_access(p_member uuid, p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); v_roles uuid[]; v_stores uuid[]; v_all boolean := coalesce((p ->> 'all_stores')::boolean, false); v_default uuid := nullif(p ->> 'default_store_id', '')::uuid;
begin
  v_roles := array(select distinct (jsonb_array_elements_text(coalesce(p -> 'roles', '[]')))::uuid);
  v_stores := array(select distinct (jsonb_array_elements_text(coalesce(p -> 'stores', '[]')))::uuid);
  if cardinality(v_roles) = 0 then raise exception 'Escolha ao menos um perfil' using errcode = 'P0420'; end if;
  if exists (select 1 from unnest(v_roles) x where not exists (select 1 from core.roles r where r.id = x and r.org_id = v_org)) then raise exception 'Perfil inválido' using errcode = 'P0420'; end if;
  if not v_all and cardinality(v_stores) = 0 then raise exception 'Escolha as lojas que a pessoa acessa (ou todas)' using errcode = 'P0420'; end if;
  if exists (select 1 from unnest(v_stores) x where not exists (select 1 from core.stores s where s.id = x and s.org_id = v_org)) then raise exception 'Loja inválida' using errcode = 'P0420'; end if;
  if v_default is not null and not v_all and not (v_default = any (v_stores)) then raise exception 'A loja padrão precisa estar entre as lojas liberadas' using errcode = 'P0420'; end if;

  delete from core.member_roles where member_id = p_member and role_id <> all (v_roles);
  insert into core.member_roles (member_id, role_id) select p_member, x from unnest(v_roles) x on conflict do nothing;
  delete from core.member_store_access where member_id = p_member;
  if v_all then insert into core.member_store_access (member_id, all_stores) values (p_member, true);
  else insert into core.member_store_access (member_id, store_id) select p_member, x from unnest(v_stores) x; end if;
  update core.members set default_store_id = coalesce(v_default, case when v_all then default_store_id end, v_stores[1]) where id = p_member;

  if private.active_superusers(v_org) = 0 then raise exception 'Precisa sobrar ao menos um sócio ativo' using errcode = 'P0421'; end if;
  if p_member = private.member_id() and not private.member_is_admin(p_member) then raise exception 'Você não pode tirar o próprio acesso de administração' using errcode = 'P0421'; end if;
end $$;

-- p = {email, display_name, password, roles[], all_stores, stores[], default_store_id}
create or replace function core.create_user(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); v_email text := lower(trim(coalesce(p ->> 'email', ''))); v_name text := trim(coalesce(p ->> 'display_name', ''));
        v_user uuid; v_member uuid;
begin
  perform private.require_perm('core.admin');
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'E-mail inválido' using errcode = 'P0420'; end if;
  if length(v_name) < 2 then raise exception 'Informe o nome da pessoa' using errcode = 'P0420'; end if;
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
  insert into core.members (org_id, user_id, display_name, must_change_password) values (v_org, v_user, v_name, true) returning id into v_member;
  perform private.apply_member_access(v_member, p);
  perform private.audit_admin('USER_CREATED', 'core.members', v_member, jsonb_build_object('email', v_email, 'name', v_name, 'roles', p -> 'roles'));
  return v_member;
end $$;

-- p = {display_name, roles[], all_stores, stores[], default_store_id}
create or replace function core.update_user(p_member uuid, p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare v_name text := trim(coalesce(p ->> 'display_name', ''));
begin
  perform private.require_perm('core.admin');
  if not exists (select 1 from core.members where id = p_member and org_id = private.org_id()) then raise exception 'Usuário não encontrado' using errcode = 'P0422'; end if;
  if length(v_name) < 2 then raise exception 'Informe o nome da pessoa' using errcode = 'P0420'; end if;
  update core.members set display_name = v_name where id = p_member;
  perform private.apply_member_access(p_member, p);
  perform private.audit_admin('USER_UPDATED', 'core.members', p_member, p - 'password');
end $$;

create or replace function core.set_user_status(p_member uuid, p_active boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare m core.members;
begin
  perform private.require_perm('core.admin');
  select * into m from core.members where id = p_member and org_id = private.org_id();
  if m.id is null then raise exception 'Usuário não encontrado' using errcode = 'P0422'; end if;
  if not p_active and m.id = private.member_id() then raise exception 'Você não pode suspender a si mesmo' using errcode = 'P0421'; end if;
  update core.members set status = case when p_active then 'ACTIVE' else 'SUSPENDED' end where id = p_member;
  if private.active_superusers(m.org_id) = 0 then raise exception 'Precisa sobrar ao menos um sócio ativo' using errcode = 'P0421'; end if;
  if p_active then
    update auth.users set banned_until = null, updated_at = now() where id = m.user_id;
  else
    update auth.users set banned_until = now() + interval '100 years', updated_at = now() where id = m.user_id;   -- bloqueia novos logins
    delete from auth.sessions where user_id = m.user_id;                                                         -- e derruba as sessões abertas
    delete from auth.refresh_tokens where user_id = m.user_id::text;
  end if;
  perform private.audit_admin(case when p_active then 'USER_REACTIVATED' else 'USER_SUSPENDED' end, 'core.members', p_member, null);
end $$;

-- Nova senha provisória (a pessoa troca no próximo acesso); derruba as sessões abertas
create or replace function core.reset_user_password(p_member uuid, p_password text) returns void
language plpgsql security definer set search_path = '' as $$
declare m core.members;
begin
  perform private.require_perm('core.admin');
  select * into m from core.members where id = p_member and org_id = private.org_id();
  if m.id is null then raise exception 'Usuário não encontrado' using errcode = 'P0422'; end if;
  perform private.check_password(p_password);
  update auth.users set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf')), updated_at = now() where id = m.user_id;
  update core.members set must_change_password = m.id <> private.member_id() where id = p_member;
  if m.id <> private.member_id() then
    delete from auth.sessions where user_id = m.user_id;
    delete from auth.refresh_tokens where user_id = m.user_id::text;
  end if;
  perform private.audit_admin('USER_PASSWORD_RESET', 'core.members', p_member, null);
end $$;

-- A própria pessoa troca a senha (Minha conta). Confere a senha atual.
create or replace function core.change_my_password(p_current text, p_new text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_user uuid := auth.uid(); v_hash text;
begin
  if v_user is null or private.member_id() is null then raise exception 'Faça login novamente' using errcode = '42501'; end if;
  select encrypted_password into v_hash from auth.users where id = v_user;
  if v_hash is null or extensions.crypt(coalesce(p_current, ''), v_hash) <> v_hash then raise exception 'A senha atual não confere' using errcode = 'P0420'; end if;
  perform private.check_password(p_new);
  if p_new = p_current then raise exception 'A nova senha precisa ser diferente da atual' using errcode = 'P0420'; end if;
  update auth.users set encrypted_password = extensions.crypt(p_new, extensions.gen_salt('bf')), updated_at = now() where id = v_user;
  update core.members set must_change_password = false where id = private.member_id();
end $$;

grant execute on function core.change_my_password(text, text) to authenticated;

insert into private.internal_functions (fqname) values ('private.active_superusers'), ('private.member_is_admin'), ('private.check_password'), ('private.apply_member_access'), ('private.audit_admin') on conflict do nothing;
select private.lock_functions();
