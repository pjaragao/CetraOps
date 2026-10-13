-- =====================================================================
-- Encomenda dentro do PDV: o carrinho mistura peça em estoque, peça a encomendar, item avulso, desconto e cupom
--  • Peça com estoque na loja fica reservada para a cliente (sem prazo, como o resto da encomenda); só o que falta entra no
--    pedido de compra. Quantidade maior que o estoque divide a linha: o que tem fica reservado, o resto é encomendado.
--  • Produto não liberado para encomenda só entra se a loja tiver a quantidade inteira (P0352 senão).
--  • Desconto por linha, cupom e item avulso seguem as regras do pedido de balcão/remoto (permissões sales.discount e
--    sales.custom_item; cupom sobre o subtotal líquido).
--  • O fornecedor das encomendas só é exigido quando alguma peça precisa ser pedida; o pedido de compra só é aberto nesse caso.
--  • A encomenda passa a gravar crédito do vendedor (comissão), centro de resultado e tabela de preço, como as outras vendas.
--  • Se nada precisou ser encomendado (o estoque chegou entre a tela e o envio), as reservas valem 24 h como no pedido remoto.
--  • idempotency_key opcional: reenviar a mesma chave (duplo clique, rede lenta) devolve a encomenda já criada.
-- Códigos: P0350 dado inválido · P0351 configuração faltando · P0352 situação não permite · P0008 desconto/cupom inválido.
-- =====================================================================

create or replace function sales.create_backorder(p jsonb) returns sales.orders
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id(); s core.stores; o sales.orders; po purch.purchase_orders; it jsonb; v record; v_loc uuid; v_supplier uuid; v_price_list uuid;
  v_list numeric; v_unit numeric; v_qty numeric; v_disc numeric; v_disc_a numeric; v_av numeric; v_res_qty numeric; v_bo_qty numeric;
  v_item uuid; v_res inv.reservations; v_cost numeric; v_subtotal numeric := 0; v_discount numeric := 0; v_coupon sales.coupons; v_cdisc numeric;
  v_can_discount boolean; v_can_custom boolean; v_desc text; v_party text; v_task uuid; v_lines text := ''; v_ordered boolean := false;
