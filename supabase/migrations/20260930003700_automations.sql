-- =====================================================================
-- Atendimento › Automações: regras "quando acontecer X, faça Y" — palavra-chave na mensagem, chegada por anúncio no WhatsApp, menção em story,
-- comentário com palavra-chave no Instagram (resposta privada) e, por dia, aniversário e cliente parada.
-- Regras de segurança: nasce desligada; só envia texto onde o canal permite (mesma janela das demais mensagens); uma resposta automática por mensagem;
-- intervalo mínimo por pessoa; resposta privada a comentário só uma vez e em até 7 dias; aniversário e inatividade só criam TAREFA (nunca mandam mensagem).
-- Quando uma automação responde, a IA não responde à mesma mensagem. Tudo fica em omni.automation_runs.
-- Códigos de erro: P0200 dado inválido · P0201 situação não permite · P0202 não encontrado.
-- =====================================================================

create table omni.automations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  name text not null,
  trigger text not null check (trigger in ('KEYWORD', 'CTWA_REFERRAL', 'STORY_MENTION', 'COMMENT_KEYWORD', 'BIRTHDAY', 'INACTIVITY')),
  channel_account_id uuid references omni.channel_accounts(id),
  conditions jsonb not null default '{}',
  actions jsonb not null default '[]',
  cooldown_days integer not null default 1 check (cooldown_days between 0 and 365),
  priority integer not null default 100,
  active boolean not null default false,
  created_by uuid references core.members(id),
  last_run_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index automations_active_idx on omni.automations (org_id, trigger) where active;

create table omni.automation_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  automation_id uuid not null references omni.automations(id) on delete cascade,
  conversation_id uuid references omni.conversations(id) on delete set null,
  party_id uuid references crm.parties(id) on delete cascade,
  message_id uuid references omni.messages(id) on delete set null,
  status text not null check (status in ('DONE', 'SKIPPED', 'FAILED')),
  reason text,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index automation_runs_cooldown_idx on omni.automation_runs (automation_id, party_id, created_at desc) where status = 'DONE';
create index automation_runs_recent_idx on omni.automation_runs (org_id, created_at desc);

select private.attach_updated_at('omni');
select private.apply_rls('omni', array['automations', 'automation_runs'], 'omni.read', 'omni.write');
select private.rpc_only('omni', array['automations', 'automation_runs']);
create trigger trg_audit after insert or update or delete on omni.automations for each row execute function private.audit_capture();

-- Texto comparável: sem acento, minúsculo, só letras e números separados por um espaço, com espaço nas pontas (busca por palavra/frase inteira)
create or replace function private.kw_text(p_text text) returns text
language sql immutable as $$ select ' ' || trim(regexp_replace(private.norm(p_text), '[^a-z0-9]+', ' ', 'g')) || ' ' $$;

create or replace function private.kw_match(p_text text, p_keywords jsonb) returns boolean
language sql immutable as $$
  select coalesce(jsonb_array_length(coalesce(p_keywords, '[]')) = 0, true) or exists (
    select 1 from jsonb_array_elements_text(p_keywords) k where length(trim(private.kw_text(k))) > 0 and private.kw_text(p_text) like '%' || private.kw_text(k) || '%')
$$;

-- ---------------------------------------------------------------------
-- 1) Cadastro
-- p = {id?, name, trigger, channel_account_id?, conditions, actions, cooldown_days?, priority?}
-- ---------------------------------------------------------------------
create or replace function omni.save_automation(p jsonb) returns omni.automations
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id(); v_id uuid := nullif(p ->> 'id', '')::uuid; v_name text := trim(coalesce(p ->> 'name', '')); v_trig text := upper(coalesce(p ->> 'trigger', ''));
  v_acc uuid := nullif(p ->> 'channel_account_id', '')::uuid; v_cond jsonb := coalesce(p -> 'conditions', '{}'); v_act jsonb := coalesce(p -> 'actions', '[]'); x jsonb; k text; ca omni.channel_accounts;
  v_allowed text[]; v_cool int; v_n_send int := 0; a omni.automations; v_days int;
