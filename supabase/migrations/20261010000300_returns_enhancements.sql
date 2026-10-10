-- =====================================================================
-- Melhores para o fluxo de trocas e devoluções
-- 1) Suporte a itens avulsos em sales.create_return (sem tentar repor estoque de variante inexistente)
-- 2) sales.set_order_status suportando PARTIALLY_RETURNED e RETURNED
-- 3) sales.get_customer_store_credit para o PDV consultar saldo de vale-troca
-- =====================================================================

create or replace function sales.get_customer_store_credit(p_party uuid)
returns numeric
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('sales.read');
  return coalesce((select sum(amount) from sales.store_credit_ledger where party_id = p_party), 0);
end $$;

-- Atualizar set_order_status para incluir status de devolução
create or replace function sales.set_order_status(p_order uuid, p_status text, p_notes text default null)
returns sales.orders
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id();
  o sales.orders;
  v_old_status text;
begin
  perform private.require_perm('sales.write');
  select * into o from sales.orders where id = p_order and org_id = v_org for update;
  if o.id is null then
    raise exception 'Pedido não encontrado' using errcode = 'P0002';
  end if;

  if coalesce(auth.role(), '') = 'authenticated' and not private.can_store(o.store_id) then
    raise exception 'Sem acesso à loja do pedido' using errcode = '42501';
  end if;

  if p_status not in ('DRAFT', 'PENDING_PAYMENT', 'PAID', 'FULFILLING', 'READY_FOR_PICKUP', 'SHIPPED', 'COMPLETED', 'CANCELLED', 'PARTIALLY_RETURNED', 'RETURNED') then
    raise exception 'Situação % inválida', p_status using errcode = 'P0093';
  end if;

  v_old_status := o.status;
  if v_old_status = p_status then
    if p_notes is not null and trim(p_notes) <> '' then
      update sales.orders set notes = coalesce(notes || ' · ', '') || trim(p_notes) where id = o.id returning * into o;
    end if;
    return o;
  end if;

  -- Se for cancelado, libera reservas de estoque e cancela payment links pendentes
  if p_status = 'CANCELLED' then
    update inv.reservations
    set status = 'RELEASED'
    where order_id = o.id and status = 'ACTIVE';

    update sales.payment_links
    set status = 'CANCELLED'
    where order_id = o.id and status in ('CREATED', 'SENT');
  end if;

  update sales.orders
  set status = p_status::sales.order_status,
      notes = case
        when p_notes is not null and trim(p_notes) <> ''
        then coalesce(notes || ' · ', '') || format('[Status: %s -> %s] %s', v_old_status, p_status, trim(p_notes))
        else notes
      end
  where id = o.id
  returning * into o;

  return o;
end $$;

-- Atualizar sales.create_return para suportar itens avulsos sem estourar restrição de inv.movements
create or replace function sales.create_return(p jsonb) returns sales.returns
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id(); v_actor uuid := private.member_id();
  o sales.orders; ret sales.returns; oi sales.order_items; it jsonb;
  v_type text := p ->> 'type'; v_method text; v_qty numeric; v_amt numeric; v_cost numeric; v_total numeric := 0; v_cogs numeric := 0;
  v_items_sum numeric; v_coupon numeric; v_ratio numeric; v_cc uuid; v_loc uuid; v_date date := private.today_sp();
  v_lines jsonb; v_entry uuid; v_reduced numeric := 0; v_payable numeric := 0; v_title fin.titles; v_drawer uuid; v_drawer_acc uuid;
  v_all boolean;
