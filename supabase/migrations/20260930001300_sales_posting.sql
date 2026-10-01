-- =====================================================================
-- Vendas e contratos passam a contabilizar no razão:
--   venda   → Dr recebíveis (cartão/Pix/B2B) ou caixa ou vale-troca · Cr receita  |  Dr CMV · Cr estoque
--   contrato→ competência mensal do patrocínio (Dr despesa · Cr patrocínio a pagar)
-- =====================================================================

create or replace function private.post_sale(p_order uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  o sales.orders;
  v_date date;
  v_cc uuid;
  v_lines jsonb := '[]';
  v_total numeric := 0;
  v_cash numeric;
  v_drawer uuid;
  v_drawer_account uuid;
  r record;
  v_rev text;
  v_entry uuid;
begin
  select * into o from sales.orders where id = p_order;
  v_date := (o.created_at at time zone 'America/Sao_Paulo')::date;
  v_cc := coalesce(o.profit_cost_center_id, (select s.cost_center_id from core.stores s where s.id = o.store_id));

  for r in
    select case when p.method in ('CREDIT', 'DEBIT', 'PAYMENT_LINK') then 'AR_CARD'
                when p.method = 'PIX' then 'AR_PIX'
                when p.method in ('BOLETO', 'B2B_INVOICE') then 'AR_B2B'
                when p.method = 'STORE_CREDIT' then 'STORE_CREDIT_LIABILITY'
                when p.method = 'PERMUTA' then 'PERMUTA_RECEIVABLE'
                else null end as role,
           sum(p.amount) as amount
    from sales.payments p
    where p.order_id = o.id and p.status in ('AUTHORIZED', 'CAPTURED') and p.method <> 'CASH'
    group by 1
  loop
    if r.role is null then raise exception 'Forma de pagamento sem conta contábil no pedido %', o.number; end if;
    v_lines := v_lines || jsonb_build_object('role', r.role, 'debit', r.amount, 'party_id', case when r.role = 'AR_B2B' then o.party_id end);
    v_total := v_total + r.amount;
  end loop;

  -- Dinheiro líquido do troco entra na gaveta (conta bancária do tipo CASH_DRAWER da loja, se existir)
  select coalesce(sum(m.amount), 0) into v_cash from sales.cash_session_movements m
  where m.order_id = o.id and m.type in ('SALE_CASH', 'CHANGE');
  if v_cash > 0 then
    select ba.id into v_drawer from fin.bank_accounts ba
    where ba.legal_entity_id = o.legal_entity_id and ba.kind = 'CASH_DRAWER' and ba.active
      and (ba.store_id = o.store_id or ba.store_id is null)
    order by (ba.store_id is not null) desc limit 1;
    v_drawer_account := case when v_drawer is not null then private.bank_chart(v_drawer) else private.acct(o.org_id, 'CASH_DRAWER') end;
    v_lines := v_lines || jsonb_build_object('account_id', v_drawer_account, 'debit', v_cash);
    v_total := v_total + v_cash;
  end if;

  if round(v_total, 2) <> o.total then
    raise exception 'Contabilização da venda %: pagamentos (%) diferentes do total (%)', o.number, v_total, o.total using errcode = 'P0005';
  end if;

  v_rev := case o.channel when 'POS' then 'REV_POS' when 'B2B' then 'REV_B2B' else 'REV_REMOTE' end;
  v_lines := v_lines || jsonb_build_object('role', v_rev, 'credit', v_total, 'cost_center_id', v_cc, 'party_id', o.party_id);
  v_entry := private.post_entry(o.legal_entity_id, v_date, 'SALE', 'sales.orders', o.id,
                                format('Venda %s (%s)', o.number, o.channel), v_lines);

  if v_cash > 0 and v_drawer is not null then
    insert into fin.cash_transactions (org_id, legal_entity_id, bank_account_id, occurred_on, amount, kind, description,
                                       reconciled, reconciled_amount, journal_entry_id, created_by)
    values (o.org_id, o.legal_entity_id, v_drawer, v_date, v_cash, 'CASH_SALE', 'Venda em dinheiro ' || o.number,
            true, v_cash, v_entry, o.created_by);
  end if;

  if o.cost_total > 0 then
    perform private.post_entry(o.legal_entity_id, v_date, 'COGS', 'sales.orders', o.id, format('CMV da venda %s', o.number),
      jsonb_build_array(
        jsonb_build_object('role', 'CMV', 'debit', o.cost_total, 'cost_center_id', v_cc),
        jsonb_build_object('role', 'INVENTORY', 'credit', o.cost_total)));
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Finalização do pedido: agora com conta de controle nos recebíveis, separação MDR × antecipação e contabilização
-- ---------------------------------------------------------------------
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

  -- 1) Estoque: consome reservas e lança SALE
  for it in select * from sales.order_items where order_id = o.id loop
    if it.reservation_id is not null then
      update inv.reservations set status = 'CONSUMED' where id = it.reservation_id and status = 'ACTIVE';
    end if;
    select ic.avg_cost into v_unit_cost from inv.item_costs ic
    where ic.legal_entity_id = o.legal_entity_id and ic.variant_id = it.variant_id;
    insert into inv.movements (org_id, variant_id, location_id, qty, unit_cost, movement_type, source_type, source_id, source_line_id, created_by)
    values (o.org_id, it.variant_id, o.location_id, -it.qty, v_unit_cost, 'SALE', 'sales.orders', o.id, it.id, o.created_by);
    update sales.order_items set unit_cost_snapshot = v_unit_cost where id = it.id;
    v_cost_total := v_cost_total + coalesce(v_unit_cost, 0) * it.qty;
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
revoke execute on function private.post_sale(uuid) from authenticated;