begin
  perform private.require_perm('omni.write');
  if length(v_name) not between 3 and 120 then raise exception 'O nome da automação tem de 3 a 120 caracteres' using errcode = 'P0200'; end if;
  if v_trig not in ('KEYWORD', 'CTWA_REFERRAL', 'STORY_MENTION', 'COMMENT_KEYWORD', 'BIRTHDAY', 'INACTIVITY') then raise exception 'Gatilho inválido' using errcode = 'P0200'; end if;
  if jsonb_typeof(v_cond) <> 'object' or jsonb_typeof(v_act) <> 'array' then raise exception 'Condições ou ações inválidas' using errcode = 'P0200'; end if;
  v_allowed := case v_trig when 'COMMENT_KEYWORD' then array['PRIVATE_REPLY', 'ADD_TAG', 'CREATE_TASK'] when 'BIRTHDAY' then array['CREATE_TASK', 'ADD_TAG'] when 'INACTIVITY' then array['CREATE_TASK', 'ADD_TAG']
                            else array['SEND_TEXT', 'ADD_TAG', 'CREATE_TASK', 'HANDOFF'] end;
  v_cool := coalesce(nullif(p ->> 'cooldown_days', '')::int, case v_trig when 'BIRTHDAY' then 300 when 'INACTIVITY' then 60 when 'CTWA_REFERRAL' then 30 when 'STORY_MENTION' then 7 when 'COMMENT_KEYWORD' then 0 else 1 end);
  if v_cool not between 0 and 365 then raise exception 'O intervalo vai de 0 a 365 dias' using errcode = 'P0200'; end if;

  if v_trig in ('KEYWORD', 'COMMENT_KEYWORD') then
    if jsonb_typeof(coalesce(v_cond -> 'keywords', '[]')) <> 'array' or jsonb_array_length(coalesce(v_cond -> 'keywords', '[]')) > 20 then raise exception 'Informe até 20 palavras-chave' using errcode = 'P0200'; end if;
    if v_trig = 'KEYWORD' and jsonb_array_length(coalesce(v_cond -> 'keywords', '[]')) = 0 then raise exception 'Informe ao menos uma palavra-chave' using errcode = 'P0200'; end if;
    for k in select jsonb_array_elements_text(coalesce(v_cond -> 'keywords', '[]')) loop
      if length(trim(private.kw_text(k))) not between 2 and 40 then raise exception 'Cada palavra-chave tem de 2 a 40 letras ou números' using errcode = 'P0200'; end if;
    end loop;
    v_cond := jsonb_build_object('keywords', coalesce(v_cond -> 'keywords', '[]'));
  elsif v_trig = 'BIRTHDAY' then
    v_days := coalesce(nullif(v_cond ->> 'days_before', '')::int, 0);
    if v_days not between 0 and 30 then raise exception 'Avisar de 0 a 30 dias antes do aniversário' using errcode = 'P0200'; end if;
    v_cond := jsonb_build_object('days_before', v_days);
  elsif v_trig = 'INACTIVITY' then
    v_days := coalesce(nullif(v_cond ->> 'days', '')::int, 60);
    if v_days not between 15 and 720 then raise exception 'Cliente parada há 15 a 720 dias' using errcode = 'P0200'; end if;
    v_cond := jsonb_build_object('days', v_days);
  else
    v_cond := '{}';
  end if;

  if v_acc is not null then
    select * into ca from omni.channel_accounts where id = v_acc and org_id = v_org;
    if ca.id is null then raise exception 'Canal inválido' using errcode = 'P0200'; end if;
    if v_trig in ('BIRTHDAY', 'INACTIVITY') then raise exception 'Rotinas diárias não dependem de canal' using errcode = 'P0200'; end if;
    if (v_trig in ('STORY_MENTION', 'COMMENT_KEYWORD') and ca.channel <> 'INSTAGRAM') or (v_trig = 'CTWA_REFERRAL' and ca.channel <> 'WHATSAPP') then raise exception 'Este gatilho não existe nesse canal' using errcode = 'P0200'; end if;
  end if;

  if jsonb_array_length(v_act) not between 1 and 4 then raise exception 'Defina de 1 a 4 ações' using errcode = 'P0200'; end if;
  for x in select * from jsonb_array_elements(v_act) loop
    if jsonb_typeof(x) <> 'object' or not (x ->> 'type' = any (v_allowed)) then raise exception 'Ação % não vale para este gatilho', coalesce(x ->> 'type', '?') using errcode = 'P0200'; end if;
    case x ->> 'type'
      when 'SEND_TEXT', 'PRIVATE_REPLY' then
        v_n_send := v_n_send + 1;
        if length(trim(coalesce(x ->> 'text', ''))) not between 2 and 1000 then raise exception 'O texto da resposta tem de 2 a 1000 caracteres' using errcode = 'P0200'; end if;
      when 'ADD_TAG' then
        if coalesce(x ->> 'tag', '') !~ '^[a-z0-9][a-z0-9_-]{1,29}$' then raise exception 'Etiqueta: 2 a 30 letras minúsculas, números, _ ou -' using errcode = 'P0200'; end if;
      when 'CREATE_TASK' then
        if length(trim(coalesce(x ->> 'title', ''))) not between 2 and 140 then raise exception 'O título da tarefa tem de 2 a 140 caracteres' using errcode = 'P0200'; end if;
        if coalesce((x ->> 'due_in_hours')::int, 24) not between 0 and 720 then raise exception 'O prazo da tarefa vai de 0 a 720 horas' using errcode = 'P0200'; end if;
      when 'HANDOFF' then
        null;
      else
        raise exception 'Ação inválida' using errcode = 'P0200';
    end case;
  end loop;
  if v_n_send > 1 then raise exception 'Uma automação manda no máximo uma resposta' using errcode = 'P0200'; end if;

  if v_id is null then
    insert into omni.automations (org_id, name, trigger, channel_account_id, conditions, actions, cooldown_days, priority, created_by)
    values (v_org, v_name, v_trig, v_acc, v_cond, v_act, v_cool, coalesce(nullif(p ->> 'priority', '')::int, 100), private.member_id()) returning * into a;
  else
    update omni.automations set name = v_name, trigger = v_trig, channel_account_id = v_acc, conditions = v_cond, actions = v_act, cooldown_days = v_cool, priority = coalesce(nullif(p ->> 'priority', '')::int, priority)
    where id = v_id and org_id = v_org returning * into a;
    if a.id is null then raise exception 'Automação não encontrada' using errcode = 'P0202'; end if;
  end if;
  return a;
