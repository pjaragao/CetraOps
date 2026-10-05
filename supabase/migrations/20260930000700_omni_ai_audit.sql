-- =====================================================================
-- omni: canais, identidades, conversas (modo IA/humano), mensagens, rascunhos da IA, eventos de modo, webhooks
-- ai: roteamento de modelos (OpenRouter), personas, execuções, sugestões
-- audit: log imutável
-- =====================================================================

create type omni.channel as enum ('WHATSAPP', 'INSTAGRAM', 'TELEGRAM', 'TIKTOK');
create type omni.conv_mode as enum ('AI_AUTOPILOT', 'AI_COPILOT', 'HUMAN', 'WAITING_HUMAN');

create table omni.channel_accounts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  channel omni.channel not null,
  provider_account_id text not null,                             -- phone_number_id / ig_user_id / bot id
  display_name text not null,
  store_id uuid references core.stores(id),
  default_persona_id uuid,
  default_ai_mode omni.conv_mode not null default 'AI_COPILOT',
  business_hours jsonb not null default '{}',
  connection_id uuid references core.integration_connections(id),
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'DISABLED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (channel, provider_account_id)
);

create table omni.channel_identities (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  channel_account_id uuid not null references omni.channel_accounts(id),
  external_id text not null,                                     -- wa_id / IGSID / chat_id
  party_id uuid not null references crm.parties(id),
  profile jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (channel_account_id, external_id)
);

create table omni.conversations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  party_id uuid not null references crm.parties(id),
  channel_account_id uuid not null references omni.channel_accounts(id),
  channel_identity_id uuid not null references omni.channel_identities(id),
  status text not null default 'OPEN' check (status in ('OPEN', 'SNOOZED', 'CLOSED')),
  mode omni.conv_mode not null default 'AI_COPILOT',
  assignee_member_id uuid references core.members(id),
  persona_id uuid,
  deal_id uuid references crm.deals(id),
  last_message_at timestamptz,
  last_inbound_at timestamptz,
  service_window_expires_at timestamptz,                         -- WhatsApp/IG: último inbound + 24h
  human_agent_window_expires_at timestamptz,                     -- IG: último inbound + 7 dias (só humano)
  sla_due_at timestamptz,
  unread_count int not null default 0,
  priority smallint not null default 0,
  tags text[] not null default '{}',
  intent text,
  sentiment text,
  summary text,
  ai_paused_until timestamptz,
  pending_ai_at timestamptz,
  version int not null default 0,                                -- concorrência otimista (IA x humano)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index conversations_one_open on omni.conversations (channel_identity_id) where status <> 'CLOSED';
create index on omni.conversations (org_id, status, mode, last_message_at desc);
create index on omni.conversations (assignee_member_id) where status <> 'CLOSED';

alter table crm.deals add constraint deals_conversation_fk foreign key (conversation_id) references omni.conversations(id);
alter table sales.orders add constraint orders_conversation_fk foreign key (origin_conversation_id) references omni.conversations(id);

create table omni.messages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  conversation_id uuid not null references omni.conversations(id) on delete cascade,
  channel_account_id uuid not null references omni.channel_accounts(id),
  direction text not null check (direction in ('IN', 'OUT')),
  author_type text not null check (author_type in ('CUSTOMER', 'AI', 'HUMAN', 'ECHO_FROM_APP', 'SYSTEM')),
  author_member_id uuid references core.members(id),
  ai_run_id uuid,
  type text not null default 'TEXT' check (type in (
    'TEXT', 'IMAGE', 'AUDIO', 'VIDEO', 'DOCUMENT', 'STICKER', 'LOCATION', 'INTERACTIVE', 'TEMPLATE',
    'REACTION', 'STORY_REPLY', 'STORY_MENTION', 'COMMENT')),
  body text,
  media_path text,
  transcript text,
  template_name text,
  payload jsonb not null default '{}',
  provider_message_id text,
  client_dedupe_key text,
  status text not null default 'RECEIVED' check (status in ('RECEIVED', 'QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED')),
  error text,
  reply_to_id uuid references omni.messages(id),
  sent_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index messages_provider_uq on omni.messages (channel_account_id, provider_message_id) where provider_message_id is not null;
create unique index messages_dedupe_uq on omni.messages (client_dedupe_key) where client_dedupe_key is not null;
create index on omni.messages (conversation_id, created_at);

