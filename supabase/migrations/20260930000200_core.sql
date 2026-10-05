-- =====================================================================
-- core: organização, empresas (CNPJs), lojas, centros de custo, RBAC, configuração
-- =====================================================================

create table core.orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  settings jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create type core.legal_entity_kind as enum ('OPERATING', 'HOLDING');

create table core.legal_entities (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  parent_id uuid references core.legal_entities(id),          -- matriz → filial (/0002)
  kind core.legal_entity_kind not null default 'OPERATING',
  cnpj text not null,
  razao_social text not null,
  nome_fantasia text,
  ie text,
  im text,
  crt smallint not null default 1,                            -- 1 = Simples Nacional
  tax_regime text not null default 'SIMPLES_NACIONAL',
  cnae_principal text,
  cnaes_secundarios text[] not null default '{}',
  address jsonb not null default '{}',
  nfce_series int,
  nfe_series int,
  fiscal_provider_ref text,
  cert_expires_at date,
  status text not null default 'ACTIVE',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, cnpj),
  check (cnpj ~ '^\d{14}$')
);

create type core.cost_center_kind as enum ('CORPORATE', 'LEGAL_ENTITY', 'STORE', 'CHANNEL', 'PROJECT_EVENT', 'POOL');

create table core.cost_centers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  parent_id uuid references core.cost_centers(id),
  code text not null,
  name text not null,
  kind core.cost_center_kind not null,
  legal_entity_id uuid references core.legal_entities(id),
  store_id uuid,                                               -- FK adicionada após core.stores
  channel text,
  valid_from date not null default current_date,
  valid_to date,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, code)
);

create type core.store_format as enum ('SHOP_IN_SHOP', 'CONSIGNMENT_CORNER', 'POPUP', 'DIGITAL', 'WAREHOUSE', 'B2B');
create type core.store_status as enum ('PLANNED', 'ACTIVE', 'CLOSED');

create table core.stores (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  legal_entity_id uuid not null references core.legal_entities(id),
  code text not null,
  name text not null,
  format core.store_format not null,
  host_partner_party_id uuid,                                  -- FK para crm.parties (academia/parceiro anfitrião), adicionada no crm
  area_m2 numeric(8,2),
  business_hours jsonb not null default '{}',
  fiscal_mode text not null default 'ESTABELECIMENTO',
  cost_center_id uuid references core.cost_centers(id),
  opened_at date,
  closed_at date,
  status core.store_status not null default 'PLANNED',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, code)
);
alter table core.cost_centers add constraint cost_centers_store_fk foreign key (store_id) references core.stores(id);

