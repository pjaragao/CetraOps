-- Fechar a venda pelo WhatsApp, de ponta a ponta (23/11/2026).
--
-- Cliente: vê as peças (cartões do catálogo ou fotos), manda o carrinho pelo catálogo ou diz o que quer → recebe o resumo do pedido
--          com o link de pagamento (Pix ou cartão, checkout da Stone/Pagar.me) → paga → recebe "pagamento confirmado" na mesma conversa.
-- Atendente: no carrinho da conversa, "Fechar pedido" (escolhe tamanhos, quantidade e entrega) → o sistema cria o pedido com estoque
--          reservado por 24 h, gera o link na Stone e manda o resumo ao cliente → o pagamento cai sozinho (aviso da Stone), o pedido vira
--          pago e o atendente é avisado. Sem pagamento em 24 h, o pedido expira e vira tarefa de retomada (regra que já existia).

-- Cobrança online da Stone (checkout do Pagar.me): mesma tabela das cobranças da maquininha, então o aviso da Stone e a conferência
-- (syncStoneOrder → complete_stone_pos_payment → register_payment) já dão baixa no pedido.
alter table sales.stone_pos_orders drop constraint if exists stone_pos_orders_source_ck;
alter table sales.stone_pos_orders add constraint stone_pos_orders_source_ck check (source = any (array['CONNECT', 'DEEPLINK', 'LINK']));

-- Carrinho: peça que virou pedido sai da lista (status ORDERED) e guarda o pedido
alter table omni.cart_items add column if not exists order_id uuid references sales.orders (id) on delete set null;
alter table omni.cart_items drop constraint if exists cart_items_status_check;
alter table omni.cart_items add constraint cart_items_status_check check (status in ('ACTIVE', 'REMOVED', 'ORDERED'));

-- Carrinho com as variantes (tamanhos) de cada peça, para o atendente escolher o tamanho ao fechar o pedido
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
           'available', (select coalesce(sum((x ->> 'available')::numeric), 0) from jsonb_array_elements(vs.variants) x where ci.size is null or x ->> 'size' = ci.size),
           'sizes_in_stock', (select to_jsonb(private.sort_sizes(array_agg(x ->> 'size'))) from jsonb_array_elements(vs.variants) x where (x ->> 'available')::numeric > 0),
           'variants', vs.variants,
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
  left join lateral (
    select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'size', s.size, 'price', s.price, 'available', s.avail)
                              order by s.sort_key nulls last, s.size), '[]') as variants
    from (select v.id, v.size, catalog.current_price(v.id) as price,
                 coalesce((select sum(sl.available) from inv.stock_levels sl join inv.locations l on l.id = sl.location_id and l.is_sellable
                           and (v_store is null or l.store_id = v_store) where sl.variant_id = v.id), 0) as avail,
                 array_position(private.sort_sizes((select array_agg(v2.size) from catalog.variants v2 where v2.product_id = ci.product_id and v2.active
                                                     and (ci.color_id is null or v2.color_id = ci.color_id))), v.size) as sort_key
          from catalog.variants v
          where v.product_id = ci.product_id and v.active and (ci.color_id is null or v.color_id = ci.color_id)) s) vs on true
  where ci.conversation_id = cv.id and ci.status = 'ACTIVE';
  return v_items;
end $$;

