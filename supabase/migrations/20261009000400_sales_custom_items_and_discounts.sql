-- =====================================================================
-- Permissão de item avulso e descontos granulares nas vendas
-- =====================================================================

-- 1) Permitir item avulso fora do estoque em sales.order_items
alter table sales.order_items alter column variant_id drop not null;
alter table sales.order_items add column if not exists description text;

alter table sales.order_items drop constraint if exists order_items_variant_or_description_check;
alter table sales.order_items add constraint order_items_variant_or_description_check
  check (variant_id is not null or coalesce(trim(description), '') <> '');

-- 2) Catálogo de permissões
update core.permission_catalog
set label = 'Dar descontos na venda',
    description = 'Permite aplicar descontos manuais em % ou R$ nos itens ou no total da venda.'
where key = 'sales.discount';

insert into core.permission_catalog (key, area, label, description, position)
values ('sales.custom_item', 'Vendas', 'Adicionar item avulso', 'Permite incluir produtos ou serviços avulsos fora do estoque com preço manual no PDV e pedidos.', 43)
on conflict (key) do update set label = excluded.label, description = excluded.description, position = excluded.position;

-- Vincula sales.custom_item para perfis que já vendem para manter compatibilidade
insert into core.role_permissions (role_id, permission_key)
select distinct r.id, 'sales.custom_item'
from core.roles r
join core.role_permissions rp on rp.role_id = r.id
where rp.permission_key = 'sales.write'
on conflict do nothing;

-- 3) sales.create_pos_order atualizado para suportar itens avulsos e descontos granulares
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

  v_location := coalesce((p ->> 'location_id')::uuid,
    (select l.id from inv.locations l where l.store_id = v_store.id and l.kind = 'SALES_FLOOR' order by l.created_at limit 1));
  if v_location is null then raise exception 'Loja sem local de estoque de venda'; end if;
  select id into v_price_list from catalog.price_lists where org_id = v_org and is_default;

  v_can_discount := coalesce(auth.role(), '') <> 'authenticated' or private.has_perm('sales.discount');
  v_can_custom := coalesce(auth.role(), '') <> 'authenticated' or private.has_perm('sales.custom_item') or private.has_perm('sales.write');

  insert into sales.orders (org_id, legal_entity_id, store_id, location_id, number, channel, status, party_id,
                            seller_member_id, profit_cost_center_id, price_list_id, cash_session_id, cpf_on_invoice,
                            idempotency_key, created_by, attribution)
  values (v_org, v_store.legal_entity_id, v_store.id, v_location, core.next_number(v_org, 'VEN'),
          coalesce((p ->> 'channel')::sales.channel, 'POS'), 'CONFIRMED', (p ->> 'party_id')::uuid,
          coalesce((p ->> 'seller_member_id')::uuid, private.member_id()), v_store.cost_center_id, v_price_list,
          (p ->> 'cash_session_id')::uuid, p ->> 'cpf_on_invoice', p ->> 'idempotency_key', private.member_id(),
          coalesce(p -> 'attribution', '{}'))
  returning * into o;

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

-- 4) sales.create_remote_order atualizado
create or replace function sales.create_remote_order(p jsonb) returns sales.orders
language plpgsql security definer set search_path = '' as $$
declare
  v_store core.stores; v_org uuid; v_location uuid; v_price_list uuid; o sales.orders; it jsonb; v_list numeric; v_unit numeric; v_qty numeric; v_disc numeric;
  v_subtotal numeric := 0; v_discount numeric := 0; v_shipping numeric := coalesce((p ->> 'shipping_total')::numeric, 0); v_coupon sales.coupons; v_cdisc numeric;
  v_can_discount boolean; v_can_custom boolean; v_res inv.reservations; v_hours int := coalesce((p ->> 'hold_hours')::int, case when coalesce((p ->> 'draft')::boolean, false) then 2 else 24 end); v_item uuid; v_ai boolean := coalesce((p ->> 'assisted_by_ai')::boolean, false);
  v_desc_text text;
