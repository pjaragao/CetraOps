-- =====================================================================
-- agent: ferramentas que o agente de IA (Hermes, via servidor MCP) pode chamar.
--
-- Segurança em camadas:
--   1. o servidor MCP conecta com a role agent_rpc: sem grant em tabela, só executa funções do schema agent;
--   2. toda chamada entra por agent.call_tool(ctx, ferramenta, argumentos): o ctx (assinado pelo roteador, 10 min) traz
--      org/conversa/cliente/execução e a lista de ferramentas permitidas; o banco confere que a conversa é mesmo daquele
--      cliente e IGNORA qualquer ID de cliente vindo do modelo;
--   3. valores (preço, estoque, totais) são sempre calculados aqui; ações de risco têm limites (retenção ≤ 48 h e 3 peças,
--      pedido acima de R$ 1.500 vai para humano, link só com pedido confirmado pela cliente);
--   4. tudo fica em ai.tool_calls com o resultado completo: o validador confere números da resposta contra ele.
--   Erros de regra de negócio voltam como dado ({ok:false, error, code}) para o modelo reagir; erro de contexto levanta exceção.
-- =====================================================================

-- Contexto → conversa (confere org, cliente e conversa)
create or replace function agent.ctx_conversation(p_ctx jsonb) returns omni.conversations
language plpgsql stable security definer set search_path = '' as $$
declare c omni.conversations;
begin
  select * into c from omni.conversations
  where id = nullif(p_ctx ->> 'conv', '')::uuid and org_id = nullif(p_ctx ->> 'org', '')::uuid and party_id = nullif(p_ctx ->> 'party', '')::uuid;
  if c.id is null then raise exception 'Contexto do agente inválido' using errcode = '42501'; end if;
  return c;
end $$;

