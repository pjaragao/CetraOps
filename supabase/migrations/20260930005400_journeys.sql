-- =====================================================================
-- Marketing › Réguas de relacionamento e regras de contato (plano de marketing e atendimento, Fase 3).
-- Régua = gatilho (1ª compra, sem 2ª compra, aniversário, em risco, inativa, inativa há muito, oportunidade perdida)
--         + passos com espera (tarefa pessoal com mensagem pronta, texto se a janela estiver aberta, template de marketing com aceite)
--         + grupo de controle (holdout) que não recebe nada, para medir o efeito real.
-- Regras de contato (core.settings 'contact_policy'), valem para réguas e campanhas: aceite, recusa, reclamação aberta, conversa
-- em andamento, limite de marketing por 7/30 dias, limite de contatos pessoais por 14 dias e horário de silêncio.
-- Nasce tudo DESLIGADO (as réguas padrão vêm prontas, desligadas). Códigos de erro: P0350 dado inválido · P0351 situação · P0352 não encontrado.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Regras de contato
-- ---------------------------------------------------------------------
create or replace function private.contact_cfg(p_org uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('marketing_per_7d', 1, 'marketing_per_30d', 4, 'relationship_per_14d', 2, 'quiet_start', '20:00', 'quiet_end', '09:00', 'no_sunday', true)
         || coalesce((select value from core.settings where org_id = p_org and key = 'contact_policy'), '{}')
$$;

create or replace function mkt.save_contact_policy(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); c jsonb;
begin
  perform private.require_perm('core.admin');
  c := private.contact_cfg(v_org) || jsonb_strip_nulls(jsonb_build_object(
    'marketing_per_7d', (p ->> 'marketing_per_7d')::int, 'marketing_per_30d', (p ->> 'marketing_per_30d')::int, 'relationship_per_14d', (p ->> 'relationship_per_14d')::int,
    'quiet_start', nullif(p ->> 'quiet_start', ''), 'quiet_end', nullif(p ->> 'quiet_end', ''), 'no_sunday', (p ->> 'no_sunday')::boolean));
  if (c ->> 'marketing_per_7d')::int not between 0 and 7 or (c ->> 'marketing_per_30d')::int not between 0 and 30 or (c ->> 'relationship_per_14d')::int not between 0 and 14 then
    raise exception 'Limites fora do esperado' using errcode = 'P0350';
  end if;
  perform (c ->> 'quiet_start')::time, (c ->> 'quiet_end')::time;
  insert into core.settings (org_id, key, value) values (v_org, 'contact_policy', c) on conflict (org_id, key) do update set value = excluded.value;
  return c;
end $$;

-- Por que NÃO contatar a pessoa agora (null = pode). p_kind: MARKETING (template de marketing) | RELATIONSHIP (contato pessoal, tarefa)
create or replace function private.contact_block(p_party uuid, p_kind text) returns text
language plpgsql stable security definer set search_path = '' as $$
declare p crm.parties; c jsonb; v_granted boolean; v_n int;
begin
  select * into p from crm.parties where id = p_party;
  if p.id is null or p.anonymized_at is not null or p.merged_into_id is not null then return 'NOT_AVAILABLE'; end if;
  if exists (select 1 from crm.party_roles rl where rl.party_id = p.id and rl.role in ('EMPLOYEE', 'SUPPLIER', 'SERVICE_PROVIDER', 'CARRIER', 'ACQUIRER', 'BANK')) then return 'NOT_CUSTOMER'; end if;
  c := private.contact_cfg(p.org_id);
  select granted into v_granted from crm.v_current_consents where party_id = p.id and purpose = 'MARKETING_WHATSAPP';
  if v_granted is false then return 'OPTED_OUT'; end if;                                     -- pediu para parar: nada proativo
  if p_kind = 'MARKETING' and not coalesce(v_granted, false) then return 'NO_CONSENT'; end if;
  if exists (select 1 from crm.tasks t where t.party_id = p.id and t.status = 'OPEN' and t.type = 'RECOVERY' and (t.source_rule like 'csat:%' or t.source_rule like 'case:%')) then return 'OPEN_COMPLAINT'; end if;
  if exists (select 1 from omni.conversations cv where cv.party_id = p.id and cv.status = 'OPEN' and cv.mode in ('HUMAN', 'WAITING_HUMAN') and cv.last_message_at > now() - interval '2 days') then return 'IN_CONVERSATION'; end if;
  if p_kind = 'MARKETING' then
    select count(*) into v_n from omni.messages m join omni.conversations cv on cv.id = m.conversation_id join omni.templates t on t.id = (m.payload ->> 'template_id')::uuid
    where cv.party_id = p.id and m.direction = 'OUT' and m.type = 'TEMPLATE' and t.category = 'MARKETING' and m.status <> 'FAILED' and m.created_at > now() - interval '7 days';
    if v_n >= (c ->> 'marketing_per_7d')::int then return 'FREQUENCY_CAP'; end if;
    select count(*) into v_n from omni.messages m join omni.conversations cv on cv.id = m.conversation_id join omni.templates t on t.id = (m.payload ->> 'template_id')::uuid
    where cv.party_id = p.id and m.direction = 'OUT' and m.type = 'TEMPLATE' and t.category = 'MARKETING' and m.status <> 'FAILED' and m.created_at > now() - interval '30 days';
    if v_n >= (c ->> 'marketing_per_30d')::int then return 'FREQUENCY_CAP'; end if;
  else
    select count(*) into v_n from crm.tasks t where t.party_id = p.id and t.source_rule like 'journey:%' and t.created_at > now() - interval '14 days';
    if v_n >= (c ->> 'relationship_per_14d')::int then return 'FREQUENCY_CAP'; end if;
  end if;
  return null;
end $$;

-- Horário de silêncio (envios automáticos esperam; tarefas não)
create or replace function private.next_send_time(p_org uuid, p_at timestamptz default now()) returns timestamptz
language plpgsql stable security definer set search_path = '' as $$
declare c jsonb := private.contact_cfg(p_org); l timestamp := p_at at time zone 'America/Sao_Paulo'; qs time := (c ->> 'quiet_start')::time; qe time := (c ->> 'quiet_end')::time; d date;
begin
  d := l::date;
  if l::time >= qs then d := d + 1; elsif l::time >= qe and not (coalesce((c ->> 'no_sunday')::boolean, true) and extract(dow from d) = 0) then return p_at; end if;
  if coalesce((c ->> 'no_sunday')::boolean, true) and extract(dow from d) = 0 then d := d + 1; end if;
  return greatest(p_at, (d + qe)::timestamp at time zone 'America/Sao_Paulo');
end $$;

-- Texto com os dados da pessoa: {nome} {tamanho} {ultima_peca} {data_limite} {loja}
create or replace function private.render_party_text(p_party uuid, p_text text) returns text
language plpgsql stable security definer set search_path = '' as $$
declare p crm.parties; v_last text; v_store text;
begin
  select * into p from crm.parties where id = p_party;
  select pr.name into v_last from sales.orders o join sales.order_items oi on oi.order_id = o.id join catalog.variants v on v.id = oi.variant_id join catalog.products pr on pr.id = v.product_id
  where o.party_id = p_party and o.status::text in ('PAID', 'COMPLETED', 'FULFILLING', 'READY_FOR_PICKUP', 'SHIPPED', 'PARTIALLY_RETURNED') order by o.created_at desc limit 1;
  select name into v_store from core.stores where id = p.home_store_id;
  return replace(replace(replace(replace(replace(coalesce(p_text, ''),
    '{nome}', split_part(p.display_name, ' ', 1)),
    '{tamanho}', coalesce(p.sizes ->> 'bottom', p.sizes ->> 'top', 'seu tamanho')),
    '{ultima_peca}', coalesce(lower(v_last), 'sua última peça')),
    '{data_limite}', to_char(private.today_sp() + 30, 'DD/MM')),
    '{loja}', coalesce(v_store, 'SIÉ'));
end $$;

-- ---------------------------------------------------------------------
-- 2) Réguas
-- ---------------------------------------------------------------------
create table mkt.journeys (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  key text not null,
  name text not null,
  description text,
  trigger text not null check (trigger in ('FIRST_PURCHASE', 'ANY_PURCHASE', 'NO_SECOND_PURCHASE', 'BIRTHDAY', 'AT_RISK', 'INACTIVE', 'LONG_INACTIVE', 'DEAL_LOST')),
  trigger_config jsonb not null default '{}',
  holdout_pct smallint not null default 10 check (holdout_pct between 0 and 50),
  exit_on_purchase boolean not null default true,
  active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, key)
);