begin
  perform private.require_perm('sales.write');
  select * into s from core.stores where id = (p ->> 'store_id')::uuid and org_id = v_org;
  if s.id is null then raise exception 'Loja não encontrada' using errcode = 'P0350'; end if;
  if coalesce(auth.role(), '') = 'authenticated' and not private.can_store(s.id) then raise exception 'Sem acesso à loja' using errcode = '42501'; end if;
  select display_name into v_party from crm.parties where id = (p ->> 'party_id')::uuid and org_id = v_org;
  if v_party is null then raise exception 'Escolha a cliente da encomenda' using errcode = 'P0350'; end if;
  if jsonb_array_length(coalesce(p -> 'items', '[]')) = 0 then raise exception 'Escolha ao menos uma peça' using errcode = 'P0350'; end if;
  if nullif(p ->> 'idempotency_key', '') is not null then
    select * into o from sales.orders where org_id = v_org and idempotency_key = 'encomenda:' || (p ->> 'idempotency_key');
    if o.id is not null then return o; end if;
  end if;
  v_loc := (select id from inv.locations where store_id = s.id and kind = 'SALES_FLOOR' order by created_at limit 1);
  if v_loc is null then raise exception 'Loja sem local de venda' using errcode = 'P0351'; end if;
  select id into v_price_list from catalog.price_lists where org_id = v_org and is_default;
  v_can_discount := coalesce(auth.role(), '') <> 'authenticated' or private.has_perm('sales.discount');
  v_can_custom := coalesce(auth.role(), '') <> 'authenticated' or private.has_perm('sales.custom_item');

  insert into sales.orders (org_id, legal_entity_id, store_id, location_id, number, channel, status, party_id, seller_member_id, profit_cost_center_id,
                            price_list_id, fulfillment_type, subtotal, total, idempotency_key, notes, created_by)
  values (v_org, s.legal_entity_id, s.id, v_loc, core.next_number(v_org, 'VEN'), coalesce(nullif(p ->> 'channel', ''), 'POS')::sales.channel, 'PENDING_PAYMENT',
          (p ->> 'party_id')::uuid, private.member_id(), s.cost_center_id, v_price_list, 'TAKEAWAY', 0, 0, 'encomenda:' || coalesce(nullif(p ->> 'idempotency_key', ''), gen_random_uuid()::text),
          concat_ws(' · ', 'ENCOMENDA (peças a pedir ao fornecedor)', nullif(trim(coalesce(p ->> 'notes', '')), '')), private.member_id())
  returning * into o;

  for it in select * from jsonb_array_elements(p -> 'items') loop
    v_qty := coalesce(nullif(it ->> 'qty', '')::numeric, 1);
    if v_qty <= 0 or v_qty <> trunc(v_qty) or v_qty > 50 then raise exception 'Quantidade inválida' using errcode = 'P0350'; end if;

    if nullif(it ->> 'variant_id', '') is null then
      -- item avulso (serviço ou peça fora do cadastro): não tem estoque nem vai ao pedido de compra
      if not v_can_custom then raise exception 'Inclusão de item avulso exige permissão sales.custom_item' using errcode = '42501'; end if;
      v_desc := trim(coalesce(it ->> 'description', ''));
      if v_desc = '' then raise exception 'Item avulso precisa de descrição' using errcode = 'P0350'; end if;
      v_unit := coalesce(nullif(it ->> 'unit_price', '')::numeric, 0);
      if v_unit < 0 then raise exception 'Preço inválido' using errcode = 'P0350'; end if;
      v_list := coalesce(nullif(it ->> 'list_price', '')::numeric, v_unit);
      v_disc := coalesce(nullif(it ->> 'discount_amount', '')::numeric, 0) + greatest(v_list - v_unit, 0) * v_qty;
      if coalesce(nullif(it ->> 'discount_amount', '')::numeric, 0) < 0 or v_disc > round(v_list * v_qty, 2) then
        raise exception 'Desconto inválido: maior que o valor do item ou negativo' using errcode = 'P0008';
      end if;
      if v_disc > 0 and not v_can_discount then raise exception 'Desconto exige permissão sales.discount' using errcode = '42501'; end if;
      insert into sales.order_items (org_id, order_id, variant_id, description, qty, list_price, unit_price, discount_amount, discount_reason, total, ncm)
      values (v_org, o.id, null, v_desc, v_qty, v_list, v_list, v_disc, nullif(it ->> 'discount_reason', ''), round(v_list * v_qty - v_disc, 2), private.clean_ncm(it ->> 'ncm'));
      v_subtotal := v_subtotal + v_list * v_qty; v_discount := v_discount + v_disc;
      continue;
    end if;

    select va.id, va.sku, pr.name, pr.backorder, c.name as color, va.size into v from catalog.variants va join catalog.products pr on pr.id = va.product_id
      left join catalog.colors c on c.id = va.color_id where va.id = (it ->> 'variant_id')::uuid and va.org_id = v_org;
    if v.id is null then raise exception 'Peça não encontrada' using errcode = 'P0350'; end if;
    v_list := catalog.current_price(v.id, v_price_list);
    if v_list is null or v_list <= 0 then raise exception '% (%) está sem preço', v.name, v.sku using errcode = 'P0350'; end if;
    v_unit := coalesce(nullif(it ->> 'unit_price', '')::numeric, v_list);
    v_disc := coalesce(nullif(it ->> 'discount_amount', '')::numeric, 0) + greatest(v_list - v_unit, 0) * v_qty;
    if coalesce(nullif(it ->> 'discount_amount', '')::numeric, 0) < 0 or v_disc > round(v_list * v_qty, 2) then
      raise exception 'Desconto inválido: maior que o valor do item ou negativo' using errcode = 'P0008';
    end if;
    if v_disc > 0 and not v_can_discount then raise exception 'Desconto exige permissão sales.discount' using errcode = '42501'; end if;

    -- o que a loja tem fica reservado; o que falta (só de produto liberado) vai ao pedido de compra
    select floor(greatest(sl.available, 0)) into v_av from inv.stock_levels sl where sl.location_id = v_loc and sl.variant_id = v.id for update;
    v_av := coalesce(v_av, 0);
    v_res_qty := least(v_av, v_qty);
    v_bo_qty := v_qty - v_res_qty;
    if v_bo_qty > 0 and not v.backorder then
      raise exception '% (%) não está liberado para encomenda e a loja tem % na quantidade pedida (%)', v.name, v.sku, v_av::int, v_qty::int using errcode = 'P0352';
    end if;
    v_disc_a := case when v_bo_qty = 0 then v_disc else round(v_disc * v_res_qty / v_qty, 2) end;

    if v_res_qty > 0 then
      insert into sales.order_items (org_id, order_id, variant_id, qty, list_price, unit_price, discount_amount, discount_reason, total)
      values (v_org, o.id, v.id, v_res_qty, v_list, v_list, v_disc_a, nullif(it ->> 'discount_reason', ''), round(v_list * v_res_qty - v_disc_a, 2)) returning id into v_item;
      insert into inv.reservations (org_id, variant_id, location_id, qty, reason, order_id, party_id, created_by_kind)
      values (v_org, v.id, v_loc, v_res_qty, 'ORDER', o.id, o.party_id, 'HUMAN') returning * into v_res;
      update sales.order_items set reservation_id = v_res.id where id = v_item;
    end if;

    if v_bo_qty > 0 then
      if po.id is null then
        select (value ->> 'supplier_party_id')::uuid into v_supplier from core.settings where org_id = v_org and key = 'backorders';
        if v_supplier is null then raise exception 'Defina o fornecedor das encomendas (Vender › Encomendas)' using errcode = 'P0351'; end if;
        -- pedido de compra em rascunho do fornecedor nesta loja (complementa) ou um novo
        select * into po from purch.purchase_orders where org_id = v_org and supplier_party_id = v_supplier and store_id = s.id and status = 'DRAFT'
        order by created_at limit 1 for update;
        if po.id is null then
          insert into purch.purchase_orders (org_id, legal_entity_id, location_id, store_id, supplier_party_id, number, notes, total, created_by)
          values (v_org, s.legal_entity_id, v_loc, s.id, v_supplier, core.next_number(v_org, 'PC'), 'Encomendas de clientes (gerado pelo sistema)', 0, private.member_id())
          returning * into po;
        end if;
      end if;
      insert into sales.order_items (org_id, order_id, variant_id, qty, list_price, unit_price, discount_amount, discount_reason, total)
      values (v_org, o.id, v.id, v_bo_qty, v_list, v_list, v_disc - v_disc_a, nullif(it ->> 'discount_reason', ''), round(v_list * v_bo_qty - (v_disc - v_disc_a), 2)) returning id into v_item;
      insert into sales.backorder_items (org_id, order_id, order_item_id, variant_id, qty, po_id) values (v_org, o.id, v_item, v.id, v_bo_qty, po.id);
      v_ordered := true;

      -- custo no pedido de compra: último custo conhecido → preço de catálogo (sem desconto) → zero
      v_cost := coalesce((select coalesce(ic.last_cost, nullif(ic.avg_cost, 0)) from inv.item_costs ic where ic.variant_id = v.id and ic.legal_entity_id = s.legal_entity_id),
                         v_list, 0);
      if exists (select 1 from purch.po_items where po_id = po.id and variant_id = v.id) then
        update purch.po_items set qty_ordered = qty_ordered + v_bo_qty where po_id = po.id and variant_id = v.id;
      else
        insert into purch.po_items (org_id, po_id, variant_id, qty_ordered, unit_cost) values (v_org, po.id, v.id, v_bo_qty, v_cost);
      end if;
      v_lines := v_lines || format(E'\n%s × %s %s %s (%s)', v_bo_qty::int, v.name, coalesce(v.color, ''), v.size, v.sku);
    end if;
    v_subtotal := v_subtotal + v_list * v_qty; v_discount := v_discount + v_disc;
  end loop;

  -- cupom (percentual ou valor) sobre o subtotal líquido, como na venda de balcão
  if coalesce(p ->> 'coupon_code', '') <> '' then
    select * into v_coupon from sales.coupons where org_id = v_org and upper(code) = upper(p ->> 'coupon_code') and active and valid_from <= now() and (valid_to is null or valid_to > now());
    if v_coupon.id is null then raise exception 'Cupom inválido ou expirado' using errcode = 'P0008'; end if;
    if v_coupon.min_order is not null and v_subtotal - v_discount < v_coupon.min_order then raise exception 'Pedido abaixo do mínimo do cupom' using errcode = 'P0008'; end if;
    v_cdisc := round(case when v_coupon.kind = 'PERCENT' then (v_subtotal - v_discount) * v_coupon.value / 100 else least(v_coupon.value, v_subtotal - v_discount) end, 2);
    v_discount := v_discount + v_cdisc;
    insert into sales.coupon_redemptions (org_id, coupon_id, order_id, party_id, amount) values (v_org, v_coupon.id, o.id, o.party_id, v_cdisc);
    update sales.orders set coupon_id = v_coupon.id, attribution = attribution || jsonb_build_object('coupon', v_coupon.code, 'affiliate_party_id', v_coupon.affiliate_party_id) where id = o.id;
  end if;

  update sales.orders set subtotal = round(v_subtotal, 2), discount_total = round(v_discount, 2), total = round(v_subtotal - v_discount, 2)
  where id = o.id returning * into o;
  insert into sales.order_credits (order_id, org_id, member_id, role, share_pct)
  values (o.id, v_org, o.seller_member_id, case when o.seller_member_id is null then 'HOUSE' else 'CLOSER' end, 100);

  if po.id is not null then
    update purch.purchase_orders set
      total = (select coalesce(sum(qty_ordered * unit_cost), 0) from purch.po_items where po_id = po.id),
      notes = left(concat_ws(E'\n', notes, format('Encomenda %s — %s:%s', o.number, v_party, v_lines)), 4000)
    where id = po.id;
    select id into v_task from crm.tasks where source_rule = 'po_close:' || po.id and status = 'OPEN';
    if v_task is null then
      insert into crm.tasks (org_id, type, title, body, due_at, source_rule)
      values (v_org, 'FOLLOW_UP', 'Fechar o pedido de compra ' || po.number || ' (encomendas de clientes)',
              'Peças encomendadas por clientes entraram no pedido de compra em rascunho. Confira, aprove e envie ao fornecedor (Produtos › Pedidos de compra).',
              ((current_date + 1)::timestamp + time '12:00') at time zone 'America/Sao_Paulo', 'po_close:' || po.id);
    end if;
  end if;
  if not v_ordered then
    update inv.reservations set expires_at = now() + interval '24 hours' where order_id = o.id and status = 'ACTIVE';
  end if;
  return o;
end $$;

select private.lock_functions();