-- Atualiza janelas, não lidas e contadores da conversa; enfileira o roteador para mensagens do cliente
create or replace function private.on_message() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_channel omni.channel;
begin
  if new.direction = 'IN' then
    select channel into v_channel from omni.channel_accounts where id = new.channel_account_id;
    update omni.conversations set
      last_message_at = new.created_at,
      last_inbound_at = new.created_at,
      service_window_expires_at = case when v_channel in ('WHATSAPP', 'INSTAGRAM') then new.created_at + interval '24 hours' end,
      human_agent_window_expires_at = case when v_channel = 'INSTAGRAM' then new.created_at + interval '7 days' end,
      unread_count = unread_count + 1,
      status = 'OPEN',
      pending_ai_at = now()
    where id = new.conversation_id;
    -- Debounce: roteador roda 6 s depois; descarta se chegar mensagem mais nova
    perform private.enqueue('conversation_router',
      jsonb_build_object('conversation_id', new.conversation_id, 'message_id', new.id), 6);
  else
    -- Resposta enviada pelo app oficial (celular) → a conversa passa para HUMANO automaticamente
    if new.author_type = 'ECHO_FROM_APP' then
      perform set_config('centralops.mode_trigger', 'HUMAN_REPLIED_FROM_APP', true);
    elsif new.author_type = 'HUMAN' then
      perform set_config('centralops.mode_trigger', 'HUMAN_REPLIED', true);
    end if;
    update omni.conversations set last_message_at = new.created_at,
      unread_count = case when new.author_type in ('HUMAN', 'ECHO_FROM_APP') then 0 else unread_count end,
      assignee_member_id = coalesce(assignee_member_id, new.author_member_id),
      mode = case when new.author_type in ('ECHO_FROM_APP', 'HUMAN') and mode in ('AI_AUTOPILOT', 'AI_COPILOT', 'WAITING_HUMAN')
                  then 'HUMAN'::omni.conv_mode else mode end
    where id = new.conversation_id;
  end if;
  return new;
end $$;
create trigger trg_on_message after insert on omni.messages for each row execute function private.on_message();

create table omni.message_drafts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  conversation_id uuid not null references omni.conversations(id) on delete cascade,
  ai_run_id uuid,
  variants jsonb not null,                                       -- [{messages:[...bolhas]}]
  intent text,
  stage text,
  confidence numeric(4,3),
  needs_human boolean not null default false,
  flags text[] not null default '{}',
  status text not null default 'PENDING' check (status in ('PENDING', 'SENT', 'EDITED_SENT', 'DISCARDED', 'SUPERSEDED')),
  discard_reason text,
  final_message_id uuid references omni.messages(id),
  decided_by uuid references core.members(id),
  created_at timestamptz not null default now()
);
create index on omni.message_drafts (conversation_id) where status = 'PENDING';

create table omni.internal_notes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  conversation_id uuid not null references omni.conversations(id) on delete cascade,
  member_id uuid not null references core.members(id),
  body text not null,
  mentions uuid[] not null default '{}',
  created_at timestamptz not null default now()
);

create table omni.mode_events (
  id bigint generated always as identity primary key,
  org_id uuid not null references core.orgs(id),
  conversation_id uuid not null references omni.conversations(id) on delete cascade,
  from_mode omni.conv_mode,
  to_mode omni.conv_mode not null,
  trigger text not null,                                         -- MANUAL, HUMAN_REPLIED, HUMAN_REPLIED_FROM_APP, AI_REQUEST_HANDOFF, LOW_CONFIDENCE, KEYWORD, SLA...
  actor_type text not null check (actor_type in ('USER', 'AI', 'SYSTEM')),
  actor_member_id uuid references core.members(id),
  reason text,
  created_at timestamptz not null default now()
);

create or replace function private.log_mode_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.mode is distinct from old.mode then
    insert into omni.mode_events (org_id, conversation_id, from_mode, to_mode, trigger, actor_type, actor_member_id)
    values (new.org_id, new.id, old.mode, new.mode,
            coalesce(current_setting('centralops.mode_trigger', true), 'UNSPECIFIED'),
            case when private.member_id() is not null then 'USER' else 'SYSTEM' end, private.member_id());
    new.version := old.version + 1;                              -- invalida execuções de IA em andamento
  end if;
  return new;
end $$;
create trigger trg_log_mode before update of mode on omni.conversations
  for each row execute function private.log_mode_change();