create table mkt.journey_steps (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  journey_id uuid not null references mkt.journeys(id) on delete cascade,
  position smallint not null check (position between 1 and 10),
  wait_days numeric(5, 1) not null default 0 check (wait_days between 0 and 365),   -- espera desde o passo anterior (o 1º conta da inscrição)
  action text not null check (action in ('TASK', 'TEXT_IF_WINDOW', 'MARKETING_TEMPLATE')),
  title text not null,
  message text,
  template_id uuid references omni.templates(id),
  template_vars jsonb not null default '[]',
  due_hours int not null default 24 check (due_hours between 1 and 720),
  unique (journey_id, position)
);

create table mkt.journey_enrollments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  journey_id uuid not null references mkt.journeys(id) on delete cascade,
  party_id uuid not null references crm.parties(id) on delete cascade,
  source_key text not null,                      -- o fato que inscreveu (pedido, ano do aniversário, data do risco…): não inscreve duas vezes pelo mesmo fato
  grp text not null check (grp in ('TREATMENT', 'HOLDOUT')),
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'COMPLETED', 'EXITED')),
  exit_reason text,
  next_step smallint not null default 1,
  next_run_at timestamptz,
  enrolled_at timestamptz not null default now(),
  finished_at timestamptz,
  converted_order_id uuid references sales.orders(id) on delete set null,
  converted_at timestamptz,
  unique (journey_id, party_id, source_key)
);
create index journey_enroll_due_idx on mkt.journey_enrollments (next_run_at) where status = 'ACTIVE';
create index journey_enroll_party_idx on mkt.journey_enrollments (party_id, status);

