-- Inbox: carrinho da conversa, sugestão da IA sob demanda (com comentário para refazer) e Hydrogen nas rotas de conversa (23/11/2026).
--
-- 1. Carrinho da conversa (omni.cart_items): o que está sendo mostrado ao cliente, para o atendente se localizar.
--    • Automático, em qualquer modo (inclusive humano): cada mensagem enviada com foto de peça do catálogo põe a peça (modelo + cor)
--      no carrinho; o carrinho enviado pelo cliente pelo catálogo do WhatsApp entra com as quantidades.
--    • Manual: o atendente adiciona (busca no catálogo) ou remove. Peça removida volta se for mostrada de novo.
--    • PDV: o carrinho do caixa vai para a conversa de WhatsApp do cliente (abre uma se não houver) com a mensagem pronta.
-- 2. "Sugerir resposta": o atendente pede uma sugestão da IA em qualquer modo, mesmo com a última mensagem sendo da loja, e pode
--    comentar a sugestão para a IA refazer. A sugestão nunca sai sozinha (fica como rascunho).
-- 3. Modelo das rotas de conversa (atendimento e assistente da Central): Gemini 4 Hydrogen, pensamento baixo (AGY).

-- ============ 3. Modelo das rotas de conversa ============
update ai.model_routes set primary_model = 'hermes/agy/gemini-4-hydrogen-low'
where task in ('conversation', 'assistant') and primary_model like 'hermes/agy%' and primary_model <> 'hermes/agy/gemini-4-hydrogen-low';

