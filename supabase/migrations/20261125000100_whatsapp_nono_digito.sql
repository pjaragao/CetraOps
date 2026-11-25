-- WhatsApp: celular brasileiro chega da Meta sem o 9 (wa_id 55 48 9148-5644) mesmo quando a conversa foi aberta com ele (55 48 99148-5644).
-- Antes isso criava outra identidade, outro cadastro e outra conversa. Agora as duas formas são o mesmo número.

-- As formas do mesmo número: celular BR com 9 (13 dígitos) e sem o 9 (12 dígitos, começando em 6-9).
create or replace function private.wa_alt_ids(p text) returns text[]
language sql immutable set search_path = '' as $$
  select case
    when p ~ '^55\d{2}9[6-9]\d{7}$' then array[p, substr(p, 1, 4) || substr(p, 6)]
    when p ~ '^55\d{2}[6-9]\d{7}$' then array[p, substr(p, 1, 4) || '9' || substr(p, 5)]
    else array[p] end
$$;

-- Chave canônica (com o 9) para travas.
create or replace function private.wa_key(p text) returns text
language sql immutable set search_path = '' as $$
  select case when p ~ '^55\d{2}[6-9]\d{7}$' then substr(p, 1, 4) || '9' || substr(p, 5) else p end
$$;

-- Mensagem chegou com uma forma e a identidade existe com a outra: a identidade passa a usar a forma que a Meta manda.
create or replace function private.wa_adopt_identity(p_account uuid, p_wa_id text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from omni.channel_identities where channel_account_id = p_account and external_id = p_wa_id) then return; end if;
  update omni.channel_identities set external_id = p_wa_id
  where id = (select id from omni.channel_identities where channel_account_id = p_account and external_id = any(private.wa_alt_ids(p_wa_id)) and external_id <> p_wa_id
              order by created_at limit 1);
end $$;

CREATE OR REPLACE FUNCTION omni.ingest_event(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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

  -- celular BR com e sem o 9: a mesma pessoa. A trava usa a forma canônica e a identidade criada com a outra forma vira a do WhatsApp.
  perform pg_advisory_xact_lock(hashtext('omni.identity:' || ca.id::text || ':' || case when ca.channel = 'WHATSAPP' then private.wa_key(p ->> 'external_id') else p ->> 'external_id' end));
  if ca.channel = 'WHATSAPP' then perform private.wa_adopt_identity(ca.id, p ->> 'external_id'); end if;

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
end $function$;

CREATE OR REPLACE FUNCTION private.ensure_wa_conversation(p_account uuid, p_party uuid, p_wa_id text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare ca omni.channel_accounts; idn omni.channel_identities; cv omni.conversations;
begin
  select * into ca from omni.channel_accounts where id = p_account;
  select * into idn from omni.channel_identities where channel_account_id = ca.id and external_id = any(private.wa_alt_ids(p_wa_id))
  order by (external_id = p_wa_id) desc, created_at limit 1;
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
end $function$;

-- Junta as conversas já duplicadas: fica a conversa mais antiga, com o número na forma que chegou da Meta (a da identidade mais nova).
do $$
declare r record; t record; v_n int;
begin
  for r in
    select a.id keep_idn, b.id dup_idn, a.party_id keep_party, b.party_id dup_party, b.external_id wa, b.profile dup_profile
    from omni.channel_identities a
    join omni.channel_identities b on b.channel_account_id = a.channel_account_id and b.id <> a.id
      and b.external_id = any(private.wa_alt_ids(a.external_id)) and (a.created_at, a.id) < (b.created_at, b.id)
  loop
    declare keep_cv uuid; dup_cv uuid;
    begin
      for dup_cv in select id from omni.conversations where channel_identity_id = r.dup_idn order by created_at loop
        select id into keep_cv from omni.conversations where channel_identity_id = r.keep_idn and status <> 'CLOSED' order by created_at desc limit 1;
        if keep_cv is null then
          update omni.conversations set channel_identity_id = r.keep_idn, party_id = r.keep_party where id = dup_cv;
          continue;
        end if;
        for t in
          select c.conrelid::regclass::text tbl, a.attname col from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
          where c.confrelid = 'omni.conversations'::regclass and c.contype = 'f' and array_length(c.conkey, 1) = 1
        loop
          begin
            execute format('update %s set %I = $1 where %I = $2', t.tbl, t.col, t.col) using keep_cv, dup_cv;
          exception when unique_violation then
            execute format('delete from %s where %I = $1', t.tbl, t.col) using dup_cv;
          end;
        end loop;
        update omni.conversations k set
          last_message_at = greatest(k.last_message_at, d.last_message_at), last_inbound_at = greatest(k.last_inbound_at, d.last_inbound_at),
          service_window_expires_at = greatest(k.service_window_expires_at, d.service_window_expires_at),
          human_agent_window_expires_at = greatest(k.human_agent_window_expires_at, d.human_agent_window_expires_at),
          unread_count = k.unread_count + d.unread_count, updated_at = now()
        from omni.conversations d where k.id = keep_cv and d.id = dup_cv;
        delete from omni.conversations where id = dup_cv;
      end loop;
      delete from omni.channel_identities where id = r.dup_idn;
      update omni.channel_identities set external_id = r.wa, profile = profile || (r.dup_profile - 'source') where id = r.keep_idn;

      -- o cadastro que a mensagem criou à parte vira mesclado no original (contatos e histórico passam para o original)
      if r.dup_party <> r.keep_party and not exists (select 1 from omni.channel_identities where party_id = r.dup_party)
         and not exists (select 1 from crm.party_roles where party_id = r.dup_party and role = 'EMPLOYEE') then
        update crm.party_contact_points set party_id = r.keep_party, is_primary = false where party_id = r.dup_party;
        for t in
          select c.conrelid::regclass::text tbl, a.attname col from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
          where c.confrelid = 'crm.parties'::regclass and c.contype = 'f' and array_length(c.conkey, 1) = 1
            and c.conrelid not in ('crm.parties'::regclass, 'crm.party_contact_points'::regclass, 'crm.party_merge_log'::regclass)
        loop
          begin
            execute format('update %s set %I = $1 where %I = $2', t.tbl, t.col, t.col) using r.keep_party, r.dup_party;
          exception when unique_violation then
            execute format('delete from %s where %I = $1', t.tbl, t.col) using r.dup_party;
          end;
        end loop;
        update crm.parties set merged_into_id = r.keep_party, tags = array(select distinct unnest(tags || array['mesclada'])) where id = r.dup_party;
        insert into crm.party_merge_log (org_id, kept_id, merged_id, merged_name, moved, skipped, merged_by)
        select org_id, r.keep_party, id, display_name, '{}'::jsonb, '{}'::text[], null from crm.parties where id = r.dup_party;
      end if;
    end;
  end loop;
end $$;

insert into private.internal_functions (fqname) values ('private.wa_adopt_identity') on conflict do nothing;
select private.lock_functions();