create table mkt.journey_events (
  id bigint generated always as identity primary key,
  org_id uuid not null references core.orgs(id),
  enrollment_id uuid not null references mkt.journey_enrollments(id) on delete cascade,
  step_position smallint not null,
  result text not null check (result in ('TASK', 'SENT_TEXT', 'SENT_TEMPLATE', 'HOLDOUT', 'SKIPPED')),
  reason text,
  task_id uuid references crm.tasks(id) on delete set null,
  message_id uuid references omni.messages(id) on delete set null,
  created_at timestamptz not null default now()
);
create index journey_events_enr_idx on mkt.journey_events (enrollment_id);

select private.attach_updated_at('mkt');
select private.apply_rls('mkt', array['journeys', 'journey_steps', 'journey_enrollments', 'journey_events'], 'crm.read', 'crm.write');
select private.rpc_only('mkt', array['journeys', 'journey_steps', 'journey_enrollments', 'journey_events']);

-- Cadastro
create or replace function mkt.save_journey(p jsonb) returns mkt.journeys
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); v_id uuid := nullif(p ->> 'id', '')::uuid; j mkt.journeys; v_trig text := upper(coalesce(p ->> 'trigger', '')); v_cfg jsonb := coalesce(p -> 'trigger_config', '{}');
begin
  perform private.require_perm('crm.write');
  if length(trim(coalesce(p ->> 'name', ''))) not between 3 and 80 then raise exception 'Nome: 3 a 80 caracteres' using errcode = 'P0350'; end if;
  if v_trig not in ('FIRST_PURCHASE', 'ANY_PURCHASE', 'NO_SECOND_PURCHASE', 'BIRTHDAY', 'AT_RISK', 'INACTIVE', 'LONG_INACTIVE', 'DEAL_LOST') then raise exception 'Gatilho inválido' using errcode = 'P0350'; end if;
  if jsonb_typeof(v_cfg) <> 'object' then raise exception 'Configuração inválida' using errcode = 'P0350'; end if;
  if v_trig = 'NO_SECOND_PURCHASE' and coalesce((v_cfg ->> 'days')::int, 30) not between 7 and 180 then raise exception 'Sem 2ª compra: de 7 a 180 dias' using errcode = 'P0350'; end if;
  if v_trig = 'BIRTHDAY' and coalesce((v_cfg ->> 'days_before')::int, 3) not between 0 and 30 then raise exception 'Aniversário: avisar de 0 a 30 dias antes' using errcode = 'P0350'; end if;
  if coalesce((p ->> 'holdout_pct')::int, 10) not between 0 and 50 then raise exception 'Grupo de controle: 0%% a 50%%' using errcode = 'P0350'; end if;
  if v_id is null then
    insert into mkt.journeys (org_id, key, name, description, trigger, trigger_config, holdout_pct, exit_on_purchase)
    values (v_org, coalesce(nullif(p ->> 'key', ''), 'custom-' || substr(gen_random_uuid()::text, 1, 8)), trim(p ->> 'name'), nullif(trim(coalesce(p ->> 'description', '')), ''),
            v_trig, v_cfg, coalesce((p ->> 'holdout_pct')::int, 10), coalesce((p ->> 'exit_on_purchase')::boolean, true)) returning * into j;
  else
    update mkt.journeys set name = trim(p ->> 'name'), description = nullif(trim(coalesce(p ->> 'description', '')), ''), trigger = v_trig, trigger_config = v_cfg,
           holdout_pct = coalesce((p ->> 'holdout_pct')::int, holdout_pct), exit_on_purchase = coalesce((p ->> 'exit_on_purchase')::boolean, exit_on_purchase)
    where id = v_id and org_id = v_org returning * into j;
    if j.id is null then raise exception 'Régua não encontrada' using errcode = 'P0352'; end if;
  end if;
  return j;
end $$;

create or replace function mkt.set_journey_active(p_id uuid, p_active boolean) returns mkt.journeys
language plpgsql security definer set search_path = '' as $$
declare j mkt.journeys;
begin
  perform private.require_perm('crm.write');
  if p_active and not exists (select 1 from mkt.journey_steps where journey_id = p_id) then raise exception 'Crie ao menos um passo antes de ligar' using errcode = 'P0351'; end if;
  update mkt.journeys set active = p_active where id = p_id and org_id = private.org_id() returning * into j;
  if j.id is null then raise exception 'Régua não encontrada' using errcode = 'P0352'; end if;
  if not p_active then
    update mkt.journey_enrollments set status = 'EXITED', exit_reason = 'JOURNEY_OFF', finished_at = now() where journey_id = p_id and status = 'ACTIVE';
  end if;
  return j;
end $$;