end $$;

create or replace function omni.set_automation_active(p_id uuid, p_active boolean) returns omni.automations
language plpgsql security definer set search_path = '' as $$
declare a omni.automations;
begin
  perform private.require_perm('omni.write');
  update omni.automations set active = p_active where id = p_id and org_id = private.org_id() returning * into a;
  if a.id is null then raise exception 'Automação não encontrada' using errcode = 'P0202'; end if;
  return a;
end $$;

create or replace function omni.delete_automation(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('omni.write');
  delete from omni.automations where id = p_id and org_id = private.org_id();
  if not found then raise exception 'Automação não encontrada' using errcode = 'P0202'; end if;
end $$;

-- "Esta frase dispararia a regra?" (teste na tela, sem executar nada)
create or replace function omni.test_automation(p_id uuid, p_text text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare a omni.automations;
begin
  perform private.require_perm('omni.read');
  select * into a from omni.automations where id = p_id and org_id = private.org_id();
  if a.id is null then raise exception 'Automação não encontrada' using errcode = 'P0202'; end if;
  if a.trigger not in ('KEYWORD', 'COMMENT_KEYWORD') then raise exception 'Só regras de palavra-chave se testam com texto' using errcode = 'P0201'; end if;
  return private.kw_match(p_text, a.conditions -> 'keywords');
end $$;

-- ---------------------------------------------------------------------
-- 2) Execução das ações (interna)
-- ---------------------------------------------------------------------
create or replace function private.automation_actions(a omni.automations, p_party uuid, p_conv uuid, p_msg uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  x jsonb; v_out jsonb := '[]'; v_first text; m omni.messages; cv omni.conversations; v_id uuid; v_comment text; v_assignee uuid; v_sent boolean := false; v_reason text;
begin
  select split_part(display_name, ' ', 1) into v_first from crm.parties where id = p_party;
  select relationship_owner_member_id into v_assignee from crm.parties where id = p_party;
  if p_conv is not null then select * into cv from omni.conversations where id = p_conv; v_assignee := coalesce(cv.assignee_member_id, v_assignee); end if;
  if p_msg is not null then select * into m from omni.messages where id = p_msg; end if;
  for x in select * from jsonb_array_elements(a.actions) loop
    case x ->> 'type'
      when 'SEND_TEXT' then
        v_id := omni.queue_system_message(p_conv, replace(x ->> 'text', '{nome}', coalesce(nullif(v_first, ''), '')));
        if v_id is null then v_out := v_out || jsonb_build_object('type', 'SEND_TEXT', 'skipped', 'WINDOW_CLOSED'); else v_out := v_out || jsonb_build_object('type', 'SEND_TEXT', 'message_id', v_id); v_sent := true; end if;
      when 'PRIVATE_REPLY' then
        v_comment := m.payload ->> 'comment_id';
        v_reason := case when m.type is distinct from 'COMMENT' or v_comment is null then 'NOT_A_COMMENT'
                         when m.created_at < now() - interval '7 days' then 'COMMENT_TOO_OLD'
                         when exists (select 1 from omni.messages o where o.conversation_id = p_conv and o.payload ->> 'reply_to_comment_id' = v_comment) then 'ALREADY_REPLIED' end;
        if v_reason is not null then
          v_out := v_out || jsonb_build_object('type', 'PRIVATE_REPLY', 'skipped', v_reason);
        else
          insert into omni.messages (org_id, conversation_id, channel_account_id, direction, author_type, type, body, status, client_dedupe_key, payload)
          values (m.org_id, p_conv, m.channel_account_id, 'OUT', 'SYSTEM', 'TEXT', replace(x ->> 'text', '{nome}', coalesce(nullif(v_first, ''), '')), 'QUEUED', 'pr:' || v_comment, jsonb_build_object('reply_to_comment_id', v_comment, 'send_mode', 'PRIVATE_REPLY'))
          returning id into v_id;
          perform private.enqueue('outbound_messages', jsonb_build_object('message_id', v_id, 'org_id', m.org_id));
          v_out := v_out || jsonb_build_object('type', 'PRIVATE_REPLY', 'message_id', v_id); v_sent := true;
        end if;
      when 'ADD_TAG' then
        update crm.parties set tags = array(select distinct unnest(tags || array[x ->> 'tag'])) where id = p_party;
        if p_conv is not null then update omni.conversations set tags = array(select distinct unnest(tags || array[x ->> 'tag'])) where id = p_conv; end if;
        v_out := v_out || jsonb_build_object('type', 'ADD_TAG', 'tag', x ->> 'tag');
      when 'CREATE_TASK' then
        insert into crm.tasks (org_id, party_id, assignee_member_id, type, title, body, suggested_message, due_at, source_rule)
        values (a.org_id, p_party, v_assignee, case a.trigger when 'BIRTHDAY' then 'BIRTHDAY' when 'INACTIVITY' then 'REACTIVATION' else 'FOLLOW_UP' end,
                replace(x ->> 'title', '{nome}', coalesce(nullif(v_first, ''), '')), nullif(x ->> 'body', ''), nullif(replace(coalesce(x ->> 'suggested_message', ''), '{nome}', coalesce(nullif(v_first, ''), '')), ''),
                now() + make_interval(hours => coalesce((x ->> 'due_in_hours')::int, 24)), 'automation:' || a.id)
        returning id into v_id;
        v_out := v_out || jsonb_build_object('type', 'CREATE_TASK', 'task_id', v_id);
      when 'HANDOFF' then
        if cv.id is not null and cv.mode not in ('WAITING_HUMAN', 'HUMAN') then
          perform set_config('sie.mode_trigger', 'AUTOMATION', true);
          update omni.conversations set mode = 'WAITING_HUMAN', sla_due_at = now() + interval '15 minutes' where id = cv.id;
          update omni.mode_events set reason = left('Automação: ' || a.name, 200) where id = (select max(id) from omni.mode_events where conversation_id = cv.id);
          perform core.notify(a.org_id, 'HANDOFF', 'Automação chamou uma pessoa: ' || a.name, jsonb_build_object('conversation_id', cv.id), case when cv.assignee_member_id is null then 'omni.write' end, cv.assignee_member_id);
          v_out := v_out || jsonb_build_object('type', 'HANDOFF');
        else
          v_out := v_out || jsonb_build_object('type', 'HANDOFF', 'skipped', 'ALREADY_WITH_PEOPLE');
        end if;
      else null;
    end case;
  end loop;
  return jsonb_build_object('actions', v_out, 'replied', v_sent);
end $$;

-- Roda as automações de uma mensagem recebida (worker chama depois de gravar a mensagem). p_referral: dados do anúncio quando a conversa nasceu de um clique.
create or replace function omni.run_automations(p_message uuid, p_referral jsonb default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  m omni.messages; cv omni.conversations; a omni.automations; v_match boolean; v_res jsonb; v_ran int := 0; v_replied boolean := false;
begin
  select * into m from omni.messages where id = p_message;
  if m.id is null or m.direction <> 'IN' then return jsonb_build_object('ran', 0); end if;
  select * into cv from omni.conversations where id = m.conversation_id;
  for a in select * from omni.automations where org_id = m.org_id and active and trigger in ('KEYWORD', 'CTWA_REFERRAL', 'STORY_MENTION', 'COMMENT_KEYWORD')
             and (channel_account_id is null or channel_account_id = m.channel_account_id) order by priority, created_at loop
    v_match := case a.trigger
      when 'KEYWORD' then m.type = 'TEXT' and private.kw_match(m.body, a.conditions -> 'keywords')
      when 'CTWA_REFERRAL' then p_referral is not null
      when 'STORY_MENTION' then m.type = 'STORY_MENTION'
      when 'COMMENT_KEYWORD' then m.type = 'COMMENT' and private.kw_match(m.body, a.conditions -> 'keywords') end;
    continue when not coalesce(v_match, false);
    if v_replied and exists (select 1 from jsonb_array_elements(a.actions) z where z ->> 'type' in ('SEND_TEXT', 'PRIVATE_REPLY')) then
      insert into omni.automation_runs (org_id, automation_id, conversation_id, party_id, message_id, status, reason) values (a.org_id, a.id, cv.id, cv.party_id, m.id, 'SKIPPED', 'ALREADY_REPLIED');
      continue;
    end if;
    if a.cooldown_days > 0 and exists (select 1 from omni.automation_runs r where r.automation_id = a.id and r.party_id = cv.party_id and r.status = 'DONE' and r.created_at > now() - make_interval(days => a.cooldown_days)) then
      insert into omni.automation_runs (org_id, automation_id, conversation_id, party_id, message_id, status, reason) values (a.org_id, a.id, cv.id, cv.party_id, m.id, 'SKIPPED', 'COOLDOWN');
      continue;
    end if;
    begin
      v_res := private.automation_actions(a, cv.party_id, cv.id, m.id);
    exception when others then
      insert into omni.automation_runs (org_id, automation_id, conversation_id, party_id, message_id, status, reason) values (a.org_id, a.id, cv.id, cv.party_id, m.id, 'FAILED', left(sqlerrm, 300));
      continue;
    end;
    insert into omni.automation_runs (org_id, automation_id, conversation_id, party_id, message_id, status, detail) values (a.org_id, a.id, cv.id, cv.party_id, m.id, 'DONE', v_res);
    update omni.automations set last_run_at = now() where id = a.id;
    v_ran := v_ran + 1;
    if coalesce((v_res ->> 'replied')::boolean, false) then
      v_replied := true;
      update omni.messages set payload = payload || jsonb_build_object('automation_handled', true) where id = m.id;       -- a IA não responde de novo a esta mensagem
    end if;
  end loop;
  return jsonb_build_object('ran', v_ran, 'replied', v_replied);
end $$;

-- ---------------------------------------------------------------------
-- 3) Rotinas diárias: aniversário (daqui a N dias) e cliente parada — só criam tarefa/etiqueta
-- ---------------------------------------------------------------------
create or replace function private.run_scheduled_automations() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  a omni.automations; r record; v_n int := 0; v_res jsonb; v_today date := private.today_sp(); v_target date;
begin
  for a in select * from omni.automations where active and trigger in ('BIRTHDAY', 'INACTIVITY') order by org_id, priority loop
    v_target := v_today + coalesce((a.conditions ->> 'days_before')::int, 0);
    for r in
      select p.id as party_id from crm.parties p
      where p.org_id = a.org_id and p.merged_into_id is null and p.anonymized_at is null
        and not exists (select 1 from crm.party_roles rl where rl.party_id = p.id and rl.role in ('EMPLOYEE', 'SUPPLIER', 'SERVICE_PROVIDER', 'CARRIER', 'ACQUIRER', 'BANK'))
        and ((a.trigger = 'BIRTHDAY' and p.birth_date is not null and extract(month from p.birth_date) = extract(month from v_target) and extract(day from p.birth_date) = extract(day from v_target))
          or (a.trigger = 'INACTIVITY' and p.lifecycle_stage in ('CUSTOMER', 'VIP') and p.last_purchase_at is not null
              and p.last_purchase_at < now() - make_interval(days => (a.conditions ->> 'days')::int) and p.last_purchase_at >= now() - make_interval(days => (a.conditions ->> 'days')::int + 30)))
        and not exists (select 1 from omni.automation_runs ar where ar.automation_id = a.id and ar.party_id = p.id and ar.status = 'DONE' and ar.created_at > now() - make_interval(days => a.cooldown_days))
      order by p.lead_score desc limit 200
    loop
      begin
        v_res := private.automation_actions(a, r.party_id, null, null);
      exception when others then
        insert into omni.automation_runs (org_id, automation_id, party_id, status, reason) values (a.org_id, a.id, r.party_id, 'FAILED', left(sqlerrm, 300));
        continue;
      end;
      insert into omni.automation_runs (org_id, automation_id, party_id, status, detail) values (a.org_id, a.id, r.party_id, 'DONE', v_res);
      v_n := v_n + 1;
    end loop;
    update omni.automations set last_run_at = now() where id = a.id;
  end loop;
  return v_n;
end $$;

select cron.schedule('sie-automations-daily', '0 11 * * *', $$ select private.run_scheduled_automations() $$);      -- 08:00 BRT

-- Limpeza: o histórico de execuções guarda 90 dias
create or replace function private.purge_automation_runs() returns integer
language sql security definer set search_path = '' as $$
  with d as (delete from omni.automation_runs where created_at < now() - interval '90 days' returning 1) select count(*)::int from d
$$;
select cron.schedule('sie-purge-automation-runs', '15 6 * * 0', $$ select private.purge_automation_runs() $$);

insert into private.internal_functions (fqname) values ('private.automation_actions'), ('omni.run_automations'), ('private.run_scheduled_automations'), ('private.purge_automation_runs') on conflict do nothing;
select private.lock_functions();
