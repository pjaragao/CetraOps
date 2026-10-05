-- =====================================================================
-- crm: pessoa única (cliente = lead = fornecedor = trainer = colaborador), contatos, consentimentos, funis
-- =====================================================================

create type crm.party_kind as enum ('PERSON', 'COMPANY');
create type crm.lifecycle_stage as enum ('LEAD', 'PROSPECT', 'CUSTOMER', 'VIP', 'INACTIVE', 'LOST');
create type crm.tier as enum ('STANDARD', 'VIP', 'VIP_BLACK');
create type crm.party_role as enum (
  'CUSTOMER', 'SUPPLIER', 'EMPLOYEE', 'AFFILIATE_TRAINER', 'PARTNER_GYM', 'INFLUENCER',
  'CARRIER', 'SERVICE_PROVIDER', 'SHAREHOLDER', 'ACQUIRER', 'BANK'
);
create type crm.contact_type as enum ('PHONE', 'EMAIL', 'WHATSAPP', 'INSTAGRAM', 'TELEGRAM', 'TIKTOK');

create table crm.parties (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  kind crm.party_kind not null default 'PERSON',
  display_name text not null,
  legal_name text,
  cnpj text check (cnpj is null or cnpj ~ '^\d{14}$'),
  birth_date date,
  gender text,
  profession text,
  instagram_handle text,
  city text,
  uf char(2),
  home_store_id uuid references core.stores(id),               -- comunidade/academia de origem
  relationship_owner_member_id uuid references core.members(id),
  lifecycle_stage crm.lifecycle_stage not null default 'LEAD',
  tier crm.tier not null default 'STANDARD',
  lead_score smallint not null default 0 check (lead_score between 0 and 100),
  score_breakdown jsonb not null default '{}',
  host_member_status text not null default 'UNKNOWN'
    check (host_member_status in ('UNKNOWN', 'SELF_DECLARED', 'CONFIRMED_IN_STORE')),  -- nunca importado do parceiro
  sizes jsonb not null default '{}',                            -- {top, bottom, bra, shoe}
  preferences jsonb not null default '{}',
  source text,
  tags text[] not null default '{}',
  custom_fields jsonb not null default '{}',
  first_touch_at timestamptz not null default now(),
  first_purchase_at timestamptz,
  last_purchase_at timestamptz,
  merged_into_id uuid references crm.parties(id),
  anonymized_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on crm.parties (org_id, lifecycle_stage);
create index on crm.parties (org_id, home_store_id);
create unique index parties_cnpj_uq on crm.parties (org_id, cnpj) where cnpj is not null;
create index parties_name_trgm on crm.parties using gin (private.norm(display_name) extensions.gin_trgm_ops);

alter table core.stores add constraint stores_host_partner_fk
  foreign key (host_partner_party_id) references crm.parties(id);

-- CPF criptografado; acesso apenas por RPC com permissão 'crm.sensitive' e auditoria
create table crm.party_sensitive (
  party_id uuid primary key references crm.parties(id) on delete cascade,
  org_id uuid not null references core.orgs(id),
  cpf_encrypted bytea,
  cpf_hmac text,
  cpf_last4 char(4),
  updated_at timestamptz not null default now()
);
create unique index party_sensitive_cpf_uq on crm.party_sensitive (org_id, cpf_hmac) where cpf_hmac is not null;

create table crm.party_roles (
  party_id uuid not null references crm.parties(id) on delete cascade,
  org_id uuid not null references core.orgs(id),
  role crm.party_role not null,
  created_at timestamptz not null default now(),
  primary key (party_id, role)
);

-- Chave de resolução de identidade: um telefone/handle pertence a UMA pessoa
create table crm.party_contact_points (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  party_id uuid not null references crm.parties(id) on delete cascade,
  type crm.contact_type not null,
  value_normalized text not null,
  value_display text not null,
  is_primary boolean not null default false,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  unique (org_id, type, value_normalized)
);
create index on crm.party_contact_points (party_id);

-- Normaliza o valor antes de gravar (E.164 para telefone, minúsculas para handles/e-mail)
create or replace function private.normalize_contact_point() returns trigger
language plpgsql as $$
begin
  new.value_normalized := case
    when new.type in ('PHONE', 'WHATSAPP') then private.normalize_phone(new.value_display)
    when new.type in ('INSTAGRAM', 'TIKTOK') then lower(ltrim(trim(new.value_display), '@'))
    else lower(trim(new.value_display))
  end;
  return new;
end $$;
create trigger trg_normalize before insert or update of value_display, type on crm.party_contact_points
  for each row execute function private.normalize_contact_point();

create table crm.party_addresses (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  party_id uuid not null references crm.parties(id) on delete cascade,
  label text,
  cep char(8),
  street text, number text, complement text, district text, city text, uf char(2),
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);

create type crm.consent_purpose as enum (
  'TRANSACTIONAL', 'MARKETING_WHATSAPP', 'MARKETING_EMAIL', 'MARKETING_IG', 'AI_PROFILING', 'ENRICHMENT', 'IMAGE_USE'
);
create type crm.legal_basis as enum ('CONSENT', 'LEGITIMATE_INTEREST', 'CONTRACT', 'LEGAL_OBLIGATION');

-- Histórico só-inserção; o estado atual vem da view v_current_consents
create table crm.consents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  party_id uuid not null references crm.parties(id) on delete cascade,
  purpose crm.consent_purpose not null,
  granted boolean not null,
  legal_basis crm.legal_basis not null,
  evidence jsonb not null default '{}',                        -- message_id, versão do texto, canal
  recorded_by uuid references core.members(id),
  created_at timestamptz not null default now()
);
create index on crm.consents (party_id, purpose, created_at desc);
create trigger trg_consents_immutable before update or delete on crm.consents
  for each row execute function private.forbid_mutation();