-- ============ 1. Carrinho da conversa ============
create table if not exists omni.cart_items (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references core.orgs (id),
  conversation_id  uuid not null references omni.conversations (id) on delete cascade,
  product_id       uuid not null references catalog.products (id) on delete cascade,
  color_id         uuid references catalog.colors (id) on delete set null,
  size             text,
  qty              numeric(10, 3) not null default 1 check (qty > 0),
  source           text not null check (source in ('SHOWN', 'ORDER', 'MANUAL', 'PDV')),
  status           text not null default 'ACTIVE' check (status in ('ACTIVE', 'REMOVED')),
  message_id       uuid references omni.messages (id) on delete set null,
  added_by         uuid references core.members (id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  removed_at       timestamptz
);
create unique index if not exists cart_items_key on omni.cart_items
  (conversation_id, product_id, coalesce(color_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(size, ''));
select private.apply_rls('omni', array['cart_items'], 'omni.read', 'omni.write');
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'omni' and tablename = 'cart_items') then
    alter publication supabase_realtime add table omni.cart_items;
  end if;
end $$;

-- Põe (ou reativa) uma peça no carrinho. Automático (SHOWN/ORDER) reativa peça removida: foi mostrada/pedida de novo.
create or replace function private.cart_put(p_conversation uuid, p_product uuid, p_color uuid, p_size text, p_qty numeric, p_source text,
                                            p_message uuid default null, p_member uuid default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_id uuid;
begin
  select org_id into v_org from omni.conversations where id = p_conversation;
  if v_org is null or p_product is null then return null; end if;
  insert into omni.cart_items as t (org_id, conversation_id, product_id, color_id, size, qty, source, message_id, added_by)
  values (v_org, p_conversation, p_product, p_color, nullif(trim(coalesce(p_size, '')), ''), greatest(coalesce(p_qty, 1), 1), p_source, p_message, p_member)
  on conflict (conversation_id, product_id, coalesce(color_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(size, '')) do update
    set status = 'ACTIVE', removed_at = null, updated_at = now(),
        qty = case when excluded.source in ('ORDER', 'PDV', 'MANUAL') then excluded.qty else t.qty end,
        source = case when t.status = 'REMOVED' or excluded.source in ('ORDER', 'PDV') then excluded.source else t.source end,
        message_id = coalesce(excluded.message_id, t.message_id)
  returning id into v_id;
  return v_id;
end $$;

-- Captura automática a partir das mensagens (nunca impede a mensagem de entrar)
create or replace function private.cart_capture()
returns trigger language plpgsql security definer set search_path = '' as $$
declare r jsonb;
begin
  begin
    if new.direction = 'OUT' and new.body ~ 'https?://' then
      for r in select * from jsonb_array_elements(private.text_products(new.channel_account_id, new.body)) loop
        perform private.cart_put(new.conversation_id, (r ->> 'product_id')::uuid, (r ->> 'color_id')::uuid, null, 1, 'SHOWN', new.id);
      end loop;
    elsif new.direction = 'IN' and jsonb_typeof(new.payload -> 'order' -> 'product_items') = 'array' then
      for r in select x from jsonb_array_elements(new.payload -> 'order' -> 'product_items') x loop
        perform private.cart_put(new.conversation_id, i.product_id, i.color_id, null, coalesce((r ->> 'quantity')::numeric, 1), 'ORDER', new.id)
        from omni.meta_catalog_items i
        where i.channel_account_id = new.channel_account_id and i.retailer_id = r ->> 'product_retailer_id' and i.product_id is not null
        order by i.updated_at desc limit 1;
      end loop;
    end if;
  exception when others then
    raise warning 'carrinho da conversa não atualizado (mensagem %): %', new.id, sqlerrm;
  end;
  return null;
end $$;
drop trigger if exists trg_cart_capture on omni.messages;
create trigger trg_cart_capture after insert on omni.messages for each row
  when (new.direction = 'OUT' or new.payload ? 'order') execute function private.cart_capture();

-- Itens do carrinho para a lateral da inbox
create or replace function omni.conversation_cart(p_conversation uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare cv omni.conversations; v_store uuid; v_items jsonb;
begin
  perform private.require_perm('omni.read');
  select * into cv from omni.conversations where id = p_conversation;
  if cv.id is null or (coalesce(auth.role(), '') = 'authenticated' and cv.org_id <> private.org_id()) then
    raise exception 'Conversa não encontrada' using errcode = 'P0002';
  end if;
  select store_id into v_store from omni.channel_accounts where id = cv.channel_account_id;
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'id', ci.id, 'product_id', ci.product_id, 'color_id', ci.color_id, 'name', p.name, 'reference', p.reference_code, 'color', col.name,
           'size', ci.size, 'qty', ci.qty, 'source', ci.source, 'price', pr.price,
           'available', st.avail, 'sizes_in_stock', to_jsonb(st.sizes),
           'photo', (select private.catalog_photo_url(cv.org_id, m.storage_path, m.source_url) from catalog.product_media m
                     where m.product_id = ci.product_id order by (m.color_id is not distinct from ci.color_id) desc, m.position limit 1),
           'added_at', ci.created_at)) order by ci.created_at), '[]')
    into v_items
  from omni.cart_items ci
  join catalog.products p on p.id = ci.product_id
  left join catalog.colors col on col.id = ci.color_id
  left join lateral (select min(catalog.current_price(v.id)) as price from catalog.variants v
                     where v.product_id = ci.product_id and v.active and (ci.color_id is null or v.color_id = ci.color_id)
                       and (ci.size is null or v.size = ci.size)) pr on true
  left join lateral (select coalesce(sum(s.avail), 0) as avail, private.sort_sizes(array_agg(s.size) filter (where s.avail > 0)) as sizes
                     from (select v.size, coalesce(sum(sl.available), 0) as avail
                           from catalog.variants v
                           left join inv.stock_levels sl on sl.variant_id = v.id
                             and exists (select 1 from inv.locations l where l.id = sl.location_id and l.is_sellable and (v_store is null or l.store_id = v_store))
                           where v.product_id = ci.product_id and v.active and (ci.color_id is null or v.color_id = ci.color_id)
                             and (ci.size is null or v.size = ci.size)
                           group by v.size) s) st on true
  where ci.conversation_id = cv.id and ci.status = 'ACTIVE';
  return v_items;
end $$;

create or replace function omni.cart_add(p_conversation uuid, p_product uuid, p_color uuid default null, p_size text default null, p_qty numeric default 1)
returns uuid language plpgsql security definer set search_path = '' as $$
declare cv omni.conversations;
begin
  perform private.require_perm('omni.write');
  select * into cv from omni.conversations where id = p_conversation;
  if cv.id is null or (coalesce(auth.role(), '') = 'authenticated' and cv.org_id <> private.org_id()) then
    raise exception 'Conversa não encontrada' using errcode = 'P0002';
  end if;
  if not exists (select 1 from catalog.products where id = p_product and org_id = cv.org_id) then raise exception 'Produto não encontrado' using errcode = 'P0002'; end if;
  return private.cart_put(cv.id, p_product, p_color, p_size, p_qty, 'MANUAL', null, private.member_id());
end $$;