-- p = {id?, journey_id, position, wait_days, action, title, message?, template_id?, template_vars?, due_hours?}
create or replace function mkt.save_journey_step(p jsonb) returns mkt.journey_steps
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); v_id uuid := nullif(p ->> 'id', '')::uuid; s mkt.journey_steps; j mkt.journeys; t omni.templates; v_act text := upper(coalesce(p ->> 'action', ''));
begin
  perform private.require_perm('crm.write');
  select * into j from mkt.journeys where id = nullif(p ->> 'journey_id', '')::uuid and org_id = v_org;
  if j.id is null then raise exception 'Régua não encontrada' using errcode = 'P0352'; end if;
  if v_act not in ('TASK', 'TEXT_IF_WINDOW', 'MARKETING_TEMPLATE') then raise exception 'Ação inválida' using errcode = 'P0350'; end if;
  if length(trim(coalesce(p ->> 'title', ''))) not between 3 and 140 then raise exception 'Título: 3 a 140 caracteres' using errcode = 'P0350'; end if;
  if v_act in ('TASK', 'TEXT_IF_WINDOW') and length(trim(coalesce(p ->> 'message', ''))) not between 5 and 1000 then raise exception 'Escreva a mensagem (5 a 1000 caracteres)' using errcode = 'P0350'; end if;
  if v_act = 'MARKETING_TEMPLATE' then
    select * into t from omni.templates where id = nullif(p ->> 'template_id', '')::uuid and org_id = v_org;
    if t.id is null or t.category <> 'MARKETING' then raise exception 'Escolha um template de MARKETING' using errcode = 'P0350'; end if;
  end if;
  if coalesce((p ->> 'position')::int, 0) not between 1 and 10 or coalesce((p ->> 'wait_days')::numeric, -1) not between 0 and 365 then raise exception 'Posição (1 a 10) ou espera (0 a 365 dias) inválida' using errcode = 'P0350'; end if;
  if v_id is null then
    insert into mkt.journey_steps (org_id, journey_id, position, wait_days, action, title, message, template_id, template_vars, due_hours)
    values (v_org, j.id, (p ->> 'position')::int, (p ->> 'wait_days')::numeric, v_act, trim(p ->> 'title'), nullif(trim(coalesce(p ->> 'message', '')), ''), t.id,
            coalesce(p -> 'template_vars', '[]'), coalesce((p ->> 'due_hours')::int, 24)) returning * into s;
  else
    update mkt.journey_steps set position = (p ->> 'position')::int, wait_days = (p ->> 'wait_days')::numeric, action = v_act, title = trim(p ->> 'title'),
           message = nullif(trim(coalesce(p ->> 'message', '')), ''), template_id = t.id, template_vars = coalesce(p -> 'template_vars', '[]'), due_hours = coalesce((p ->> 'due_hours')::int, 24)
    where id = v_id and journey_id = j.id returning * into s;
    if s.id is null then raise exception 'Passo não encontrado' using errcode = 'P0352'; end if;
  end if;
  return s;
exception when unique_violation then
  raise exception 'Já existe um passo nessa posição' using errcode = 'P0350';
end $$;