create view crm.v_current_consents with (security_invoker = true) as
select distinct on (party_id, purpose) org_id, party_id, purpose, granted, legal_basis, evidence, created_at
from crm.consents
order by party_id, purpose, created_at desc;

-- Funis e oportunidades
create table crm.pipelines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  kind text not null check (kind in ('B2C', 'B2B_CORPORATE', 'AFFILIATE_RECRUIT', 'EVENT')),
  name text not null,
  active boolean not null default true
);

create table crm.pipeline_stages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  pipeline_id uuid not null references crm.pipelines(id) on delete cascade,
  name text not null,
  position int not null,
  probability numeric(5,2) not null default 0,
  sla_hours int,
  is_won boolean not null default false,
  is_lost boolean not null default false,
  unique (pipeline_id, position)
);

create table crm.deals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  party_id uuid not null references crm.parties(id),
  pipeline_id uuid not null references crm.pipelines(id),
  stage_id uuid not null references crm.pipeline_stages(id),
  title text not null,
  value_estimated numeric(14,2),
  owner_member_id uuid references core.members(id),
  conversation_id uuid,                                         -- FK adicionada em omni
  status text not null default 'OPEN' check (status in ('OPEN', 'WON', 'LOST')),
  lost_reason text,
  won_order_id uuid,                                            -- FK adicionada em sales
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on crm.deals (org_id, pipeline_id, stage_id) where status = 'OPEN';

create table crm.deal_stage_history (
  id bigint generated always as identity primary key,
  org_id uuid not null references core.orgs(id),
  deal_id uuid not null references crm.deals(id) on delete cascade,
  from_stage_id uuid references crm.pipeline_stages(id),
  to_stage_id uuid not null references crm.pipeline_stages(id),
  changed_by uuid references core.members(id),
  changed_at timestamptz not null default now()
);

create or replace function private.log_deal_stage() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' or new.stage_id is distinct from old.stage_id then
    insert into crm.deal_stage_history (org_id, deal_id, from_stage_id, to_stage_id, changed_by)
    values (new.org_id, new.id, case when tg_op = 'UPDATE' then old.stage_id end, new.stage_id, private.member_id());
  end if;
  return new;
end $$;
create trigger trg_deal_stage after insert or update of stage_id on crm.deals
  for each row execute function private.log_deal_stage();

