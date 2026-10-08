-- =====================================================================
-- Marketing › Campanha como guarda-chuva: público + oferta (cupom) + canais (disparos de WhatsApp, links/QR, anúncios) + resultado.
-- * A campanha antiga (um template, um público) vira "campanha + 1 disparo" (o disparo ganha o mesmo id da campanha antiga).
-- * Quem entra é congelado no lançamento (mkt.campaign_members), com sorteio estável do grupo de controle (holdout).
-- * Oferta: sem cupom · código único · cupom pessoal por pessoa (emitido na hora do envio) · cupom de cada afiliada.
-- * Disparos: o principal e lembretes (só para quem não comprou / não leu / não respondeu), todos respeitando consentimento, intervalo e limite diário.
-- Códigos de erro: P0190 dado inválido · P0191 situação não permite · P0192 não encontrado.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Campanha
-- ---------------------------------------------------------------------
alter table mkt.campaigns add column description text;
alter table mkt.campaigns add column objective text not null default 'CUSTOM' check (objective in ('REACTIVATE', 'LAUNCH', 'ACQUIRE', 'CONVERT', 'LOYALTY', 'EVENT', 'CLEARANCE', 'CUSTOM'));
alter table mkt.campaigns add column code text check (code is null or code ~ '^[a-z0-9]{3,10}$');
alter table mkt.campaigns add column audience_scope text not null default 'LOCAL' check (audience_scope in ('LOCAL', 'META', 'BOTH'));
alter table mkt.campaigns add column starts_at timestamptz;
alter table mkt.campaigns add column ends_at timestamptz;
alter table mkt.campaigns add column budget numeric(14, 2) check (budget is null or budget >= 0);
alter table mkt.campaigns add column holdout_pct smallint not null default 0 check (holdout_pct between 0 and 50);
alter table mkt.campaigns add column attribution_days smallint not null default 7 check (attribution_days between 1 and 60);
alter table mkt.campaigns add column landing_url text check (landing_url is null or landing_url ~* '^https?://[^\s]+$');
alter table mkt.campaigns alter column channel_account_id drop not null;       -- legados: o canal e o template agora vivem no disparo
alter table mkt.campaigns alter column template_id drop not null;
comment on column mkt.campaigns.channel_account_id is 'LEGADO: use mkt.campaign_dispatches';
comment on column mkt.campaigns.template_id is 'LEGADO: use mkt.campaign_dispatches';

create table mkt.campaign_dispatches (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  campaign_id uuid not null references mkt.campaigns(id) on delete cascade,
  seq smallint not null default 1,
  label text,
  channel_account_id uuid not null references omni.channel_accounts(id),
  template_id uuid not null references omni.templates(id),
  variables jsonb not null default '[]',                          -- uma entrada por {{n}}: {source, text?}
  filter text not null default 'ALL' check (filter in ('ALL', 'NOT_BOUGHT', 'NOT_READ', 'NOT_REPLIED')),
  scheduled_at timestamptz,
  frequency_cap_days integer not null default 7 check (frequency_cap_days between 0 and 90),
  daily_limit integer not null default 250 check (daily_limit between 1 and 10000),
  status text not null default 'DRAFT' check (status in ('DRAFT', 'SCHEDULED', 'SENDING', 'DONE', 'CANCELLED')),
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (campaign_id, seq)
);
create index campaign_dispatches_account_idx on mkt.campaign_dispatches (channel_account_id);

-- Campanhas antigas: 1 disparo com o MESMO id (mensagens e filas em andamento continuam apontando para ele)
insert into mkt.campaign_dispatches (id, org_id, campaign_id, seq, channel_account_id, template_id, variables, filter, scheduled_at, frequency_cap_days, daily_limit, status, started_at, finished_at, created_at)
select c.id, c.org_id, c.id, 1, c.channel_account_id, c.template_id, c.variables, 'ALL', c.scheduled_at, c.frequency_cap_days, c.daily_limit, c.status, c.started_at, c.finished_at, c.created_at
from mkt.campaigns c where c.channel_account_id is not null and c.template_id is not null;

alter table mkt.campaign_recipients add column dispatch_id uuid references mkt.campaign_dispatches(id) on delete cascade;
update mkt.campaign_recipients set dispatch_id = campaign_id;
alter table mkt.campaign_recipients alter column dispatch_id set not null;
alter table mkt.campaign_recipients drop constraint campaign_recipients_campaign_id_party_id_key;
alter table mkt.campaign_recipients add constraint campaign_recipients_dispatch_party_key unique (dispatch_id, party_id);
create index campaign_recipients_dispatch_todo_idx on mkt.campaign_recipients (dispatch_id, seq) where status = 'PENDING';
create index campaign_recipients_party_idx on mkt.campaign_recipients (party_id);

-- Situações da campanha: rascunho → ativa → encerrada (ou cancelada)
alter table mkt.campaigns drop constraint campaigns_status_check;
update mkt.campaigns set status = 'ACTIVE' where status in ('SCHEDULED', 'SENDING');
update mkt.campaigns set status = 'ENDED' where status = 'DONE';
alter table mkt.campaigns add constraint campaigns_status_check check (status in ('DRAFT', 'ACTIVE', 'ENDED', 'CANCELLED'));
update mkt.campaigns set code = 'c' || substr(replace(id::text, '-', ''), 1, 6) where code is null;
create unique index campaigns_code_uq on mkt.campaigns (org_id, code) where code is not null;
update mkt.campaigns set starts_at = coalesce(started_at, created_at) where status <> 'DRAFT' and starts_at is null;

create table mkt.campaign_members (
  campaign_id uuid not null references mkt.campaigns(id) on delete cascade,
  party_id uuid not null references crm.parties(id),
  org_id uuid not null references core.orgs(id),
  grp text not null default 'TREATMENT' check (grp in ('TREATMENT', 'HOLDOUT')),
  coupon_id uuid references sales.coupons(id) on delete set null,
  joined_at timestamptz not null default now(),
  primary key (campaign_id, party_id)
);
create index campaign_members_party_idx on mkt.campaign_members (party_id);
insert into mkt.campaign_members (campaign_id, party_id, org_id, grp, joined_at)
select r.campaign_id, r.party_id, min(r.org_id::text)::uuid, 'TREATMENT', min(r.created_at) from mkt.campaign_recipients r group by 1, 2;

create table mkt.campaign_offers (
  campaign_id uuid primary key references mkt.campaigns(id) on delete cascade,
  org_id uuid not null references core.orgs(id),
  mode text not null default 'NONE' check (mode in ('NONE', 'SHARED', 'PERSONAL', 'AFFILIATE')),
  kind text check (kind in ('PERCENT', 'AMOUNT')),
  value numeric(14, 2) check (value is null or value > 0),
  min_order numeric(14, 2) check (min_order is null or min_order >= 0),
  per_customer_limit integer check (per_customer_limit is null or per_customer_limit >= 1),
  max_uses integer check (max_uses is null or max_uses >= 1),
  valid_days integer check (valid_days is null or valid_days between 1 and 365),     -- cupom pessoal: dias de validade a partir do envio
  valid_to timestamptz,                                                              -- código único: até quando vale (vazio = até o fim da campanha)
  code text check (code is null or code ~ '^[A-Z0-9]{3,20}$'),
  code_prefix text check (code_prefix is null or code_prefix ~ '^[A-Z0-9]{2,8}$'),
  updated_at timestamptz not null default now()
);

alter table sales.coupons add column campaign_id uuid references mkt.campaigns(id) on delete set null;
alter table sales.coupons add column source text not null default 'MANUAL' check (source in ('MANUAL', 'CAMPAIGN', 'JOURNEY', 'AFFILIATE', 'REFERRAL'));
alter table sales.coupons add column updated_at timestamptz not null default now();
create index coupons_campaign_idx on sales.coupons (campaign_id) where campaign_id is not null;
update sales.coupons set source = 'AFFILIATE' where affiliate_party_id is not null;
update sales.coupons set source = 'JOURNEY' where source = 'MANUAL' and id in (select coupon_id from mkt.journey_enrollments where coupon_id is not null);
select private.attach_updated_at('sales');

select private.attach_updated_at('mkt');
select private.apply_rls('mkt', array['campaign_dispatches', 'campaign_members', 'campaign_offers'], 'crm.read', 'crm.write');
select private.rpc_only('mkt', array['campaign_dispatches', 'campaign_members', 'campaign_offers']);
create trigger trg_audit after insert or update or delete on mkt.campaign_dispatches for each row execute function private.audit_capture();
create trigger trg_audit after insert or update or delete on mkt.campaign_offers for each row execute function private.audit_capture();