-- Troca de modo a qualquer momento (botões IA Piloto / IA Copiloto / Humano / Devolver para IA)
create or replace function omni.set_mode(p_conversation uuid, p_mode omni.conv_mode, p_reason text default null)
returns omni.conversations
language plpgsql security definer set search_path = '' as $$
declare c omni.conversations;
begin
  perform private.require_perm('omni.write');
  perform set_config('centralops.mode_trigger', 'MANUAL', true);
  update omni.conversations set
    mode = p_mode,
    assignee_member_id = case when p_mode = 'HUMAN' then coalesce(assignee_member_id, private.member_id()) else assignee_member_id end,
    sla_due_at = case when p_mode = 'WAITING_HUMAN' then now() + interval '15 minutes' when p_mode = 'HUMAN' then null else sla_due_at end
  where id = p_conversation
    and (coalesce(auth.role(), '') <> 'authenticated' or org_id = private.org_id())
  returning * into c;
  if c.id is null then raise exception 'Conversa não encontrada' using errcode = 'P0002'; end if;
  if p_reason is not null then
    update omni.mode_events set reason = p_reason
    where id = (select max(id) from omni.mode_events where conversation_id = c.id);
  end if;
  -- Rascunhos pendentes deixam de valer quando um humano assume
  if p_mode = 'HUMAN' then
    update omni.message_drafts set status = 'SUPERSEDED' where conversation_id = c.id and status = 'PENDING';
  end if;
  return c;
end $$;

create table omni.templates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  channel_account_id uuid not null references omni.channel_accounts(id),
  name text not null,
  language text not null default 'pt_BR',
  category text not null check (category in ('MARKETING', 'UTILITY', 'AUTHENTICATION')),
  components jsonb not null default '[]',
  status text not null default 'PENDING',
  quality text,
  updated_at timestamptz not null default now(),
  unique (channel_account_id, name, language)
);

create table omni.quick_replies (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  shortcut text not null,
  body text not null,
  unique (org_id, shortcut)
);

-- Webhooks brutos: idempotência por (provider, event_key); payload expurgado após 90 dias
create table omni.webhook_events (
  id bigint generated always as identity primary key,
  provider text not null,
  event_key text not null,
  payload jsonb not null,
  signature_valid boolean not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  error text,
  unique (provider, event_key)
);
revoke all on omni.webhook_events from authenticated;

-- ---------------------------------------------------------------------
-- ai
-- ---------------------------------------------------------------------
create table ai.model_routes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  task text not null,                                            -- conversation, classify, extract, summarize, persona_style, judge, ops_copilot, embeddings
  primary_model text not null,                                   -- slug do OpenRouter
  fallback_models text[] not null default '{}',
  params jsonb not null default '{}',                            -- temperature, max_tokens, reasoning...
  provider_prefs jsonb not null default '{"zdr": true, "data_collection": "deny"}',
  daily_budget_usd numeric(10,2),
  requires_tools boolean not null default false,
  requires_json_schema boolean not null default false,
  active boolean not null default true,
  updated_by uuid references core.members(id),
  updated_at timestamptz not null default now(),
  unique (org_id, task)
);

create table ai.model_route_changes (
  id bigint generated always as identity primary key,
  org_id uuid not null references core.orgs(id),
  task text not null,
  before jsonb,
  after jsonb not null,
  changed_by uuid references core.members(id),
  changed_at timestamptz not null default now()
);

create or replace function private.log_route_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into ai.model_route_changes (org_id, task, before, after, changed_by)
  values (new.org_id, new.task, case when tg_op = 'UPDATE' then to_jsonb(old) end, to_jsonb(new), private.member_id());
  return new;
end $$;
create trigger trg_route_change after insert or update on ai.model_routes
  for each row execute function private.log_route_change();

create table ai.personas (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  name text not null,                                            -- 'Luisa', 'Paulo', 'Concierge'
  member_id uuid references core.members(id),
  active_version_id uuid,
  created_at timestamptz not null default now(),
  unique (org_id, name)
);