begin
  perform private.require_perm('sales.write');
  select * into v_store from core.stores where id = (p ->> 'store_id')::uuid;
  if v_store.id is null then raise exception 'Loja inválida' using errcode = '22023'; end if;
  v_org := v_store.org_id;
  if coalesce(auth.role(), '') = 'authenticated' and (v_org is distinct from private.org_id() or not private.can_store(v_store.id)) then raise exception 'Sem acesso a esta loja' using errcode = '42501'; end if;
  if coalesce(p ->> 'idempotency_key', '') = '' then raise exception 'idempotency_key obrigatório'; end if;
  select * into o from sales.orders where org_id = v_org and idempotency_key = p ->> 'idempotency_key';
  if o.id is not null then return o; end if;
  if jsonb_array_length(coalesce(p -> 'items', '[]')) = 0 then raise exception 'Pedido sem itens'; end if;
  if (p ->> 'channel') is not null and (p ->> 'channel') = 'POS' then raise exception 'Use o PDV para vendas de balcão'; end if;

  v_location := coalesce((p ->> 'location_id')::uuid, (select l.id from inv.locations l where l.store_id = v_store.id and l.kind = 'SALES_FLOOR' order by l.created_at limit 1));
  if v_location is null then raise exception 'Loja sem local de estoque de venda'; end if;
  select id into v_price_list from catalog.price_lists where org_id = v_org and is_default;
  v_can_discount := coalesce(auth.role(), '') <> 'authenticated' or private.has_perm('sales.discount');
  v_can_custom := coalesce(auth.role(), '') <> 'authenticated' or private.has_perm('sales.custom_item') or private.has_perm('sales.write');

  insert into sales.orders (org_id, legal_entity_id, store_id, location_id, number, channel, status, party_id, seller_member_id, profit_cost_center_id,
                            price_list_id, origin_conversation_id, assisted_by_ai, fulfillment_type, idempotency_key, created_by, attribution, notes)
  values (v_org, v_store.legal_entity_id, v_store.id, v_location, core.next_number(v_org, 'VEN'), coalesce((p ->> 'channel')::sales.channel, 'WHATSAPP'),
          case when coalesce((p ->> 'draft')::boolean, false) then 'DRAFT'::sales.order_status else 'PENDING_PAYMENT'::sales.order_status end,
          (p ->> 'party_id')::uuid, coalesce((p ->> 'seller_member_id')::uuid, private.member_id()),
          coalesce((select s.cost_center_id from core.stores s where s.id = v_store.id), null), v_price_list, (p ->> 'conversation_id')::uuid, v_ai,
          coalesce((p ->> 'fulfillment_type')::sales.fulfillment_type, 'MOTOBOY'), p ->> 'idempotency_key', private.member_id(), coalesce(p -> 'attribution', '{}'), p ->> 'notes')
  returning * into o;

  update sales.orders set profit_cost_center_id = coalesce(
    (select cc.id from core.cost_centers cc where cc.store_id = v_store.id and cc.kind = 'CHANNEL' and cc.channel = 'DIGITAL' limit 1),
    (select cc.id from core.cost_centers cc join core.cost_centers par on par.id = cc.parent_id where par.store_id = v_store.id and cc.kind = 'CHANNEL' and cc.code ilike '%DIGITAL%' limit 1),
    profit_cost_center_id) where id = o.id;

  for it in select * from jsonb_array_elements(p -> 'items') loop
    v_qty := (it ->> 'qty')::numeric;
    if v_qty <= 0 then raise exception 'Quantidade inválida'; end if;

    if (it ->> 'variant_id') is null then
      if not v_can_custom then raise exception 'Inclusão de item avulso exige permissão sales.custom_item' using errcode = '42501'; end if;
      v_desc_text := trim(coalesce(it ->> 'description', ''));
      if v_desc_text = '' then raise exception 'Item avulso precisa de descrição' using errcode = '22023'; end if;
      v_unit := coalesce((it ->> 'unit_price')::numeric, 0);
      if v_unit < 0 then raise exception 'Preço inválido'; end if;
      v_list := coalesce((it ->> 'list_price')::numeric, v_unit);
      v_disc := coalesce((it ->> 'discount_amount')::numeric, 0) + greatest(v_list - v_unit, 0) * v_qty;
      if v_disc > 0 and not v_can_discount then raise exception 'Desconto exige permissão sales.discount' using errcode = '42501'; end if;

      insert into sales.order_items (org_id, order_id, variant_id, description, qty, list_price, unit_price, discount_amount, total)
      values (v_org, o.id, null, v_desc_text, v_qty, v_list, v_list, v_disc, round(v_list * v_qty - v_disc, 2));
      v_subtotal := v_subtotal + v_list * v_qty; v_discount := v_discount + v_disc;
    else
      v_list := catalog.current_price((it ->> 'variant_id')::uuid, v_price_list);
      if v_list is null then raise exception 'Variante % sem preço vigente', it ->> 'variant_id' using errcode = 'P0007'; end if;
      v_unit := coalesce((it ->> 'unit_price')::numeric, v_list);
      v_disc := coalesce((it ->> 'discount_amount')::numeric, 0) + greatest(v_list - v_unit, 0) * v_qty;
      if v_disc > 0 and not v_can_discount then raise exception 'Desconto exige permissão sales.discount' using errcode = '42501'; end if;
      insert into sales.order_items (org_id, order_id, variant_id, description, qty, list_price, unit_price, discount_amount, total)
      values (v_org, o.id, (it ->> 'variant_id')::uuid, null, v_qty, v_list, v_list, v_disc, round(v_list * v_qty - v_disc, 2)) returning id into v_item;

      insert into inv.reservations (org_id, variant_id, location_id, qty, reason, order_id, party_id, conversation_id, expires_at, created_by_kind)
      values (v_org, (it ->> 'variant_id')::uuid, v_location, v_qty, 'ORDER', o.id, o.party_id, o.origin_conversation_id, now() + make_interval(hours => v_hours),
              case when v_ai then 'AI' else 'HUMAN' end) returning * into v_res;
      update sales.order_items set reservation_id = v_res.id where id = v_item;
      v_subtotal := v_subtotal + v_list * v_qty; v_discount := v_discount + v_disc;
    end if;
  end loop;

  if coalesce(p ->> 'coupon_code', '') <> '' then
    select * into v_coupon from sales.coupons where org_id = v_org and upper(code) = upper(p ->> 'coupon_code') and active and valid_from <= now() and (valid_to is null or valid_to > now());
    if v_coupon.id is null then raise exception 'Cupom inválido ou expirado' using errcode = 'P0008'; end if;
    if v_coupon.min_order is not null and v_subtotal - v_discount < v_coupon.min_order then raise exception 'Pedido abaixo do mínimo do cupom' using errcode = 'P0008'; end if;
    v_cdisc := round(case when v_coupon.kind = 'PERCENT' then (v_subtotal - v_discount) * v_coupon.value / 100 else least(v_coupon.value, v_subtotal - v_discount) end, 2);
    v_discount := v_discount + v_cdisc;
    insert into sales.coupon_redemptions (org_id, coupon_id, order_id, party_id, amount) values (v_org, v_coupon.id, o.id, o.party_id, v_cdisc);
    update sales.orders set coupon_id = v_coupon.id, attribution = attribution || jsonb_build_object('coupon', v_coupon.code, 'affiliate_party_id', v_coupon.affiliate_party_id) where id = o.id;
  end if;

  update sales.orders set subtotal = round(v_subtotal, 2), discount_total = round(v_discount, 2), shipping_total = round(v_shipping, 2),
         total = round(v_subtotal - v_discount + v_shipping, 2) where id = o.id returning * into o;
  insert into sales.order_credits (order_id, org_id, member_id, role, share_pct)
  values (o.id, v_org, case when v_ai then null else o.seller_member_id end, case when v_ai then 'AI' when o.seller_member_id is null then 'HOUSE' else 'CLOSER' end, 100);
  return o;
