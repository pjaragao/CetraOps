-- =====================================================================
-- Atendimento: horário de atendimento de verdade e encerramento com desfecho (plano de marketing e atendimento, Fase 1).
-- • Horário por canal (omni.channel_accounts.business_hours): {"days": {"1": [["09:00","20:00"]], …}, "after_hours_ai": "DRAFT_ONLY"|"SAFE_AUTOPILOT"}.
--   Sem dias cadastrados = sempre aberto (comportamento anterior). O prazo de atendimento (SLA) só corre com a loja aberta;
--   fora do horário a mensagem de espera diz quando a equipe volta e fica uma tarefa para a abertura.
--   "SAFE_AUTOPILOT": fora do horário a IA envia sozinha só respostas informativas (saudação, estoque, produto, medidas, loja, pedido).
-- • Encerrar conversa com desfecho (vendeu, reservou, dúvida resolvida, troca, reclamação, sem retorno, não é cliente, spam),
--   com sugestão automática; conversas paradas há 7 dias são encerradas sozinhas com o desfecho sugerido.
-- Códigos de erro: P0320 dado inválido · P0321 situação não permite · P0322 não encontrado.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Horário
-- ---------------------------------------------------------------------
create or replace function private.valid_business_hours(p jsonb) returns boolean
language plpgsql immutable as $$
declare d text; iv jsonb; s time; e time; prev time;
begin
  if p is null or p = '{}'::jsonb then return true; end if;
  if jsonb_typeof(p) <> 'object' or (p ? 'days' and jsonb_typeof(p -> 'days') <> 'object') then return false; end if;
  if p ? 'after_hours_ai' and p ->> 'after_hours_ai' not in ('DRAFT_ONLY', 'SAFE_AUTOPILOT') then return false; end if;
  for d in select jsonb_object_keys(coalesce(p -> 'days', '{}')) loop
    if d !~ '^[0-6]$' or jsonb_typeof(p -> 'days' -> d) <> 'array' or jsonb_array_length(p -> 'days' -> d) > 3 then return false; end if;
    prev := null;
    for iv in select x from jsonb_array_elements(p -> 'days' -> d) x loop
      begin s := (iv ->> 0)::time; e := (iv ->> 1)::time; exception when others then return false; end;
      if s is null or e is null or e <= s or (prev is not null and s < prev) then return false; end if;   -- faixas no mesmo dia, em ordem, sem sobrepor
      prev := e;
    end loop;
  end loop;
  return true;
end $$;
alter table omni.channel_accounts add constraint channel_business_hours_valid check (private.valid_business_hours(business_hours));

-- Faixas de um dia (no fuso de São Paulo) como intervalos absolutos
create or replace function private.bh_intervals(p_hours jsonb, p_day date) returns table (s timestamptz, e timestamptz)
language sql stable as $$
  select ((p_day + (iv ->> 0)::time)::timestamp at time zone 'America/Sao_Paulo'), ((p_day + (iv ->> 1)::time)::timestamp at time zone 'America/Sao_Paulo')
  from jsonb_array_elements(coalesce(p_hours -> 'days' -> extract(dow from p_day)::int::text, '[]')) iv
$$;

create or replace function private.bh_configured(p_hours jsonb) returns boolean
language sql immutable as $$ select coalesce(p_hours -> 'days', '{}'::jsonb) <> '{}'::jsonb $$;

create or replace function private.channel_is_open(p_ca uuid, p_at timestamptz default now()) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare h jsonb; d date;
begin
  select business_hours into h from omni.channel_accounts where id = p_ca;
  if not private.bh_configured(h) then return true; end if;
  d := (p_at at time zone 'America/Sao_Paulo')::date;
  return exists (select 1 from private.bh_intervals(h, d) i where p_at >= i.s and p_at < i.e);
end $$;