create table ai.persona_versions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  persona_id uuid not null references ai.personas(id) on delete cascade,
  version int not null,
  style_profile jsonb not null default '{}',
  system_prompt text,
  guardrails jsonb not null default '{}',
  eval_score jsonb,
  approved_by uuid references core.members(id),
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  unique (persona_id, version)
);
alter table ai.personas add constraint personas_active_version_fk foreign key (active_version_id) references ai.persona_versions(id);
alter table omni.channel_accounts add constraint channel_accounts_persona_fk foreign key (default_persona_id) references ai.personas(id);
alter table omni.conversations add constraint conversations_persona_fk foreign key (persona_id) references ai.personas(id);

create table ai.runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  route_task text not null,
  model text,
  provider text,
  persona_version_id uuid references ai.persona_versions(id),
  conversation_id uuid references omni.conversations(id) on delete set null,
  party_id uuid references crm.parties(id) on delete set null,
  tokens_in int, tokens_out int, cache_read_tokens int,
  cost_usd numeric(12,6),
  latency_ms int,
  confidence numeric(4,3),
  status text not null default 'RUNNING' check (status in ('RUNNING', 'OK', 'ERROR', 'DISCARDED', 'GUARDRAIL_BLOCKED')),
  error text,
  trace_id text,
  created_at timestamptz not null default now()
);
create index on ai.runs (org_id, route_task, created_at desc);

create table ai.tool_calls (
  id bigint generated always as identity primary key,
  run_id uuid not null references ai.runs(id) on delete cascade,
  tool text not null,
  args jsonb not null default '{}',
  result_digest jsonb,
  ok boolean not null,
  ms int,
  created_at timestamptz not null default now()
);

create table ai.customer_memories (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  party_id uuid not null references crm.parties(id) on delete cascade,
  fact text not null,
  category text,
  source_message_id uuid references omni.messages(id) on delete set null,
  confidence numeric(4,3),
  verified boolean not null default false,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

create table ai.suggestions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  kind text not null check (kind in ('NBA', 'CATEGORIZATION', 'RECON_MATCH', 'SKU_MATCH', 'REORDER', 'ANOMALY', 'REACTIVATION', 'ALLOCATION')),
  target_type text,
  target_id uuid,
  payload jsonb not null,
  confidence numeric(4,3),
  status text not null default 'OPEN' check (status in ('OPEN', 'ACCEPTED', 'DISMISSED', 'AUTO_APPLIED')),
  decided_by uuid references core.members(id),
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create index on ai.suggestions (org_id, kind) where status = 'OPEN';

-- ---------------------------------------------------------------------
-- audit
-- ---------------------------------------------------------------------
create table audit.log (
  id bigint generated always as identity primary key,
  org_id uuid,
  actor_type text not null,                                      -- USER, AI, SYSTEM, INTEGRATION
  actor_id uuid,
  action text not null,                                          -- INSERT, UPDATE, DELETE, VIEW_SENSITIVE...
  table_name text not null,
  record_id text,
  before jsonb,
  after jsonb,
  created_at timestamptz not null default now()
);
create index on audit.log (table_name, record_id);
create trigger trg_audit_immutable before update or delete on audit.log
  for each row execute function private.forbid_mutation();

create or replace function private.audit_capture() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r jsonb := to_jsonb(coalesce(new, old));
begin
  insert into audit.log (org_id, actor_type, actor_id, action, table_name, record_id, before, after)
  values ((r ->> 'org_id')::uuid,
          case when private.member_id() is not null then 'USER' else 'SYSTEM' end, private.member_id(),
          tg_op, tg_table_schema || '.' || tg_table_name, r ->> 'id',
          case when tg_op <> 'INSERT' then to_jsonb(old) end,
          case when tg_op <> 'DELETE' then to_jsonb(new) end);
  return coalesce(new, old);
end $$;

-- Tabelas sensíveis auditadas
create trigger trg_audit after insert or update or delete on core.members for each row execute function private.audit_capture();
create trigger trg_audit after insert or update or delete on core.member_roles for each row execute function private.audit_capture();
create trigger trg_audit after insert or update or delete on core.role_permissions for each row execute function private.audit_capture();
create trigger trg_audit after insert or update or delete on crm.party_sensitive for each row execute function private.audit_capture();
create trigger trg_audit after insert or update or delete on fin.titles for each row execute function private.audit_capture();
create trigger trg_audit after insert or update or delete on fin.acquirer_fee_plans for each row execute function private.audit_capture();
create trigger trg_audit after insert or update or delete on catalog.prices for each row execute function private.audit_capture();

select private.attach_updated_at('omni');
select private.attach_updated_at('ai');