-- ---------------------------------------------------------------------
-- RBAC
-- ---------------------------------------------------------------------
create table core.members (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  display_name text not null,
  default_store_id uuid references core.stores(id),
  pin_hash text,                                               -- PIN do PDV (bcrypt via pgcrypto)
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'SUSPENDED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on core.members (org_id);

create table core.roles (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  key text not null,
  name text not null,
  is_superuser boolean not null default false,                 -- sócio/admin: todas as permissões
  unique (org_id, key)
);

create table core.role_permissions (
  role_id uuid not null references core.roles(id) on delete cascade,
  permission_key text not null,                                -- ex.: 'sales.read', 'fin.write'
  primary key (role_id, permission_key)
);

create table core.member_roles (
  member_id uuid not null references core.members(id) on delete cascade,
  role_id uuid not null references core.roles(id) on delete cascade,
  primary key (member_id, role_id)
);

create table core.member_store_access (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references core.members(id) on delete cascade,
  store_id uuid references core.stores(id) on delete cascade,
  all_stores boolean not null default false,
  check (all_stores or store_id is not null)
);
create unique index member_store_access_uq
  on core.member_store_access (member_id, coalesce(store_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- ---------------------------------------------------------------------
-- Configuração, integrações e suporte
-- ---------------------------------------------------------------------
create table core.settings (
  org_id uuid not null references core.orgs(id),
  key text not null,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (org_id, key)
);

create table core.feature_flags (
  org_id uuid not null references core.orgs(id),
  key text not null,                                           -- ex.: 'channel.tiktok', 'ai.autopilot.whatsapp'
  enabled boolean not null default false,
  scope jsonb not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (org_id, key)
);

create table core.integration_connections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  provider text not null,       -- STONE, MERCADOPAGO, SIPAG, INTER, BTG, PLUGGY, FOCUS_NFE, META_WA, META_IG, TELEGRAM, OPENROUTER
  capability text not null,     -- POS, PAYMENT_LINK, PIX, BOLETO, STATEMENT, FISCAL, MESSAGING, LLM
  legal_entity_id uuid references core.legal_entities(id),
  status text not null default 'PENDING' check (status in ('PENDING', 'ACTIVE', 'ERROR', 'DISABLED')),
  config jsonb not null default '{}',                          -- nunca segredos; segredos ficam no Vault
  secret_ref text,                                             -- nome do segredo em vault.secrets
  last_sync_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index integration_connections_uq
  on core.integration_connections (org_id, provider, capability, coalesce(legal_entity_id, '00000000-0000-0000-0000-000000000000'::uuid));

create table core.attachments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  entity_type text not null,
  entity_id uuid not null,
  storage_path text not null,
  sha256 text,
  mime text,
  created_by uuid references core.members(id),
  created_at timestamptz not null default now()
);
create index on core.attachments (org_id, entity_type, entity_id);

create table core.custom_field_defs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  entity_type text not null,                                   -- 'fin.titles', 'crm.parties'...
  key text not null,
  label text not null,
  type text not null check (type in ('text', 'number', 'date', 'select', 'boolean')),
  options jsonb not null default '[]',
  required boolean not null default false,
  active boolean not null default true,
  position int not null default 0,
  unique (org_id, entity_type, key)
);

create table core.notifications (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  member_id uuid not null references core.members(id) on delete cascade,
  kind text not null,
  title text not null,
  payload jsonb not null default '{}',
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index on core.notifications (member_id, created_at desc) where read_at is null;

create table core.document_sequences (
  org_id uuid not null references core.orgs(id),
  doc_type text not null,
  year int not null,
  last_value bigint not null default 0,
  primary key (org_id, doc_type, year)
);

create table core.legacy_id_map (
  org_id uuid not null references core.orgs(id),
  entity text not null,
  legacy_id text not null,
  new_id uuid not null,
  primary key (org_id, entity, legacy_id)
);

-- Numeração legível por tipo de documento: VEN-2026-000123
create or replace function core.next_number(p_org uuid, p_doc_type text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v bigint;
  y int := extract(year from (now() at time zone 'America/Sao_Paulo'))::int;
begin
  insert into core.document_sequences as ds (org_id, doc_type, year, last_value)
  values (p_org, p_doc_type, y, 1)
  on conflict (org_id, doc_type, year) do update set last_value = ds.last_value + 1
  returning ds.last_value into v;
  return p_doc_type || '-' || y || '-' || lpad(v::text, 6, '0');
end $$;

-- ---------------------------------------------------------------------
-- Helpers de RLS (STABLE, chamados via (select ...) para cache por initPlan)
-- ---------------------------------------------------------------------
create or replace function private.org_id() returns uuid
language sql stable as $$
  select nullif(auth.jwt() -> 'app_metadata' ->> 'org_id', '')::uuid
$$;

create or replace function private.member_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select m.id from core.members m where m.user_id = (select auth.uid()) and m.status = 'ACTIVE'
$$;

create or replace function private.has_perm(p text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from core.members m
    join core.member_roles mr on mr.member_id = m.id
    join core.roles r on r.id = mr.role_id
    left join core.role_permissions rp on rp.role_id = r.id and rp.permission_key = p
    where m.user_id = (select auth.uid()) and m.status = 'ACTIVE'
      and (r.is_superuser or rp.permission_key is not null)
  )
$$;

create or replace function private.can_store(s uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select s is null or exists (
    select 1 from core.member_store_access a
    join core.members m on m.id = a.member_id
    where m.user_id = (select auth.uid()) and m.status = 'ACTIVE'
      and (a.all_stores or a.store_id = s)
  )
$$;

-- Para RPCs security definer: exige a permissão quando a chamada vem de um usuário (JWT role = authenticated).
-- service_role (worker) e agent_rpc (MCP, com escopo próprio) passam.
create or replace function private.require_perm(p text) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if coalesce(auth.role(), '') = 'authenticated' and not private.has_perm(p) then
    raise exception 'Sem permissão: %', p using errcode = '42501';
  end if;
  if coalesce(auth.role(), '') = 'anon' then
    raise exception 'Acesso anônimo negado' using errcode = '42501';
  end if;
end $$;

-- Custom Access Token Hook: injeta org_id e member_id nas claims do JWT
create or replace function private.custom_access_token_hook(event jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  claims jsonb := event -> 'claims';
  v_member_id uuid;
  v_org_id uuid;
begin
  select id, org_id into v_member_id, v_org_id from core.members
  where user_id = (event ->> 'user_id')::uuid and status = 'ACTIVE';
  if v_member_id is not null then
    claims := jsonb_set(claims, '{app_metadata}',
      coalesce(claims -> 'app_metadata', '{}'::jsonb)
      || jsonb_build_object('org_id', v_org_id, 'member_id', v_member_id));
  end if;
  return jsonb_set(event, '{claims}', claims);
end $$;

grant execute on function private.custom_access_token_hook(jsonb) to supabase_auth_admin;
revoke execute on function private.custom_access_token_hook(jsonb) from authenticated, anon, public;
grant execute on function private.org_id(), private.member_id(), private.has_perm(text), private.can_store(uuid), private.require_perm(text)
  to authenticated, service_role;

select private.attach_updated_at('core');