begin
  perform private.require_perm('sales.write');
  select * into o from sales.orders where id = (p ->> 'order_id')::uuid and org_id = v_org for update;
  if o.id is null then raise exception 'Pedido não encontrado'; end if;
  if coalesce(auth.role(), '') = 'authenticated' and not private.can_store(o.store_id) then raise exception 'Sem acesso à loja do pedido' using errcode = '42501'; end if;
  if o.status not in ('PAID', 'COMPLETED', 'FULFILLING', 'READY_FOR_PICKUP', 'SHIPPED', 'PARTIALLY_RETURNED') then
    raise exception 'O pedido % não pode ter devolução (situação %)', o.number, o.status using errcode = 'P0093';
  end if;
  if v_type not in ('RETURN_REFUND', 'EXCHANGE', 'STORE_CREDIT') then raise exception 'Tipo de devolução inválido' using errcode = 'P0093'; end if;
  if jsonb_array_length(coalesce(p -> 'items', '[]')) = 0 then raise exception 'Escolha ao menos um item' using errcode = 'P0093'; end if;
  v_method := case when v_type in ('EXCHANGE', 'STORE_CREDIT') then 'STORE_CREDIT' else coalesce(p ->> 'refund_method', 'PIX') end;
  if v_method = 'STORE_CREDIT' and o.party_id is null then raise exception 'Vale-troca exige o cliente identificado no pedido' using errcode = 'P0093'; end if;
  if v_method = 'CASH' and (p ->> 'cash_session_id') is null then raise exception 'Devolução em dinheiro exige caixa aberto' using errcode = 'P0093'; end if;
  v_cc := coalesce(o.profit_cost_center_id, (select s.cost_center_id from core.stores s where s.id = o.store_id));

  select coalesce(sum(total), 0) into v_items_sum from sales.order_items where order_id = o.id;
  select coalesce(sum(amount), 0) into v_coupon from sales.coupon_redemptions where order_id = o.id;
  v_ratio := case when v_items_sum > 0 then greatest(1 - v_coupon / v_items_sum, 0) else 1 end;

  insert into sales.returns (org_id, number, order_id, type, reason, notes, refund_method, party_id, created_by)
  values (v_org, core.next_number(v_org, 'DEV'), o.id, v_type, coalesce(p ->> 'reason', 'OTHER'), p ->> 'notes', v_method, o.party_id, v_actor)
  returning * into ret;

  for it in select * from jsonb_array_elements(p -> 'items') loop
    select * into oi from sales.order_items where id = (it ->> 'order_item_id')::uuid and order_id = o.id for update;
    if oi.id is null then raise exception 'Item não pertence ao pedido' using errcode = 'P0093'; end if;
    v_qty := (it ->> 'qty')::numeric;
    if v_qty <= 0 or v_qty > oi.qty - oi.returned_qty then
      raise exception 'Quantidade a devolver (%) maior que a disponível (%) no item', v_qty, oi.qty - oi.returned_qty using errcode = 'P0093';
    end if;
    v_amt := round(oi.total * v_qty / oi.qty * v_ratio, 2);
    v_cost := round(coalesce(oi.unit_cost_snapshot, 0) * v_qty, 2);
    v_loc := coalesce((it ->> 'restock_location_id')::uuid, o.location_id);
    if not exists (select 1 from inv.locations where id = v_loc and org_id = v_org and legal_entity_id = o.legal_entity_id) then raise exception 'Local de reposição inválido' using errcode = 'P0093'; end if;

    insert into sales.return_items (org_id, return_id, order_item_id, qty, restock_location_id) values (v_org, ret.id, oi.id, v_qty, v_loc);
    update sales.order_items set returned_qty = returned_qty + v_qty where id = oi.id;

    -- Apenas itens com variante movimentam estoque
    if oi.variant_id is not null then
      insert into inv.movements (org_id, variant_id, location_id, qty, unit_cost, movement_type, source_type, source_id, source_line_id, created_by)
      values (v_org, oi.variant_id, v_loc, v_qty, oi.unit_cost_snapshot, 'SALE_RETURN', 'sales.returns', ret.id, oi.id, v_actor);
    end if;

    v_total := v_total + v_amt; v_cogs := v_cogs + v_cost;
  end loop;
  if v_total <= 0 then raise exception 'Valor da devolução zerado' using errcode = 'P0093'; end if;

  -- Contabilização: receita reduzida pela devolução; o meio de devolução recebe o crédito
  v_lines := jsonb_build_array(jsonb_build_object('role', 'SALES_RETURNS', 'debit', v_total, 'cost_center_id', v_cc, 'party_id', o.party_id, 'memo', 'Devolução ' || ret.number));
  if v_method = 'STORE_CREDIT' then
    v_lines := v_lines || jsonb_build_object('role', 'STORE_CREDIT_LIABILITY', 'credit', v_total, 'party_id', o.party_id);
    insert into sales.store_credit_ledger (org_id, party_id, amount, reason, source_type, source_id, created_by)
    values (v_org, o.party_id, v_total, 'RETURN', 'sales.returns', ret.id, v_actor);
  elsif v_method = 'CASH' then
    insert into sales.cash_session_movements (org_id, session_id, type, amount, reason, order_id, created_by)
    values (v_org, (p ->> 'cash_session_id')::uuid, 'REFUND_CASH', -v_total, 'Devolução ' || ret.number, o.id, v_actor);
    select ba.id into v_drawer from fin.bank_accounts ba where ba.legal_entity_id = o.legal_entity_id and ba.kind = 'CASH_DRAWER' and ba.active order by ba.created_at limit 1;
    v_drawer_acc := case when v_drawer is not null then private.bank_chart(v_drawer) else private.acct(v_org, 'CASH_DRAWER') end;
    v_lines := v_lines || jsonb_build_object('account_id', v_drawer_acc, 'credit', v_total, 'memo', 'Devolução em dinheiro');
  else
    if v_method = 'CARD' then v_reduced := private.reduce_card_receivables(o.id, v_total); end if;
    v_payable := v_total - v_reduced;
    if v_reduced > 0 then v_lines := v_lines || jsonb_build_object('role', 'AR_CARD', 'credit', v_reduced, 'memo', 'Estorno no cartão'); end if;
    if v_payable > 0 then v_lines := v_lines || jsonb_build_object('role', 'ADVANCE_CUSTOMERS', 'credit', v_payable, 'party_id', o.party_id, 'memo', 'A devolver ao cliente'); end if;
  end if;
  v_entry := private.post_entry(o.legal_entity_id, v_date, 'SALE_RETURN', 'sales.returns', ret.id, format('Devolução %s do pedido %s', ret.number, o.number), v_lines);
  if v_cogs > 0 then
    perform private.post_entry(o.legal_entity_id, v_date, 'COGS_RETURN', 'sales.returns', ret.id, format('CMV estornado — devolução %s', ret.number),
      jsonb_build_array(jsonb_build_object('role', 'INVENTORY', 'debit', v_cogs), jsonb_build_object('role', 'CMV', 'credit', v_cogs, 'cost_center_id', v_cc)));
  end if;

  -- O que ainda precisa ser pago ao cliente vira conta a pagar (Pix/TED ou parte já recebida do cartão)
  if v_payable > 0 then
    v_title := private.insert_title(jsonb_build_object(
      'direction', 'PAYABLE', 'legal_entity_id', o.legal_entity_id, 'store_id', o.store_id, 'party_id', o.party_id,
      'description', format('Devolução %s — pedido %s', ret.number, o.number), 'document_kind', 'DEVOLUCAO', 'competence_date', v_date,
      'installments', jsonb_build_array(jsonb_build_object('due_date', v_date, 'amount', v_payable)),
      'origin_type', 'RETURN', 'origin_id', ret.id, 'accrual_mode', 'EXTERNAL', 'approval_status', 'APPROVED',
      'control_account_id', private.acct(v_org, 'ADVANCE_CUSTOMERS'), 'tags', jsonb_build_array('devolucao')), v_actor);
    update fin.titles set accrual_entry_id = v_entry where id = v_title.id;
  end if;

  select bool_and(returned_qty >= qty) into v_all from sales.order_items where order_id = o.id;
  update sales.orders set status = (case when v_all then 'RETURNED' else 'PARTIALLY_RETURNED' end)::sales.order_status where id = o.id;
  update sales.returns set amount = v_total, cogs_amount = v_cogs, entry_id = v_entry, refund_title_id = v_title.id where id = ret.id returning * into ret;

  return ret;
end $$;