-- A régua de aniversário passa a marcar o cupom como "JOURNEY"
do $x$
declare v_def text;
begin
  select pg_get_functiondef('private.ensure_journey_coupon(uuid)'::regprocedure) into v_def;
  if position('(org_id, code, kind, value, party_id, max_uses, per_customer_limit, min_order, valid_to)' in v_def) = 0
     or position($y$(v_last + 1)::timestamp at time zone 'America/Sao_Paulo')$y$ in v_def) = 0 then
    raise exception 'ensure_journey_coupon mudou: ajuste este patch';
  end if;
  v_def := replace(v_def, '(org_id, code, kind, value, party_id, max_uses, per_customer_limit, min_order, valid_to)', '(org_id, code, kind, value, party_id, max_uses, per_customer_limit, min_order, valid_to, source)');
  v_def := replace(v_def, $y$(v_last + 1)::timestamp at time zone 'America/Sao_Paulo')$y$, $y$(v_last + 1)::timestamp at time zone 'America/Sao_Paulo', 'JOURNEY')$y$);
  execute v_def;
end $x$;

-- ---------------------------------------------------------------------
-- 2) Auxiliares
-- ---------------------------------------------------------------------
create or replace function private.fmt_num(n numeric) returns text
language sql immutable as $$ select replace(case when n = trunc(n) then trunc(n)::text else regexp_replace(n::text, '0+$', '') end, '.', ',') $$;

-- Sorteio estável do grupo de controle: a mesma pessoa cai sempre no mesmo grupo da mesma campanha
create or replace function private.campaign_group(p_campaign uuid, p_party uuid, p_holdout integer) returns text
language sql immutable as $$ select case when (hashtext(p_party::text || p_campaign::text)::bigint & 2147483647) % 100 < coalesce(p_holdout, 0) then 'HOLDOUT' else 'TREATMENT' end $$;

create or replace function private.campaign_make_code(p_org uuid, p_name text) returns text
language plpgsql security definer set search_path = '' as $$
declare v text := left(regexp_replace(private.norm(p_name), '[^a-z0-9]+', '', 'g'), 8); v_try int := 0; v_c text;
begin
  if length(v) < 3 then v := left('camp' || v, 8); end if;
  v_c := v;
  while exists (select 1 from mkt.campaigns where org_id = p_org and code = v_c) and v_try < 20 loop
    v_try := v_try + 1;
    v_c := v || substr(md5(random()::text || clock_timestamp()::text), 1, 2);
  end loop;
  return v_c;
end $$;

-- Definição completa do público (filtros da campanha + público salvo)
create or replace function private.campaign_audience_def(c mkt.campaigns) returns jsonb
language sql immutable as $$ select coalesce(c.audience, '{}') || case when c.segment_id is not null then jsonb_build_object('segment_id', c.segment_id) else '{}'::jsonb end $$;

-- Por que uma pessoa NÃO pode receber agora (null = pode). Mensagens da própria campanha não contam para o intervalo.
drop function private.campaign_skip_reason(uuid, integer);
create or replace function private.campaign_skip_reason(p_party uuid, p_cap_days integer, p_campaign uuid default null) returns text
language plpgsql stable security definer set search_path = '' as $$
declare v_granted boolean;
begin
  if private.party_wa_id(p_party) is null then return 'NO_PHONE'; end if;
  select granted into v_granted from crm.v_current_consents where party_id = p_party and purpose = 'MARKETING_WHATSAPP';
  if not coalesce(v_granted, false) then return 'NO_CONSENT'; end if;
  if p_cap_days > 0 and exists (
    select 1 from omni.messages m join omni.conversations c on c.id = m.conversation_id join omni.templates t on t.id = (m.payload ->> 'template_id')::uuid
    where c.party_id = p_party and m.direction = 'OUT' and m.type = 'TEMPLATE' and t.category = 'MARKETING' and m.status <> 'FAILED' and m.created_at > now() - make_interval(days => p_cap_days)
      and (p_campaign is null or m.payload ->> 'campaign_id' is distinct from p_campaign::text)) then
    return 'FREQUENCY_CAP';
  end if;
  return null;
end $$;

-- Cupom pessoal (um por pessoa, uso único)
create or replace function private.issue_personal_coupon(p_org uuid, p_party uuid, p_kind text, p_value numeric, p_min numeric, p_valid_from timestamptz, p_valid_to timestamptz,
                                                         p_prefix text, p_campaign uuid, p_source text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_try int := 0;
begin
  while v_id is null and v_try < 8 loop
    v_try := v_try + 1;
    insert into sales.coupons (org_id, code, kind, value, party_id, max_uses, per_customer_limit, min_order, valid_from, valid_to, campaign_id, source)
    values (p_org, p_prefix || '-' || upper(substr(md5(random()::text || clock_timestamp()::text || p_party::text), 1, 6)), p_kind, p_value, p_party, 1, 1, p_min, p_valid_from, p_valid_to, p_campaign, p_source)
    on conflict (org_id, code) do nothing returning id into v_id;
  end loop;
  return v_id;
end $$;

-- ---------------------------------------------------------------------
-- 3) Campanha: cadastro (por passos; enquanto rascunho edita tudo, depois só descrição, fim e orçamento)
-- p = {id?, name, description?, objective?, segment_id?, audience?, audience_scope?, starts_at?, ends_at?, budget?, holdout_pct?, attribution_days?, landing_url?}
-- ---------------------------------------------------------------------
create or replace function mkt.save_campaign(p jsonb) returns mkt.campaigns
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id(); v_id uuid := nullif(p ->> 'id', '')::uuid; c mkt.campaigns; v_name text := trim(coalesce(p ->> 'name', ''));
  v_obj text := upper(coalesce(nullif(p ->> 'objective', ''), 'CUSTOM')); v_seg uuid := nullif(p ->> 'segment_id', '')::uuid; v_aud jsonb := coalesce(p -> 'audience', '{}');
  v_scope text := upper(coalesce(nullif(p ->> 'audience_scope', ''), 'LOCAL')); v_start timestamptz := nullif(p ->> 'starts_at', '')::timestamptz; v_end timestamptz := nullif(p ->> 'ends_at', '')::timestamptz;
  v_budget numeric := nullif(p ->> 'budget', '')::numeric; v_hold int := coalesce(nullif(p ->> 'holdout_pct', '')::int, 0); v_days int := coalesce(nullif(p ->> 'attribution_days', '')::int, 7);
  v_land text := nullif(trim(coalesce(p ->> 'landing_url', '')), ''); v_desc text := nullif(trim(coalesce(p ->> 'description', '')), '');
begin
  perform private.require_perm('crm.write');
  if length(v_name) not between 3 and 120 then raise exception 'O nome da campanha tem de 3 a 120 caracteres' using errcode = 'P0190'; end if;
  if v_obj not in ('REACTIVATE', 'LAUNCH', 'ACQUIRE', 'CONVERT', 'LOYALTY', 'EVENT', 'CLEARANCE', 'CUSTOM') then raise exception 'Objetivo inválido' using errcode = 'P0190'; end if;
  if v_scope not in ('LOCAL', 'META', 'BOTH') then raise exception 'Público inválido: escolha base local, Meta ou os dois' using errcode = 'P0190'; end if;
  perform private.audience_validate(v_aud);
  if v_seg is not null and not exists (select 1 from mkt.segments where id = v_seg and org_id = v_org) then raise exception 'Público salvo não encontrado' using errcode = 'P0192'; end if;
  if v_hold not between 0 and 50 then raise exception 'O grupo de controle vai de 0%% a 50%%' using errcode = 'P0190'; end if;
  if v_days not between 1 and 60 then raise exception 'A janela de atribuição vai de 1 a 60 dias' using errcode = 'P0190'; end if;
  if v_budget is not null and v_budget < 0 then raise exception 'Orçamento inválido' using errcode = 'P0190'; end if;
  if v_end is not null and v_end <= coalesce(v_start, now()) then raise exception 'O fim da campanha precisa ser depois do início' using errcode = 'P0190'; end if;
  if v_land is not null and v_land !~* '^https?://[^\s]+$' then raise exception 'Endereço da página inválido (comece com https://)' using errcode = 'P0190'; end if;
  if v_id is null then
    insert into mkt.campaigns (org_id, name, description, objective, segment_id, audience, audience_scope, starts_at, ends_at, budget, holdout_pct, attribution_days, landing_url, code, created_by)
    values (v_org, v_name, v_desc, v_obj, v_seg, v_aud, v_scope, v_start, v_end, v_budget, v_hold, v_days, v_land, private.campaign_make_code(v_org, v_name), private.member_id()) returning * into c;
  else
    select * into c from mkt.campaigns where id = v_id and org_id = v_org for update;
    if c.id is null then raise exception 'Campanha não encontrada' using errcode = 'P0192'; end if;
    if c.status = 'DRAFT' then
      update mkt.campaigns set name = v_name, description = v_desc, objective = v_obj, segment_id = v_seg, audience = v_aud, audience_scope = v_scope, starts_at = v_start, ends_at = v_end,
             budget = v_budget, holdout_pct = v_hold, attribution_days = v_days, landing_url = v_land where id = c.id returning * into c;
    elsif c.status = 'ACTIVE' then
      update mkt.campaigns set name = v_name, description = v_desc, ends_at = v_end, budget = v_budget where id = c.id returning * into c;
    else
      raise exception 'Campanha já encerrada: não pode mais ser alterada' using errcode = 'P0192';
    end if;
  end if;
  return c;