create or replace function omni.cart_remove(p_item uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('omni.write');
  update omni.cart_items set status = 'REMOVED', removed_at = now(), updated_at = now()
  where id = p_item and (coalesce(auth.role(), '') <> 'authenticated' or org_id = private.org_id());
end $$;

-- Busca para adicionar à mão: modelo + cor, com preço, estoque na loja do canal e foto
create or replace function omni.cart_search(p_conversation uuid, p_query text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare cv omni.conversations; v_store uuid; v_q text := '%' || private.norm(trim(coalesce(p_query, ''))) || '%'; v_out jsonb;
begin
  perform private.require_perm('omni.read');
  select * into cv from omni.conversations where id = p_conversation;
  if cv.id is null or (coalesce(auth.role(), '') = 'authenticated' and cv.org_id <> private.org_id()) then
    raise exception 'Conversa não encontrada' using errcode = 'P0002';
  end if;
  if length(trim(coalesce(p_query, ''))) < 2 then return '[]'; end if;
  select store_id into v_store from omni.channel_accounts where id = cv.channel_account_id;
  with pc as (
    select p.id as product_id, v.color_id, p.name, p.reference_code, p.gender, col.name as color,
           min(catalog.current_price(v.id)) as price,
           coalesce(sum((select coalesce(sum(sl.available), 0) from inv.stock_levels sl join inv.locations l on l.id = sl.location_id and l.is_sellable
                          and (v_store is null or l.store_id = v_store) where sl.variant_id = v.id)), 0) as avail
    from catalog.products p
    join catalog.variants v on v.product_id = p.id and v.active
    left join catalog.colors col on col.id = v.color_id
    where p.org_id = cv.org_id and p.status = 'ACTIVE' and p.product_kind = 'GOODS'
      and private.norm(p.name || ' ' || p.reference_code || ' ' || coalesce(col.name, '')) like v_q
    group by p.id, v.color_id, col.name
    order by (coalesce(sum((select coalesce(sum(sl.available), 0) from inv.stock_levels sl where sl.variant_id = v.id)), 0) > 0) desc, p.name, col.name
    limit 15
  )
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('product_id', pc.product_id, 'color_id', pc.color_id, 'name', pc.name, 'reference', pc.reference_code,
           'gender', pc.gender, 'color', pc.color, 'price', pc.price, 'available', pc.avail,
           'photo', (select private.catalog_photo_url(cv.org_id, m.storage_path, m.source_url) from catalog.product_media m
                     where m.product_id = pc.product_id order by (m.color_id is not distinct from pc.color_id) desc, m.position limit 1)))), '[]')
    into v_out from pc;
  return v_out;
end $$;

