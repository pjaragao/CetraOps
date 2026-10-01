-- =====================================================================
-- Marketing › Campanhas (disparo de template de marketing no WhatsApp) e público (audiência) reutilizável.
-- Regras que o banco garante: só recebe quem deu consentimento de marketing NO WHATSAPP (recusa vale na hora, inclusive no meio do disparo),
-- intervalo mínimo entre mensagens de marketing para a mesma pessoa, limite diário por número (faixa da Meta) e template aprovado do mesmo número.
-- Fornecedoras, funcionárias e prestadoras nunca entram em público de marketing. Códigos de erro: P0190 dado inválido · P0191 situação · P0192 não encontrado.
-- =====================================================================

do $$
begin
  perform pgmq.create('campaign_tasks');
  perform pgmq.create('campaign_tasks_dlq');
end $$;

-- ---------------------------------------------------------------------
-- 1) Público: quem entra. Definição (todos opcionais, combinam com E):
-- {lifecycle:[...], tiers:[...], min_score:n, inactive_days:n, birthday_month:1-12, cities:[...], tags:[...], event_id:uuid, rsvp:[...]}
-- Nunca devolve pessoa anonimizada, duplicada (mesclada) ou com papel interno (fornecedora, funcionária, prestadora, transportadora, adquirente, banco).
-- ---------------------------------------------------------------------
create or replace function crm.audience(p_def jsonb) returns table (party_id uuid)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id(); d jsonb := coalesce(p_def, '{}');
  v_life text[] := array(select jsonb_array_elements_text(coalesce(d -> 'lifecycle', '[]'))); v_tiers text[] := array(select jsonb_array_elements_text(coalesce(d -> 'tiers', '[]')));
  v_cities text[] := array(select lower(jsonb_array_elements_text(coalesce(d -> 'cities', '[]')))); v_tags text[] := array(select jsonb_array_elements_text(coalesce(d -> 'tags', '[]')));
  v_rsvp text[] := array(select jsonb_array_elements_text(coalesce(d -> 'rsvp', '[]')));
  v_score int := nullif(d ->> 'min_score', '')::int; v_inactive int := nullif(d ->> 'inactive_days', '')::int; v_bmonth int := nullif(d ->> 'birthday_month', '')::int;
  v_event uuid := nullif(d ->> 'event_id', '')::uuid;
begin
  perform private.require_perm('crm.read');
  if jsonb_typeof(d) <> 'object' then raise exception 'Definição de público inválida' using errcode = 'P0190'; end if;
  return query
    select p.id from crm.parties p
    where p.org_id = v_org and p.merged_into_id is null and p.anonymized_at is null
      and not exists (select 1 from crm.party_roles r where r.party_id = p.id and r.role in ('EMPLOYEE', 'SUPPLIER', 'SERVICE_PROVIDER', 'CARRIER', 'ACQUIRER', 'BANK'))
      and (cardinality(v_life) = 0 or p.lifecycle_stage::text = any (v_life))
      and (cardinality(v_tiers) = 0 or p.tier::text = any (v_tiers))
      and (v_score is null or p.lead_score >= v_score)
      and (v_inactive is null or p.last_purchase_at is null or p.last_purchase_at < now() - make_interval(days => v_inactive))
      and (v_bmonth is null or extract(month from p.birth_date) = v_bmonth)
      and (cardinality(v_cities) = 0 or lower(p.city) = any (v_cities))
      and (cardinality(v_tags) = 0 or p.tags && v_tags)
      and (v_event is null or exists (select 1 from mkt.event_guests g where g.event_id = v_event and g.party_id = p.id and (cardinality(v_rsvp) = 0 or g.rsvp_status = any (v_rsvp))))
    order by p.lead_score desc, p.created_at
    limit 5000;
end $$;