end $$;

-- Oferta (um cupom/regra por campanha). p = {campaign_id, mode, kind?, value?, min_order?, per_customer_limit?, max_uses?, valid_days?, valid_to?, code?, code_prefix?}
create or replace function mkt.save_campaign_offer(p jsonb) returns mkt.campaign_offers
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id(); c mkt.campaigns; o mkt.campaign_offers; v_mode text := upper(coalesce(nullif(p ->> 'mode', ''), 'NONE')); v_kind text := upper(nullif(p ->> 'kind', ''));
  v_val numeric := nullif(p ->> 'value', '')::numeric; v_min numeric := nullif(p ->> 'min_order', '')::numeric; v_pcl int := nullif(p ->> 'per_customer_limit', '')::int;
  v_max int := nullif(p ->> 'max_uses', '')::int; v_vdays int := nullif(p ->> 'valid_days', '')::int; v_vto timestamptz := nullif(p ->> 'valid_to', '')::timestamptz;
  v_code text := upper(trim(coalesce(p ->> 'code', ''))); v_prefix text := upper(trim(coalesce(p ->> 'code_prefix', '')));
begin
  perform private.require_perm('crm.write');
  select * into c from mkt.campaigns where id = nullif(p ->> 'campaign_id', '')::uuid and org_id = v_org for update;
  if c.id is null then raise exception 'Campanha não encontrada' using errcode = 'P0192'; end if;
  if c.status <> 'DRAFT' then raise exception 'A oferta só muda enquanto a campanha é rascunho' using errcode = 'P0191'; end if;
  if v_mode not in ('NONE', 'SHARED', 'PERSONAL', 'AFFILIATE') then raise exception 'Tipo de oferta inválido' using errcode = 'P0190'; end if;
  if v_mode in ('SHARED', 'PERSONAL') then
    if v_kind not in ('PERCENT', 'AMOUNT') then raise exception 'Escolha desconto em %% ou em reais' using errcode = 'P0190'; end if;
    if v_val is null or v_val <= 0 or (v_kind = 'PERCENT' and v_val > 100) then raise exception 'Valor do desconto inválido' using errcode = 'P0190'; end if;
  end if;
  if v_mode = 'SHARED' then
    if v_code !~ '^[A-Z0-9]{3,20}$' then raise exception 'O código usa de 3 a 20 letras ou números (sem espaço nem acento)' using errcode = 'P0190'; end if;
    if exists (select 1 from sales.coupons cp where cp.org_id = v_org and upper(cp.code) = v_code and cp.campaign_id is distinct from c.id) then raise exception 'Já existe um cupom com o código %', v_code using errcode = 'P0190'; end if;
  elsif v_mode = 'PERSONAL' then
    v_vdays := coalesce(v_vdays, 14);
    if v_prefix = '' then v_prefix := 'CMP'; end if;
    if v_prefix !~ '^[A-Z0-9]{2,8}$' then raise exception 'O prefixo do cupom usa de 2 a 8 letras ou números' using errcode = 'P0190'; end if;
    v_pcl := 1; v_max := 1;
  end if;
  if v_pcl is not null and v_pcl < 1 then raise exception 'Usos por cliente inválido' using errcode = 'P0190'; end if;
  if v_max is not null and v_max < 1 then raise exception 'Usos no total inválido' using errcode = 'P0190'; end if;
  if v_min is not null and v_min < 0 then raise exception 'Pedido mínimo inválido' using errcode = 'P0190'; end if;
  insert into mkt.campaign_offers (campaign_id, org_id, mode, kind, value, min_order, per_customer_limit, max_uses, valid_days, valid_to, code, code_prefix)
  values (c.id, v_org, v_mode, case when v_mode in ('SHARED', 'PERSONAL') then v_kind end, case when v_mode in ('SHARED', 'PERSONAL') then v_val end, case when v_mode in ('SHARED', 'PERSONAL') then v_min end,
          case when v_mode in ('SHARED', 'PERSONAL') then v_pcl end, case when v_mode in ('SHARED', 'PERSONAL') then v_max end, case when v_mode = 'PERSONAL' then v_vdays end,
          case when v_mode = 'SHARED' then v_vto end, case when v_mode = 'SHARED' then v_code end, case when v_mode = 'PERSONAL' then v_prefix end)
  on conflict (campaign_id) do update set mode = excluded.mode, kind = excluded.kind, value = excluded.value, min_order = excluded.min_order, per_customer_limit = excluded.per_customer_limit,
         max_uses = excluded.max_uses, valid_days = excluded.valid_days, valid_to = excluded.valid_to, code = excluded.code, code_prefix = excluded.code_prefix, updated_at = now()
  returning * into o;
  return o;
end $$;

-- ---------------------------------------------------------------------
-- 4) Disparos de WhatsApp
-- p = {id?, campaign_id, label?, channel_account_id, template_id, variables, filter?, scheduled_at?, frequency_cap_days?, daily_limit?}
-- Variáveis: FIRST_NAME · FULL_NAME · TEXT(text) · COUPON_CODE · COUPON_VALUE · COUPON_EXPIRY · LINK · CAMPAIGN_END
-- ---------------------------------------------------------------------
create or replace function mkt.save_dispatch(p jsonb) returns mkt.campaign_dispatches
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id(); v_id uuid := nullif(p ->> 'id', '')::uuid; c mkt.campaigns; d mkt.campaign_dispatches; t omni.templates; o mkt.campaign_offers;
  v_acc uuid := nullif(p ->> 'channel_account_id', '')::uuid; v_tpl uuid := nullif(p ->> 'template_id', '')::uuid; v_vars jsonb := coalesce(p -> 'variables', '[]'); x jsonb; v_body text; v_ph int[];
  v_filter text := upper(coalesce(nullif(p ->> 'filter', ''), 'ALL')); v_at timestamptz := nullif(p ->> 'scheduled_at', '')::timestamptz; v_label text := nullif(trim(coalesce(p ->> 'label', '')), '');
  v_cap int := coalesce(nullif(p ->> 'frequency_cap_days', '')::int, 7); v_daily int := coalesce(nullif(p ->> 'daily_limit', '')::int, 250); v_seq int;