-- Próximo instante com a loja aberta (o próprio instante se já estiver aberta); sem horário cadastrado = agora
create or replace function private.channel_next_open(p_ca uuid, p_at timestamptz default now()) returns timestamptz
language plpgsql stable security definer set search_path = '' as $$
declare h jsonb; d date; k int; r record;
begin
  select business_hours into h from omni.channel_accounts where id = p_ca;
  if not private.bh_configured(h) then return p_at; end if;
  d := (p_at at time zone 'America/Sao_Paulo')::date;
  for k in 0..13 loop
    for r in select * from private.bh_intervals(h, d + k) order by 1 loop
      if p_at < r.e then return greatest(p_at, r.s); end if;
    end loop;
  end loop;
  return null;   -- nenhum dia aberto cadastrado
end $$;

-- Instante em que se completam p_minutes de loja aberta a partir de p_from (prazo do SLA)
create or replace function private.business_add(p_ca uuid, p_from timestamptz, p_minutes int) returns timestamptz
language plpgsql stable security definer set search_path = '' as $$
declare h jsonb; d date; k int; r record; v_left numeric := greatest(p_minutes, 0); v_start timestamptz; v_avail numeric;
begin
  select business_hours into h from omni.channel_accounts where id = p_ca;
  if not private.bh_configured(h) then return p_from + make_interval(mins => p_minutes); end if;
  d := (p_from at time zone 'America/Sao_Paulo')::date;
  for k in 0..20 loop
    for r in select * from private.bh_intervals(h, d + k) order by 1 loop
      continue when r.e <= p_from;
      v_start := greatest(p_from, r.s);
      v_avail := extract(epoch from (r.e - v_start)) / 60;
      if v_avail >= v_left then return v_start + make_interval(secs => v_left * 60); end if;
      v_left := v_left - v_avail;
    end loop;
  end loop;
  return p_from + make_interval(mins => p_minutes);
end $$;

-- "hoje às 9h", "amanhã às 9h30", "segunda às 9h"
create or replace function private.when_label(p_at timestamptz) returns text
language plpgsql stable as $$
declare l timestamp := p_at at time zone 'America/Sao_Paulo'; t date := (now() at time zone 'America/Sao_Paulo')::date; v_h text;
begin
  if p_at is null then return null; end if;
  v_h := extract(hour from l)::int || 'h' || case when extract(minute from l) > 0 then lpad(extract(minute from l)::int::text, 2, '0') else '' end;
  return case when l::date = t then 'hoje às ' when l::date = t + 1 then 'amanhã às '
              else (array['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'])[extract(dow from l)::int + 1] || ' às ' end || v_h;
end $$;

-- O prazo (SLA) gravado por qualquer caminho (IA, automação, ferramenta) passa a contar só o tempo de loja aberta
create or replace function private.sla_business_hours() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_min int;
begin
  if new.sla_due_at is not null and new.sla_due_at is distinct from old.sla_due_at and new.sla_due_at > now() then
    v_min := ceil(extract(epoch from (new.sla_due_at - now())) / 60)::int;
    new.sla_due_at := private.business_add(new.channel_account_id, now(), v_min);
  end if;
  return new;
end $$;
create trigger trg_sla_business_hours before update of sla_due_at on omni.conversations for each row execute function private.sla_business_hours();

create or replace function omni.set_business_hours(p_id uuid, p jsonb) returns omni.channel_accounts
language plpgsql security definer set search_path = '' as $$
declare ca omni.channel_accounts;
begin
  perform private.require_perm('core.admin');
  if not private.valid_business_hours(coalesce(p, '{}')) then raise exception 'Horário inválido: cada faixa precisa terminar depois de começar, no mesmo dia, sem sobrepor' using errcode = 'P0320'; end if;
  update omni.channel_accounts set business_hours = coalesce(p, '{}') where id = p_id and org_id = private.org_id() returning * into ca;
  if ca.id is null then raise exception 'Canal não encontrado' using errcode = 'P0322'; end if;
  return ca;