end $$;

-- 5) sales.finalize_order atualizado para ignorar itens sem estoque
create or replace function sales.finalize_order(p_order uuid) returns sales.orders
language plpgsql security definer set search_path = '' as $$
declare
  o sales.orders;
  it record;
  pay record;
  v_title uuid;
  v_n int;
  v_inst_amount numeric;
  v_inst_fee numeric;
  v_inst_antic numeric;
  v_natural_rate numeric;
  v_expected date;
  v_cost_total numeric := 0;
  v_unit_cost numeric;
  v_control text;
begin
  select * into o from sales.orders where id = p_order for update;
  if o.id is null then raise exception 'Pedido não encontrado'; end if;
  if o.status not in ('DRAFT', 'CONFIRMED', 'PENDING_PAYMENT') then
    raise exception 'Pedido % já finalizado (status %)', o.number, o.status using errcode = 'P0004';
  end if;
  if o.paid_total <> o.total then
    raise exception 'Pagamentos (%) diferentes do total (%)', o.paid_total, o.total using errcode = 'P0005';
  end if;

  -- 1) Estoque: consome reservas e lança SALE apenas para itens de catálogo com variante
  for it in select * from sales.order_items where order_id = o.id loop
    if it.reservation_id is not null then
      update inv.reservations set status = 'CONSUMED' where id = it.reservation_id and status = 'ACTIVE';
    end if;
    if it.variant_id is not null then
      select ic.avg_cost into v_unit_cost from inv.item_costs ic
      where ic.legal_entity_id = o.legal_entity_id and ic.variant_id = it.variant_id;
      insert into inv.movements (org_id, variant_id, location_id, qty, unit_cost, movement_type, source_type, source_id, source_line_id, created_by)
      values (o.org_id, it.variant_id, o.location_id, -it.qty, v_unit_cost, 'SALE', 'sales.orders', o.id, it.id, o.created_by);
      update sales.order_items set unit_cost_snapshot = v_unit_cost where id = it.id;
      v_cost_total := v_cost_total + coalesce(v_unit_cost, 0) * it.qty;
    end if;
  end loop;

  -- 2) Pagamentos → recebíveis (cartão/Pix/link/boleto) ou gaveta (dinheiro) ou vale-troca
  for pay in select * from sales.payments where order_id = o.id and status in ('AUTHORIZED', 'CAPTURED') loop
    if pay.method = 'CASH' then
      if o.cash_session_id is null then raise exception 'Venda em dinheiro exige caixa aberto'; end if;
      insert into sales.cash_session_movements (org_id, session_id, type, amount, order_id, created_by)
      values (o.org_id, o.cash_session_id, 'SALE_CASH', pay.amount, o.id, o.created_by);
    elsif pay.method = 'STORE_CREDIT' then
      if o.party_id is null or sales.store_credit_balance(o.party_id) < pay.amount then
        raise exception 'Saldo de vale-troca insuficiente' using errcode = 'P0006';
      end if;
      insert into sales.store_credit_ledger (org_id, party_id, amount, reason, source_type, source_id, created_by)
      values (o.org_id, o.party_id, -pay.amount, 'REDEMPTION', 'sales.orders', o.id, o.created_by);
    elsif pay.method <> 'PERMUTA' then
      v_control := case when pay.method in ('CREDIT', 'DEBIT', 'PAYMENT_LINK') then 'AR_CARD'
                        when pay.method = 'PIX' then 'AR_PIX' else 'AR_B2B' end;
      insert into fin.titles (org_id, legal_entity_id, store_id, direction, number, party_id, document_kind,
                              issue_date, competence_date, description, total_amount, origin_type, origin_id,
                              cost_center_id, approval_status, created_by, control_account_id, accrual_mode)
      values (o.org_id, o.legal_entity_id, o.store_id, 'RECEIVABLE', core.next_number(o.org_id, 'REC'),
              case when pay.method in ('BOLETO', 'B2B_INVOICE') then o.party_id end,
              pay.method::text, (o.created_at at time zone 'America/Sao_Paulo')::date, (o.created_at at time zone 'America/Sao_Paulo')::date,
              format('Venda %s — %s %sx', o.number, pay.method, pay.installments), pay.amount,
              'ORDER', o.id, o.profit_cost_center_id, 'APPROVED', o.created_by, private.acct(o.org_id, v_control), 'EXTERNAL')
      returning id into v_title;

      v_natural_rate := null;
      if pay.anticipation_mode = 'D1' and pay.acquirer is not null then
        v_natural_rate := fin.expected_fee_rate(o.org_id, pay.acquirer,
                            case when pay.method = 'PAYMENT_LINK' then 'CREDIT' else pay.method::text end, pay.installments, 'NATURAL');
      end if;

      for v_n in 1 .. pay.installments loop
        v_inst_amount := case when v_n < pay.installments then round(pay.amount / pay.installments, 2)
                              else pay.amount - round(pay.amount / pay.installments, 2) * (pay.installments - 1) end;
        v_inst_fee := round(v_inst_amount * coalesce(pay.fee_rate_expected, 0) / 100, 2);
        v_inst_antic := case when v_natural_rate is null then 0
                             else greatest(v_inst_fee - round(v_inst_amount * v_natural_rate / 100, 2), 0) end;
        v_expected := case
          when pay.method = 'PIX' then current_date
          when pay.method = 'DEBIT' or pay.anticipation_mode = 'D1' then current_date + 1
          when pay.method in ('CREDIT', 'PAYMENT_LINK') then current_date + 30 * v_n
          when pay.method in ('BOLETO', 'B2B_INVOICE') then current_date + 30
          else current_date end;
        insert into fin.title_installments (org_id, title_id, n, due_date, expected_date, amount, fee_expected, fee_anticipation_expected)
        values (o.org_id, v_title, v_n, v_expected, v_expected, v_inst_amount, v_inst_fee, v_inst_antic);
      end loop;
    end if;
  end loop;

  -- 3) Pedido pago; cliente vira CUSTOMER; timeline
  update sales.orders set status = 'PAID', cost_total = round(v_cost_total, 2),
         completed_at = case when fulfillment_type = 'TAKEAWAY' then now() end
  where id = o.id returning * into o;
  if o.fulfillment_type = 'TAKEAWAY' then
    update sales.orders set status = 'COMPLETED' where id = o.id returning * into o;
  end if;

  if o.party_id is not null then
    update crm.parties set
      lifecycle_stage = case when lifecycle_stage in ('LEAD', 'PROSPECT', 'INACTIVE', 'LOST') then 'CUSTOMER' else lifecycle_stage end,
      first_purchase_at = coalesce(first_purchase_at, now()),
      last_purchase_at = now()
    where id = o.party_id;
    insert into crm.timeline_events (org_id, party_id, kind, source_type, source_id, summary, payload)
    values (o.org_id, o.party_id, 'ORDER', 'sales.orders', o.id,
            format('Compra %s — R$ %s (%s)', o.number, replace(to_char(o.total, 'FM999999990.00'), '.', ','), o.channel),
            jsonb_build_object('total', o.total, 'channel', o.channel));
  end if;

  -- 4) Razão contábil
  perform private.post_sale(o.id);

  -- 5) Outbox: emissão fiscal (NFC-e no balcão) e evento de conversão (CAPI)
  perform private.enqueue('fiscal_emission', jsonb_build_object(
    'org_id', o.org_id, 'order_id', o.id, 'purpose', 'SALE',
    'model', case when o.channel = 'B2B' then '55' else '65' end,
    'ref', o.id::text || ':SALE'));
  if o.party_id is not null then
    perform private.enqueue('capi_events', jsonb_build_object('org_id', o.org_id, 'order_id', o.id, 'event', 'Purchase'));
  end if;

  return o;