begin
  perform private.require_perm('crm.write');
  select * into c from mkt.campaigns where id = nullif(p ->> 'campaign_id', '')::uuid and org_id = v_org for update;
  if c.id is null then raise exception 'Campanha não encontrada' using errcode = 'P0192'; end if;
  if c.status not in ('DRAFT', 'ACTIVE') then raise exception 'Campanha já encerrada' using errcode = 'P0191'; end if;
  if v_id is not null then
    select * into d from mkt.campaign_dispatches where id = v_id and campaign_id = c.id;
    if d.id is null then raise exception 'Disparo não encontrado' using errcode = 'P0192'; end if;
    if d.status <> 'DRAFT' then raise exception 'Este disparo já foi agendado: cancele e crie outro' using errcode = 'P0191'; end if;
  end if;
  if not exists (select 1 from omni.channel_accounts where id = v_acc and org_id = v_org and channel = 'WHATSAPP' and status = 'ACTIVE') then raise exception 'Escolha um número de WhatsApp ativo' using errcode = 'P0190'; end if;
  select * into t from omni.templates where id = v_tpl and org_id = v_org;
  if t.id is null or t.channel_account_id <> v_acc then raise exception 'Escolha um template deste número' using errcode = 'P0190'; end if;
  if t.status <> 'APPROVED' then raise exception 'O template ainda não foi aprovado pela Meta (situação: %)', t.status using errcode = 'P0190'; end if;
  select c2 ->> 'text' into v_body from jsonb_array_elements(t.components) c2 where c2 ->> 'type' = 'BODY' limit 1;
  v_ph := private.template_placeholders(v_body);
  if jsonb_typeof(v_vars) <> 'array' or jsonb_array_length(v_vars) <> coalesce(array_length(v_ph, 1), 0) then raise exception 'Defina as % variável(is) do template', coalesce(array_length(v_ph, 1), 0) using errcode = 'P0190'; end if;
  select * into o from mkt.campaign_offers where campaign_id = c.id;
  for x in select * from jsonb_array_elements(v_vars) loop
    if x ->> 'source' not in ('FIRST_NAME', 'FULL_NAME', 'TEXT', 'COUPON_CODE', 'COUPON_VALUE', 'COUPON_EXPIRY', 'LINK', 'CAMPAIGN_END')
       or (x ->> 'source' = 'TEXT' and (coalesce(trim(x ->> 'text'), '') = '' or length(x ->> 'text') > 200 or (x ->> 'text') ~ '[\r\n\t]')) then
      raise exception 'Variável inválida: use nome, um texto fixo (até 200 caracteres, sem quebra de linha), dados do cupom, o link ou o fim da campanha' using errcode = 'P0190';
    end if;
    if x ->> 'source' in ('COUPON_CODE', 'COUPON_VALUE', 'COUPON_EXPIRY') and coalesce(o.mode, 'NONE') not in ('SHARED', 'PERSONAL') then
      raise exception 'Para usar o cupom na mensagem, defina antes a oferta (código único ou cupom pessoal)' using errcode = 'P0190';
    end if;
    if x ->> 'source' = 'CAMPAIGN_END' and c.ends_at is null then raise exception 'Defina o fim da campanha para usar a data de fim na mensagem' using errcode = 'P0190'; end if;
    if x ->> 'source' = 'LINK' and c.landing_url is null then raise exception 'Informe a página da campanha para usar o link na mensagem' using errcode = 'P0190'; end if;
  end loop;
  if v_filter not in ('ALL', 'NOT_BOUGHT', 'NOT_READ', 'NOT_REPLIED') then raise exception 'Filtro do disparo inválido' using errcode = 'P0190'; end if;
  if v_cap not between 0 and 90 then raise exception 'O intervalo entre mensagens de marketing vai de 0 a 90 dias' using errcode = 'P0190'; end if;
  if v_daily not between 1 and 10000 then raise exception 'O limite diário vai de 1 a 10.000' using errcode = 'P0190'; end if;
  if v_filter <> 'ALL' and v_at is null then raise exception 'O lembrete precisa de data e hora' using errcode = 'P0190'; end if;
  if v_filter <> 'ALL' and (select count(*) from mkt.campaign_dispatches where campaign_id = c.id and filter <> 'ALL' and id is distinct from v_id and status <> 'CANCELLED') >= 2 then
    raise exception 'No máximo 2 lembretes por campanha' using errcode = 'P0190';
  end if;
  if d.id is null then
    select coalesce(max(seq), 0) + 1 into v_seq from mkt.campaign_dispatches where campaign_id = c.id;
    insert into mkt.campaign_dispatches (org_id, campaign_id, seq, label, channel_account_id, template_id, variables, filter, scheduled_at, frequency_cap_days, daily_limit)
    values (v_org, c.id, v_seq, v_label, v_acc, v_tpl, v_vars, v_filter, v_at, v_cap, v_daily) returning * into d;
  else
    update mkt.campaign_dispatches set label = v_label, channel_account_id = v_acc, template_id = v_tpl, variables = v_vars, filter = v_filter, scheduled_at = v_at,
           frequency_cap_days = v_cap, daily_limit = v_daily where id = d.id returning * into d;
  end if;
  return d;
end $$;

