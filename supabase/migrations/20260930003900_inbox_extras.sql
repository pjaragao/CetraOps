-- =====================================================================
-- Atendimento › Caixa de entrada: pausar a IA, devolver a conversa para a IA com uma instrução, notas internas com @menção e atribuição.
-- Nota interna nunca é enviada à cliente. A instrução dada ao devolver fica valendo para a IA até uma pessoa assumir de novo.
-- Códigos de erro: P0220 dado inválido · P0221 situação não permite · P0222 não encontrado.
-- =====================================================================

alter table omni.conversations add column if not exists ai_instruction text;
create index if not exists internal_notes_conv_idx on omni.internal_notes (conversation_id, created_at);

-- Quando uma pessoa assume, a instrução para a IA perde o sentido
create or replace function omni.clear_ai_instruction() returns trigger
language plpgsql as $$
begin
  if new.mode = 'HUMAN' then new.ai_instruction := null; end if;
  return new;
end $$;
drop trigger if exists trg_clear_instruction on omni.conversations;
create trigger trg_clear_instruction before update of mode on omni.conversations for each row execute function omni.clear_ai_instruction();

-- O roteador recebe a instrução junto com o resto do contexto
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
    'window_allowed', coalesce(w.allowed, false), 'window_mode', w.mode, 'ai_replies_last_hour', v_replies, 'instruction', cv.ai_instruction,
    'message', jsonb_build_object('id', m.id, 'type', m.type, 'body', m.body, 'transcript', m.transcript, 'created_at', m.created_at));
end $$;

create or replace function private.conversation_for_update(p_id uuid) returns omni.conversations
language plpgsql security definer set search_path = '' as $$
declare c omni.conversations;
begin
  select * into c from omni.conversations where id = p_id and org_id = private.org_id() for update;
  if c.id is null then raise exception 'Conversa não encontrada' using errcode = 'P0222'; end if;
  return c;
end $$;

-- ---------------------------------------------------------------------
-- 1) Pausar a IA (0 = retomar). A conversa continua no mesmo modo; a IA só não responde enquanto estiver pausada.
-- ---------------------------------------------------------------------
create or replace function omni.pause_ai(p_conversation uuid, p_minutes integer) returns omni.conversations
language plpgsql security definer set search_path = '' as $$
declare c omni.conversations;
begin
  perform private.require_perm('omni.write');
  if p_minutes is null or p_minutes not between 0 and 1440 then raise exception 'A pausa vai de 1 minuto a 24 horas (0 retoma)' using errcode = 'P0220'; end if;
  c := private.conversation_for_update(p_conversation);
  update omni.conversations set ai_paused_until = case when p_minutes = 0 then null else now() + make_interval(mins => p_minutes) end where id = c.id returning * into c;
  return c;
end $$;

-- ---------------------------------------------------------------------
-- 2) Atribuir (null = tirar o dono). Avisa a pessoa escolhida.
-- ---------------------------------------------------------------------
create or replace function omni.assign_conversation(p_conversation uuid, p_member uuid default null) returns omni.conversations
language plpgsql security definer set search_path = '' as $$
declare c omni.conversations; v_name text;
begin
  perform private.require_perm('omni.write');
  c := private.conversation_for_update(p_conversation);
  if p_member is not null and not exists (select 1 from core.members where id = p_member and org_id = c.org_id and status = 'ACTIVE') then raise exception 'Pessoa da equipe inválida' using errcode = 'P0220'; end if;
  update omni.conversations set assignee_member_id = p_member where id = c.id returning * into c;
  if p_member is not null and p_member is distinct from private.member_id() then
    select display_name into v_name from crm.parties where id = c.party_id;
    perform core.notify(c.org_id, 'ASSIGNED', 'Conversa atribuída a você: ' || coalesce(v_name, 'cliente'), jsonb_build_object('conversation_id', c.id), null, p_member);
  end if;
  return c;
end $$;

-- ---------------------------------------------------------------------
-- 3) Nota interna (nunca vai para a cliente). p_mentions: pessoas avisadas.
-- ---------------------------------------------------------------------
create or replace function omni.add_note(p_conversation uuid, p_body text, p_mentions uuid[] default '{}') returns omni.internal_notes
language plpgsql security definer set search_path = '' as $$
declare c omni.conversations; n omni.internal_notes; v_body text := trim(coalesce(p_body, '')); v_ment uuid[]; v_who text; v_party text; m uuid;
begin
  perform private.require_perm('omni.write');
  if length(v_body) not between 1 and 2000 then raise exception 'A nota tem de 1 a 2000 caracteres' using errcode = 'P0220'; end if;
  c := private.conversation_for_update(p_conversation);
  select coalesce(array_agg(id), '{}') into v_ment from core.members where id = any (coalesce(p_mentions, '{}')) and org_id = c.org_id and status = 'ACTIVE';
  insert into omni.internal_notes (org_id, conversation_id, member_id, body, mentions) values (c.org_id, c.id, private.member_id(), v_body, v_ment) returning * into n;
  select display_name into v_who from core.members where id = private.member_id();
  select display_name into v_party from crm.parties where id = c.party_id;
  foreach m in array v_ment loop
    if m is distinct from private.member_id() then
      perform core.notify(c.org_id, 'MENTION', coalesce(v_who, 'Alguém') || ' mencionou você na conversa de ' || coalesce(v_party, 'cliente'), jsonb_build_object('conversation_id', c.id), null, m);
    end if;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------------
-- 4) Devolver para a IA, com instrução (ex.: "confirme o endereço e mande o link"). Fica na conversa como nota e vale para as próximas respostas da IA.
-- ---------------------------------------------------------------------
create or replace function omni.return_to_ai(p_conversation uuid, p_mode omni.conv_mode, p_instruction text default null) returns omni.conversations
language plpgsql security definer set search_path = '' as $$
declare c omni.conversations; v_ins text := nullif(trim(coalesce(p_instruction, '')), '');
begin
  perform private.require_perm('omni.write');
  if p_mode not in ('AI_COPILOT', 'AI_AUTOPILOT') then raise exception 'Escolha Copiloto ou Piloto automático' using errcode = 'P0220'; end if;
  if v_ins is not null and length(v_ins) > 500 then raise exception 'A instrução tem no máximo 500 caracteres' using errcode = 'P0220'; end if;
  c := private.conversation_for_update(p_conversation);
  if c.status = 'CLOSED' then raise exception 'Conversa encerrada' using errcode = 'P0221'; end if;
  perform omni.set_mode(c.id, p_mode, 'Devolvida para a IA');
  update omni.conversations set ai_instruction = v_ins, ai_paused_until = null where id = c.id returning * into c;
  if v_ins is not null then
    insert into omni.internal_notes (org_id, conversation_id, member_id, body) values (c.org_id, c.id, private.member_id(), 'Devolvida para a IA com a instrução: ' || v_ins);
  end if;
  return c;
end $$;

insert into private.internal_functions (fqname) values ('private.conversation_for_update'), ('omni.clear_ai_instruction') on conflict do nothing;
select private.lock_functions();
