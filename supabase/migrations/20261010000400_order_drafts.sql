-- =====================================================================
-- Função para salvar e atualizar pedidos em andamento (DRAFT) tanto no balcão quanto remoto
-- =====================================================================

create or replace function sales.save_order_draft(p jsonb) returns sales.orders
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
  v_store core.stores;
  v_location uuid;
  v_price_list uuid;
  o sales.orders;
  it jsonb;
  v_order_id uuid := (p ->> 'order_id')::uuid;
  v_list numeric;
  v_unit numeric;
  v_disc numeric;
  v_qty numeric;
  v_subtotal numeric := 0;
  v_discount numeric := 0;
  v_shipping numeric := coalesce((p ->> 'shipping_total')::numeric, 0);
  v_desc_text text;
  v_coupon sales.coupons;
  v_coupon_disc numeric := 0;
  v_channel sales.channel := coalesce((p ->> 'channel')::sales.channel, 'POS');
  v_ff sales.fulfillment_type := coalesce((p ->> 'fulfillment_type')::sales.fulfillment_type, 'TAKEAWAY');
begin
  perform private.require_perm('sales.write');

  select * into v_store from core.stores where id = (p ->> 'store_id')::uuid;
  if v_store.id is null then raise exception 'Loja não encontrada' using errcode = '22023'; end if;
  v_org := v_store.org_id;
  if coalesce(auth.role(), '') = 'authenticated' then
    if v_org is distinct from private.org_id() or not private.can_store(v_store.id) then
      raise exception 'Sem acesso a esta loja' using errcode = '42501';
    end if;
  end if;

  v_location := coalesce(
    (p ->> 'location_id')::uuid,
    (select l.id from inv.locations l where l.store_id = v_store.id and l.kind = 'SALES_FLOOR' order by l.created_at limit 1),
    (select l.id from inv.locations l where l.store_id = v_store.id order by l.created_at limit 1),
    (select l.id from inv.locations l where l.org_id = v_org and l.kind = 'SALES_FLOOR' order by l.created_at limit 1),
    (select l.id from inv.locations l where l.org_id = v_org order by l.created_at limit 1)
  );

  if v_location is null then
    insert into inv.locations (org_id, store_id, legal_entity_id, name, kind, is_sellable)
    values (v_org, v_store.id, v_store.legal_entity_id, coalesce(v_store.name, 'Loja') || ' - Balcão', 'SALES_FLOOR', true)
    returning id into v_location;
  end if;

  select id into v_price_list from catalog.price_lists where org_id = v_org and is_default;

  -- Se foi passado order_id, verifica se o pedido existe e está em DRAFT
  if v_order_id is not null then
    select * into o from sales.orders where id = v_order_id and org_id = v_org for update;
    if o.id is null then raise exception 'Pedido não encontrado' using errcode = 'P0002'; end if;
    if o.status <> 'DRAFT' then raise exception 'Apenas pedidos em rascunho podem ser alterados' using errcode = 'P0093'; end if;

    update sales.orders
    set party_id = (p ->> 'party_id')::uuid,
        channel = v_channel,
        fulfillment_type = v_ff,
        shipping_total = v_shipping,
        notes = p ->> 'notes',
        location_id = coalesce(o.location_id, v_location)
    where id = o.id
    returning * into o;

    delete from sales.order_items where order_id = o.id;
    delete from sales.coupon_redemptions where order_id = o.id;
  else
    insert into sales.orders (
      org_id, legal_entity_id, store_id, location_id, number, channel, status,
      party_id, seller_member_id, profit_cost_center_id, price_list_id,
      fulfillment_type, created_by, notes, shipping_total, idempotency_key
    )
    values (
      v_org, v_store.legal_entity_id, v_store.id, v_location, core.next_number(v_org, 'VEN'),
      v_channel, 'DRAFT', (p ->> 'party_id')::uuid, private.member_id(),
      v_store.cost_center_id, v_price_list, v_ff, private.member_id(),
      p ->> 'notes', v_shipping, coalesce(p ->> 'idempotency_key', 'draft-' || gen_random_uuid())
    )
    returning * into o;
  end if;

  -- Gravar itens do pedido
  for it in select * from jsonb_array_elements(coalesce(p -> 'items', '[]'::jsonb)) loop
    v_qty := coalesce((it ->> 'qty')::numeric, 1);
    if v_qty <= 0 then v_qty := 1; end if;

    if (it ->> 'variant_id') is null then
      v_desc_text := trim(coalesce(it ->> 'description', 'Item avulso'));
      v_unit := coalesce((it ->> 'unit_price')::numeric, 0);
      v_list := coalesce((it ->> 'list_price')::numeric, v_unit);
      v_disc := coalesce((it ->> 'discount_amount')::numeric, 0);

      insert into sales.order_items (
        org_id, order_id, variant_id, description, qty, list_price, unit_price, discount_amount,
        discount_reason, total
      )
      values (
        v_org, o.id, null, v_desc_text, v_qty, v_list, v_unit, v_disc,
        it ->> 'discount_reason', round(v_list * v_qty - v_disc, 2)
      );
      v_subtotal := v_subtotal + v_list * v_qty;
      v_discount := v_discount + v_disc;
    else
      v_list := catalog.current_price((it ->> 'variant_id')::uuid, v_price_list);
      if v_list is null then v_list := coalesce((it ->> 'unit_price')::numeric, 0); end if;
      v_unit := coalesce((it ->> 'unit_price')::numeric, v_list);
      v_disc := coalesce((it ->> 'discount_amount')::numeric, 0);

      insert into sales.order_items (
        org_id, order_id, variant_id, description, qty, list_price, unit_price, discount_amount,
        discount_reason, total
      )
      values (
        v_org, o.id, (it ->> 'variant_id')::uuid, null, v_qty, v_list, v_unit, v_disc,
        it ->> 'discount_reason', round(v_list * v_qty - v_disc, 2)
      );
      v_subtotal := v_subtotal + v_list * v_qty;
      v_discount := v_discount + v_disc;
    end if;
  end loop;

  -- Cupom no rascunho
  if coalesce(p ->> 'coupon_code', '') <> '' then
    select * into v_coupon from sales.coupons
    where org_id = v_org and upper(code) = upper(p ->> 'coupon_code') and active
      and valid_from <= now() and (valid_to is null or valid_to > now());
    if v_coupon.id is not null then
      v_coupon_disc := round(case when v_coupon.kind = 'PERCENT' then (v_subtotal - v_discount) * v_coupon.value / 100
                                  else least(v_coupon.value, v_subtotal - v_discount) end, 2);
      v_discount := v_discount + v_coupon_disc;
      update sales.orders
      set coupon_id = v_coupon.id,
          attribution = attribution || jsonb_build_object('coupon', v_coupon.code, 'affiliate_party_id', v_coupon.affiliate_party_id)
      where id = o.id;
    end if;
  else
    update sales.orders set coupon_id = null where id = o.id;
  end if;

  update sales.orders
  set subtotal = round(v_subtotal, 2),
      discount_total = round(v_discount, 2),
      total = round(greatest(v_subtotal - v_discount + v_shipping, 0), 2)
  where id = o.id
  returning * into o;

  return o;