create or replace function mkt.delete_dispatch(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('crm.write');
  delete from mkt.campaign_dispatches where id = p_id and org_id = private.org_id() and status = 'DRAFT';
  if not found then raise exception 'Só disparos ainda não agendados podem ser excluídos' using errcode = 'P0191'; end if;
end $$;

create or replace function mkt.cancel_dispatch(p_id uuid) returns mkt.campaign_dispatches
language plpgsql security definer set search_path = '' as $$
declare d mkt.campaign_dispatches;
begin
  perform private.require_perm('crm.write');
  update mkt.campaign_dispatches set status = 'CANCELLED', finished_at = now() where id = p_id and org_id = private.org_id() and status in ('DRAFT', 'SCHEDULED', 'SENDING') returning * into d;
  if d.id is null then raise exception 'Só disparos ainda não concluídos podem ser cancelados' using errcode = 'P0191'; end if;
  update mkt.campaign_recipients set status = 'SKIPPED', skip_reason = 'DISPATCH_CANCELLED' where dispatch_id = d.id and status = 'PENDING';
  return d;
end $$;

-- ---------------------------------------------------------------------
-- 5) Prévia e checklist
-- ---------------------------------------------------------------------
create or replace function mkt.campaign_preview(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  c mkt.campaigns; d mkt.campaign_dispatches; r record; v_ok int := 0; v_hold int := 0; v_skips jsonb := '{}'; v_sample text[] := '{}'; v_reason text; v_total int := 0; v_ads int := 0; v_cap int; v_daily int;
begin
  perform private.require_perm('crm.read');
  select * into c from mkt.campaigns where id = p_id and org_id = private.org_id();
  if c.id is null then raise exception 'Campanha não encontrada' using errcode = 'P0192'; end if;
  select * into d from mkt.campaign_dispatches where campaign_id = c.id and filter = 'ALL' order by seq limit 1;
  v_cap := coalesce(d.frequency_cap_days, 7); v_daily := coalesce(d.daily_limit, 250);
  for r in select a.party_id, p.display_name from private.audience_q(c.org_id, private.campaign_audience_def(c), 0, 20000) a join crm.parties p on p.id = a.party_id loop
    v_total := v_total + 1;
    v_reason := private.campaign_skip_reason(r.party_id, v_cap, c.id);
    if v_reason is null then
      if private.campaign_group(c.id, r.party_id, c.holdout_pct) = 'HOLDOUT' then v_hold := v_hold + 1;
      else
        v_ok := v_ok + 1;
        if cardinality(v_sample) < 5 then v_sample := v_sample || r.display_name; end if;
      end if;
    else
      v_skips := v_skips || jsonb_build_object(v_reason, coalesce((v_skips ->> v_reason)::int, 0) + 1);
    end if;
  end loop;
  select count(*) into v_ads from private.audience_q(c.org_id, private.campaign_audience_def(c) || '{"ads_consent": true}', 0, 20000);
  return jsonb_build_object('audience', v_total, 'eligible', v_ok, 'holdout', v_hold, 'excluded', v_skips, 'sample', to_jsonb(v_sample), 'ads', v_ads,
                            'days_needed', case when v_ok > 0 then ceil(v_ok::numeric / v_daily)::int else 0 end);
end $$;

-- O que falta para lançar: [{key, ok, blocking, message}] e can_launch
create or replace function mkt.campaign_checklist(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  c mkt.campaigns; o mkt.campaign_offers; d record; v_prev jsonb; items jsonb := '[]'; v_all_ok boolean := true; v_main_at timestamptz; v_has_main boolean := false; v_uses_coupon boolean := false; v_uses_link boolean := false;
  v_addr boolean; v_n_aff int;
begin
  perform private.require_perm('crm.read');
  select * into c from mkt.campaigns where id = p_id and org_id = private.org_id();
  if c.id is null then raise exception 'Campanha não encontrada' using errcode = 'P0192'; end if;
  select * into o from mkt.campaign_offers where campaign_id = c.id;
  v_prev := mkt.campaign_preview(c.id);

  items := items || jsonb_build_object('key', 'audience', 'ok', (v_prev ->> 'audience')::int > 0, 'blocking', true, 'message', case when (v_prev ->> 'audience')::int > 0 then format('%s pessoa(s) no público', v_prev ->> 'audience') else 'O público está vazio: ajuste os filtros' end);
  items := items || jsonb_build_object('key', 'channel', 'ok', exists (select 1 from mkt.campaign_dispatches where campaign_id = c.id and status <> 'CANCELLED') or c.audience_scope in ('META', 'BOTH'), 'blocking', true,
                                       'message', 'Escolha ao menos um canal: um disparo de WhatsApp ou o público para anúncios');
  for d in select x.*, t.status as tstatus, ca.status as astatus from mkt.campaign_dispatches x join omni.templates t on t.id = x.template_id join omni.channel_accounts ca on ca.id = x.channel_account_id
           where x.campaign_id = c.id and x.status <> 'CANCELLED' order by x.seq loop
    items := items || jsonb_build_object('key', 'template_' || d.seq, 'ok', d.tstatus = 'APPROVED' and d.astatus = 'ACTIVE', 'blocking', true, 'message', format('Disparo %s: o template precisa estar aprovado e o número ativo', d.seq));
    if d.filter = 'ALL' then
      v_has_main := true;
      v_main_at := coalesce(v_main_at, d.scheduled_at);
      items := items || jsonb_build_object('key', 'schedule_' || d.seq, 'ok', d.scheduled_at is null or d.scheduled_at > now() - interval '5 minutes', 'blocking', true, 'message', format('Disparo %s: a data de envio já passou', d.seq));
    else
      items := items || jsonb_build_object('key', 'schedule_' || d.seq, 'ok', d.scheduled_at is not null and d.scheduled_at > coalesce(v_main_at, now()) + interval '24 hours', 'blocking', true,
                                           'message', format('Lembrete %s: precisa sair pelo menos 24 h depois do disparo principal', d.seq));
    end if;
    if exists (select 1 from jsonb_array_elements(d.variables) v where v ->> 'source' in ('COUPON_CODE', 'COUPON_VALUE', 'COUPON_EXPIRY')) then v_uses_coupon := true; end if;
    if exists (select 1 from jsonb_array_elements(d.variables) v where v ->> 'source' = 'LINK') then v_uses_link := true; end if;
  end loop;
  if exists (select 1 from mkt.campaign_dispatches where campaign_id = c.id and status <> 'CANCELLED') then
    items := items || jsonb_build_object('key', 'eligible', 'ok', (v_prev ->> 'eligible')::int > 0, 'blocking', true, 'message', case when (v_prev ->> 'eligible')::int > 0
      then format('%s podem receber no WhatsApp', v_prev ->> 'eligible') else 'Ninguém do público pode receber agora (consentimento, telefone ou intervalo entre mensagens)' end);
  end if;
  if coalesce(o.mode, 'NONE') = 'PERSONAL' then
    items := items || jsonb_build_object('key', 'offer_personal', 'ok', v_has_main, 'blocking', true, 'message', 'Cupom pessoal precisa de um disparo de WhatsApp para entregar o cupom');
  elsif o.mode = 'SHARED' then
    items := items || jsonb_build_object('key', 'offer_code', 'ok', not exists (select 1 from sales.coupons cp where cp.org_id = c.org_id and upper(cp.code) = o.code and cp.campaign_id is distinct from c.id), 'blocking', true, 'message', format('O código %s já existe', o.code));
  elsif o.mode = 'AFFILIATE' then
    select count(*) into v_n_aff from aff.affiliates where org_id = c.org_id and status = 'ACTIVE';
    items := items || jsonb_build_object('key', 'offer_affiliate', 'ok', v_n_aff > 0, 'blocking', true, 'message', 'Nenhuma afiliada ativa para divulgar a campanha');
  end if;
  if v_uses_coupon then items := items || jsonb_build_object('key', 'coupon_vars', 'ok', coalesce(o.mode, 'NONE') in ('SHARED', 'PERSONAL'), 'blocking', true, 'message', 'A mensagem usa o cupom, mas a oferta não tem cupom'); end if;
  if v_uses_link then items := items || jsonb_build_object('key', 'link_vars', 'ok', c.landing_url is not null and private.public_url(c.org_id) is not null, 'blocking', true, 'message', 'O link na mensagem precisa da página da campanha e do endereço público do sistema (Marketing › Links)'); end if;
  if c.audience_scope in ('META', 'BOTH') then
    items := items || jsonb_build_object('key', 'meta', 'ok', exists (select 1 from core.integration_connections where org_id = c.org_id and provider = 'META_ADS' and status <> 'DISABLED' and secret_ref is not null), 'blocking', true, 'message', 'Conecte a Meta (Anúncios) em Configurações › Integrações');
    items := items || jsonb_build_object('key', 'meta_audience', 'ok', (v_prev ->> 'ads')::int > 0, 'blocking', true, 'message', case when (v_prev ->> 'ads')::int > 0 then format('%s pessoa(s) aceitaram receber anúncios', v_prev ->> 'ads') else 'Ninguém do público aceitou receber anúncios (consentimento de anúncios)' end);
  end if;
  if c.ends_at is not null then items := items || jsonb_build_object('key', 'ends_at', 'ok', c.ends_at > now(), 'blocking', true, 'message', 'A data de fim já passou'); end if;
  select exists (select 1 from omni.channel_accounts where org_id = c.org_id and channel = 'WHATSAPP' and status = 'ACTIVE' and public_address is not null) into v_addr;
  items := items || jsonb_build_object('key', 'public_address', 'ok', v_addr, 'blocking', false, 'message', 'Sem o número público do WhatsApp (Marketing › Links) os links e QR da campanha não são criados');
  select bool_and((i ->> 'ok')::boolean or not (i ->> 'blocking')::boolean) into v_all_ok from jsonb_array_elements(items) i;
  return jsonb_build_object('items', items, 'can_launch', coalesce(v_all_ok, false) and c.status = 'DRAFT', 'preview', v_prev);
end $$;

-- ---------------------------------------------------------------------
-- 6) Lançar: congela quem entra, sorteia o controle, cria cupom e links e agenda os disparos
-- ---------------------------------------------------------------------
create or replace function private.campaign_launch_extras(c mkt.campaigns) returns void
language plpgsql security definer set search_path = '' as $$
begin
  null;                                                              -- gancho: o público de anúncios da Meta entra na migration dele
end $$;

create or replace function private.activate_dispatch(p_dispatch uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare d mkt.campaign_dispatches; c mkt.campaigns; r record; v_reason text; v_ok int := 0; v_delay int;
begin
  select * into d from mkt.campaign_dispatches where id = p_dispatch for update;
  select * into c from mkt.campaigns where id = d.campaign_id;
  for r in select m.party_id from mkt.campaign_members m where m.campaign_id = c.id and m.grp = 'TREATMENT' loop
    v_reason := case when d.filter = 'ALL' then private.campaign_skip_reason(r.party_id, d.frequency_cap_days, c.id) end;      -- lembrete decide na hora do envio
    insert into mkt.campaign_recipients (org_id, campaign_id, dispatch_id, party_id, status, skip_reason)
    values (c.org_id, c.id, d.id, r.party_id, case when v_reason is null then 'PENDING' else 'SKIPPED' end, v_reason) on conflict (dispatch_id, party_id) do nothing;
    if v_reason is null then v_ok := v_ok + 1; end if;
  end loop;
  v_delay := greatest(0, ceil(extract(epoch from (coalesce(d.scheduled_at, now()) - now())))::int);
  update mkt.campaign_dispatches set status = case when v_delay = 0 then 'SENDING' else 'SCHEDULED' end, started_at = case when v_delay = 0 then now() end where id = d.id;
  perform private.enqueue('campaign_tasks', jsonb_build_object('dispatch_id', d.id, 'campaign_id', c.id, 'org_id', c.org_id), v_delay);
  return v_ok;
end $$;

create or replace function private.campaign_create_links(c mkt.campaigns) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_acc uuid; n int := 0; l_id uuid; a record; v_text text := 'Oi! Vim pela campanha ' || c.name || '.';
begin
  select coalesce((select d.channel_account_id from mkt.campaign_dispatches d join omni.channel_accounts ca on ca.id = d.channel_account_id where d.campaign_id = c.id and ca.public_address is not null order by d.seq limit 1),
                  (select id from omni.channel_accounts where org_id = c.org_id and channel = 'WHATSAPP' and status = 'ACTIVE' and public_address is not null order by created_at limit 1)) into v_acc;
  if v_acc is not null then
    insert into mkt.tracking_links (org_id, code, name, kind, target, channel_account_id, prefill_text, campaign_id, created_by) values
      (c.org_id, c.code || '-story', c.name || ' · story', 'STORY', 'WHATSAPP', v_acc, left(v_text, 200), c.id, private.member_id()),
      (c.org_id, c.code || '-bio', c.name || ' · bio', 'BIO', 'WHATSAPP', v_acc, left(v_text, 200), c.id, private.member_id()),
      (c.org_id, c.code || '-qr', c.name || ' · QR', 'QR', 'WHATSAPP', v_acc, left(v_text, 200), c.id, private.member_id())
    on conflict (org_id, code) do nothing;
    get diagnostics n = row_count;
    if (select mode from mkt.campaign_offers where campaign_id = c.id) = 'AFFILIATE' then
      for a in select af.party_id, lower(regexp_replace(cp.code, '[^A-Za-z0-9]', '', 'g')) as cc, pt.display_name from aff.affiliates af join sales.coupons cp on cp.id = af.coupon_id join crm.parties pt on pt.id = af.party_id
               where af.org_id = c.org_id and af.status = 'ACTIVE' loop
        insert into mkt.tracking_links (org_id, code, name, kind, target, channel_account_id, prefill_text, affiliate_party_id, campaign_id, created_by)
        values (c.org_id, left(c.code || '-' || a.cc, 23), c.name || ' · ' || a.display_name, 'TRAINER', 'WHATSAPP', v_acc, left(v_text, 200), a.party_id, c.id, private.member_id()) on conflict (org_id, code) do nothing;
        n := n + 1;
      end loop;
    end if;
  end if;
  if c.landing_url is not null then
    insert into mkt.tracking_links (org_id, code, name, kind, target, target_url, utm, campaign_id, created_by)
    values (c.org_id, c.code || '-web', c.name || ' · página', 'CAMPAIGN', 'WEB', c.landing_url, jsonb_build_object('source', 'whatsapp', 'medium', 'campanha', 'campaign', c.code), c.id, private.member_id()) on conflict (org_id, code) do nothing;
    n := n + 1;
  end if;
  return n;
end $$;

create or replace function mkt.launch_campaign(p_id uuid) returns mkt.campaigns
language plpgsql security definer set search_path = '' as $$
declare c mkt.campaigns; o mkt.campaign_offers; v_chk jsonb; v_msg text; r record; d record; v_valid_from timestamptz;
begin
  perform private.require_perm('crm.write');
  select * into c from mkt.campaigns where id = p_id and org_id = private.org_id() for update;
  if c.id is null then raise exception 'Campanha não encontrada' using errcode = 'P0192'; end if;
  if c.status <> 'DRAFT' then raise exception 'Esta campanha já foi lançada' using errcode = 'P0191'; end if;
  v_chk := mkt.campaign_checklist(c.id);
  if not (v_chk ->> 'can_launch')::boolean then
    select i ->> 'message' into v_msg from jsonb_array_elements(v_chk -> 'items') i where (i ->> 'blocking')::boolean and not (i ->> 'ok')::boolean limit 1;
    raise exception '%', coalesce(v_msg, 'A campanha ainda tem pendências') using errcode = 'P0191';
  end if;
  select * into o from mkt.campaign_offers where campaign_id = c.id;
  -- 1) quem entra (congelado) e grupo de controle
  insert into mkt.campaign_members (campaign_id, party_id, org_id, grp)
  select c.id, a.party_id, c.org_id, private.campaign_group(c.id, a.party_id, c.holdout_pct) from private.audience_q(c.org_id, private.campaign_audience_def(c), 0, 20000) a on conflict do nothing;
  -- 2) código único
  v_valid_from := greatest(now(), coalesce(c.starts_at, now()));
  if o.mode = 'SHARED' then
    insert into sales.coupons (org_id, code, kind, value, min_order, max_uses, per_customer_limit, valid_from, valid_to, campaign_id, source)
    values (c.org_id, o.code, o.kind, o.value, o.min_order, o.max_uses, o.per_customer_limit, v_valid_from, coalesce(o.valid_to, c.ends_at), c.id, 'CAMPAIGN');
  end if;
  -- 3) campanha ativa, links e disparos
  update mkt.campaigns set status = 'ACTIVE', starts_at = coalesce(starts_at, now()) where id = c.id returning * into c;
  perform private.campaign_create_links(c);
  for d in select id from mkt.campaign_dispatches where campaign_id = c.id and status = 'DRAFT' order by seq loop
    perform private.activate_dispatch(d.id);
  end loop;
  perform private.campaign_launch_extras(c);
  return c;