-- "Fechar pedido": cria o pedido do cliente desta conversa (estoque reservado por 24 h, aguardando pagamento) a partir das peças
-- escolhidas no carrinho. p = {items: [{variant_id, qty, cart_item_id?}], fulfillment_type, shipping_total, notes}
create or replace function omni.cart_checkout(p_conversation uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare cv omni.conversations; ca omni.channel_accounts; o sales.orders; v_mode text := coalesce(nullif(p ->> 'fulfillment_type', ''), 'STORE_PICKUP');
        v_items jsonb;
begin
  perform private.require_perm('omni.write');
  select * into cv from omni.conversations where id = p_conversation;
  if cv.id is null or (coalesce(auth.role(), '') = 'authenticated' and cv.org_id <> private.org_id()) then
    raise exception 'Conversa não encontrada' using errcode = 'P0002';
  end if;
  select * into ca from omni.channel_accounts where id = cv.channel_account_id;
  if ca.store_id is null then raise exception 'O canal não tem loja de origem (Configurações › Integrações)' using errcode = '22023'; end if;
  if v_mode not in ('MOTOBOY', 'CARRIER', 'STORE_PICKUP', 'LOCKER_PICKUP') then raise exception 'Forma de entrega inválida' using errcode = '22023'; end if;
  select jsonb_agg(jsonb_build_object('variant_id', x ->> 'variant_id', 'qty', greatest(coalesce((x ->> 'qty')::numeric, 1), 1)))
    into v_items from jsonb_array_elements(coalesce(p -> 'items', '[]')) x where nullif(x ->> 'variant_id', '') is not null;
  if v_items is null then raise exception 'Escolha o tamanho de pelo menos uma peça' using errcode = '22023'; end if;

  o := sales.create_remote_order(jsonb_build_object(
         'idempotency_key', 'wa-checkout:' || cv.id || ':' || md5(v_items::text || v_mode || coalesce(p ->> 'shipping_total', '0') || date_trunc('minute', now())::text),
         'store_id', ca.store_id, 'channel', case when ca.channel::text in ('WHATSAPP', 'INSTAGRAM', 'TELEGRAM') then ca.channel::text else 'WHATSAPP' end,
         'party_id', cv.party_id, 'conversation_id', cv.id, 'items', v_items, 'fulfillment_type', v_mode,
         'shipping_total', least(greatest(coalesce((p ->> 'shipping_total')::numeric, 0), 0), 500),
         'notes', nullif(trim(coalesce(p ->> 'notes', '')), ''), 'draft', false, 'seller_member_id', coalesce(cv.assignee_member_id, private.member_id())));

  -- peças do carrinho que entraram no pedido saem da lista
  update omni.cart_items ci set status = 'ORDERED', order_id = o.id, updated_at = now()
  where ci.conversation_id = cv.id and ci.status = 'ACTIVE'
    and exists (select 1 from jsonb_array_elements(v_items) x join catalog.variants v on v.id = (x ->> 'variant_id')::uuid
                where v.product_id = ci.product_id and (ci.color_id is null or v.color_id = ci.color_id) and (ci.size is null or v.size = ci.size));

  return jsonb_build_object('order_id', o.id, 'number', o.number, 'subtotal', o.subtotal, 'discount', o.discount_total, 'shipping', o.shipping_total,
    'total', o.total, 'status', o.status, 'fulfillment_type', o.fulfillment_type,
    'expires_at', (select max(r.expires_at) from inv.reservations r where r.order_id = o.id and r.status = 'ACTIVE'),
    'items', (select jsonb_agg(jsonb_build_object('name', pr.name, 'color', col.name, 'size', v.size, 'qty', i.qty, 'unit_price', i.list_price, 'total', i.total) order by pr.name, v.size)
              from sales.order_items i join catalog.variants v on v.id = i.variant_id join catalog.products pr on pr.id = v.product_id
              left join catalog.colors col on col.id = v.color_id where i.order_id = o.id),
    'party_name', (select display_name from crm.parties where id = cv.party_id),
    'party_phone', private.party_wa_id(cv.party_id),
    'store_phone', ca.public_address);
end $$;

-- Link da Stone criado pela web: registra a cobrança online (para o aviso de pagamento dar baixa) e o link do pedido
create or replace function sales.attach_stone_link(p_order uuid, p_stone_order_id text, p_url text, p_max_installments integer default 1)
returns uuid language plpgsql security definer set search_path = '' as $$
declare o sales.orders; l sales.payment_links;
begin
  perform private.require_perm('sales.write');
  select * into o from sales.orders where id = p_order and org_id = coalesce(private.org_id(), org_id);
  if o.id is null then raise exception 'Pedido não encontrado' using errcode = 'P0002'; end if;
  if o.status <> 'PENDING_PAYMENT' then raise exception 'O pedido precisa estar aguardando pagamento' using errcode = 'P0004'; end if;
  update sales.payment_links set status = 'CANCELLED' where order_id = o.id and status in ('CREATED', 'SENT');
  insert into sales.payment_links (org_id, order_id, provider, external_id, url, amount, max_installments, expires_at, status)
  values (o.org_id, o.id, 'STONE', p_stone_order_id, p_url, o.total - o.paid_total, least(greatest(coalesce(p_max_installments, 1), 1), 12),
          (select max(r.expires_at) from inv.reservations r where r.order_id = o.id and r.status = 'ACTIVE'), 'SENT')
  returning * into l;
  insert into sales.stone_pos_orders (org_id, order_id, stone_order_id, terminal_serial, display_name, amount, method, installments, status, source, created_by)
  values (o.org_id, o.id, p_stone_order_id, 'ONLINE', 'Link WhatsApp ' || o.number, o.total - o.paid_total, 'PIX', 1, 'PENDING', 'LINK', auth.uid())
  on conflict (stone_order_id) do nothing;
  return l.id;
end $$;

-- Pago: o atendente da conversa é avisado (o cliente recebe o aviso ORDER_PAID, abaixo)
create or replace function private.notify_order_paid()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_member uuid;
begin
  if new.status = 'PAID' and old.status is distinct from 'PAID' and new.origin_conversation_id is not null then
    begin
      select assignee_member_id into v_member from omni.conversations where id = new.origin_conversation_id;
      perform core.notify(new.org_id, 'ORDER_PAID', 'Pagamento confirmado: pedido ' || new.number,
                          jsonb_build_object('order_id', new.id, 'conversation_id', new.origin_conversation_id, 'total', new.total),
                          case when v_member is null then 'sales.write' end, v_member);
    exception when others then
      raise warning 'aviso de pagamento do pedido % falhou: %', new.id, sqlerrm;
    end;
  end if;
  return null;
end $$;
drop trigger if exists trg_notify_order_paid on sales.orders;
create trigger trg_notify_order_paid after update of status on sales.orders for each row execute function private.notify_order_paid();

-- Aviso ao cliente quando o pagamento cai (o disparo já existia; faltava a regra). Editável em Atendimento › Avisos automáticos.
insert into omni.notice_rules (org_id, event, active, free_text)
select o.id, 'ORDER_PAID', true,
       'Pagamento confirmado ✅ Recebemos o pagamento do pedido {pedido}, {nome}! Já estamos separando tudo e te avisamos por aqui assim que estiver pronto. 💛'
from core.orgs o
where not exists (select 1 from omni.notice_rules r where r.org_id = o.id and r.event = 'ORDER_PAID');

insert into private.internal_functions (fqname) values ('private.notify_order_paid') on conflict do nothing;
select private.lock_functions();