end $$;

-- 2) sales.discard_order_draft para excluir rascunho cancelado/limpo
create or replace function sales.discard_order_draft(p_order_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  o sales.orders;
begin
  perform private.require_perm('sales.write');
  select * into o from sales.orders where id = p_order_id for update;
  if o.id is null or o.status <> 'DRAFT' then
    return;
  end if;
  if coalesce(auth.role(), '') = 'authenticated' then
    if o.org_id is distinct from private.org_id() or not private.can_store(o.store_id) then
      raise exception 'Sem acesso a este pedido' using errcode = '42501';
    end if;
  end if;

  delete from sales.order_items where order_id = o.id;
  delete from sales.coupon_redemptions where order_id = o.id;
  delete from sales.orders where id = o.id;
end $$;

-- 3) sales.create_pos_order atualizado para reaproveitar rascunho existente (DRAFT) quando passado order_id
create or replace function sales.create_pos_order(p jsonb) returns sales.orders
language plpgsql security definer set search_path = '' as $$
declare
  v_store core.stores;
  v_org uuid;
  v_location uuid;
  v_price_list uuid;
  o sales.orders;
  it jsonb;
  pay jsonb;
  v_list numeric;
  v_unit numeric;
  v_disc numeric;
  v_qty numeric;
  v_subtotal numeric := 0;
  v_discount numeric := 0;
  v_paid numeric := 0;
  v_rate numeric;
  v_method text;
  v_inst int;
  v_mode text;
  v_coupon sales.coupons;
  v_coupon_disc numeric := 0;
  v_can_discount boolean;
  v_can_custom boolean;
  v_desc_text text;
  v_order_id uuid := (p ->> 'order_id')::uuid;
