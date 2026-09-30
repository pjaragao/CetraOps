-- =====================================================================
-- omni: pipeline de mensagens (ingresso → conversa → IA/humano → envio → status).
-- Tudo aqui é chamado SÓ pelo servidor (Edge Functions e worker, com service_role). A regra de negócio mora no banco:
-- idempotência de webhooks e mensagens, abertura/reabertura de conversa, janela de envio, concorrência otimista
-- entre IA e humano, rascunho × envio × transferência.
-- =====================================================================

-- Ordem de chegada das mensagens: created_at é o horário do provedor (segundos, no WhatsApp) e os balões da IA nascem
-- na mesma transação; sem um desempate monotônico a conversa poderia embaralhar. seq resolve (created_at, seq).
alter table omni.messages add column if not exists seq bigint generated always as identity;
create index if not exists messages_conversation_seq_idx on omni.messages (conversation_id, created_at, seq);

-- Funções internas: só service_role. A lista mora numa tabela para cada migration acrescentar as suas.
create table if not exists private.internal_functions (fqname text primary key);
insert into private.internal_functions (fqname) values
  ('core.next_number'), ('crm.resolve_identity'), ('hr.roll_vacation_status'), ('inv.expire_reservations'),
  ('sales.expire_locker_drops'), ('sales.expire_pending_orders'), ('sales.finalize_order')
on conflict do nothing;

create or replace function private.lock_functions() returns void
language plpgsql security definer set search_path = '' as $$
declare s text; r record;
begin
  foreach s in array array['core', 'crm', 'catalog', 'inv', 'sales', 'fin', 'fiscal', 'omni', 'ai', 'hr', 'comm', 'purch'] loop
    execute format('revoke execute on all functions in schema %I from public, anon', s);
    execute format('grant execute on all functions in schema %I to authenticated, service_role', s);
  end loop;
  for r in select p.oid::regprocedure as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           join private.internal_functions f on f.fqname = n.nspname || '.' || p.proname loop
    execute format('revoke execute on function %s from public, anon, authenticated', r.fn);   -- (funções do schema private nascem executáveis por PUBLIC)
    execute format('grant execute on function %s to service_role', r.fn);
  end loop;