end $$;

-- Fora do horário: deixa uma tarefa para a abertura (uma por conversa enquanto estiver aberta)
create or replace function omni.after_hours_followup(p_conversation uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare cv omni.conversations; v_at timestamptz; v_id uuid; v_name text;
begin
  select * into cv from omni.conversations where id = p_conversation;
  if cv.id is null or private.channel_is_open(cv.channel_account_id, now()) then return null; end if;
  select id into v_id from crm.tasks where source_rule = 'after_hours:' || cv.id and status = 'OPEN';
  if v_id is not null then return v_id; end if;
  v_at := coalesce(private.channel_next_open(cv.channel_account_id, now()), now() + interval '12 hours');
  select display_name into v_name from crm.parties where id = cv.party_id;
  insert into crm.tasks (org_id, party_id, assignee_member_id, type, title, body, due_at, source_rule, created_by_ai)
  values (cv.org_id, cv.party_id, cv.assignee_member_id, 'FOLLOW_UP', 'Responder ' || coalesce(split_part(v_name, ' ', 1), 'cliente') || ' (escreveu fora do horário)',
          coalesce(cv.summary, 'Abra a conversa: a IA deixou rascunho ou chamou uma pessoa.'), v_at, 'after_hours:' || cv.id, true)
  returning id into v_id;
  return v_id;
end $$;

-- Roteador: além do que já devolvia, se a loja está aberta, quando abre e o que a IA pode fazer fora do horário
create or replace function omni.claim_router(p_conversation uuid, p_message uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  cv omni.conversations; ca omni.channel_accounts; m omni.messages; w record; v_tier text; v_replies int; v_last uuid; v_open boolean; v_next timestamptz;
begin
  select * into cv from omni.conversations where id = p_conversation;
  if cv.id is null then return jsonb_build_object('skip', true, 'reason', 'conversation_not_found'); end if;
  select * into m from omni.messages where id = p_message;
  select id into v_last from omni.messages where conversation_id = cv.id and direction = 'IN' order by created_at desc, seq desc limit 1;
  if v_last is distinct from p_message then return jsonb_build_object('skip', true, 'reason', 'newer_message'); end if;
  if cv.status = 'CLOSED' then return jsonb_build_object('skip', true, 'reason', 'closed'); end if;
  select * into ca from omni.channel_accounts where id = cv.channel_account_id;
  select tier::text into v_tier from crm.parties where id = cv.party_id;
  select * into w from omni.check_send_window(cv.id, 'AI');
  select count(*) into v_replies from omni.messages where conversation_id = cv.id and direction = 'OUT' and author_type = 'AI' and created_at > now() - interval '1 hour';
  v_open := private.channel_is_open(ca.id, now());
  v_next := case when v_open then null else private.channel_next_open(ca.id, now()) end;
  return jsonb_build_object('skip', false, 'org_id', cv.org_id, 'conversation_id', cv.id, 'message_id', m.id, 'mode', cv.mode, 'version', cv.version,
    'party_id', cv.party_id, 'channel', ca.channel, 'persona_id', coalesce(cv.persona_id, ca.default_persona_id), 'tier', v_tier,
    'ai_paused', cv.ai_paused_until is not null and cv.ai_paused_until > now(), 'last_inbound_at', cv.last_inbound_at,
    'window_allowed', coalesce(w.allowed, false), 'window_mode', w.mode, 'ai_replies_last_hour', v_replies, 'instruction', cv.ai_instruction,
    'is_open', v_open, 'next_open_at', v_next, 'next_open_label', private.when_label(v_next),
    'after_hours_ai', coalesce(ca.business_hours ->> 'after_hours_ai', 'DRAFT_ONLY'),
    'message', jsonb_build_object('id', m.id, 'type', m.type, 'body', m.body, 'transcript', m.transcript, 'created_at', m.created_at));
end $$;

-- Resultado da IA: o banco também garante a exceção de fora do horário (o worker não decide sozinho)
create or replace function omni.apply_ai_result(p_conversation uuid, p_expected_version int, p_run uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  cv omni.conversations; v_action text := p ->> 'action'; b text; i int := 0; w record; v_tier text; v_ids uuid[] := '{}'; m omni.messages; d omni.message_drafts;
begin
  select * into cv from omni.conversations where id = p_conversation for update;
  if cv.id is null then raise exception 'Conversa não encontrada' using errcode = 'P0002'; end if;
  if cv.version <> p_expected_version or cv.mode = 'HUMAN' or cv.status = 'CLOSED' or (cv.ai_paused_until is not null and cv.ai_paused_until > now()) then
    update ai.runs set status = 'DISCARDED', error = 'a conversa mudou durante a execução' where id = p_run;
    return jsonb_build_object('applied', false, 'reason', 'conversation_changed');
  end if;
  if (p ->> 'based_on_message_at') is not null and cv.last_inbound_at > (p ->> 'based_on_message_at')::timestamptz then
    update ai.runs set status = 'DISCARDED', error = 'chegou mensagem mais nova' where id = p_run;
    return jsonb_build_object('applied', false, 'reason', 'newer_message');
  end if;
  if v_action not in ('SEND', 'DRAFT', 'HANDOFF') then raise exception 'Ação inválida: %', v_action using errcode = 'P0102'; end if;

  if v_action = 'SEND' then
    -- envio sozinho: modo piloto, ou copiloto fora do horário com o canal em "SAFE_AUTOPILOT" e resposta só informativa
    if cv.mode <> 'AI_AUTOPILOT' and not (cv.mode = 'AI_COPILOT' and not private.channel_is_open(cv.channel_account_id, now())
         and (select business_hours ->> 'after_hours_ai' from omni.channel_accounts where id = cv.channel_account_id) = 'SAFE_AUTOPILOT'
         and upper(coalesce(p ->> 'intent', '')) in ('GREETING', 'STOCK', 'PRODUCT_INFO', 'SIZE_GUIDE', 'STORE_INFO', 'ORDER_STATUS')) then
      update ai.runs set status = 'DISCARDED', error = 'envio automático fora do modo autopiloto' where id = p_run;
      return jsonb_build_object('applied', false, 'reason', 'not_autopilot');
    end if;
    select * into w from omni.check_send_window(cv.id, 'AI');
    if not w.allowed then
      update ai.runs set status = 'DISCARDED', error = w.reason where id = p_run;
      return jsonb_build_object('applied', false, 'reason', 'window_closed', 'detail', w.reason);
    end if;
    if jsonb_array_length(coalesce(p -> 'messages', '[]')) = 0 or jsonb_array_length(p -> 'messages') > 3 then
      raise exception 'A resposta precisa ter de 1 a 3 mensagens' using errcode = 'P0102';
    end if;
    for b in select jsonb_array_elements_text(p -> 'messages') loop
      insert into omni.messages (org_id, conversation_id, channel_account_id, direction, author_type, ai_run_id, body, status, client_dedupe_key, payload)
      values (cv.org_id, cv.id, cv.channel_account_id, 'OUT', 'AI', p_run, b, 'QUEUED', p_run::text || ':' || i, jsonb_build_object('send_mode', w.mode))
      on conflict (client_dedupe_key) where client_dedupe_key is not null do nothing returning * into m;
      if m.id is not null then
        perform private.enqueue('outbound_messages', jsonb_build_object('message_id', m.id, 'org_id', cv.org_id), i * 3);
        v_ids := v_ids || m.id;
      end if;
      m := null; i := i + 1;
    end loop;
  elsif v_action = 'DRAFT' then
    update omni.message_drafts set status = 'SUPERSEDED' where conversation_id = cv.id and status = 'PENDING';
    insert into omni.message_drafts (org_id, conversation_id, ai_run_id, variants, intent, stage, confidence, needs_human, flags)
    values (cv.org_id, cv.id, p_run, jsonb_build_array(jsonb_build_object('messages', coalesce(p -> 'messages', '[]'))), p ->> 'intent', p ->> 'stage',
            (p ->> 'confidence')::numeric, coalesce((p ->> 'needs_human')::boolean, false), coalesce(array(select jsonb_array_elements_text(coalesce(p -> 'flags', '[]'))), '{}'))
    returning * into d;
  else
    select tier::text into v_tier from crm.parties where id = cv.party_id;
    perform set_config('sie.mode_trigger', coalesce(p ->> 'trigger', 'AI_REQUEST_HANDOFF'), true);
    update omni.conversations set mode = 'WAITING_HUMAN', sla_due_at = now() + case when v_tier in ('VIP', 'VIP_BLACK') then interval '5 minutes' else interval '15 minutes' end
    where id = cv.id;
    update omni.mode_events set reason = p ->> 'reason' where id = (select max(id) from omni.mode_events where conversation_id = cv.id);
    update omni.message_drafts set status = 'SUPERSEDED' where conversation_id = cv.id and status = 'PENDING';
  end if;

  update omni.conversations set intent = coalesce(p ->> 'intent', intent), pending_ai_at = null where id = cv.id;
  update ai.runs set status = 'OK', confidence = (p ->> 'confidence')::numeric where id = p_run;
  return jsonb_build_object('applied', true, 'action', v_action, 'message_ids', to_jsonb(v_ids), 'draft_id', d.id);
end $$;

-- ---------------------------------------------------------------------
-- 2) Desfecho ao encerrar
-- ---------------------------------------------------------------------
alter table omni.conversations add column if not exists outcome text
  check (outcome is null or outcome in ('PURCHASED', 'RESERVED', 'RESOLVED', 'EXCHANGE', 'COMPLAINT', 'NO_REPLY', 'NOT_CUSTOMER', 'SPAM'));
alter table omni.conversations add column if not exists outcome_note text;
alter table omni.conversations add column if not exists outcome_source text check (outcome_source is null or outcome_source in ('HUMAN', 'AUTO'));
alter table omni.conversations add column if not exists closed_by uuid references core.members(id);

-- O que provavelmente aconteceu, olhando os fatos da conversa
create or replace function omni.suggest_outcome(p_conversation uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
declare cv omni.conversations; v_last_dir text; v_last_at timestamptz;
  v_paid text[] := array['PAID', 'COMPLETED', 'FULFILLING', 'READY_FOR_PICKUP', 'SHIPPED', 'PARTIALLY_RETURNED'];
begin
  select * into cv from omni.conversations where id = p_conversation and (private.org_id() is null or org_id = private.org_id());   -- rotina noturna roda sem org
  if cv.id is null then return null; end if;
  if exists (select 1 from sales.orders o where o.party_id = cv.party_id and o.created_at >= cv.created_at and o.status::text = any (v_paid)) then return 'PURCHASED'; end if;
  if exists (select 1 from inv.reservations r where r.party_id = cv.party_id and r.created_at >= cv.created_at and r.status = 'ACTIVE') then return 'RESERVED'; end if;
  if cv.intent in ('COMPLAINT', 'PAYMENT_PROBLEM') or exists (select 1 from omni.mode_events e where e.conversation_id = cv.id and e.trigger = 'POLICY') then return 'COMPLAINT'; end if;
  if cv.intent = 'EXCHANGE_DEFECT' or 'troca' = any (cv.tags) then return 'EXCHANGE'; end if;
  select direction, created_at into v_last_dir, v_last_at from omni.messages where conversation_id = cv.id order by created_at desc, seq desc limit 1;
  if v_last_dir = 'OUT' and v_last_at < now() - interval '48 hours' then return 'NO_REPLY'; end if;
  return 'RESOLVED';
end $$;

create or replace function omni.close_conversation(p_conversation uuid, p_outcome text, p_note text default null) returns omni.conversations
language plpgsql security definer set search_path = '' as $$
declare c omni.conversations;
  lbl constant jsonb := '{"PURCHASED":"comprou","RESERVED":"reservou","RESOLVED":"dúvida resolvida","EXCHANGE":"troca ou devolução","COMPLAINT":"reclamação","NO_REPLY":"sem retorno","NOT_CUSTOMER":"não é cliente","SPAM":"spam"}';
begin
  perform private.require_perm('omni.write');
  c := private.conversation_for_update(p_conversation);
  if c.status = 'CLOSED' then raise exception 'A conversa já está encerrada' using errcode = 'P0321'; end if;
  if not lbl ? coalesce(p_outcome, '') then raise exception 'Escolha o desfecho' using errcode = 'P0320'; end if;
  update omni.conversations set status = 'CLOSED', outcome = p_outcome, outcome_note = nullif(left(trim(coalesce(p_note, '')), 300), ''), outcome_source = 'HUMAN',
         closed_by = private.member_id(), unread_count = 0
  where id = c.id returning * into c;
  update omni.message_drafts set status = 'SUPERSEDED' where conversation_id = c.id and status = 'PENDING';
  perform private.timeline(c.org_id, c.party_id, 'CONVERSATION_CLOSED', 'omni.conversations', c.id,
    'Conversa encerrada: ' || (lbl ->> p_outcome) || coalesce(' — ' || c.outcome_note, ''), jsonb_build_object('outcome', p_outcome));
  return c;
end $$;

-- Conversas paradas há 7 dias (sem ninguém esperando pessoa) fecham sozinhas com o desfecho sugerido
create or replace function private.auto_close_idle_conversations() returns integer
language plpgsql security definer set search_path = '' as $$
declare r record; n int := 0; v_out text;
begin
  for r in select cv.id, cv.org_id, cv.party_id from omni.conversations cv
           where cv.status = 'OPEN' and cv.mode <> 'WAITING_HUMAN' and coalesce(cv.last_message_at, cv.created_at) < now() - interval '7 days' limit 500 loop
    v_out := omni.suggest_outcome(r.id);
    update omni.conversations set status = 'CLOSED', outcome = v_out, outcome_source = 'AUTO' where id = r.id;
    update omni.message_drafts set status = 'SUPERSEDED' where conversation_id = r.id and status = 'PENDING';
    perform private.timeline(r.org_id, r.party_id, 'CONVERSATION_CLOSED', 'omni.conversations', r.id, 'Conversa encerrada automaticamente após 7 dias parada', jsonb_build_object('outcome', v_out, 'auto', true));
    n := n + 1;
  end loop;
  return n;
end $$;
select cron.schedule('sie-auto-close-conversations', '45 6 * * *', $$ select private.auto_close_idle_conversations() $$);   -- 03:45 BRT

-- Desfechos no período (Atendimento › Desempenho)
create or replace function omni.outcomes(p_from timestamptz, p_to timestamptz) returns table (outcome text, source text, conversations int)
language sql stable security definer set search_path = '' as $$
  select coalesce(cv.outcome, 'SEM_DESFECHO'), coalesce(cv.outcome_source, '—'), count(*)::int
  from omni.conversations cv
  where cv.org_id = private.org_id() and (select private.has_perm('omni.read')) and cv.status = 'CLOSED' and cv.closed_at >= p_from and cv.closed_at < p_to
  group by 1, 2 order by 3 desc
$$;

insert into private.internal_functions (fqname) values
  ('private.channel_is_open'), ('private.channel_next_open'), ('private.business_add'), ('private.sla_business_hours'), ('private.auto_close_idle_conversations'),
  ('omni.after_hours_followup')
on conflict do nothing;
select private.lock_functions();