create or replace function mkt.delete_journey_step(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('crm.write');
  delete from mkt.journey_steps where id = p_id and org_id = private.org_id();
  if not found then raise exception 'Passo não encontrado' using errcode = 'P0352'; end if;
end $$;

-- ---------------------------------------------------------------------
-- 3) Template de marketing para uma pessoa (com aceite; usado pelas réguas)
-- ---------------------------------------------------------------------
create or replace function private.send_marketing_template(p_party uuid, p_template uuid, p_vars jsonb, p_dedupe text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare t omni.templates; v_wa text; v_conv uuid; v_body text; v_params jsonb := '[]'; x text; i int := 0; v_first text; v_msg uuid; p crm.parties;
begin
  select * into t from omni.templates where id = p_template and status = 'APPROVED' and category = 'MARKETING';
  if t.id is null then return null; end if;
  select * into p from crm.parties where id = p_party;
  v_wa := private.party_wa_id(p_party);
  if v_wa is null then return null; end if;
  v_conv := private.ensure_wa_conversation(t.channel_account_id, p_party, v_wa);
  if v_conv is null then return null; end if;
  v_first := split_part(p.display_name, ' ', 1);
  v_body := (select c2 ->> 'text' from jsonb_array_elements(t.components) c2 where c2 ->> 'type' = 'BODY' limit 1);
  for x in select jsonb_array_elements_text(coalesce(p_vars, '[]')) loop
    i := i + 1;
    v_params := v_params || to_jsonb(coalesce(case x when 'FIRST_NAME' then v_first when 'SIZE' then coalesce(p.sizes ->> 'bottom', p.sizes ->> 'top') when 'DEADLINE' then to_char(private.today_sp() + 30, 'DD/MM')
                                               else private.render_party_text(p_party, x) end, '-'));
    v_body := replace(v_body, '{{' || i || '}}', v_params ->> (i - 1));
  end loop;
  insert into omni.messages (org_id, conversation_id, channel_account_id, direction, author_type, type, body, template_name, status, client_dedupe_key, payload)
  values (t.org_id, v_conv, t.channel_account_id, 'OUT', 'SYSTEM', 'TEMPLATE', v_body, t.name, 'QUEUED', p_dedupe,
          jsonb_build_object('language', t.language, 'template_id', t.id, 'journey', true,
            'components', case when jsonb_array_length(v_params) = 0 then '[]'::jsonb
                               else jsonb_build_array(jsonb_build_object('type', 'body', 'parameters', (select jsonb_agg(jsonb_build_object('type', 'text', 'text', z #>> '{}')) from jsonb_array_elements(v_params) z))) end))
  on conflict (client_dedupe_key) where client_dedupe_key is not null do nothing returning id into v_msg;
  if v_msg is not null then perform private.enqueue('outbound_messages', jsonb_build_object('message_id', v_msg, 'org_id', t.org_id)); end if;
  return v_msg;
end $$;

-- ---------------------------------------------------------------------
-- 4) Motor (a cada 15 min): inscreve, tira quem comprou/recusou, executa os passos vencidos
-- ---------------------------------------------------------------------
create or replace function private.journey_enroll(j mkt.journeys) returns integer
language plpgsql security definer set search_path = '' as $$
declare r record; n int := 0; v_first timestamptz; v_grp text; v_paid text[] := array['PAID', 'COMPLETED', 'FULFILLING', 'READY_FOR_PICKUP', 'SHIPPED', 'PARTIALLY_RETURNED'];
  v_days int; v_target date;
begin
  for r in
    select x.party_id, x.source_key from (
      -- 1ª compra / qualquer compra (pedidos pagos nas últimas 48 h)
      select o.party_id, o.id::text as source_key from sales.orders o
      where j.trigger in ('FIRST_PURCHASE', 'ANY_PURCHASE') and o.org_id = j.org_id and o.party_id is not null and o.status::text = any (v_paid) and o.created_at > now() - interval '48 hours'
        and (j.trigger = 'ANY_PURCHASE' or not exists (select 1 from sales.orders o2 where o2.party_id = o.party_id and o2.status::text = any (v_paid) and o2.created_at < o.created_at))
      union all
      -- sem 2ª compra há N dias (janela de 15 dias para não perder ninguém)
      select m.party_id, m.last_purchase_at::date::text from crm.customer_metrics m
      where j.trigger = 'NO_SECOND_PURCHASE' and m.org_id = j.org_id and m.orders_total = 1
        and m.days_since_last between coalesce((j.trigger_config ->> 'days')::int, 30) and coalesce((j.trigger_config ->> 'days')::int, 30) + 15
      union all
      -- aniversário daqui a N dias (uma vez por ano)
      select p.id, to_char(private.today_sp(), 'YYYY') from crm.parties p
      where j.trigger = 'BIRTHDAY' and p.org_id = j.org_id and p.birth_date is not null
        and to_char(p.birth_date, 'MM-DD') = to_char(private.today_sp() + coalesce((j.trigger_config ->> 'days_before')::int, 3), 'MM-DD')
      union all
      -- em risco (pelo intervalo habitual dela)
      select m.party_id, coalesce(m.at_risk_since::date::text, '') from crm.customer_metrics m where j.trigger = 'AT_RISK' and m.org_id = j.org_id and m.at_risk
      union all
      -- inativa (estágio) e inativa há muito (180 a 365 dias)
      select p.id, m.last_purchase_at::date::text from crm.parties p join crm.customer_metrics m on m.party_id = p.id
      where j.trigger = 'INACTIVE' and p.org_id = j.org_id and p.lifecycle_stage = 'INACTIVE'
      union all
      select m.party_id, m.last_purchase_at::date::text from crm.customer_metrics m
      where j.trigger = 'LONG_INACTIVE' and m.org_id = j.org_id and m.days_since_last between 180 and 365
      union all
      -- oportunidade perdida com um dos motivos escolhidos, perdida há N dias (padrão 7)
      select d.party_id, d.id::text from crm.deals d
      where j.trigger = 'DEAL_LOST' and d.org_id = j.org_id and d.status = 'LOST'
        and d.updated_at between now() - make_interval(days => coalesce((j.trigger_config ->> 'after_days')::int, 7) + 7) and now() - make_interval(days => coalesce((j.trigger_config ->> 'after_days')::int, 7))
        and (jsonb_array_length(coalesce(j.trigger_config -> 'reasons', '[]')) = 0
             or exists (select 1 from jsonb_array_elements_text(j.trigger_config -> 'reasons') rr where private.norm(coalesce(d.lost_reason, '')) like '%' || private.norm(rr) || '%'))
    ) x
    join crm.parties p on p.id = x.party_id
    where p.anonymized_at is null and p.merged_into_id is null
      and not exists (select 1 from crm.party_roles rl where rl.party_id = p.id and rl.role in ('EMPLOYEE', 'SUPPLIER', 'SERVICE_PROVIDER', 'CARRIER', 'ACQUIRER', 'BANK'))
      and not exists (select 1 from mkt.journey_enrollments e where e.journey_id = j.id and e.party_id = x.party_id and (e.source_key = x.source_key or e.status = 'ACTIVE'))
    limit 500
  loop
    v_grp := case when random() * 100 < j.holdout_pct then 'HOLDOUT' else 'TREATMENT' end;
    select coalesce(wait_days, 0) into v_days from mkt.journey_steps where journey_id = j.id order by position limit 1;
    insert into mkt.journey_enrollments (org_id, journey_id, party_id, source_key, grp, next_run_at)
    values (j.org_id, j.id, r.party_id, r.source_key, v_grp, now() + make_interval(days => coalesce(v_days, 0)))
    on conflict do nothing;
    if found then n := n + 1; end if;
  end loop;
  return n;
end $$;

create or replace function private.run_journeys() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare j mkt.journeys; e record; s mkt.journey_steps; v_enrolled int := 0; v_done int := 0; v_block text; v_task uuid; v_msg uuid; v_conv uuid; w record; v_wa text; v_next mkt.journey_steps;
  v_paid text[] := array['PAID', 'COMPLETED', 'FULFILLING', 'READY_FOR_PICKUP', 'SHIPPED', 'PARTIALLY_RETURNED']; v_owner uuid; v_text text; v_when timestamptz; v_ord record; v_kind text;
begin
  for j in select * from mkt.journeys where active loop
    v_enrolled := v_enrolled + private.journey_enroll(j);
  end loop;

  -- saída por compra (meta atingida) — vale para os dois grupos, é o que mede o efeito
  for e in select en.*, jj.exit_on_purchase from mkt.journey_enrollments en join mkt.journeys jj on jj.id = en.journey_id where en.status = 'ACTIVE' and jj.exit_on_purchase loop
    select o.id, o.created_at into v_ord from sales.orders o where o.party_id = e.party_id and o.status::text = any (v_paid) and o.created_at > e.enrolled_at and o.id::text <> e.source_key order by o.created_at limit 1;
    if v_ord.id is not null then
      update mkt.journey_enrollments set status = 'COMPLETED', exit_reason = 'PURCHASED', converted_order_id = v_ord.id, converted_at = v_ord.created_at, finished_at = now() where id = e.id;
    end if;
  end loop;

  -- passos vencidos
  for e in select en.* from mkt.journey_enrollments en join mkt.journeys jj on jj.id = en.journey_id
           where en.status = 'ACTIVE' and jj.active and en.next_run_at <= now() order by en.next_run_at limit 500 for update of en skip locked loop
    select * into s from mkt.journey_steps where journey_id = e.journey_id and position >= e.next_step order by position limit 1;
    if s.id is null then
      update mkt.journey_enrollments set status = 'COMPLETED', exit_reason = 'FINISHED', finished_at = now(), next_run_at = null where id = e.id;
      continue;
    end if;
    v_task := null; v_msg := null; v_block := null;
    if e.grp = 'HOLDOUT' then
      insert into mkt.journey_events (org_id, enrollment_id, step_position, result) values (e.org_id, e.id, s.position, 'HOLDOUT');
    else
      v_kind := case when s.action = 'MARKETING_TEMPLATE' then 'MARKETING' else 'RELATIONSHIP' end;
      v_block := private.contact_block(e.party_id, v_kind);
      if v_block in ('OPTED_OUT', 'OPEN_COMPLAINT', 'NOT_CUSTOMER', 'NOT_AVAILABLE') then
        update mkt.journey_enrollments set status = 'EXITED', exit_reason = v_block, finished_at = now(), next_run_at = null where id = e.id;
        insert into mkt.journey_events (org_id, enrollment_id, step_position, result, reason) values (e.org_id, e.id, s.position, 'SKIPPED', v_block);
        continue;
      end if;
      if v_block in ('IN_CONVERSATION') then                                                  -- conversa em andamento: tenta de novo amanhã
        update mkt.journey_enrollments set next_run_at = now() + interval '1 day' where id = e.id;
        continue;
      end if;
      if s.action <> 'TASK' then
        v_when := private.next_send_time(e.org_id, now());
        if v_when > now() then update mkt.journey_enrollments set next_run_at = v_when where id = e.id; continue; end if;   -- horário de silêncio
      end if;
      v_text := private.render_party_text(e.party_id, s.message);
      if v_block is null and s.action = 'MARKETING_TEMPLATE' then
        v_msg := private.send_marketing_template(e.party_id, s.template_id, s.template_vars, 'journey:' || e.id || ':' || s.position);
        insert into mkt.journey_events (org_id, enrollment_id, step_position, result, reason, message_id)
        values (e.org_id, e.id, s.position, case when v_msg is null then 'SKIPPED' else 'SENT_TEMPLATE' end, case when v_msg is null then 'NO_TEMPLATE_OR_PHONE' end, v_msg);
      elsif v_block is null and s.action = 'TEXT_IF_WINDOW' then
        v_wa := private.party_wa_id(e.party_id);
        select id into v_conv from omni.conversations where party_id = e.party_id and status <> 'CLOSED' and last_inbound_at > now() - interval '23 hours' order by last_inbound_at desc limit 1;
        if v_conv is not null then
          v_msg := omni.queue_system_message(v_conv, v_text);
        end if;
        if v_msg is not null then
          insert into mkt.journey_events (org_id, enrollment_id, step_position, result, message_id) values (e.org_id, e.id, s.position, 'SENT_TEXT', v_msg);
        end if;
      end if;
      -- tarefa: o passo é tarefa, ou a mensagem não pôde sair (janela fechada) — desde que o limite de contatos pessoais deixe
      if v_msg is null and (s.action in ('TASK', 'TEXT_IF_WINDOW')) then
        if private.contact_block(e.party_id, 'RELATIONSHIP') is null then
          select relationship_owner_member_id into v_owner from crm.parties where id = e.party_id;
          insert into crm.tasks (org_id, party_id, assignee_member_id, type, title, suggested_message, due_at, source_rule)
          values (e.org_id, e.party_id, v_owner, 'JOURNEY', private.render_party_text(e.party_id, s.title), v_text, now() + make_interval(hours => s.due_hours), 'journey:' || e.id || ':' || s.position)
          returning id into v_task;
          insert into mkt.journey_events (org_id, enrollment_id, step_position, result, task_id) values (e.org_id, e.id, s.position, 'TASK', v_task);
        else
          insert into mkt.journey_events (org_id, enrollment_id, step_position, result, reason) values (e.org_id, e.id, s.position, 'SKIPPED', 'FREQUENCY_CAP');
        end if;
      elsif v_msg is null and s.action = 'MARKETING_TEMPLATE' and v_block is not null then
        insert into mkt.journey_events (org_id, enrollment_id, step_position, result, reason) values (e.org_id, e.id, s.position, 'SKIPPED', v_block);
      end if;
    end if;
    select * into v_next from mkt.journey_steps where journey_id = e.journey_id and position > s.position order by position limit 1;
    if v_next.id is null then
      update mkt.journey_enrollments set next_step = s.position + 1, status = 'COMPLETED', exit_reason = 'FINISHED', finished_at = now(), next_run_at = null where id = e.id;
    else
      update mkt.journey_enrollments set next_step = v_next.position, next_run_at = now() + make_interval(secs => (v_next.wait_days * 86400)::int) where id = e.id;
    end if;
    v_done := v_done + 1;
  end loop;
  return jsonb_build_object('enrolled', v_enrolled, 'steps', v_done);
end $$;
select cron.schedule('sie-journeys', '*/15 * * * *', $$ select private.run_journeys() $$);

-- ---------------------------------------------------------------------
-- 5) Resultado: tratamento × controle (compra em até N dias da inscrição)
-- ---------------------------------------------------------------------
create or replace function mkt.journey_report(p_journey uuid, p_days int default 30) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); res jsonb; v_paid text[] := array['PAID', 'COMPLETED', 'FULFILLING', 'READY_FOR_PICKUP', 'SHIPPED', 'PARTIALLY_RETURNED'];
begin
  perform private.require_perm('crm.read');
  if not exists (select 1 from mkt.journeys where id = p_journey and org_id = v_org) then raise exception 'Régua não encontrada' using errcode = 'P0352'; end if;
  with en as (
    select e.*, (select o.total from sales.orders o where o.party_id = e.party_id and o.status::text = any (v_paid) and o.created_at > e.enrolled_at
                   and o.created_at <= e.enrolled_at + make_interval(days => p_days) and o.id::text <> e.source_key order by o.created_at limit 1) as conv_total
    from mkt.journey_enrollments e where e.journey_id = p_journey
  ), g as (
    select grp, count(*) as n, count(conv_total) as conv, coalesce(sum(conv_total), 0) as revenue,
           count(*) filter (where enrolled_at <= now() - make_interval(days => p_days)) as matured
    from en group by grp
  )
  select jsonb_build_object(
    'groups', coalesce((select jsonb_object_agg(grp, jsonb_build_object('enrolled', n, 'converted', conv, 'revenue', revenue, 'matured', matured,
                                                                       'rate', case when n > 0 then round(100.0 * conv / n, 1) end)) from g), '{}'),
    'active', (select count(*) from mkt.journey_enrollments where journey_id = p_journey and status = 'ACTIVE'),
    'exits', coalesce((select jsonb_object_agg(coalesce(exit_reason, 'ACTIVE'), c) from (select exit_reason, count(*) c from mkt.journey_enrollments where journey_id = p_journey group by 1) x), '{}'),
    'steps', coalesce((select jsonb_agg(jsonb_build_object('position', step_position, 'result', result, 'n', c, 'done', d) order by step_position, result) from (
               select ev.step_position, ev.result, count(*) c, count(*) filter (where t.status = 'DONE') d
               from mkt.journey_events ev join mkt.journey_enrollments en2 on en2.id = ev.enrollment_id left join crm.tasks t on t.id = ev.task_id
               where en2.journey_id = p_journey group by 1, 2) s), '[]'),
    'window_days', p_days
  ) into res;
  return res;
end $$;

-- ---------------------------------------------------------------------
-- 6) Réguas padrão do plano (desligadas) para cada organização
-- ---------------------------------------------------------------------
create or replace function private.seed_default_journeys(p_org uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v uuid;
begin
  insert into mkt.journeys (org_id, key, name, description, trigger, trigger_config, exit_on_purchase) values
    (p_org, 'pos-compra', 'Pós-compra', 'Primeiras semanas depois da 1ª compra: caimento, indicação e complemento do look.', 'FIRST_PURCHASE', '{}', false)
  on conflict (org_id, key) do nothing returning id into v;
  if v is not null then
    insert into mkt.journey_steps (org_id, journey_id, position, wait_days, action, title, message, due_hours) values
      (p_org, v, 1, 4, 'TEXT_IF_WINDOW', 'Caimento: como ficou a peça de {nome}?', 'Oi, {nome}! Como ficou a {ultima_peca} no treino? Se o caimento não ficou perfeito, a gente troca rapidinho. 💛', 48),
      (p_org, v, 2, 17, 'TASK', 'Complemento do look para {nome}', 'Oi, {nome}! Chegaram peças que combinam com a {ultima_peca}, no seu tamanho ({tamanho}). Quer que eu separe para você provar?', 72);
  end if;
  v := null;
  insert into mkt.journeys (org_id, key, name, description, trigger, trigger_config) values
    (p_org, 'segunda-compra', 'Segunda compra', 'Cliente nova que ainda não voltou depois de 30 dias: convite pessoal.', 'NO_SECOND_PURCHASE', '{"days": 30}')
  on conflict (org_id, key) do nothing returning id into v;
  if v is not null then
    insert into mkt.journey_steps (org_id, journey_id, position, wait_days, action, title, message, due_hours) values
      (p_org, v, 1, 0, 'TASK', 'Convidar {nome} para a 2ª compra', 'Oi, {nome}! Chegaram novidades no seu tamanho ({tamanho}) e lembrei de você. Quer que eu separe algumas para você provar no seu próximo treino?', 48);
  end if;
  v := null;
  insert into mkt.journeys (org_id, key, name, description, trigger, trigger_config, exit_on_purchase) values
    (p_org, 'aniversario', 'Aniversário', 'Três dias antes: mensagem pessoal com um mimo para retirar na loja.', 'BIRTHDAY', '{"days_before": 3}', false)
  on conflict (org_id, key) do nothing returning id into v;
  if v is not null then
    insert into mkt.journey_steps (org_id, journey_id, position, wait_days, action, title, message, due_hours) values
      (p_org, v, 1, 0, 'TASK', 'Aniversário de {nome}: mimo para retirar', 'Feliz aniversário, {nome}! 💛 Separamos um mimo para você retirar na loja até {data_limite}.', 48);
  end if;
  v := null;
  insert into mkt.journeys (org_id, key, name, description, trigger) values
    (p_org, 'em-risco', 'Em risco', 'Passou do intervalo habitual de compra: contato pessoal, sem desconto.', 'AT_RISK')
  on conflict (org_id, key) do nothing returning id into v;
  if v is not null then
    insert into mkt.journey_steps (org_id, journey_id, position, wait_days, action, title, message, due_hours) values
      (p_org, v, 1, 0, 'TASK', 'Novidade no tamanho de {nome}', 'Oi, {nome}! Chegou novidade no seu tamanho ({tamanho}) e lembrei de você. Quer que eu separe para provar?', 48);
  end if;
  v := null;
  insert into mkt.journeys (org_id, key, name, description, trigger) values
    (p_org, 'inativa', 'Inativa (120 dias)', 'Convite para provador ou evento; com aceite, template de marketing.', 'INACTIVE')
  on conflict (org_id, key) do nothing returning id into v;
  if v is not null then
    insert into mkt.journey_steps (org_id, journey_id, position, wait_days, action, title, message, due_hours) values
      (p_org, v, 1, 0, 'TASK', 'Convidar {nome} para voltar', 'Oi, {nome}! Faz um tempinho que você não passa na SIÉ. Que tal provar as novidades no seu próximo treino? Posso separar no seu tamanho.', 72);
  end if;
  v := null;
  insert into mkt.journeys (org_id, key, name, description, trigger) values
    (p_org, 'inativa-longa', 'Última tentativa (180+ dias)', 'Antes de considerar perdida: benefício de retorno.', 'LONG_INACTIVE')
  on conflict (org_id, key) do nothing returning id into v;
  if v is not null then
    insert into mkt.journey_steps (org_id, journey_id, position, wait_days, action, title, message, due_hours) values
      (p_org, v, 1, 0, 'TASK', 'Última tentativa com {nome}', 'Oi, {nome}! Sentimos sua falta por aqui. Na sua próxima visita até {data_limite}, tem um mimo te esperando.', 72);
  end if;
  v := null;
  insert into mkt.journeys (org_id, key, name, description, trigger, trigger_config) values
    (p_org, 'perdida-sem-retorno', 'Oportunidade perdida: sem retorno', 'Uma tentativa 7 dias depois de perder por falta de resposta.', 'DEAL_LOST', '{"after_days": 7, "reasons": ["sem retorno", "não respondeu"]}')
  on conflict (org_id, key) do nothing returning id into v;
  if v is not null then
    insert into mkt.journey_steps (org_id, journey_id, position, wait_days, action, title, message, due_hours) values
      (p_org, v, 1, 0, 'TASK', 'Retomar com {nome}', 'Oi, {nome}! Passando para saber se ainda posso te ajudar com aquela peça. Separo para você provar?', 48);
  end if;
end $$;
select private.seed_default_journeys(id) from core.orgs;
-- organização nova (inclusive a do seed, que nasce depois das migrations) também ganha as réguas padrão
create or replace function private.seed_journeys_on_org() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.seed_default_journeys(new.id);
  return null;
end $$;
create trigger trg_seed_journeys after insert on core.orgs for each row execute function private.seed_journeys_on_org();

insert into private.internal_functions (fqname) values
  ('private.contact_cfg'), ('private.contact_block'), ('private.next_send_time'), ('private.render_party_text'), ('private.send_marketing_template'),
  ('private.journey_enroll'), ('private.run_journeys'), ('private.seed_default_journeys'), ('private.seed_journeys_on_org')
on conflict do nothing;
select private.lock_functions();