end $$;

-- Lembrete novo numa campanha já ativa
create or replace function mkt.activate_dispatch(p_id uuid) returns mkt.campaign_dispatches
language plpgsql security definer set search_path = '' as $$
declare d mkt.campaign_dispatches; c mkt.campaigns; t omni.templates;
begin
  perform private.require_perm('crm.write');
  select * into d from mkt.campaign_dispatches where id = p_id and org_id = private.org_id() for update;
  if d.id is null then raise exception 'Disparo não encontrado' using errcode = 'P0192'; end if;
  select * into c from mkt.campaigns where id = d.campaign_id;
  if c.status <> 'ACTIVE' then raise exception 'A campanha precisa estar ativa' using errcode = 'P0191'; end if;
  if d.status <> 'DRAFT' then raise exception 'Este disparo já foi agendado' using errcode = 'P0191'; end if;
  select * into t from omni.templates where id = d.template_id;
  if t.status <> 'APPROVED' then raise exception 'O template deixou de estar aprovado (situação: %)', t.status using errcode = 'P0191'; end if;
  if d.scheduled_at is not null and d.scheduled_at < now() - interval '5 minutes' then raise exception 'A data agendada já passou' using errcode = 'P0190'; end if;
  if d.filter <> 'ALL' and (d.scheduled_at is null or d.scheduled_at < now() + interval '1 hour') then raise exception 'O lembrete precisa de uma data pelo menos 1 hora à frente' using errcode = 'P0190'; end if;
  perform private.activate_dispatch(d.id);
  select * into d from mkt.campaign_dispatches where id = p_id;
  return d;
end $$;

-- ---------------------------------------------------------------------
-- 7) Encerrar, cancelar, excluir
-- ---------------------------------------------------------------------
create or replace function private.campaign_wrap_up(p_id uuid, p_status text, p_reason text) returns mkt.campaigns
language plpgsql security definer set search_path = '' as $$
declare c mkt.campaigns;
begin
  update mkt.campaigns set status = p_status, finished_at = now() where id = p_id and status in ('DRAFT', 'ACTIVE') returning * into c;
  if c.id is null then return null; end if;
  update mkt.campaign_recipients set status = 'SKIPPED', skip_reason = p_reason where campaign_id = c.id and status = 'PENDING';
  update mkt.campaign_dispatches set status = 'CANCELLED', finished_at = now() where campaign_id = c.id and status in ('DRAFT', 'SCHEDULED', 'SENDING');
  update mkt.tracking_links set active = false where campaign_id = c.id;
  if p_status = 'CANCELLED' then
    update sales.coupons set active = false where campaign_id = c.id and source = 'CAMPAIGN';
  else
    update sales.coupons set valid_to = least(coalesce(valid_to, now()), now()) where campaign_id = c.id and source = 'CAMPAIGN' and party_id is null;   -- o código único para de valer; pessoais seguem até a própria validade
  end if;
  return c;
end $$;

create or replace function mkt.cancel_campaign(p_id uuid) returns mkt.campaigns
language plpgsql security definer set search_path = '' as $$
declare c mkt.campaigns;
begin
  perform private.require_perm('crm.write');
  if not exists (select 1 from mkt.campaigns where id = p_id and org_id = private.org_id()) then raise exception 'Campanha não encontrada' using errcode = 'P0192'; end if;
  c := private.campaign_wrap_up(p_id, 'CANCELLED', 'CAMPAIGN_CANCELLED');
  if c.id is null then raise exception 'Só campanhas ainda não encerradas podem ser canceladas' using errcode = 'P0191'; end if;
  return c;
end $$;

create or replace function mkt.end_campaign(p_id uuid) returns mkt.campaigns
language plpgsql security definer set search_path = '' as $$
declare c mkt.campaigns;
begin
  perform private.require_perm('crm.write');
  if not exists (select 1 from mkt.campaigns where id = p_id and org_id = private.org_id()) then raise exception 'Campanha não encontrada' using errcode = 'P0192'; end if;
  if not exists (select 1 from mkt.campaigns where id = p_id and status = 'ACTIVE') then raise exception 'Só campanhas ativas podem ser encerradas' using errcode = 'P0191'; end if;
  c := private.campaign_wrap_up(p_id, 'ENDED', 'CAMPAIGN_ENDED');
  return c;
end $$;