-- ---------------------------------------------------------------------
-- Contrato: cada parcela vira título aprovado que já contabiliza a competência do mês
-- ---------------------------------------------------------------------
create or replace function fin.generate_contract_schedule(p_contract uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare
  c fin.contracts;
  i int;
  v_due date;
  v_n int := 0;
begin
  perform private.require_perm('fin.write');
  select * into c from fin.contracts where id = p_contract and org_id = coalesce(private.org_id(), org_id);
  if c.id is null then raise exception 'Contrato não encontrado'; end if;
  if exists (select 1 from fin.titles where origin_type = 'CONTRACT' and origin_id = c.id) then
    raise exception 'Cronograma já gerado para este contrato';
  end if;

  for i in 0 .. c.months - 1 loop
    v_due := (date_trunc('month', c.start_date) + make_interval(months => i))::date
             + (least(coalesce(c.due_day, extract(day from c.start_date)::int), 28) - 1);
    if i < c.in_kind_months then
      insert into fin.contract_obligations (org_id, contract_id, kind, description, due_date)
      values (c.org_id, c.id, 'IN_KIND_DELIVERY',
              format('Mês %s/%s: pagamento em espécie — %s', i + 1, c.months, coalesce(c.in_kind_description, 'peças')), v_due);
    elsif c.installment_amount is not null then
      perform private.insert_title(jsonb_build_object(
        'direction', 'PAYABLE', 'legal_entity_id', c.legal_entity_id, 'store_id', c.store_id, 'party_id', c.party_id,
        'description', format('%s — parcela %s/%s', c.title, i + 1, c.months), 'document_kind', 'CONTRATO',
        'issue_date', v_due, 'competence_date', date_trunc('month', v_due)::date,
        'chart_account_id', coalesce(c.chart_account_id, private.acct(c.org_id, 'SPONSORSHIP_EXPENSE')),
        'cost_center_id', c.cost_center_id, 'origin_type', 'CONTRACT', 'origin_id', c.id,
        'approval_status', 'APPROVED', 'control_account_id', private.acct(c.org_id, 'SPONSORSHIP_PAYABLE'),
        'installments', jsonb_build_array(jsonb_build_object('due_date', v_due, 'amount', c.installment_amount))),
        private.member_id());
    end if;
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;