-- ---------------------------------------------------------------------
-- Leitura
-- ---------------------------------------------------------------------
create or replace function agent.t_search_catalog(c omni.conversations, a jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_store uuid; v_q text := private.norm(coalesce(a ->> 'query', '')); v_tokens text[]; v_in_stock boolean := coalesce((a ->> 'in_stock_only')::boolean, true);
  v_max numeric := (a ->> 'price_max')::numeric; v_out jsonb;
begin
  select ca.store_id into v_store from omni.channel_accounts ca where ca.id = c.channel_account_id;
  v_tokens := array(select '%' || case when length(t) >= 5 then regexp_replace(t, '(as|os|es|a|o|e|s)$', '') else t end || '%' from unnest(regexp_split_to_array(v_q, '\s+')) t where length(t) >= 2);
  select coalesce(jsonb_agg(x.j), '[]') into v_out from (
    select jsonb_build_object('product_id', p.id, 'name', p.name, 'reference', p.reference_code, 'gender', p.gender, 'price', min(pr.price),
             'colors', coalesce(array_agg(distinct col.name) filter (where st.avail > 0), '{}'), 'sizes_in_stock', coalesce(array_agg(distinct v.size) filter (where st.avail > 0), '{}'),
             'total_available', coalesce(sum(st.avail), 0)) as j
    from catalog.products p
    join catalog.variants v on v.product_id = p.id and v.active
    left join catalog.colors col on col.id = v.color_id
    left join lateral (select coalesce(sum(sl.available), 0) as avail from inv.stock_levels sl join inv.locations l on l.id = sl.location_id and l.is_sellable
                       and (v_store is null or l.store_id = v_store) where sl.variant_id = v.id) st on true
    left join lateral (select catalog.current_price(v.id) as price) pr on true
    where p.org_id = c.org_id and p.status = 'ACTIVE' and p.product_kind = 'GOODS'
      and (cardinality(v_tokens) = 0 or private.norm(p.name || ' ' || p.reference_code || ' ' || coalesce(col.name, '')) like all (v_tokens))
      and ((a ->> 'category') is null or exists (select 1 from catalog.categories cat where cat.id = p.category_id and private.norm(cat.name) like '%' || private.norm(a ->> 'category') || '%'))
      and ((a ->> 'color') is null or private.norm(col.name) like '%' || regexp_replace(private.norm(a ->> 'color'), '(as|os|es|a|o|e|s)$', '') || '%')
    group by p.id, p.name, p.reference_code, p.gender
    having (not v_in_stock or coalesce(sum(st.avail), 0) > 0) and (v_max is null or min(pr.price) <= v_max)
    order by coalesce(sum(st.avail), 0) desc, p.name limit 8) x;
  return jsonb_build_object('ok', true, 'products', v_out);
end $$;

create or replace function agent.t_check_stock(c omni.conversations, a jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_store uuid; v_out jsonb;
begin
  select ca.store_id into v_store from omni.channel_accounts ca where ca.id = c.channel_account_id;
  select coalesce(jsonb_agg(jsonb_build_object('variant_id', v.id, 'sku', v.sku, 'size', v.size, 'color', col.name, 'available', st.avail, 'price', catalog.current_price(v.id))
                            order by col.name, v.size), '[]') into v_out
  from catalog.variants v
  left join catalog.colors col on col.id = v.color_id
  left join lateral (select coalesce(sum(sl.available), 0) as avail from inv.stock_levels sl join inv.locations l on l.id = sl.location_id and l.is_sellable
                     and (v_store is null or l.store_id = v_store) where sl.variant_id = v.id) st on true
  where v.org_id = c.org_id and v.active
    and (v.product_id = nullif(a ->> 'product_id', '')::uuid or v.id = nullif(a ->> 'variant_id', '')::uuid or v.sku = upper(nullif(a ->> 'sku', '')))
    and ((a ->> 'color') is null or private.norm(col.name) like '%' || regexp_replace(private.norm(a ->> 'color'), '(as|os|es|a|o|e|s)$', '') || '%');
  if v_out = '[]' then return jsonb_build_object('ok', false, 'error', 'Produto não encontrado', 'code', 'NOT_FOUND'); end if;
  return jsonb_build_object('ok', true, 'variants', v_out);
end $$;

-- Subconjunto SEGURO do cliente: sem CPF, sem endereço completo, sem contatos
create or replace function agent.t_customer_360(c omni.conversations, a jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare p crm.parties; v_recent jsonb; v_cnt int; v_total numeric; v_res int; v_mem jsonb; v_mkt boolean;
begin
  select * into p from crm.parties where id = c.party_id;
  select count(*), coalesce(sum(total), 0) into v_cnt, v_total from sales.orders where party_id = p.id and status not in ('DRAFT', 'CANCELLED', 'PENDING_PAYMENT');
  select coalesce(jsonb_agg(jsonb_build_object('number', o.number, 'date', (o.created_at at time zone 'America/Sao_Paulo')::date, 'total', o.total, 'status', o.status,
      'items', (select coalesce(jsonb_agg(pr.name || ' ' || v.size), '[]') from sales.order_items i join catalog.variants v on v.id = i.variant_id join catalog.products pr on pr.id = v.product_id where i.order_id = o.id))
      order by o.created_at desc), '[]') into v_recent
  from (select * from sales.orders where party_id = p.id and status not in ('DRAFT', 'CANCELLED') order by created_at desc limit 3) o;
  select count(*) into v_res from inv.reservations where party_id = p.id and status = 'ACTIVE';
  select coalesce(jsonb_agg(jsonb_build_object('fact', fact, 'verified', verified)), '[]') into v_mem
  from (select fact, verified from ai.customer_memories where party_id = p.id and (expires_at is null or expires_at > now()) order by created_at desc limit 10) m;
  select coalesce((select granted from crm.consents where party_id = p.id and purpose = 'MARKETING_WHATSAPP' order by created_at desc limit 1), false) into v_mkt;
  return jsonb_build_object('ok', true, 'customer', jsonb_build_object('first_name', split_part(p.display_name, ' ', 1), 'tier', p.tier, 'lifecycle', p.lifecycle_stage,
    'city', p.city, 'sizes', p.sizes, 'preferences', p.preferences, 'orders_count', v_cnt, 'total_spent', v_total, 'last_purchase_at', p.last_purchase_at,
    'recent_orders', v_recent, 'store_credit', sales.store_credit_balance(p.id), 'active_reservations', v_res, 'accepts_marketing', v_mkt, 'memories', v_mem));
end $$;

create or replace function agent.t_order_status(c omni.conversations, a jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_out jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object('number', o.number, 'status', o.status, 'total', o.total, 'paid', o.paid_total, 'fulfillment', o.fulfillment_type,
      'date', (o.created_at at time zone 'America/Sao_Paulo')::date,
      'shipment', (select jsonb_build_object('carrier', s.carrier, 'tracking', s.tracking, 'status', s.status) from sales.shipments s where s.order_id = o.id order by s.created_at desc limit 1))
      order by o.created_at desc), '[]') into v_out
  from (select * from sales.orders where party_id = c.party_id and status <> 'DRAFT' and ((a ->> 'number') is null or upper(number) = upper(a ->> 'number')) order by created_at desc limit 3) o;
  if v_out = '[]' then return jsonb_build_object('ok', false, 'error', 'Nenhum pedido encontrado para esta cliente', 'code', 'NOT_FOUND'); end if;
  return jsonb_build_object('ok', true, 'orders', v_out);
end $$;

create or replace function agent.t_get_policies(c omni.conversations, a jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v jsonb;
begin
  select value into v from core.settings where org_id = c.org_id and key = 'policies';
  if v is null then return jsonb_build_object('ok', false, 'error', 'Políticas não cadastradas: encaminhe para um humano', 'code', 'NOT_CONFIGURED'); end if;
  if (a ->> 'topic') is null then return jsonb_build_object('ok', true, 'topics', (select coalesce(jsonb_agg(k), '[]') from jsonb_object_keys(v) k)); end if;
  if not v ? (a ->> 'topic') then return jsonb_build_object('ok', false, 'error', 'Tema sem política cadastrada: encaminhe para um humano', 'code', 'NOT_FOUND'); end if;
  return jsonb_build_object('ok', true, 'topic', a ->> 'topic', 'policy', v -> (a ->> 'topic'));
end $$;

create or replace function agent.t_apply_coupon(c omni.conversations, a jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r jsonb;
begin
  r := private.coupon_preview(c.org_id, a ->> 'code', coalesce((a ->> 'subtotal')::numeric, 0), c.party_id);
  return jsonb_build_object('ok', (r ->> 'valid')::boolean, 'coupon', r) || case when (r ->> 'valid')::boolean then '{}'::jsonb else jsonb_build_object('error', r ->> 'reason', 'code', 'COUPON_INVALID') end;
end $$;

-- ---------------------------------------------------------------------
-- Escrita com limites
-- ---------------------------------------------------------------------
create or replace function agent.t_create_reservation(c omni.conversations, a jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r inv.reservations; v_store uuid;
begin
  select ca.store_id into v_store from omni.channel_accounts ca where ca.id = c.channel_account_id;
  if coalesce((a ->> 'qty')::numeric, 1) > 2 then return jsonb_build_object('ok', false, 'error', 'A IA reserva no máximo 2 peças iguais', 'code', 'LIMIT'); end if;
  r := private.reserve_for(c.org_id, jsonb_build_object('variant_id', a ->> 'variant_id', 'store_id', v_store, 'qty', coalesce((a ->> 'qty')::numeric, 1), 'reason', 'AI_HOLD',
    'party_id', c.party_id, 'conversation_id', c.id, 'hold_hours', least(coalesce((a ->> 'hold_hours')::int, 24), 48), 'created_by_kind', 'AI'));
  return jsonb_build_object('ok', true, 'reservation_id', r.id, 'expires_at', r.expires_at);
end $$;

-- Pede para a vendedora preparar o Armário VIP (a IA não mexe no armário): tarefa + retenção das peças
create or replace function agent.t_schedule_locker(c omni.conversations, a jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_store uuid; it jsonb; r inv.reservations; v_titles text[] := '{}'; v_task uuid; v_n int := 0;
begin
  select ca.store_id into v_store from omni.channel_accounts ca where ca.id = c.channel_account_id;
  if jsonb_array_length(coalesce(a -> 'items', '[]')) = 0 or jsonb_array_length(a -> 'items') > 3 then
    return jsonb_build_object('ok', false, 'error', 'Informe de 1 a 3 peças', 'code', 'LIMIT');
  end if;
  for it in select * from jsonb_array_elements(a -> 'items') loop
    r := private.reserve_for(c.org_id, jsonb_build_object('variant_id', it ->> 'variant_id', 'store_id', v_store, 'qty', coalesce((it ->> 'qty')::numeric, 1), 'reason', 'AI_HOLD',
      'party_id', c.party_id, 'conversation_id', c.id, 'hold_hours', 48, 'created_by_kind', 'AI'));
    v_titles := v_titles || (select pr.name || ' ' || v.size from catalog.variants v join catalog.products pr on pr.id = v.product_id where v.id = r.variant_id);
    v_n := v_n + 1;
  end loop;
  insert into crm.tasks (org_id, party_id, assignee_member_id, type, title, body, due_at, created_by_ai, source_rule)
  values (c.org_id, c.party_id, c.assignee_member_id, 'VIP_LOCKER_PREP', 'Preparar Armário VIP: ' || array_to_string(v_titles, ', '),
          coalesce(a ->> 'notes', 'Cliente pediu para provar na loja. Peças retidas por 48 h.') || coalesce(' Quando: ' || (a ->> 'when'), ''), now() + interval '12 hours', true, 'AI_SCHEDULE_LOCKER')
  returning id into v_task;
  return jsonb_build_object('ok', true, 'task_id', v_task, 'held_items', v_n);
end $$;

-- Pedido em rascunho (reserva curta). Totais e preços vêm do banco; acima de R$ 1.500 é com humano.
create or replace function agent.t_create_order_draft(c omni.conversations, a jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_store uuid; v_channel text; o sales.orders; v_key text; v_ship numeric := least(greatest(coalesce((a ->> 'shipping_total')::numeric, 0), 0), 200);
  v_mode text := coalesce(a ->> 'fulfillment_type', 'MOTOBOY');
begin
  select ca.store_id, ca.channel::text into v_store, v_channel from omni.channel_accounts ca where ca.id = c.channel_account_id;
  if v_store is null then return jsonb_build_object('ok', false, 'error', 'Canal sem loja de origem', 'code', 'NOT_CONFIGURED'); end if;
  if v_mode not in ('MOTOBOY', 'CARRIER', 'STORE_PICKUP', 'LOCKER_PICKUP') then return jsonb_build_object('ok', false, 'error', 'Forma de entrega inválida', 'code', 'INVALID'); end if;
  v_key := 'ai:' || coalesce(a ->> '_run', 'x') || ':' || md5((a -> 'items')::text || coalesce(a ->> 'coupon_code', ''));
  o := sales.create_remote_order(jsonb_build_object('idempotency_key', v_key, 'store_id', v_store, 'channel', case when v_channel in ('WHATSAPP', 'INSTAGRAM', 'TELEGRAM') then v_channel else 'WHATSAPP' end,
    'party_id', c.party_id, 'conversation_id', c.id, 'items', a -> 'items', 'coupon_code', a ->> 'coupon_code', 'shipping_total', v_ship, 'fulfillment_type', v_mode,
    'assisted_by_ai', true, 'draft', true, 'seller_member_id', c.assignee_member_id));
  if o.total > 1500 then
    update inv.reservations set status = 'RELEASED' where order_id = o.id and status = 'ACTIVE';
    update sales.orders set status = 'CANCELLED', notes = 'Rascunho descartado: valor acima do limite da IA' where id = o.id;
    return jsonb_build_object('ok', false, 'error', 'Pedido acima de R$ 1.500 precisa de atendimento humano (fechamento VIP)', 'code', 'HIGH_VALUE', 'handoff', true, 'total', o.total);
  end if;
  return jsonb_build_object('ok', true, 'order_id', o.id, 'number', o.number, 'subtotal', o.subtotal, 'discount', o.discount_total, 'shipping', o.shipping_total, 'total', o.total,
    'items', (select jsonb_agg(jsonb_build_object('sku', v.sku, 'name', pr.name || ' ' || v.size, 'qty', i.qty, 'unit_price', i.list_price, 'total', i.total))
              from sales.order_items i join catalog.variants v on v.id = i.variant_id join catalog.products pr on pr.id = v.product_id where i.order_id = o.id),
    'status', o.status, 'note', 'Peça(s) reservada(s) por 2 h. Confirme os itens e o total com a cliente antes de gerar o link.');
exception when others then
  return jsonb_build_object('ok', false, 'error', sqlerrm, 'code', sqlstate);
end $$;

-- Só depois de uma mensagem da cliente confirmando: pedido vira "aguardando pagamento" e a reserva sobe para 24 h
create or replace function agent.t_confirm_order_draft(c omni.conversations, a jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare o sales.orders; m omni.messages;
begin
  select * into o from sales.orders where id = (a ->> 'order_id')::uuid and party_id = c.party_id and org_id = c.org_id for update;
  if o.id is null then return jsonb_build_object('ok', false, 'error', 'Pedido não encontrado', 'code', 'NOT_FOUND'); end if;
  if o.status <> 'DRAFT' then return jsonb_build_object('ok', false, 'error', 'O pedido não está em rascunho', 'code', 'INVALID_STATE'); end if;
  select * into m from omni.messages where id = (a ->> 'customer_message_id')::uuid and conversation_id = c.id and direction = 'IN' and author_type = 'CUSTOMER';
  if m.id is null then return jsonb_build_object('ok', false, 'error', 'A confirmação precisa ser uma mensagem da própria cliente nesta conversa', 'code', 'NO_CONFIRMATION'); end if;
  update sales.orders set status = 'PENDING_PAYMENT', customer_confirmed_message_id = m.id where id = o.id returning * into o;
  update inv.reservations set expires_at = now() + interval '24 hours' where order_id = o.id and status = 'ACTIVE';
  return jsonb_build_object('ok', true, 'order_id', o.id, 'number', o.number, 'total', o.total, 'status', o.status);
end $$;

create or replace function agent.t_create_payment_link(c omni.conversations, a jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare o sales.orders; l sales.payment_links;
begin
  select * into o from sales.orders where id = (a ->> 'order_id')::uuid and party_id = c.party_id and org_id = c.org_id;
  if o.id is null then return jsonb_build_object('ok', false, 'error', 'Pedido não encontrado', 'code', 'NOT_FOUND'); end if;
  if o.status <> 'PENDING_PAYMENT' or o.customer_confirmed_message_id is null then
    return jsonb_build_object('ok', false, 'error', 'Só há link para pedido confirmado pela cliente', 'code', 'NOT_CONFIRMED');
  end if;
  l := sales.create_payment_link(o.id, least(coalesce((a ->> 'max_installments')::int, 1), 6), coalesce(a ->> 'provider', 'MERCADOPAGO'));
  return jsonb_build_object('ok', true, 'link_id', l.id, 'amount', l.amount, 'max_installments', l.max_installments, 'status', l.status,
                            'note', 'O link chega em instantes; o envio à cliente é feito pelo sistema.');
end $$;

create or replace function agent.t_register_consent(c omni.conversations, a jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare pu crm.consent_purpose;
begin
  begin pu := (a ->> 'purpose')::crm.consent_purpose; exception when others then return jsonb_build_object('ok', false, 'error', 'Finalidade inválida', 'code', 'INVALID'); end;
  if pu not in ('MARKETING_WHATSAPP', 'MARKETING_EMAIL', 'MARKETING_IG', 'AI_PROFILING') then return jsonb_build_object('ok', false, 'error', 'Finalidade não permitida ao agente', 'code', 'INVALID'); end if;
  insert into crm.consents (org_id, party_id, purpose, granted, legal_basis, evidence)
  values (c.org_id, c.party_id, pu, coalesce((a ->> 'granted')::boolean, true), 'CONSENT',
          jsonb_build_object('message_id', a ->> 'message_id', 'conversation_id', c.id, 'text_version', 'agent-v1'));
  return jsonb_build_object('ok', true);
end $$;

create or replace function agent.t_update_profile(c omni.conversations, a jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  update crm.parties set
    sizes = case when a ? 'sizes' then sizes || (select coalesce(jsonb_object_agg(k, v), '{}') from jsonb_each_text(a -> 'sizes') e(k, v) where k in ('top', 'bottom', 'bra', 'shoe')) else sizes end,
    preferences = case when a ? 'preferences' then preferences || (select coalesce(jsonb_object_agg(k, v), '{}') from jsonb_each(a -> 'preferences') e(k, v) where k in ('colors', 'activities', 'fit', 'notes', 'avoid')) else preferences end,
    birth_date = coalesce(nullif(a ->> 'birth_date', '')::date, birth_date), city = coalesce(nullif(a ->> 'city', ''), city), profession = coalesce(nullif(a ->> 'profession', ''), profession),
    updated_at = now()
  where id = c.party_id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function agent.t_remember_fact(c omni.conversations, a jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_msg uuid := nullif(a ->> 'message_id', '')::uuid;
begin
  if coalesce(trim(a ->> 'fact'), '') = '' or length(a ->> 'fact') > 300 then return jsonb_build_object('ok', false, 'error', 'Fato vazio ou longo demais', 'code', 'INVALID'); end if;
  if v_msg is not null and not exists (select 1 from omni.messages where id = v_msg and conversation_id = c.id) then v_msg := null; end if;
  insert into ai.customer_memories (org_id, party_id, fact, category, source_message_id, confidence, verified, expires_at)
  values (c.org_id, c.party_id, trim(a ->> 'fact'), a ->> 'category', v_msg, (a ->> 'confidence')::numeric, false, now() + interval '18 months');
  return jsonb_build_object('ok', true);
end $$;

-- Pedido de humano: usa a mesma regra de concorrência do resultado da IA
create or replace function agent.t_request_handoff(p_ctx jsonb, c omni.conversations, a jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r jsonb;
begin
  r := omni.apply_ai_result(c.id, (p_ctx ->> 'version')::int, nullif(p_ctx ->> 'run', '')::uuid,
        jsonb_build_object('action', 'HANDOFF', 'reason', coalesce(a ->> 'reason_code', 'OTHER') || ': ' || coalesce(a ->> 'summary', ''), 'trigger', 'AI_REQUEST_HANDOFF', 'intent', a ->> 'reason_code'));
  if (r ->> 'applied')::boolean then
    update omni.conversations set summary = left(a ->> 'summary', 600) where id = c.id;
    if (a ->> 'urgency') = 'HIGH' then update omni.conversations set priority = 2, sla_due_at = now() + interval '5 minutes' where id = c.id; end if;
  end if;
  return jsonb_build_object('ok', coalesce((r ->> 'applied')::boolean, false), 'result', r);
end $$;

-- Contrato de saída: registra a proposta; o roteador valida (grounding, formato, políticas) e decide enviar/rascunhar/transferir
create or replace function agent.t_propose_reply(c omni.conversations, a jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare b jsonb; n int := 0;
begin
  if jsonb_typeof(a -> 'messages') <> 'array' or jsonb_array_length(a -> 'messages') not between 1 and 3 then
    return jsonb_build_object('ok', false, 'error', 'A resposta precisa ter de 1 a 3 mensagens', 'code', 'INVALID');
  end if;
  for b in select * from jsonb_array_elements(a -> 'messages') loop
    if jsonb_typeof(b) <> 'string' or length(b #>> '{}') = 0 or length(b #>> '{}') > 600 then
      return jsonb_build_object('ok', false, 'error', 'Cada mensagem deve ter texto de até 600 caracteres', 'code', 'INVALID');
    end if;
    n := n + 1;
  end loop;
  if (a ->> 'confidence') is null or (a ->> 'confidence')::numeric not between 0 and 1 then
    return jsonb_build_object('ok', false, 'error', 'Informe a confiança entre 0 e 1', 'code', 'INVALID');
  end if;
  return jsonb_build_object('ok', true, 'accepted', true, 'messages', n);
end $$;

-- ---------------------------------------------------------------------
-- Ponto único de entrada
-- ---------------------------------------------------------------------
create or replace function agent.call_tool(p_ctx jsonb, p_tool text, p_args jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c omni.conversations; v_t0 timestamptz := clock_timestamp(); v_res jsonb; v_run uuid := nullif(p_ctx ->> 'run', '')::uuid; v_args jsonb := coalesce(p_args, '{}');
begin
  c := agent.ctx_conversation(p_ctx);
  if jsonb_typeof(p_ctx -> 'caps') <> 'array' or not (p_ctx -> 'caps') ? p_tool then
    raise exception 'Ferramenta % não permitida neste contexto', p_tool using errcode = '42501';
  end if;
  -- IDs de cliente/organização/conversa vindos do modelo são descartados: vale só o do ctx
  v_args := v_args - 'party_id' - 'org_id' - 'conversation_id' - 'party' - 'org' - 'conv';
  begin
    v_res := case p_tool
      when 'search_catalog' then agent.t_search_catalog(c, v_args)
      when 'check_stock_by_size' then agent.t_check_stock(c, v_args)
      when 'get_customer_360' then agent.t_customer_360(c, v_args)
      when 'get_order_status' then agent.t_order_status(c, v_args)
      when 'get_policies' then agent.t_get_policies(c, v_args)
      when 'apply_coupon' then agent.t_apply_coupon(c, v_args)
      when 'create_reservation' then agent.t_create_reservation(c, v_args)
      when 'schedule_locker' then agent.t_schedule_locker(c, v_args)
      when 'create_order_draft' then agent.t_create_order_draft(c, v_args || jsonb_build_object('_run', coalesce(v_run::text, 'x')))
      when 'confirm_order_draft' then agent.t_confirm_order_draft(c, v_args)
      when 'create_payment_link' then agent.t_create_payment_link(c, v_args)
      when 'register_consent' then agent.t_register_consent(c, v_args)
      when 'update_customer_profile' then agent.t_update_profile(c, v_args)
      when 'remember_customer_fact' then agent.t_remember_fact(c, v_args)
      when 'request_handoff' then agent.t_request_handoff(p_ctx, c, v_args)
      when 'propose_reply' then agent.t_propose_reply(c, v_args)
      else jsonb_build_object('ok', false, 'error', 'Ferramenta desconhecida: ' || p_tool, 'code', 'UNKNOWN_TOOL')
    end;
  exception when others then
    v_res := jsonb_build_object('ok', false, 'error', sqlerrm, 'code', sqlstate);
  end;
  if v_run is not null and exists (select 1 from ai.runs where id = v_run and org_id = c.org_id) then
    insert into ai.tool_calls (run_id, tool, args, result_digest, ok, ms)
    values (v_run, p_tool, v_args, v_res, coalesce((v_res ->> 'ok')::boolean, false), (extract(epoch from clock_timestamp() - v_t0) * 1000)::int);
  end if;
  return v_res;
end $$;

-- (as políticas padrão que a IA consulta ficam em supabase/seed/05_ai_config.sql: a organização só existe depois dos seeds)

-- O schema agent só é chamável pela role do servidor MCP (agent_rpc) e pelo service_role
revoke execute on all functions in schema agent from public, anon, authenticated;
grant execute on all functions in schema agent to agent_rpc, service_role;
grant usage on schema agent to agent_rpc;

-- permite ao dono do banco (postgres) assumir a role do agente em testes e diagnósticos (SET ROLE)
grant agent_rpc to postgres;