end $$;
revoke execute on function sales.finalize_order(uuid) from authenticated;

-- 6) fiscal.build_emission_payload com suporte a itens avulsos
create or replace function fiscal.build_emission_payload(p_order uuid, p_purpose text default 'SALE') returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  o sales.orders; le core.legal_entities; matrix jsonb; v_items jsonb; v_pay jsonb; v_model text; v_items_sum numeric; v_coupon numeric; v_ratio numeric;
begin
  select * into o from sales.orders where id = p_order;
  if o.id is null then raise exception 'Pedido não encontrado' using errcode = 'P0002'; end if;
  select * into le from core.legal_entities where id = o.legal_entity_id;
  select value into matrix from core.settings where org_id = o.org_id and key = 'fiscal_matrix';
  matrix := coalesce(matrix, '{}');
  if p_purpose <> 'SALE' then
    return jsonb_build_object('ref', o.id::text || ':' || p_purpose, 'purpose', p_purpose, 'requires_review', true, 'order_number', o.number,
      'note', 'Devolução: o tratamento fiscal (cancelamento da NFC-e ou NF-e de entrada) depende da matriz validada com o contador');
  end if;
  v_model := case when o.channel = 'B2B' then '55'
                  when o.fulfillment_type in ('MOTOBOY', 'CARRIER') then coalesce(matrix ->> 'remote_delivery_model', '65') else '65' end;
  select coalesce(sum(total), 0) into v_items_sum from sales.order_items where order_id = o.id;
  select coalesce(sum(amount), 0) into v_coupon from sales.coupon_redemptions where order_id = o.id;
  v_ratio := case when v_items_sum > 0 then greatest(1 - v_coupon / v_items_sum, 0) else 1 end;

  select jsonb_agg(jsonb_build_object(
      'numero_item', x.n, 'codigo_produto', x.sku, 'descricao', x.name, 'codigo_ncm', coalesce(x.ncm, matrix ->> 'default_ncm', '61091000'),
      'cfop', coalesce(matrix ->> 'cfop_balcao', '5102'), 'unidade_comercial', 'UN', 'quantidade_comercial', x.qty, 'valor_unitario_comercial', x.list_price,
      'valor_bruto', round(x.list_price * x.qty, 2), 'unidade_tributavel', 'UN', 'quantidade_tributavel', x.qty, 'valor_unitario_tributavel', x.list_price,
      'valor_desconto', round(x.list_price * x.qty - x.total * v_ratio, 2), 'icms_origem', coalesce(x.origin, 0),
      'icms_situacao_tributaria', coalesce(matrix ->> 'csosn', '102'), 'inclui_no_total', 1) order by x.n) into v_items
  from (select row_number() over (order by i.line_no) as n,
               coalesce(v.sku, 'AVULSO') as sku,
               coalesce(nullif(trim(concat_ws(' ', p.name, c.name, v.size)), ''), i.description, 'Item Avulso') as name,
               p.ncm, p.origin, i.qty, i.list_price, i.total
        from sales.order_items i
        left join catalog.variants v on v.id = i.variant_id
        left join catalog.products p on p.id = v.product_id
        left join catalog.colors c on c.id = v.color_id
        where i.order_id = o.id) x;

  select jsonb_agg(jsonb_build_object('forma_pagamento', case pm.method when 'CASH' then '01' when 'CREDIT' then '03' when 'DEBIT' then '04' when 'PIX' then '17' when 'PAYMENT_LINK' then '03'
      when 'BOLETO' then '15' when 'STORE_CREDIT' then '05' when 'PERMUTA' then '99' else '99' end, 'valor_pagamento', pm.amount)) into v_pay
  from sales.payments pm where pm.order_id = o.id and pm.status in ('AUTHORIZED', 'CAPTURED');

  return jsonb_build_object('ref', o.id::text || ':SALE', 'purpose', 'SALE', 'model', v_model, 'order_id', o.id, 'order_number', o.number, 'legal_entity_id', o.legal_entity_id,
    'provider_ref', le.fiscal_provider_ref, 'series', case when v_model = '65' then le.nfce_series else le.nfe_series end,
    'document', jsonb_build_object('natureza_operacao', 'VENDA AO CONSUMIDOR', 'data_emissao', to_char(now() at time zone 'America/Sao_Paulo', 'YYYY-MM-DD"T"HH24:MI:SS') || '-03:00',
      'presenca_comprador', case when o.fulfillment_type in ('MOTOBOY', 'CARRIER') then 4 else 1 end, 'modalidade_frete', case when o.fulfillment_type in ('MOTOBOY', 'CARRIER') then 0 else 9 end,
      'local_destino', 1, 'finalidade_emissao', 1, 'consumidor_final', 1, 'cnpj_emitente', le.cnpj, 'cpf_destinatario', nullif(regexp_replace(coalesce(o.cpf_on_invoice, ''), '\D', '', 'g'), ''),
      'valor_frete', case when o.shipping_total > 0 then o.shipping_total end, 'itens', v_items, 'formas_pagamento', v_pay));
end $$;