create or replace function mkt.delete_campaign(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('crm.write');
  delete from mkt.campaigns where id = p_id and org_id = private.org_id() and status = 'DRAFT';
  if not found then raise exception 'Só rascunhos podem ser excluídos' using errcode = 'P0191'; end if;
end $$;

-- Fecha sozinha: passou do fim ou (sem data de fim) todos os disparos terminaram e a janela de atribuição acabou
create or replace function private.close_campaigns() returns integer
language plpgsql security definer set search_path = '' as $$
declare c record; n integer := 0; w mkt.campaigns;
begin
  for c in select x.id from mkt.campaigns x where x.status = 'ACTIVE' and (
       (x.ends_at is not null and x.ends_at < now())
    or (x.ends_at is null and exists (select 1 from mkt.campaign_dispatches d where d.campaign_id = x.id)
        and not exists (select 1 from mkt.campaign_dispatches d where d.campaign_id = x.id and d.status in ('DRAFT', 'SCHEDULED', 'SENDING'))
        and (select max(d.finished_at) from mkt.campaign_dispatches d where d.campaign_id = x.id) < now() - make_interval(days => x.attribution_days))) loop
    w := private.campaign_wrap_up(c.id, 'ENDED', 'CAMPAIGN_ENDED');
    if w.id is not null then n := n + 1; end if;
  end loop;
  return n;
end $$;
select cron.schedule('centralops-close-campaigns', '*/15 * * * *', $$ select private.close_campaigns() $$);

-- Andamento para as listas (uma linha por campanha)
create or replace function mkt.campaign_progress() returns table (campaign_id uuid, dispatches int, total int, sent int, skipped int, pending int, members int)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_perm('crm.read');
  return query
    select c.id, (select count(*)::int from mkt.campaign_dispatches d where d.campaign_id = c.id and d.status <> 'CANCELLED'),
           coalesce(sum(1) filter (where r.id is not null), 0)::int, coalesce(sum(1) filter (where r.status in ('QUEUED', 'SENT')), 0)::int,
           coalesce(sum(1) filter (where r.status = 'SKIPPED'), 0)::int, coalesce(sum(1) filter (where r.status = 'PENDING'), 0)::int,
           (select count(*)::int from mkt.campaign_members m where m.campaign_id = c.id)
    from mkt.campaigns c left join mkt.campaign_recipients r on r.campaign_id = c.id where c.org_id = private.org_id() group by c.id;
end $$;

-- ---------------------------------------------------------------------
-- 8) Envio (worker): um lote de um disparo
-- ---------------------------------------------------------------------
drop function mkt.campaign_send_batch(uuid, integer);

-- Valor de uma variável do template para uma pessoa (null = indisponível)
create or replace function private.campaign_var_value(p_var jsonb, c mkt.campaigns, p_name text, p_coupon sales.coupons) returns text
language plpgsql stable security definer set search_path = '' as $$
declare v_link text; v_base text;
begin
  return case p_var ->> 'source'
    when 'FIRST_NAME' then split_part(p_name, ' ', 1)
    when 'FULL_NAME' then p_name
    when 'TEXT' then p_var ->> 'text'
    when 'COUPON_CODE' then p_coupon.code
    when 'COUPON_VALUE' then case when p_coupon.id is null then null when p_coupon.kind = 'PERCENT' then private.fmt_num(p_coupon.value) || '%' else 'R$ ' || private.fmt_num(p_coupon.value) end
    when 'COUPON_EXPIRY' then case when p_coupon.valid_to is null then null else to_char(p_coupon.valid_to at time zone 'America/Sao_Paulo', 'DD/MM') end
    when 'CAMPAIGN_END' then case when c.ends_at is null then null else to_char(c.ends_at at time zone 'America/Sao_Paulo', 'DD/MM') end
    when 'LINK' then (select private.public_url(c.org_id) || '/r/' || l.code from mkt.tracking_links l where l.campaign_id = c.id and l.target = 'WEB' and l.active limit 1)
    else null end;
end $$;

create or replace function mkt.dispatch_send_batch(p_dispatch uuid, p_limit integer default 50) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  d mkt.campaign_dispatches; c mkt.campaigns; t omni.templates; o mkt.campaign_offers; m mkt.campaign_members; cp sales.coupons; r record; v_used int; v_room int; v_sent int := 0; v_reason text; v_conv uuid; v_wa text;
  v_body text; v_tbody text; v_ph int[]; v_params jsonb; v_msg omni.messages; i int; v_name text; v_var jsonb; v_val text; v_pending int; v_blocked boolean := false;