begin
  perform private.require_perm('sales.write');

  select * into v_store from core.stores where id = (p ->> 'store_id')::uuid;
  if v_store.id is null then raise exception 'Loja inválida' using errcode = '22023'; end if;
  v_org := v_store.org_id;
  if coalesce(auth.role(), '') = 'authenticated' then
    if v_org is distinct from private.org_id() or not private.can_store(v_store.id) then
      raise exception 'Sem acesso a esta loja' using errcode = '42501';
    end if;
  end if;

  select * into o from sales.orders where org_id = v_org and idempotency_key = p ->> 'idempotency_key';
  if o.id is not null then return o; end if;
  if coalesce(p ->> 'idempotency_key', '') = '' then raise exception 'idempotency_key obrigatório'; end if;
  if jsonb_array_length(coalesce(p -> 'items', '[]')) = 0 then raise exception 'Pedido sem itens'; end if;

  v_location := coalesce(
    (p ->> 'location_id')::uuid,
    (select l.id from inv.locations l where l.store_id = v_store.id and l.kind = 'SALES_FLOOR' order by l.created_at limit 1),
    (select l.id from inv.locations l where l.store_id = v_store.id order by l.created_at limit 1),
    (select l.id from inv.locations l where l.org_id = v_org and l.kind = 'SALES_FLOOR' order by l.created_at limit 1),
    (select l.id from inv.locations l where l.org_id = v_org order by l.created_at limit 1)
  );

  if v_location is null then
    insert into inv.locations (org_id, store_id, legal_entity_id, name, kind, is_sellable)
    values (v_org, v_store.id, v_store.legal_entity_id, coalesce(v_store.name, 'Loja') || ' - Balcão', 'SALES_FLOOR', true)
    returning id into v_location;
  end if;

  select id into v_price_list from catalog.price_lists where org_id = v_org and is_default;

  v_can_discount := coalesce(auth.role(), '') <> 'authenticated' or private.has_perm('sales.discount');
  v_can_custom := coalesce(auth.role(), '') <> 'authenticated' or private.has_perm('sales.custom_item') or private.has_perm('sales.write');

  if v_order_id is not null then
    select * into o from sales.orders where id = v_order_id and org_id = v_org for update;
    if o.id is null or o.status <> 'DRAFT' then
      v_order_id := null;
    else
      delete from sales.order_items where order_id = o.id;
      delete from sales.coupon_redemptions where order_id = o.id;
      delete from sales.payments where order_id = o.id;

      update sales.orders
      set status = 'CONFIRMED',
          store_id = v_store.id,
          location_id = v_location,
          party_id = (p ->> 'party_id')::uuid,
          seller_member_id = coalesce((p ->> 'seller_member_id')::uuid, private.member_id()),
          cash_session_id = (p ->> 'cash_session_id')::uuid,
          cpf_on_invoice = p ->> 'cpf_on_invoice',
          idempotency_key = p ->> 'idempotency_key',
          price_list_id = v_price_list,
          channel = coalesce((p ->> 'channel')::sales.channel, 'POS'),
          fulfillment_type = 'TAKEAWAY',
          attribution = coalesce(p -> 'attribution', '{}')
      where id = o.id
      returning * into o;
    end if;
  end if;

  if v_order_id is null then
    insert into sales.orders (org_id, legal_entity_id, store_id, location_id, number, channel, status, party_id,
                              seller_member_id, profit_cost_center_id, price_list_id, cash_session_id, cpf_on_invoice,
                              idempotency_key, created_by, attribution)
    values (v_org, v_store.legal_entity_id, v_store.id, v_location, core.next_number(v_org, 'VEN'),
            coalesce((p ->> 'channel')::sales.channel, 'POS'), 'CONFIRMED', (p ->> 'party_id')::uuid,
            coalesce((p ->> 'seller_member_id')::uuid, private.member_id()), v_store.cost_center_id, v_price_list,
            (p ->> 'cash_session_id')::uuid, p ->> 'cpf_on_invoice', p ->> 'idempotency_key', private.member_id(),
            coalesce(p -> 'attribution', '{}'))
    returning * into o;
  end if;

  for it in select * from jsonb_array_elements(p -> 'items') loop
    v_qty := (it ->> 'qty')::numeric;
    if v_qty <= 0 then raise exception 'Quantidade inválida no pedido'; end if;

    if (it ->> 'variant_id') is null then
      -- Item avulso (fora do estoque)
      if not v_can_custom then
        raise exception 'Inclusão de item avulso exige permissão sales.custom_item' using errcode = '42501';
      end if;
      v_desc_text := trim(coalesce(it ->> 'description', ''));
      if v_desc_text = '' then raise exception 'Item avulso precisa de descrição' using errcode = '22023'; end if;
      v_unit := coalesce((it ->> 'unit_price')::numeric, 0);
      if v_unit < 0 then raise exception 'Preço inválido para o item avulso'; end if;
      v_list := coalesce((it ->> 'list_price')::numeric, v_unit);
      v_disc := coalesce((it ->> 'discount_amount')::numeric, 0) + greatest(v_list - v_unit, 0) * v_qty;
      if v_disc > 0 and not v_can_discount then
        raise exception 'Desconto exige permissão sales.discount' using errcode = '42501';
      end if;

      insert into sales.order_items (org_id, order_id, variant_id, description, qty, list_price, unit_price, discount_amount,
                                     discount_reason, total, reservation_id)
      values (v_org, o.id, null, v_desc_text, v_qty, v_list, v_list, v_disc, it ->> 'discount_reason',
              round(v_list * v_qty - v_disc, 2), null);
      v_subtotal := v_subtotal + v_list * v_qty;
      v_discount := v_discount + v_disc;
    else
      -- Item regular do catálogo
      v_list := catalog.current_price((it ->> 'variant_id')::uuid, v_price_list);
      if v_list is null then raise exception 'Variante % sem preço vigente', it ->> 'variant_id' using errcode = 'P0007'; end if;
      v_unit := coalesce((it ->> 'unit_price')::numeric, v_list);
      v_disc := coalesce((it ->> 'discount_amount')::numeric, 0) + greatest(v_list - v_unit, 0) * v_qty;
      if v_disc > 0 and not v_can_discount then
        raise exception 'Desconto exige permissão sales.discount' using errcode = '42501';
      end if;

      insert into sales.order_items (org_id, order_id, variant_id, description, qty, list_price, unit_price, discount_amount,
                                     discount_reason, total, reservation_id)
      values (v_org, o.id, (it ->> 'variant_id')::uuid, null, v_qty, v_list, v_list, v_disc, it ->> 'discount_reason',
              round(v_list * v_qty - v_disc, 2), (it ->> 'reservation_id')::uuid);
      v_subtotal := v_subtotal + v_list * v_qty;
      v_discount := v_discount + v_disc;
    end if;
  end loop;

  -- Cupom (percentual ou valor) sobre o subtotal líquido
  if coalesce(p ->> 'coupon_code', '') <> '' then
    select * into v_coupon from sales.coupons
    where org_id = v_org and upper(code) = upper(p ->> 'coupon_code') and active
      and valid_from <= now() and (valid_to is null or valid_to > now());
    if v_coupon.id is null then raise exception 'Cupom inválido ou expirado' using errcode = 'P0008'; end if;
    if v_coupon.min_order is not null and v_subtotal - v_discount < v_coupon.min_order then
      raise exception 'Pedido abaixo do mínimo do cupom' using errcode = 'P0008';
    end if;
    v_coupon_disc := round(case when v_coupon.kind = 'PERCENT' then (v_subtotal - v_discount) * v_coupon.value / 100
                                else least(v_coupon.value, v_subtotal - v_discount) end, 2);
    v_discount := v_discount + v_coupon_disc;
    insert into sales.coupon_redemptions (org_id, coupon_id, order_id, party_id, amount)
    values (v_org, v_coupon.id, o.id, o.party_id, v_coupon_disc);
    update sales.orders set coupon_id = v_coupon.id,
      attribution = attribution || jsonb_build_object('coupon', v_coupon.code, 'affiliate_party_id', v_coupon.affiliate_party_id)
    where id = o.id;
  end if;

  for pay in select * from jsonb_array_elements(coalesce(p -> 'payments', '[]')) loop
    v_method := pay ->> 'method';
    v_inst := coalesce((pay ->> 'installments')::int, 1);
    v_mode := case when v_method in ('DEBIT', 'CREDIT', 'PAYMENT_LINK') then coalesce(pay ->> 'anticipation_mode', 'D1') end;
    v_rate := case when v_method in ('DEBIT', 'CREDIT', 'PAYMENT_LINK', 'PIX') and pay ->> 'acquirer' is not null then
                fin.expected_fee_rate(v_org, pay ->> 'acquirer', case when v_method = 'PAYMENT_LINK' then 'CREDIT' else v_method end,
                                      v_inst, coalesce(v_mode, 'NATURAL'))
              end;
    insert into sales.payments (org_id, order_id, method, amount, installments, acquirer, terminal_id, nsu, auth_code,
                                brand, last4, anticipation_mode, fee_rate_expected, fee_expected, net_expected)
    values (v_org, o.id, v_method::sales.payment_method, (pay ->> 'amount')::numeric, v_inst, pay ->> 'acquirer',
            pay ->> 'terminal_id', pay ->> 'nsu', pay ->> 'auth_code', pay ->> 'brand', pay ->> 'last4', v_mode, v_rate,
            round((pay ->> 'amount')::numeric * coalesce(v_rate, 0) / 100, 2),
            (pay ->> 'amount')::numeric - round((pay ->> 'amount')::numeric * coalesce(v_rate, 0) / 100, 2));
    v_paid := v_paid + (pay ->> 'amount')::numeric;
  end loop;

  -- Troco em dinheiro: pago acima do total só é aceito quando há dinheiro, e vira movimento CHANGE
  if v_paid > round(v_subtotal - v_discount, 2) then
    if not exists (select 1 from jsonb_array_elements(p -> 'payments') x where x ->> 'method' = 'CASH') then
      raise exception 'Pagamento acima do total sem dinheiro para troco' using errcode = 'P0005';
    end if;
    insert into sales.cash_session_movements (org_id, session_id, type, amount, order_id, created_by)
    values (v_org, (p ->> 'cash_session_id')::uuid, 'CHANGE', -(v_paid - round(v_subtotal - v_discount, 2)), o.id, private.member_id());
    v_paid := round(v_subtotal - v_discount, 2);
  end if;

  update sales.orders set subtotal = round(v_subtotal, 2), discount_total = round(v_discount, 2),
         total = round(v_subtotal - v_discount, 2), paid_total = round(v_paid, 2)
  where id = o.id returning * into o;

  insert into sales.order_credits (order_id, org_id, member_id, role, share_pct)
  values (o.id, v_org, o.seller_member_id, case when o.seller_member_id is null then 'HOUSE' else 'CLOSER' end, 100);

  return sales.finalize_order(o.id);
end $$;
