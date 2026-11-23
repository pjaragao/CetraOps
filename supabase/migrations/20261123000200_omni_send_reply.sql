-- Responder (reply) a uma mensagem específica pela inbox: a cliente vê a mensagem citada no WhatsApp/Instagram.
-- p_reply_to = id (omni.messages) da mensagem citada, da mesma conversa. Grava reply_to_id e, no payload, `reply_to` com o id do provedor
-- (mesma chave do que chega pelo webhook), que o worker manda como `context.message_id` na Meta.
drop function if exists omni.send_message(uuid, text, uuid, boolean);

create or replace function omni.send_message(p_conversation uuid, p_body text, p_draft uuid default null, p_edited boolean default false, p_reply_to uuid default null)
returns omni.messages
language plpgsql security definer set search_path = '' as $$
declare
  c omni.conversations;
  w record;
  m omni.messages;
  q omni.messages;
begin
  perform private.require_perm('omni.write');
  select * into c from omni.conversations where id = p_conversation;
  if c.id is null or (coalesce(auth.role(), '') = 'authenticated' and c.org_id <> private.org_id()) then
    raise exception 'Conversa não encontrada' using errcode = 'P0002';
  end if;
  if coalesce(trim(p_body), '') = '' then raise exception 'Mensagem vazia' using errcode = '22023'; end if;
  if p_reply_to is not null then
    select * into q from omni.messages where id = p_reply_to and conversation_id = c.id;
    if q.id is null then raise exception 'Mensagem citada não encontrada nesta conversa' using errcode = 'P0002'; end if;
    if q.provider_message_id is null then raise exception 'Essa mensagem ainda não foi entregue: não dá para responder a ela' using errcode = '22023'; end if;
  end if;

  select * into w from omni.check_send_window(p_conversation, 'HUMAN');
  if not w.allowed then raise exception '%', w.reason using errcode = 'P0010'; end if;

  insert into omni.messages (org_id, conversation_id, channel_account_id, direction, author_type, author_member_id,
                             body, status, client_dedupe_key, payload, reply_to_id)
  values (c.org_id, c.id, c.channel_account_id, 'OUT', 'HUMAN', private.member_id(), trim(p_body), 'QUEUED',
          gen_random_uuid()::text,
          jsonb_build_object('send_mode', w.mode) || case when q.id is not null then jsonb_build_object('reply_to', q.provider_message_id) else '{}'::jsonb end,
          q.id)
  returning * into m;

  if p_draft is not null then
    update omni.message_drafts set status = case when p_edited then 'EDITED_SENT' else 'SENT' end,
           final_message_id = m.id, decided_by = private.member_id()
    where id = p_draft and conversation_id = c.id;
  end if;

  perform private.enqueue('outbound_messages', jsonb_build_object('message_id', m.id, 'org_id', c.org_id));
  return m;
end $$;

select private.lock_functions();