begin
  select * into d from mkt.campaign_dispatches where id = p_dispatch for update;
  if d.id is null then raise exception 'Disparo não encontrado' using errcode = 'P0192'; end if;
  select * into c from mkt.campaigns where id = d.campaign_id;
  if d.status not in ('SCHEDULED', 'SENDING') or c.status <> 'ACTIVE' then return jsonb_build_object('sent', 0, 'pending', 0, 'blocked_by_daily_limit', false, 'done', true, 'status', d.status); end if;
  if d.status = 'SCHEDULED' then update mkt.campaign_dispatches set status = 'SENDING', started_at = coalesce(started_at, now()) where id = d.id; end if;
  select * into t from omni.templates where id = d.template_id;
  select * into o from mkt.campaign_offers where campaign_id = c.id;
  if t.status <> 'APPROVED' then
    update mkt.campaign_recipients set status = 'SKIPPED', skip_reason = 'TEMPLATE_NOT_APPROVED' where dispatch_id = d.id and status = 'PENDING';
  end if;
  select c2 ->> 'text' into v_tbody from jsonb_array_elements(t.components) c2 where c2 ->> 'type' = 'BODY' limit 1;
  v_ph := private.template_placeholders(v_tbody);
  -- limite diário do NÚMERO (faixa da Meta): todos os disparos dele nas últimas 24 h
  select count(*) into v_used from mkt.campaign_recipients cr join mkt.campaign_dispatches dd on dd.id = cr.dispatch_id
   where dd.channel_account_id = d.channel_account_id and cr.status in ('QUEUED', 'SENT') and cr.sent_at > now() - interval '24 hours';
  v_room := least(p_limit, d.daily_limit - v_used);
  if v_room <= 0 then v_blocked := true; end if;
  if not v_blocked then
    for r in select cr.id, cr.party_id from mkt.campaign_recipients cr where cr.dispatch_id = d.id and cr.status = 'PENDING' order by cr.seq limit v_room for update skip locked loop
      v_reason := null;
      select * into m from mkt.campaign_members where campaign_id = c.id and party_id = r.party_id;
      if m.party_id is null or m.grp <> 'TREATMENT' then v_reason := 'NOT_IN_AUDIENCE'; end if;
      if v_reason is null and d.filter = 'NOT_BOUGHT' and exists (select 1 from sales.orders o2 where o2.party_id = r.party_id and o2.status::text = any (private.paid_order_statuses()) and o2.created_at > coalesce(c.starts_at, c.created_at)) then v_reason := 'ALREADY_BOUGHT'; end if;
      if v_reason is null and d.filter = 'NOT_READ' and exists (select 1 from omni.messages mm join omni.conversations cv on cv.id = mm.conversation_id where cv.party_id = r.party_id and mm.payload ->> 'campaign_id' = c.id::text and mm.status = 'READ') then v_reason := 'ALREADY_READ'; end if;
      if v_reason is null and d.filter = 'NOT_REPLIED' and exists (select 1 from omni.messages mm join omni.conversations cv on cv.id = mm.conversation_id where cv.party_id = r.party_id and mm.direction = 'IN' and mm.created_at > coalesce(c.starts_at, c.created_at)) then v_reason := 'ALREADY_REPLIED'; end if;
      if v_reason is null then v_reason := private.campaign_skip_reason(r.party_id, d.frequency_cap_days, c.id); end if;   -- pode ter mudado desde o lançamento (recusa no meio do disparo)
      v_wa := private.party_wa_id(r.party_id);
      if v_reason is null then v_conv := private.ensure_wa_conversation(d.channel_account_id, r.party_id, v_wa); if v_conv is null then v_reason := 'IDENTITY_CONFLICT'; end if; end if;
      -- cupom da pessoa: pessoal é emitido agora (só quem recebe a mensagem ganha cupom); código único é o da campanha
      cp := null;
      if v_reason is null and o.mode = 'PERSONAL' then
        if m.coupon_id is null then
          m.coupon_id := private.issue_personal_coupon(c.org_id, r.party_id, o.kind, o.value, o.min_order, now(), least(now() + make_interval(days => o.valid_days), coalesce(c.ends_at, now() + make_interval(days => o.valid_days))), o.code_prefix, c.id, 'CAMPAIGN');
          update mkt.campaign_members set coupon_id = m.coupon_id where campaign_id = c.id and party_id = r.party_id;
        end if;
        select * into cp from sales.coupons where id = m.coupon_id;
      elsif v_reason is null and o.mode = 'SHARED' then
        select * into cp from sales.coupons where campaign_id = c.id and source = 'CAMPAIGN' and party_id is null limit 1;
      end if;
      if v_reason is null then
        select display_name into v_name from crm.parties where id = r.party_id;
        v_params := '[]'; v_body := v_tbody; i := 0;
        for v_var in select * from jsonb_array_elements(d.variables) loop
          i := i + 1;
          v_val := private.campaign_var_value(v_var, c, v_name, cp);
          if v_val is null then v_reason := case when v_var ->> 'source' like 'COUPON%' then 'NO_COUPON' when v_var ->> 'source' = 'LINK' then 'NO_LINK' else 'NO_VALUE' end; exit; end if;
          v_params := v_params || to_jsonb(v_val);
          v_body := replace(v_body, '{{' || i || '}}', v_val);
        end loop;
      end if;
      if v_reason is not null then
        update mkt.campaign_recipients set status = 'SKIPPED', skip_reason = v_reason where id = r.id;
        continue;
      end if;
      insert into omni.messages (org_id, conversation_id, channel_account_id, direction, author_type, type, body, template_name, status, client_dedupe_key, payload)
      values (c.org_id, v_conv, d.channel_account_id, 'OUT', 'SYSTEM', 'TEMPLATE', v_body, t.name, 'QUEUED', 'campaign:' || d.id || ':' || r.party_id,
              jsonb_build_object('language', t.language, 'template_id', t.id, 'campaign_id', c.id, 'dispatch_id', d.id,
                'components', case when coalesce(array_length(v_ph, 1), 0) = 0 then '[]'::jsonb
                                   else jsonb_build_array(jsonb_build_object('type', 'body', 'parameters', (select jsonb_agg(jsonb_build_object('type', 'text', 'text', x #>> '{}')) from jsonb_array_elements(v_params) x))) end))
      returning * into v_msg;
      perform private.enqueue('outbound_messages', jsonb_build_object('message_id', v_msg.id, 'org_id', c.org_id));
      update mkt.campaign_recipients set status = 'QUEUED', message_id = v_msg.id, sent_at = now() where id = r.id;
      perform private.timeline(c.org_id, r.party_id, 'CAMPAIGN', 'mkt.campaigns', c.id, format('Recebeu a campanha "%s"%s', c.name, case when cp.id is not null then ' com o cupom ' || cp.code else '' end));
      v_sent := v_sent + 1;
    end loop;
  end if;
  select count(*) into v_pending from mkt.campaign_recipients where dispatch_id = d.id and status = 'PENDING';
  if v_pending = 0 then update mkt.campaign_dispatches set status = 'DONE', finished_at = now() where id = d.id; end if;
  return jsonb_build_object('sent', v_sent, 'pending', v_pending, 'blocked_by_daily_limit', v_blocked, 'done', v_pending = 0, 'status', case when v_pending = 0 then 'DONE' else 'SENDING' end);
end $$;

-- ---------------------------------------------------------------------
-- 9) Cupons: cadastro por RPC (criar e editar os avulsos)
-- p = {id?, code, kind, value, min_order?, max_uses?, per_customer_limit?, valid_to?, affiliate_party_id?, party_id?}
-- ---------------------------------------------------------------------
create or replace function sales.save_coupon(p jsonb) returns sales.coupons
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id(); v_id uuid := nullif(p ->> 'id', '')::uuid; v_code text := upper(trim(coalesce(p ->> 'code', ''))); v_kind text := upper(coalesce(p ->> 'kind', ''));
  v_val numeric := nullif(p ->> 'value', '')::numeric; v_min numeric := nullif(p ->> 'min_order', '')::numeric; v_max int := nullif(p ->> 'max_uses', '')::int;
  v_pcl int := nullif(p ->> 'per_customer_limit', '')::int; v_to timestamptz := nullif(p ->> 'valid_to', '')::timestamptz;
  v_aff uuid := nullif(p ->> 'affiliate_party_id', '')::uuid; v_party uuid := nullif(p ->> 'party_id', '')::uuid; cp sales.coupons;
begin
  perform private.require_perm('sales.write');
  if v_code !~ '^[A-Z0-9][A-Z0-9-]{2,29}$' then raise exception 'O código usa de 3 a 30 letras, números ou hífen (sem espaço nem acento)' using errcode = 'P0190'; end if;
  if v_kind not in ('PERCENT', 'AMOUNT') then raise exception 'Escolha desconto em %% ou em reais' using errcode = 'P0190'; end if;
  if v_val is null or v_val <= 0 or (v_kind = 'PERCENT' and v_val > 100) then raise exception 'Valor do desconto inválido' using errcode = 'P0190'; end if;
  if v_min is not null and v_min < 0 then raise exception 'Pedido mínimo inválido' using errcode = 'P0190'; end if;
  if v_max is not null and v_max < 1 then raise exception 'Usos no total inválido' using errcode = 'P0190'; end if;
  if v_pcl is not null and v_pcl < 1 then raise exception 'Usos por cliente inválido' using errcode = 'P0190'; end if;
  if v_aff is not null and v_party is not null then raise exception 'O cupom é de uma afiliada ou exclusivo de uma cliente, não os dois' using errcode = 'P0190'; end if;
  if v_aff is not null and not exists (select 1 from crm.parties where id = v_aff and org_id = v_org) then raise exception 'Afiliada inválida' using errcode = 'P0190'; end if;
  if v_party is not null and not exists (select 1 from crm.parties where id = v_party and org_id = v_org) then raise exception 'Cliente inválida' using errcode = 'P0190'; end if;
  if v_id is null then
    insert into sales.coupons (org_id, code, kind, value, min_order, max_uses, per_customer_limit, valid_to, affiliate_party_id, party_id, source)
    values (v_org, v_code, v_kind, v_val, v_min, v_max, v_pcl, v_to, v_aff, v_party, case when v_aff is not null then 'AFFILIATE' else 'MANUAL' end) returning * into cp;
  else
    select * into cp from sales.coupons where id = v_id and org_id = v_org for update;
    if cp.id is null then raise exception 'Cupom não encontrado' using errcode = 'P0192'; end if;
    if cp.source not in ('MANUAL') then raise exception 'Este cupom é gerido pela campanha, afiliada ou régua: altere por lá' using errcode = 'P0191'; end if;
    if exists (select 1 from sales.coupon_redemptions where coupon_id = cp.id) and (upper(cp.code) <> v_code or cp.kind <> v_kind or cp.value <> v_val) then
      raise exception 'O cupom já foi usado em vendas: código, tipo e valor não podem mudar (pause e crie outro)' using errcode = 'P0191';
    end if;
    update sales.coupons set code = v_code, kind = v_kind, value = v_val, min_order = v_min, max_uses = v_max, per_customer_limit = v_pcl, valid_to = v_to, affiliate_party_id = v_aff, party_id = v_party
    where id = cp.id returning * into cp;
  end if;
  return cp;
exception when unique_violation then
  raise exception 'Já existe um cupom com o código %', v_code using errcode = 'P0190';
end $$;

-- Cupom vigente da cliente que entra sozinho no carrinho: agora diz de onde veio
create or replace function sales.party_auto_coupon(p_party uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c sales.coupons; v_camp text;
begin
  perform private.require_perm('sales.read');
  select * into c from sales.coupons cp
  where cp.org_id = private.org_id() and cp.party_id = p_party and cp.active and cp.valid_from <= now() and (cp.valid_to is null or cp.valid_to > now())
    and (cp.max_uses is null or (select count(*) from sales.coupon_redemptions r join sales.orders o on o.id = r.order_id where r.coupon_id = cp.id and o.status <> 'CANCELLED') < cp.max_uses)
  order by cp.valid_to nulls last limit 1;
  if c.id is null then return null; end if;
  select name into v_camp from mkt.campaigns where id = c.campaign_id;
  return jsonb_build_object('code', c.code, 'kind', c.kind, 'value', c.value, 'valid_to', c.valid_to, 'min_order', c.min_order, 'source', c.source, 'campaign', v_camp);
end $$;

insert into private.internal_functions (fqname) values
  ('private.campaign_skip_reason'), ('private.campaign_make_code'), ('private.campaign_audience_def'), ('private.campaign_group'), ('private.fmt_num'), ('private.issue_personal_coupon'),
  ('private.campaign_launch_extras'), ('private.activate_dispatch'), ('private.campaign_create_links'), ('private.campaign_wrap_up'), ('private.close_campaigns'),
  ('private.campaign_var_value'), ('mkt.dispatch_send_batch') on conflict do nothing;
select private.lock_functions();
