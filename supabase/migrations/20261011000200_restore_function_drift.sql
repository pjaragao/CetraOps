-- =====================================================================
-- Realinha o banco de produção com o repositório: 4 funções estavam na versão antiga porque migrations antigas foram editadas depois
-- de aplicadas (troca de nome do produto) e reexecutadas à mão, desfazendo patches posteriores. Aqui ficam as versões finais do repositório:
--   fin.approve_title              aprovar título volta a lançar a provisão contábil (private.post_title_accrual)
--   omni.claim_router              informa ao roteador se o canal está aberto e o próximo horário (atendimento fora do horário)
--   omni.apply_ai_result           copiloto fora do horário com canal em SAFE_AUTOPILOT responde sozinho só perguntas informativas
--   private.ensure_initial_admin   nome do papel de acesso total ("Administrador(a) — acesso total")
-- Em banco novo (migrations do zero) nada muda: as definições são as mesmas.
-- =====================================================================
CREATE OR REPLACE FUNCTION fin.approve_title(p_title uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.require_perm('fin.approve');
  update fin.titles set approval_status = 'APPROVED', approved_by = private.member_id(), approved_at = now()
  where id = p_title and org_id = private.org_id() and approval_status = 'DRAFT';
  if found then perform private.post_title_accrual(p_title); end if;
end $function$

;

CREATE OR REPLACE FUNCTION omni.claim_router(p_conversation uuid, p_message uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
end $function$

;

CREATE OR REPLACE FUNCTION omni.apply_ai_result(p_conversation uuid, p_expected_version integer, p_run uuid, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    perform set_config('centralops.mode_trigger', coalesce(p ->> 'trigger', 'AI_REQUEST_HANDOFF'), true);
    update omni.conversations set mode = 'WAITING_HUMAN', sla_due_at = now() + case when v_tier in ('VIP', 'VIP_BLACK') then interval '5 minutes' else interval '15 minutes' end
    where id = cv.id;
    update omni.mode_events set reason = p ->> 'reason' where id = (select max(id) from omni.mode_events where conversation_id = cv.id);
    update omni.message_drafts set status = 'SUPERSEDED' where conversation_id = cv.id and status = 'PENDING';
  end if;

  update omni.conversations set intent = coalesce(p ->> 'intent', intent), pending_ai_at = null where id = cv.id;
  update ai.runs set status = 'OK', confidence = (p ->> 'confidence')::numeric where id = p_run;
  return jsonb_build_object('applied', true, 'action', v_action, 'message_ids', to_jsonb(v_ids), 'draft_id', d.id);
end $function$

;

CREATE OR REPLACE FUNCTION private.ensure_initial_admin(p_email text, p_password_hash text, p_org uuid DEFAULT '00000000-0000-4000-8000-000000000001'::uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_email text := lower(trim(p_email)); v_user uuid; v_member uuid; v_role uuid; v_store uuid; v_has_owner boolean;
begin
  if not exists (select 1 from core.orgs where id = p_org) then return 'NO_ORG'; end if;
  select exists (select 1 from core.members m join core.member_roles mr on mr.member_id = m.id join core.roles r on r.id = mr.role_id
                 where m.org_id = p_org and m.status = 'ACTIVE' and r.is_superuser) into v_has_owner;
  select id into v_user from auth.users where lower(email) = v_email;
  if v_user is not null then select id into v_member from core.members where user_id = v_user; end if;
  if v_has_owner and (v_user is null or v_member is not null) then return 'OK'; end if;   -- já há como entrar

  select id into v_role from core.roles where org_id = p_org and is_superuser order by key = 'owner' desc limit 1;
  if v_role is null then
    insert into core.roles (org_id, key, name, is_superuser) values (p_org, 'owner', 'Administrador(a) — acesso total', true) returning id into v_role;
  end if;
  select id into v_store from core.stores where org_id = p_org order by status = 'ACTIVE' desc, created_at limit 1;

  if v_user is null then
    v_user := gen_random_uuid();
    insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                            confirmation_token, recovery_token, email_change, email_change_token_new)
    values ('00000000-0000-0000-0000-000000000000', v_user, 'authenticated', 'authenticated', v_email, p_password_hash, now(),
            '{"provider": "email", "providers": ["email"]}', '{}', now(), now(), '', '', '', '');
  else
    update auth.users set encrypted_password = p_password_hash, email_confirmed_at = coalesce(email_confirmed_at, now()), banned_until = null, updated_at = now() where id = v_user;
  end if;
  if not exists (select 1 from auth.identities where user_id = v_user and provider = 'email') then
    insert into auth.identities (id, user_id, provider_id, identity_data, provider, created_at, updated_at)
    values (gen_random_uuid(), v_user, v_user::text, jsonb_build_object('sub', v_user::text, 'email', v_email, 'email_verified', true), 'email', now(), now());
  end if;

  if v_member is null then
    insert into core.members (org_id, user_id, display_name, default_store_id, must_change_password)
    values (p_org, v_user, initcap(split_part(v_email, '@', 1)), v_store, true) returning id into v_member;
  else
    update core.members set status = 'ACTIVE', must_change_password = true, default_store_id = coalesce(default_store_id, v_store) where id = v_member;
  end if;
  insert into core.member_roles (member_id, role_id) values (v_member, v_role) on conflict do nothing;
  if not exists (select 1 from core.member_store_access where member_id = v_member and all_stores) then
    insert into core.member_store_access (member_id, all_stores) values (v_member, true);
  end if;
  begin
    insert into audit.log (org_id, actor_type, action, table_name, record_id, after)
    values (p_org, 'SYSTEM', 'INITIAL_ADMIN_ENSURED', 'core.members', v_member::text, jsonb_build_object('email', v_email));
  exception when others then null; end;
  return 'CREATED';
end $function$

;