-- PDV → WhatsApp: abre (ou acha) a conversa do cliente, põe as peças no carrinho e devolve a mensagem pronta (com as fotos,
-- que saem como cartões do catálogo no modo nativo). Quem envia é o atendente, na inbox (fora da janela de 24 h, por template).
create or replace function omni.cart_to_whatsapp(p_party uuid, p_items jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_conv uuid; cv omni.conversations; r record; v_lines text[] := '{}'; v_total numeric := 0; v_first text; v_n int := 0;
begin
  perform private.require_perm('omni.write');
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'O carrinho está vazio' using errcode = '22023'; end if;
  v_conv := omni.open_conversation_for(p_party);
  select * into cv from omni.conversations where id = v_conv;
  for r in
    select v.product_id, v.color_id, v.size, greatest(coalesce((x ->> 'qty')::numeric, 1), 1) as qty, p.name, col.name as color,
           coalesce((x ->> 'unit_price')::numeric, catalog.current_price(v.id)) as price,
           (select private.catalog_photo_url(cv.org_id, m.storage_path, m.source_url) from catalog.product_media m
             where m.product_id = v.product_id order by (m.color_id is not distinct from v.color_id) desc, m.position limit 1) as photo
    from jsonb_array_elements(p_items) with ordinality as e(x, ord)
    join catalog.variants v on v.id = (x ->> 'variant_id')::uuid
    join catalog.products p on p.id = v.product_id and p.org_id = cv.org_id
    left join catalog.colors col on col.id = v.color_id
    order by e.ord
  loop
    perform private.cart_put(cv.id, r.product_id, r.color_id, r.size, r.qty, 'PDV', null, private.member_id());
    v_n := v_n + 1;
    v_total := v_total + coalesce(r.price, 0) * r.qty;
    v_lines := v_lines || (r.name || coalesce(' (' || r.color || ')', '') || ' · tam. ' || r.size
                           || case when r.qty > 1 then ' · ' || trim(to_char(r.qty, 'FM999990.##')) || ' un.' else '' end
                           || coalesce(' · R$ ' || replace(to_char(r.price, 'FM999999990.00'), '.', ','), '')
                           || coalesce(': ' || r.photo, ''));
  end loop;
  if v_n = 0 then raise exception 'Nenhuma peça do carrinho foi encontrada no catálogo' using errcode = '22023'; end if;
  select split_part(display_name, ' ', 1) into v_first from crm.parties where id = p_party;
  return jsonb_build_object('conversation_id', cv.id,
    'message', 'Oi' || coalesce(', ' || nullif(v_first, ''), '') || '! Separei estas peças pra você ✨' || E'\n\n' || array_to_string(v_lines, E'\n')
               || E'\n\n' || 'Total: R$ ' || replace(to_char(v_total, 'FM999999990.00'), '.', ',') || E'\n' || 'Quer que eu reserve pra você?');
end $$;

-- Carrinho das conversas recentes já preenchido com o que foi mostrado (últimos 14 dias)
do $$
declare m record; r jsonb;
begin
  for m in select ms.id, ms.conversation_id, ms.channel_account_id, ms.body from omni.messages ms
           join omni.conversations c on c.id = ms.conversation_id and c.status <> 'CLOSED'
           where ms.direction = 'OUT' and ms.body ~ 'https?://' and ms.created_at > now() - interval '14 days' order by ms.created_at loop
    for r in select * from jsonb_array_elements(private.text_products(m.channel_account_id, m.body)) loop
      perform private.cart_put(m.conversation_id, (r ->> 'product_id')::uuid, (r ->> 'color_id')::uuid, null, 1, 'SHOWN', m.id);
    end loop;
  end loop;
end $$;

-- ============ 2. Sugestão da IA sob demanda ============
alter table omni.conversations add column if not exists ai_forced_at timestamptz;
comment on column omni.conversations.ai_forced_at is 'Atendente pediu uma sugestão da IA (botão Sugerir resposta/Comentar); limpo quando o rascunho fica pronto';

create or replace function omni.request_ai_suggestion(p_conversation uuid, p_comment text default null, p_draft uuid default null)
returns void language plpgsql security definer set search_path = '' as $$
declare cv omni.conversations; v_last uuid;
begin
  perform private.require_perm('omni.write');
  select * into cv from omni.conversations where id = p_conversation;
  if cv.id is null or (coalesce(auth.role(), '') = 'authenticated' and cv.org_id <> private.org_id()) then
    raise exception 'Conversa não encontrada' using errcode = 'P0002';
  end if;
  if cv.status = 'CLOSED' then raise exception 'Conversa encerrada' using errcode = '22023'; end if;
  select id into v_last from omni.messages where conversation_id = cv.id and direction = 'IN' order by created_at desc, seq desc limit 1;
  if v_last is null then raise exception 'Ainda não há mensagem do cliente nesta conversa: escreva a primeira mensagem' using errcode = '22023'; end if;
  update omni.conversations set ai_forced_at = now() where id = cv.id;
  perform private.enqueue('conversation_router', jsonb_build_object('conversation_id', cv.id, 'message_id', v_last, 'force', true,
                                                                    'comment', nullif(trim(coalesce(p_comment, '')), ''), 'draft_id', p_draft), 0);
end $$;

create or replace function omni.apply_ai_result(p_conversation uuid, p_expected_version integer, p_run uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  cv omni.conversations; v_action text := p ->> 'action'; b text; i int := 0; w record; v_tier text; v_ids uuid[] := '{}'; m omni.messages; d omni.message_drafts;
  v_force boolean := coalesce((p ->> 'force')::boolean, false) and (p ->> 'action') = 'DRAFT';   -- pedido do atendente: só rascunho, em qualquer modo
begin
  select * into cv from omni.conversations where id = p_conversation for update;
  if cv.id is null then raise exception 'Conversa não encontrada' using errcode = 'P0002'; end if;
  if cv.version <> p_expected_version or cv.status = 'CLOSED'
     or (not v_force and (cv.mode = 'HUMAN' or (cv.ai_paused_until is not null and cv.ai_paused_until > now()))) then
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

  update omni.conversations set intent = coalesce(p ->> 'intent', intent), pending_ai_at = null,
         ai_forced_at = case when v_force then null else ai_forced_at end where id = cv.id;
  update ai.runs set status = 'OK', confidence = (p ->> 'confidence')::numeric where id = p_run;
  return jsonb_build_object('applied', true, 'action', v_action, 'message_ids', to_jsonb(v_ids), 'draft_id', d.id);
end $$;

insert into private.internal_functions (fqname) values ('private.cart_put'), ('private.cart_capture')
on conflict do nothing;
select private.lock_functions();