end $$;
revoke execute on function private.lock_functions() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 1) Ingresso do webhook: grava o bruto (idempotente por provider+event_key) e enfileira, na mesma transação
-- ---------------------------------------------------------------------
create or replace function omni.ingest_webhook(p_provider text, p_event_key text, p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_id bigint;
begin
  insert into omni.webhook_events (provider, event_key, payload, signature_valid)
  values (p_provider, p_event_key, p_payload, true)
  on conflict (provider, event_key) do nothing returning id into v_id;
  if v_id is null then return jsonb_build_object('duplicate', true); end if;
  perform private.enqueue('inbound_events', jsonb_build_object('webhook_event_id', v_id, 'provider', p_provider));
  return jsonb_build_object('duplicate', false, 'id', v_id);
end $$;

-- ---------------------------------------------------------------------
-- 2) Evento normalizado → conversa/mensagem
-- p = {kind: MESSAGE|ECHO|STATUS, channel, provider_account_id, external_id, display_name?, phone?, handle?, provider_message_id,
--      type?, body?, payload?, occurred_at?, referral?, status?, error?}
-- ---------------------------------------------------------------------
create or replace function omni.ingest_event(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_kind text := p ->> 'kind';
  ca omni.channel_accounts; idn omni.channel_identities; cv omni.conversations; m omni.messages;
  v_party uuid; v_new boolean := false; v_dup boolean := false; v_contact text; v_type crm.contact_type;
  v_at timestamptz := coalesce((p ->> 'occurred_at')::timestamptz, now());
  v_updated int;
begin
  select * into ca from omni.channel_accounts
  where channel = (p ->> 'channel')::omni.channel and provider_account_id = p ->> 'provider_account_id' and status = 'ACTIVE';
  if ca.id is null then
    raise exception 'Canal %/% não cadastrado ou desativado', p ->> 'channel', p ->> 'provider_account_id' using errcode = 'P0100';
  end if;

  if v_kind = 'STATUS' then
    -- o status só avança (lida não volta para entregue); falha vale sempre
    update omni.messages set
      status = case when (p ->> 'status') = 'FAILED' then 'FAILED' else p ->> 'status' end,
      error = case when (p ->> 'status') = 'FAILED' then p ->> 'error' else error end
    where channel_account_id = ca.id and provider_message_id = p ->> 'provider_message_id' and direction = 'OUT'
      and (p ->> 'status') in ('SENT', 'DELIVERED', 'READ', 'FAILED')
      and ((p ->> 'status') = 'FAILED' or array_position(array['QUEUED', 'SENT', 'DELIVERED', 'READ'], status) < array_position(array['QUEUED', 'SENT', 'DELIVERED', 'READ'], p ->> 'status'));
    get diagnostics v_updated = row_count;
    return jsonb_build_object('kind', 'STATUS', 'updated', v_updated > 0);
  end if;
  if v_kind not in ('MESSAGE', 'ECHO') then raise exception 'Tipo de evento inválido: %', v_kind using errcode = 'P0101'; end if;
  if coalesce(p ->> 'external_id', '') = '' or coalesce(p ->> 'provider_message_id', '') = '' then
    raise exception 'Evento sem external_id ou provider_message_id' using errcode = 'P0101';
  end if;

  perform pg_advisory_xact_lock(hashtext('omni.identity:' || ca.id::text || ':' || (p ->> 'external_id')));

  select * into idn from omni.channel_identities where channel_account_id = ca.id and external_id = p ->> 'external_id';
  if idn.id is null then
    v_type := (case ca.channel when 'WHATSAPP' then 'WHATSAPP' when 'INSTAGRAM' then 'INSTAGRAM' when 'TELEGRAM' then 'TELEGRAM' else 'TIKTOK' end)::crm.contact_type;
    v_contact := coalesce(nullif(p ->> 'phone', ''), nullif(p ->> 'handle', ''),
                          case ca.channel when 'INSTAGRAM' then 'ig:' when 'TELEGRAM' then 'tg:' when 'TIKTOK' then 'tt:' else '' end || (p ->> 'external_id'));
    v_party := crm.resolve_identity(ca.org_id, v_type, v_contact, p ->> 'display_name', case when p ? 'referral' then 'CTWA' else ca.channel::text || '_INBOUND' end);
    update crm.parties set instagram_handle = null where id = v_party and instagram_handle like 'ig:%';
    insert into omni.channel_identities (org_id, channel_account_id, external_id, party_id, profile)
    values (ca.org_id, ca.id, p ->> 'external_id', v_party, jsonb_strip_nulls(jsonb_build_object('display_name', p ->> 'display_name', 'handle', p ->> 'handle')))
    returning * into idn;
    if p ? 'referral' then
      insert into crm.timeline_events (org_id, party_id, kind, source_type, summary, payload)
      values (ca.org_id, v_party, 'AD_REFERRAL', 'omni.channel_accounts', 'Chegou por anúncio (Click-to-WhatsApp)', p -> 'referral');
    end if;
  else
    v_party := idn.party_id;
    if coalesce(p ->> 'display_name', '') <> '' and (idn.profile ->> 'display_name') is distinct from (p ->> 'display_name') then
      update omni.channel_identities set profile = profile || jsonb_build_object('display_name', p ->> 'display_name') where id = idn.id;
    end if;
  end if;

  select * into cv from omni.conversations where channel_identity_id = idn.id and status <> 'CLOSED' for update;
  if cv.id is null then
    insert into omni.conversations (org_id, party_id, channel_account_id, channel_identity_id, mode, persona_id)
    values (ca.org_id, v_party, ca.id, idn.id, ca.default_ai_mode, ca.default_persona_id) returning * into cv;
    v_new := true;
  end if;

  insert into omni.messages (org_id, conversation_id, channel_account_id, direction, author_type, type, body, payload, provider_message_id, status, sent_at, created_at)
  values (ca.org_id, cv.id, ca.id, case v_kind when 'ECHO' then 'OUT' else 'IN' end, case v_kind when 'ECHO' then 'ECHO_FROM_APP' else 'CUSTOMER' end,
          coalesce(p ->> 'type', 'TEXT'), p ->> 'body', coalesce(p -> 'payload', '{}'), p ->> 'provider_message_id',
          case v_kind when 'ECHO' then 'SENT' else 'RECEIVED' end, case v_kind when 'ECHO' then v_at end, v_at)
  on conflict (channel_account_id, provider_message_id) where provider_message_id is not null do nothing
  returning * into m;
  if m.id is null then
    v_dup := true;
    select * into m from omni.messages where channel_account_id = ca.id and provider_message_id = p ->> 'provider_message_id';
  end if;
  select * into cv from omni.conversations where id = cv.id;
  return jsonb_build_object('kind', v_kind, 'conversation_id', cv.id, 'message_id', m.id, 'party_id', v_party, 'new_conversation', v_new,
                            'duplicate', v_dup, 'mode', cv.mode, 'version', cv.version);
end $$;

-- ---------------------------------------------------------------------
-- 3) Roteador: fotografia da conversa para decidir (ou pular quando já não vale)
-- ---------------------------------------------------------------------
create or replace function omni.claim_router(p_conversation uuid, p_message uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  cv omni.conversations; ca omni.channel_accounts; m omni.messages; w record; v_tier text; v_replies int; v_last uuid;
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
  return jsonb_build_object('skip', false, 'org_id', cv.org_id, 'conversation_id', cv.id, 'message_id', m.id, 'mode', cv.mode, 'version', cv.version,
    'party_id', cv.party_id, 'channel', ca.channel, 'persona_id', coalesce(cv.persona_id, ca.default_persona_id), 'tier', v_tier,
    'ai_paused', cv.ai_paused_until is not null and cv.ai_paused_until > now(), 'last_inbound_at', cv.last_inbound_at,
    'window_allowed', coalesce(w.allowed, false), 'window_mode', w.mode, 'ai_replies_last_hour', v_replies,
    'message', jsonb_build_object('id', m.id, 'type', m.type, 'body', m.body, 'transcript', m.transcript, 'created_at', m.created_at));
end $$;

-- ---------------------------------------------------------------------
-- 4) Resultado da IA com concorrência otimista: envia, guarda rascunho ou transfere para humano
-- p = {action: SEND|DRAFT|HANDOFF, messages?: [text...], intent?, stage?, confidence?, needs_human?, flags?: [], reason?,
--      based_on_message_at?, trigger?}
-- ---------------------------------------------------------------------
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
    if cv.mode <> 'AI_AUTOPILOT' then
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
-- 5) Envio: contexto para o sender e atualização do resultado
-- ---------------------------------------------------------------------
create or replace function omni.outbound_context(p_message uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare m omni.messages; cv omni.conversations; ca omni.channel_accounts; idn omni.channel_identities; w record;
begin
  select * into m from omni.messages where id = p_message;
  if m.id is null then return jsonb_build_object('found', false); end if;
  select * into cv from omni.conversations where id = m.conversation_id;
  select * into ca from omni.channel_accounts where id = m.channel_account_id;
  select * into idn from omni.channel_identities where id = cv.channel_identity_id;
  select * into w from omni.check_send_window(cv.id, case m.author_type when 'AI' then 'AI' else 'HUMAN' end);
  return jsonb_build_object('found', true, 'message', jsonb_build_object('id', m.id, 'type', m.type, 'body', m.body, 'status', m.status, 'template_name', m.template_name,
      'payload', m.payload, 'author_type', m.author_type, 'media_path', m.media_path),
    'channel', ca.channel, 'provider_account_id', ca.provider_account_id, 'connection_id', ca.connection_id, 'external_id', idn.external_id,
    'conversation_id', cv.id, 'org_id', m.org_id, 'window_allowed', coalesce(w.allowed, false), 'window_mode', w.mode, 'window_reason', w.reason);
end $$;

create or replace function omni.mark_outbound(p_message uuid, p_status text, p_provider_message_id text default null, p_error text default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_status not in ('SENT', 'FAILED') then raise exception 'Status inválido para o envio' using errcode = 'P0102'; end if;
  update omni.messages set status = p_status, provider_message_id = coalesce(p_provider_message_id, provider_message_id),
         error = case when p_status = 'FAILED' then left(p_error, 500) else null end, sent_at = case when p_status = 'SENT' then now() else sent_at end
  where id = p_message and status in ('QUEUED', 'FAILED');
end $$;

-- ---------------------------------------------------------------------
-- 6) Opt-out ("parar", "sair"): revoga marketing e registra a evidência
-- ---------------------------------------------------------------------
create or replace function omni.record_opt_out(p_party uuid, p_message uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid; pu crm.consent_purpose;
begin
  select org_id into v_org from crm.parties where id = p_party;
  foreach pu in array array['MARKETING_WHATSAPP', 'MARKETING_EMAIL', 'MARKETING_IG']::crm.consent_purpose[] loop
    insert into crm.consents (org_id, party_id, purpose, granted, legal_basis, evidence)
    values (v_org, p_party, pu, false, 'CONSENT', jsonb_build_object('message_id', p_message, 'keyword', true));
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 7) Segredos das integrações (Vault): o servidor lê o JSON guardado sob o nome em secret_ref
-- ---------------------------------------------------------------------
create or replace function core.integration_secret(p_connection uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_ref text; v_secret text;
begin
  select secret_ref into v_ref from core.integration_connections where id = p_connection;
  if v_ref is null then return null; end if;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = v_ref;
  if v_secret is null then return null; end if;
  return case when left(v_secret, 1) = '{' then v_secret::jsonb else jsonb_build_object('token', v_secret) end;
end $$;

insert into private.internal_functions (fqname) values
  ('omni.ingest_webhook'), ('omni.ingest_event'), ('omni.claim_router'), ('omni.apply_ai_result'), ('omni.outbound_context'),
  ('omni.mark_outbound'), ('omni.record_opt_out'), ('core.integration_secret')
on conflict do nothing;

select private.lock_functions();