-- Linha do tempo do cliente (alimentada por triggers de pedidos, conversas, pagamentos e pela IA)
create table crm.timeline_events (
  id bigint generated always as identity primary key,
  org_id uuid not null references core.orgs(id),
  party_id uuid not null references crm.parties(id) on delete cascade,
  occurred_at timestamptz not null default now(),
  kind text not null,                                           -- ORDER, PAYMENT, CONVERSATION_SUMMARY, NOTE, EVENT_RSVP...
  source_type text,
  source_id uuid,
  summary text not null,
  payload jsonb not null default '{}'
);
create index on crm.timeline_events (party_id, occurred_at desc);

create table crm.tasks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  party_id uuid references crm.parties(id) on delete cascade,
  deal_id uuid references crm.deals(id) on delete cascade,
  assignee_member_id uuid references core.members(id),
  type text not null default 'FOLLOW_UP',                       -- FOLLOW_UP, LOCKER_PREP, CALL, OUTREACH, BIRTHDAY...
  title text not null,
  body text,
  suggested_message text,
  due_at timestamptz,
  status text not null default 'OPEN' check (status in ('OPEN', 'DONE', 'CANCELLED')),
  created_by_ai boolean not null default false,
  source_rule text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on crm.tasks (assignee_member_id, due_at) where status = 'OPEN';

create table crm.segments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  name text not null,
  definition jsonb not null default '{}',
  is_dynamic boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table crm.segment_members (
  segment_id uuid not null references crm.segments(id) on delete cascade,
  party_id uuid not null references crm.parties(id) on delete cascade,
  org_id uuid not null references core.orgs(id),
  added_at timestamptz not null default now(),
  primary key (segment_id, party_id)
);

create table crm.lead_scoring_rules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  version int not null,
  rules jsonb not null,
  active boolean not null default false,
  created_at timestamptz not null default now(),
  unique (org_id, version)
);

create table crm.outreach_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  party_id uuid not null references crm.parties(id) on delete cascade,
  channel crm.contact_type not null,
  playbook_step text not null,                                  -- STORY_VIEW, LIKE, FOLLOW, DM
  suggested_message text,
  assigned_member_id uuid references core.members(id),
  status text not null default 'SUGGESTED' check (status in ('SUGGESTED', 'APPROVED', 'SENT_MANUALLY', 'SKIPPED')),
  evidence_message_id uuid,
  due_on date not null default current_date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Resolve (ou cria) a pessoa a partir de um ponto de contato. Usado pelo normalizador de mensagens e pelo PDV.
create or replace function crm.resolve_identity(
  p_org uuid, p_type crm.contact_type, p_value text, p_display_name text default null, p_source text default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_norm text;
  v_party uuid;
begin
  v_norm := case
    when p_type in ('PHONE', 'WHATSAPP') then private.normalize_phone(p_value)
    when p_type in ('INSTAGRAM', 'TIKTOK') then lower(ltrim(trim(p_value), '@'))
    else lower(trim(p_value))
  end;
  if v_norm is null then
    raise exception 'Contato vazio' using errcode = '22023';
  end if;

  select party_id into v_party from crm.party_contact_points
  where org_id = p_org and type = p_type and value_normalized = v_norm;
  if v_party is not null then
    return v_party;
  end if;

  insert into crm.parties (org_id, display_name, source, instagram_handle)
  values (p_org, coalesce(nullif(trim(p_display_name), ''), p_value), p_source,
          case when p_type = 'INSTAGRAM' then v_norm end)
  returning id into v_party;

  insert into crm.party_roles (party_id, org_id, role) values (v_party, p_org, 'CUSTOMER');
  insert into crm.party_contact_points (org_id, party_id, type, value_normalized, value_display, is_primary)
  values (p_org, v_party, p_type, v_norm, p_value, true)
  on conflict (org_id, type, value_normalized) do nothing;

  -- Corrida: outro processo criou o mesmo contato ao mesmo tempo → fica com o dele e descarta o órfão
  declare v_winner uuid;
  begin
    select party_id into v_winner from crm.party_contact_points
    where org_id = p_org and type = p_type and value_normalized = v_norm;
    if v_winner <> v_party then
      delete from crm.parties where id = v_party;
    end if;
    return v_winner;
  end;
end $$;
revoke execute on function crm.resolve_identity(uuid, crm.contact_type, text, text, text) from authenticated;

select private.attach_updated_at('crm');