-- Convida para um evento todas as pessoas de um público (até 200, pelas de maior score)
create or replace function mkt.invite_audience(p_event uuid, p_def jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_ids uuid[];
begin
  perform private.require_perm('crm.write');
  select array(select a.party_id from crm.audience(p_def) a limit 200) into v_ids;
  if coalesce(cardinality(v_ids), 0) = 0 then raise exception 'Ninguém encontrado nesse grupo' using errcode = 'P0190'; end if;
  return mkt.invite_guests(p_event, v_ids, 'SEGMENT');
end $$;

-- Lista do dia da prospecção: nunca inclui papéis internos (mesma regra do público)
create or replace function crm.generate_outreach(p_limit integer default null) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id(); v_me uuid := private.member_id(); v_today date := private.today_sp();
  v_cfg jsonb := coalesce((select value from core.settings where org_id = private.org_id() and key = 'outreach'), '{}');
  v_daily int := coalesce((v_cfg ->> 'daily_limit')::int, 15); v_cool int := coalesce((v_cfg ->> 'cooldown_days')::int, 30);
  v_have int; v_room int; v_n int := 0; r record; v_step text; v_ids uuid[] := '{}'; v_id uuid;
begin
  perform private.require_perm('crm.write');
  if v_me is null then raise exception 'Só membros da equipe geram a lista' using errcode = 'P0171'; end if;
  select count(*) into v_have from crm.outreach_items where assigned_member_id = v_me and due_on = v_today and status <> 'SKIPPED';
  v_room := least(coalesce(p_limit, v_daily), v_daily) - v_have;
  if v_room <= 0 then raise exception 'A meta do dia (%) já está na sua lista', v_daily using errcode = 'P0171'; end if;

  for r in
    select p.id as party_id, p.instagram_handle, last.playbook_step as last_step, last.status as last_status, last.done_at as last_done, last.created_at as last_created
    from crm.parties p
    left join lateral (select o.playbook_step, o.status, o.done_at, o.created_at from crm.outreach_items o where o.party_id = p.id and o.channel = 'INSTAGRAM' order by o.created_at desc limit 1) last on true
    where p.org_id = v_org and p.instagram_handle is not null and trim(p.instagram_handle) <> '' and p.merged_into_id is null and p.anonymized_at is null
      and p.lifecycle_stage in ('LEAD', 'PROSPECT')
      and not exists (select 1 from crm.party_roles rl where rl.party_id = p.id and rl.role in ('EMPLOYEE', 'SUPPLIER', 'SERVICE_PROVIDER', 'CARRIER', 'ACQUIRER', 'BANK'))
      and not exists (select 1 from crm.v_current_consents c where c.party_id = p.id and c.purpose = 'MARKETING_IG' and c.granted = false)
      and (last.status is null or last.status in ('SENT_MANUALLY', 'SKIPPED'))
    order by p.lead_score desc, p.created_at
    limit 400
  loop
    if r.last_status is null then
      v_step := 'STORY';
    elsif r.last_status = 'SKIPPED' then
      continue when r.last_created > now() - make_interval(days => v_cool);   -- recusou/pulou: só volta depois do intervalo
      v_step := 'STORY';
    elsif r.last_step = 'DM' then
      continue when coalesce(r.last_done, r.last_created) > now() - make_interval(days => v_cool);
      v_step := 'STORY';
    else
      continue when coalesce(r.last_done, r.last_created)::date >= v_today;       -- um passo por dia
      v_step := private.outreach_next_step(r.last_step);
    end if;
    insert into crm.outreach_items (org_id, party_id, channel, playbook_step, assigned_member_id, due_on)
    values (v_org, r.party_id, 'INSTAGRAM', v_step, v_me, v_today) returning id into v_id;
    v_n := v_n + 1;
    if v_step = 'DM' then v_ids := v_ids || v_id; end if;
    exit when v_n >= v_room;
  end loop;
  if cardinality(v_ids) > 0 then
    perform private.enqueue('ai_tasks', jsonb_build_object('action', 'OUTREACH_DRAFT', 'org_id', v_org, 'item_ids', to_jsonb(v_ids)));
  end if;
  return v_n;
end $$;

-- ---------------------------------------------------------------------
-- 2) Campanhas
-- ---------------------------------------------------------------------
create table mkt.campaigns (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  name text not null,
  channel_account_id uuid not null references omni.channel_accounts(id),
  template_id uuid not null references omni.templates(id),
  variables jsonb not null default '[]',                          -- uma entrada por {{n}}: {source: FIRST_NAME|FULL_NAME|TEXT, text?}
  audience jsonb not null default '{}',
  frequency_cap_days integer not null default 7 check (frequency_cap_days between 0 and 90),
  daily_limit integer not null default 250 check (daily_limit between 1 and 10000),
  scheduled_at timestamptz,
  status text not null default 'DRAFT' check (status in ('DRAFT', 'SCHEDULED', 'SENDING', 'DONE', 'CANCELLED')),
  created_by uuid references core.members(id),
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table mkt.campaign_recipients (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,                        -- ordem de envio = ordem do público (maior pontuação primeiro)
  org_id uuid not null references core.orgs(id),
  campaign_id uuid not null references mkt.campaigns(id) on delete cascade,
  party_id uuid not null references crm.parties(id),
  status text not null default 'PENDING' check (status in ('PENDING', 'QUEUED', 'SENT', 'FAILED', 'SKIPPED')),
  skip_reason text,
  message_id uuid references omni.messages(id) on delete set null,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  unique (campaign_id, party_id)
);
create index campaign_recipients_todo_idx on mkt.campaign_recipients (campaign_id, seq) where status = 'PENDING';
create index campaign_recipients_msg_idx on mkt.campaign_recipients (message_id) where message_id is not null;
select private.attach_updated_at('mkt');
select private.apply_rls('mkt', array['campaigns', 'campaign_recipients'], 'crm.read', 'crm.write');
select private.rpc_only('mkt', array['campaigns', 'campaign_recipients']);
create trigger trg_audit after insert or update or delete on mkt.campaigns for each row execute function private.audit_capture();

-- Número de WhatsApp (só dígitos) da pessoa: contato de WhatsApp primeiro, depois telefone
create or replace function private.party_wa_id(p_party uuid) returns text
language sql stable security definer set search_path = '' as $$
  select regexp_replace(value_normalized, '\D', '', 'g') from crm.party_contact_points
  where party_id = p_party and type in ('WHATSAPP', 'PHONE') and length(regexp_replace(value_normalized, '\D', '', 'g')) >= 10
  order by (type = 'WHATSAPP') desc, is_primary desc, created_at limit 1
$$;

-- Por que uma pessoa NÃO pode receber a campanha agora (null = pode)
create or replace function private.campaign_skip_reason(p_party uuid, p_cap_days integer) returns text
language plpgsql stable security definer set search_path = '' as $$
declare v_granted boolean;
begin
  if private.party_wa_id(p_party) is null then return 'NO_PHONE'; end if;
  select granted into v_granted from crm.v_current_consents where party_id = p_party and purpose = 'MARKETING_WHATSAPP';
  if not coalesce(v_granted, false) then return 'NO_CONSENT'; end if;
  if p_cap_days > 0 and exists (
    select 1 from omni.messages m join omni.conversations c on c.id = m.conversation_id join omni.templates t on t.id = (m.payload ->> 'template_id')::uuid
    where c.party_id = p_party and m.direction = 'OUT' and m.type = 'TEMPLATE' and t.category = 'MARKETING' and m.status <> 'FAILED' and m.created_at > now() - make_interval(days => p_cap_days)) then
    return 'FREQUENCY_CAP';
  end if;
  return null;
end $$;

-- p = {id?, name, channel_account_id, template_id, variables: [...], audience: {...}, frequency_cap_days?, daily_limit?, scheduled_at?}
create or replace function mkt.save_campaign(p jsonb) returns mkt.campaigns
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id(); v_id uuid := nullif(p ->> 'id', '')::uuid; v_name text := trim(coalesce(p ->> 'name', '')); v_acc uuid := nullif(p ->> 'channel_account_id', '')::uuid;
  v_tpl uuid := nullif(p ->> 'template_id', '')::uuid; v_vars jsonb := coalesce(p -> 'variables', '[]'); v_aud jsonb := coalesce(p -> 'audience', '{}'); t omni.templates; v_body text; v_ph int[]; x jsonb;
  v_cap int := coalesce(nullif(p ->> 'frequency_cap_days', '')::int, 7); v_daily int := coalesce(nullif(p ->> 'daily_limit', '')::int, 250); v_at timestamptz := nullif(p ->> 'scheduled_at', '')::timestamptz; c mkt.campaigns;
begin
  perform private.require_perm('crm.write');
  if length(v_name) not between 3 and 120 then raise exception 'O nome da campanha tem de 3 a 120 caracteres' using errcode = 'P0190'; end if;
  if not exists (select 1 from omni.channel_accounts where id = v_acc and org_id = v_org and channel = 'WHATSAPP' and status = 'ACTIVE') then raise exception 'Escolha um número de WhatsApp ativo' using errcode = 'P0190'; end if;
  select * into t from omni.templates where id = v_tpl and org_id = v_org;
  if t.id is null or t.channel_account_id <> v_acc then raise exception 'Escolha um template deste número' using errcode = 'P0190'; end if;
  if t.status <> 'APPROVED' then raise exception 'O template ainda não foi aprovado pela Meta (situação: %)', t.status using errcode = 'P0190'; end if;
  select c2 ->> 'text' into v_body from jsonb_array_elements(t.components) c2 where c2 ->> 'type' = 'BODY' limit 1;
  v_ph := private.template_placeholders(v_body);
  if jsonb_typeof(v_vars) <> 'array' or jsonb_array_length(v_vars) <> coalesce(array_length(v_ph, 1), 0) then raise exception 'Defina as % variável(is) do template', coalesce(array_length(v_ph, 1), 0) using errcode = 'P0190'; end if;
  for x in select * from jsonb_array_elements(v_vars) loop
    if x ->> 'source' not in ('FIRST_NAME', 'FULL_NAME', 'TEXT') or (x ->> 'source' = 'TEXT' and (coalesce(trim(x ->> 'text'), '') = '' or length(x ->> 'text') > 200 or (x ->> 'text') ~ '[\r\n\t]')) then
      raise exception 'Variável inválida: use primeiro nome, nome completo ou um texto fixo (até 200 caracteres, sem quebra de linha)' using errcode = 'P0190';
    end if;
  end loop;
  if jsonb_typeof(v_aud) <> 'object' then raise exception 'Público inválido' using errcode = 'P0190'; end if;
  if v_cap not between 0 and 90 then raise exception 'O intervalo entre mensagens de marketing vai de 0 a 90 dias' using errcode = 'P0190'; end if;
  if v_daily not between 1 and 10000 then raise exception 'O limite diário vai de 1 a 10.000' using errcode = 'P0190'; end if;
  if v_id is null then
    insert into mkt.campaigns (org_id, name, channel_account_id, template_id, variables, audience, frequency_cap_days, daily_limit, scheduled_at, created_by)
    values (v_org, v_name, v_acc, v_tpl, v_vars, v_aud, v_cap, v_daily, v_at, private.member_id()) returning * into c;
  else
    update mkt.campaigns set name = v_name, channel_account_id = v_acc, template_id = v_tpl, variables = v_vars, audience = v_aud, frequency_cap_days = v_cap, daily_limit = v_daily, scheduled_at = v_at
    where id = v_id and org_id = v_org and status = 'DRAFT' returning * into c;
    if c.id is null then raise exception 'Campanha não encontrada ou já lançada' using errcode = 'P0192'; end if;
  end if;
  return c;
end $$;

-- Quantas pessoas receberiam e por que as outras ficam de fora
create or replace function mkt.campaign_preview(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c mkt.campaigns; r record; v_ok int := 0; v_skips jsonb := '{}'; v_sample text[] := '{}'; v_reason text; v_total int := 0;
begin
  perform private.require_perm('crm.read');
  select * into c from mkt.campaigns where id = p_id and org_id = private.org_id();
  if c.id is null then raise exception 'Campanha não encontrada' using errcode = 'P0192'; end if;
  for r in select a.party_id, p.display_name from crm.audience(c.audience) a join crm.parties p on p.id = a.party_id loop
    v_total := v_total + 1;
    v_reason := private.campaign_skip_reason(r.party_id, c.frequency_cap_days);
    if v_reason is null then
      v_ok := v_ok + 1;
      if cardinality(v_sample) < 5 then v_sample := v_sample || r.display_name; end if;
    else
      v_skips := v_skips || jsonb_build_object(v_reason, coalesce((v_skips ->> v_reason)::int, 0) + 1);
    end if;
  end loop;
  return jsonb_build_object('audience', v_total, 'eligible', v_ok, 'excluded', v_skips, 'sample', to_jsonb(v_sample),
                            'days_needed', case when v_ok > 0 then ceil(v_ok::numeric / c.daily_limit)::int else 0 end);
end $$;

-- Lança: congela a lista (com o motivo de quem ficou de fora) e entrega ao worker
create or replace function mkt.launch_campaign(p_id uuid) returns mkt.campaigns
language plpgsql security definer set search_path = '' as $$
declare c mkt.campaigns; t omni.templates; r record; v_reason text; v_ok int := 0; v_delay int;
begin
  perform private.require_perm('crm.write');
  select * into c from mkt.campaigns where id = p_id and org_id = private.org_id() for update;
  if c.id is null then raise exception 'Campanha não encontrada' using errcode = 'P0192'; end if;
  if c.status <> 'DRAFT' then raise exception 'Esta campanha já foi lançada' using errcode = 'P0191'; end if;
  select * into t from omni.templates where id = c.template_id;
  if t.status <> 'APPROVED' then raise exception 'O template deixou de estar aprovado (situação: %)', t.status using errcode = 'P0191'; end if;
  if c.scheduled_at is not null and c.scheduled_at < now() - interval '5 minutes' then raise exception 'A data agendada já passou' using errcode = 'P0190'; end if;
  for r in select a.party_id from crm.audience(c.audience) a loop
    v_reason := private.campaign_skip_reason(r.party_id, c.frequency_cap_days);
    insert into mkt.campaign_recipients (org_id, campaign_id, party_id, status, skip_reason) values (c.org_id, c.id, r.party_id, case when v_reason is null then 'PENDING' else 'SKIPPED' end, v_reason);
    if v_reason is null then v_ok := v_ok + 1; end if;
  end loop;
  if v_ok = 0 then raise exception 'Ninguém do público pode receber agora (consentimento, telefone ou intervalo entre mensagens)' using errcode = 'P0191'; end if;
  v_delay := greatest(0, ceil(extract(epoch from (coalesce(c.scheduled_at, now()) - now())))::int);
  update mkt.campaigns set status = case when v_delay = 0 then 'SENDING' else 'SCHEDULED' end, started_at = case when v_delay = 0 then now() end where id = c.id returning * into c;
  perform private.enqueue('campaign_tasks', jsonb_build_object('campaign_id', c.id, 'org_id', c.org_id), v_delay);
  return c;
end $$;

create or replace function mkt.cancel_campaign(p_id uuid) returns mkt.campaigns
language plpgsql security definer set search_path = '' as $$
declare c mkt.campaigns;
begin
  perform private.require_perm('crm.write');
  update mkt.campaigns set status = 'CANCELLED', finished_at = now() where id = p_id and org_id = private.org_id() and status in ('DRAFT', 'SCHEDULED', 'SENDING') returning * into c;
  if c.id is null then raise exception 'Só campanhas ainda não concluídas podem ser canceladas' using errcode = 'P0191'; end if;
  update mkt.campaign_recipients set status = 'SKIPPED', skip_reason = 'CAMPAIGN_CANCELLED' where campaign_id = c.id and status = 'PENDING';
  return c;
end $$;

create or replace function mkt.delete_campaign(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('crm.write');
  delete from mkt.campaigns where id = p_id and org_id = private.org_id() and status = 'DRAFT';
  if not found then raise exception 'Só rascunhos podem ser excluídos' using errcode = 'P0191'; end if;
end $$;

-- ---------------------------------------------------------------------
-- 3) Envio (worker): conversa da pessoa + mensagem de template na fila de saída, respeitando o limite diário do número
-- ---------------------------------------------------------------------
create or replace function private.ensure_wa_conversation(p_account uuid, p_party uuid, p_wa_id text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare ca omni.channel_accounts; idn omni.channel_identities; cv omni.conversations;
begin
  select * into ca from omni.channel_accounts where id = p_account;
  select * into idn from omni.channel_identities where channel_account_id = ca.id and external_id = p_wa_id;
  if idn.id is null then
    insert into omni.channel_identities (org_id, channel_account_id, external_id, party_id, profile) values (ca.org_id, ca.id, p_wa_id, p_party, jsonb_build_object('source', 'campaign')) returning * into idn;
  elsif idn.party_id <> p_party then
    return null;                                                    -- o número já pertence a outra pessoa: não arrisca mandar para a pessoa errada
  end if;
  select * into cv from omni.conversations where channel_identity_id = idn.id and status <> 'CLOSED' order by created_at desc limit 1;
  if cv.id is null then
    insert into omni.conversations (org_id, party_id, channel_account_id, channel_identity_id, mode, persona_id) values (ca.org_id, p_party, ca.id, idn.id, ca.default_ai_mode, ca.default_persona_id) returning * into cv;
  end if;
  return cv.id;
end $$;

-- Envia até p_limit pendentes. Devolve {sent, pending, blocked_by_daily_limit, done}.
create or replace function mkt.campaign_send_batch(p_campaign uuid, p_limit integer default 50) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c mkt.campaigns; t omni.templates; r record; v_used int; v_room int; v_sent int := 0; v_reason text; v_conv uuid; v_wa text; v_body text; v_ph int[]; v_params jsonb; v_msg omni.messages; i int; v_name text; v_var jsonb;
  v_pending int; v_blocked boolean := false;
begin
  select * into c from mkt.campaigns where id = p_campaign for update;
  if c.id is null then raise exception 'Campanha não encontrada' using errcode = 'P0192'; end if;
  if c.status not in ('SCHEDULED', 'SENDING') then return jsonb_build_object('sent', 0, 'pending', 0, 'blocked_by_daily_limit', false, 'done', true, 'status', c.status); end if;
  if c.status = 'SCHEDULED' then update mkt.campaigns set status = 'SENDING', started_at = coalesce(started_at, now()) where id = c.id; end if;
  select * into t from omni.templates where id = c.template_id;
  if t.status <> 'APPROVED' then
    update mkt.campaign_recipients set status = 'SKIPPED', skip_reason = 'TEMPLATE_NOT_APPROVED' where campaign_id = c.id and status = 'PENDING';
  end if;
  select c2 ->> 'text' into v_body from jsonb_array_elements(t.components) c2 where c2 ->> 'type' = 'BODY' limit 1;
  v_ph := private.template_placeholders(v_body);
  -- limite diário do NÚMERO (faixa da Meta): todas as campanhas dele nas últimas 24 h
  select count(*) into v_used from mkt.campaign_recipients cr join mkt.campaigns cc on cc.id = cr.campaign_id where cc.channel_account_id = c.channel_account_id and cr.status in ('QUEUED', 'SENT') and cr.sent_at > now() - interval '24 hours';
  v_room := least(p_limit, c.daily_limit - v_used);
  if v_room <= 0 then v_blocked := true; end if;
  if not v_blocked then
    for r in select cr.id, cr.party_id from mkt.campaign_recipients cr where cr.campaign_id = c.id and cr.status = 'PENDING' order by cr.seq limit v_room for update skip locked loop
      v_reason := private.campaign_skip_reason(r.party_id, c.frequency_cap_days);          -- pode ter mudado desde o lançamento (recusa no meio do disparo)
      v_wa := private.party_wa_id(r.party_id);
      if v_reason is null then v_conv := private.ensure_wa_conversation(c.channel_account_id, r.party_id, v_wa); if v_conv is null then v_reason := 'IDENTITY_CONFLICT'; end if; end if;
      if v_reason is not null then
        update mkt.campaign_recipients set status = 'SKIPPED', skip_reason = v_reason where id = r.id;
        continue;
      end if;
      select display_name into v_name from crm.parties where id = r.party_id;
      v_params := '[]'; v_body := (select c2 ->> 'text' from jsonb_array_elements(t.components) c2 where c2 ->> 'type' = 'BODY' limit 1);
      i := 0;
      for v_var in select * from jsonb_array_elements(c.variables) loop
        i := i + 1;
        v_params := v_params || to_jsonb(case v_var ->> 'source' when 'FIRST_NAME' then split_part(v_name, ' ', 1) when 'FULL_NAME' then v_name else v_var ->> 'text' end);
        v_body := replace(v_body, '{{' || i || '}}', v_params ->> (i - 1));
      end loop;
      insert into omni.messages (org_id, conversation_id, channel_account_id, direction, author_type, type, body, template_name, status, client_dedupe_key, payload)
      values (c.org_id, v_conv, c.channel_account_id, 'OUT', 'SYSTEM', 'TEMPLATE', v_body, t.name, 'QUEUED', 'campaign:' || c.id || ':' || r.party_id,
              jsonb_build_object('language', t.language, 'template_id', t.id, 'campaign_id', c.id,
                'components', case when coalesce(array_length(v_ph, 1), 0) = 0 then '[]'::jsonb
                                   else jsonb_build_array(jsonb_build_object('type', 'body', 'parameters', (select jsonb_agg(jsonb_build_object('type', 'text', 'text', x #>> '{}')) from jsonb_array_elements(v_params) x))) end))
      returning * into v_msg;
      perform private.enqueue('outbound_messages', jsonb_build_object('message_id', v_msg.id, 'org_id', c.org_id));
      update mkt.campaign_recipients set status = 'QUEUED', message_id = v_msg.id, sent_at = now() where id = r.id;
      v_sent := v_sent + 1;
    end loop;
  end if;
  select count(*) into v_pending from mkt.campaign_recipients where campaign_id = c.id and status = 'PENDING';
  if v_pending = 0 then update mkt.campaigns set status = 'DONE', finished_at = now() where id = c.id; end if;
  return jsonb_build_object('sent', v_sent, 'pending', v_pending, 'blocked_by_daily_limit', v_blocked, 'done', v_pending = 0, 'status', case when v_pending = 0 then 'DONE' else 'SENDING' end);
end $$;

-- O resultado do envio (entregue, falhou) acompanha o status da mensagem
create or replace function mkt.sync_recipient_status() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.payload ? 'campaign_id' and new.status is distinct from old.status then
    update mkt.campaign_recipients set status = case when new.status = 'FAILED' then 'FAILED' else 'SENT' end where message_id = new.id and status in ('QUEUED', 'SENT', 'FAILED');
  end if;
  return new;
end $$;
drop trigger if exists trg_campaign_status on omni.messages;
create trigger trg_campaign_status after update of status on omni.messages for each row execute function mkt.sync_recipient_status();

-- ---------------------------------------------------------------------
-- 4) Resultado: entrega, leitura, respostas em 72 h e vendas em 7 dias depois do envio
-- ---------------------------------------------------------------------
create or replace function mkt.campaign_results(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  c mkt.campaigns; v_status jsonb; v_skips jsonb; v_delivered int; v_read int; v_replied int; v_buyers int; v_orders int; v_rev numeric;
  v_paid text[] := array['PAID', 'COMPLETED', 'FULFILLING', 'READY_FOR_PICKUP', 'SHIPPED', 'PARTIALLY_RETURNED'];
begin
  perform private.require_perm('crm.read');
  select * into c from mkt.campaigns where id = p_id and org_id = private.org_id();
  if c.id is null then raise exception 'Campanha não encontrada' using errcode = 'P0192'; end if;
  select coalesce(jsonb_object_agg(status, n), '{}') into v_status from (select status, count(*) n from mkt.campaign_recipients where campaign_id = c.id group by 1) x;
  select coalesce(jsonb_object_agg(skip_reason, n), '{}') into v_skips from (select skip_reason, count(*) n from mkt.campaign_recipients where campaign_id = c.id and status = 'SKIPPED' group by 1) x;
  select count(*) filter (where m.status in ('DELIVERED', 'READ')), count(*) filter (where m.status = 'READ') into v_delivered, v_read
  from mkt.campaign_recipients cr join omni.messages m on m.id = cr.message_id where cr.campaign_id = c.id;
  select count(distinct cr.party_id) into v_replied from mkt.campaign_recipients cr join omni.messages m on m.id = cr.message_id
  join omni.messages rep on rep.conversation_id = m.conversation_id and rep.direction = 'IN' and rep.created_at > cr.sent_at and rep.created_at < cr.sent_at + interval '72 hours' where cr.campaign_id = c.id;
  select count(distinct o.party_id), count(*), coalesce(sum(o.total), 0) into v_buyers, v_orders, v_rev
  from mkt.campaign_recipients cr join sales.orders o on o.party_id = cr.party_id and o.status::text = any (v_paid) and o.created_at > cr.sent_at and o.created_at < cr.sent_at + interval '7 days'
  where cr.campaign_id = c.id and cr.sent_at is not null;
  return jsonb_build_object('recipients', v_status, 'skipped', v_skips, 'delivered', v_delivered, 'read', v_read, 'replied', v_replied, 'buyers', v_buyers, 'orders', v_orders, 'revenue', round(v_rev, 2));
end $$;

insert into private.internal_functions (fqname) values ('private.party_wa_id'), ('private.campaign_skip_reason'), ('private.ensure_wa_conversation'), ('mkt.campaign_send_batch'), ('mkt.sync_recipient_status') on conflict do nothing;
select private.lock_functions();
