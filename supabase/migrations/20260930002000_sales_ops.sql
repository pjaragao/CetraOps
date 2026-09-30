-- =====================================================================
-- sales: operações do dia a dia além do balcão
--   · trocas e devoluções (estoque, razão, vale-troca, dinheiro, Pix a devolver, estorno no cartão, comissão)
--   · limites de cupom (usos totais e por cliente)
--   · reservas (Armário VIP, retenção da IA) e locker_drops
--   · pedidos remotos (WhatsApp/Instagram/link): rascunho com reserva → pagamento (webhook/manual) → finalização
--   · links de pagamento e entregas
-- =====================================================================

alter table sales.returns add column refund_method text check (refund_method in ('STORE_CREDIT', 'CASH', 'PIX', 'CARD'));
alter table sales.returns add column refund_title_id uuid references fin.titles(id);
alter table sales.returns add column entry_id uuid;
alter table sales.returns add column cogs_amount numeric(14,2) not null default 0;
alter table sales.returns add column party_id uuid references crm.parties(id);
alter table inv.reservations add column drop_id uuid;

-- ---------------------------------------------------------------------
-- Cupons: limites de uso
-- ---------------------------------------------------------------------
create or replace function private.check_coupon_limits() returns trigger
language plpgsql security definer set search_path = '' as $$
declare c sales.coupons; v_total int; v_party int;
begin
  select * into c from sales.coupons where id = new.coupon_id;
  select count(*) into v_total from sales.coupon_redemptions r join sales.orders o on o.id = r.order_id
    where r.coupon_id = c.id and r.id is distinct from new.id and o.status <> 'CANCELLED';
  if c.max_uses is not null and v_total >= c.max_uses then
    raise exception 'Cupom % esgotado (limite de % usos)', c.code, c.max_uses using errcode = 'P0008';
  end if;
  if c.per_customer_limit is not null and new.party_id is not null then
    select count(*) into v_party from sales.coupon_redemptions r join sales.orders o on o.id = r.order_id
      where r.coupon_id = c.id and r.party_id = new.party_id and r.id is distinct from new.id and o.status <> 'CANCELLED';
    if v_party >= c.per_customer_limit then
      raise exception 'Este cliente já usou o cupom % o máximo de vezes (%)', c.code, c.per_customer_limit using errcode = 'P0008';
    end if;
  end if;
  return new;
end $$;
create trigger trg_coupon_limits before insert on sales.coupon_redemptions for each row execute function private.check_coupon_limits();

-- Prévia do desconto de um cupom (o banco recalcula de novo ao fechar o pedido)
create or replace function sales.validate_coupon(p_code text, p_subtotal numeric, p_party uuid default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c sales.coupons; v_disc numeric; v_total int; v_party int;
begin
  perform private.require_perm('sales.read');
  select * into c from sales.coupons where org_id = private.org_id() and upper(code) = upper(p_code) and active and valid_from <= now() and (valid_to is null or valid_to > now());
  if c.id is null then return jsonb_build_object('valid', false, 'reason', 'Cupom inválido ou expirado'); end if;
  if c.min_order is not null and p_subtotal < c.min_order then
    return jsonb_build_object('valid', false, 'reason', format('Pedido mínimo de R$ %s', c.min_order));
  end if;
  select count(*) into v_total from sales.coupon_redemptions r join sales.orders o on o.id = r.order_id where r.coupon_id = c.id and o.status <> 'CANCELLED';
  if c.max_uses is not null and v_total >= c.max_uses then return jsonb_build_object('valid', false, 'reason', 'Cupom esgotado'); end if;
  if c.per_customer_limit is not null and p_party is not null then
    select count(*) into v_party from sales.coupon_redemptions r join sales.orders o on o.id = r.order_id
      where r.coupon_id = c.id and r.party_id = p_party and o.status <> 'CANCELLED';
    if v_party >= c.per_customer_limit then return jsonb_build_object('valid', false, 'reason', 'Cliente já usou este cupom'); end if;
  end if;
  v_disc := round(case when c.kind = 'PERCENT' then p_subtotal * c.value / 100 else least(c.value, p_subtotal) end, 2);
  return jsonb_build_object('valid', true, 'discount', v_disc, 'kind', c.kind, 'value', c.value, 'affiliate', c.affiliate_party_id is not null);
end $$;

-- ---------------------------------------------------------------------
-- Estorno no cartão: reduz o que a adquirente ainda vai pagar (parcelas em aberto, das últimas para as primeiras).
-- Devolve o valor efetivamente reduzido; o que já foi recebido sai por Pix/dinheiro (o chamador cria o título a pagar).
-- ---------------------------------------------------------------------
create or replace function private.reduce_card_receivables(p_order uuid, p_amount numeric) returns numeric
language plpgsql security definer set search_path = '' as $$
declare i record; v_left numeric := p_amount; v_take numeric; v_avail numeric;
begin
  for i in
    select ti.id, ti.title_id, ti.amount, ti.amount_settled, ti.fee_expected, ti.fee_anticipation_expected
    from fin.title_installments ti join fin.titles t on t.id = ti.title_id
    where t.origin_type = 'ORDER' and t.origin_id = p_order and t.direction = 'RECEIVABLE'
      and t.document_kind in ('CREDIT', 'DEBIT', 'PAYMENT_LINK') and ti.status in ('OPEN', 'PARTIAL')
    order by ti.n desc
  loop
    exit when v_left <= 0;
    v_avail := i.amount - i.amount_settled;
    v_take := least(v_avail, v_left);
    continue when v_take <= 0;
    if v_take = i.amount then
      update fin.title_installments set status = 'CANCELLED', fee_expected = 0, fee_anticipation_expected = 0 where id = i.id;
    else
      update fin.title_installments set amount = amount - v_take,
        fee_expected = round(fee_expected * (amount - v_take) / amount, 2), fee_anticipation_expected = round(fee_anticipation_expected * (amount - v_take) / amount, 2)
      where id = i.id;
    end if;
    update fin.titles set total_amount = greatest(total_amount - v_take, 0.01),
      status = case when not exists (select 1 from fin.title_installments x where x.title_id = i.title_id and x.status not in ('CANCELLED', 'SETTLED'))
                    and exists (select 1 from fin.title_installments x where x.title_id = i.title_id and x.status = 'CANCELLED')
                    and not exists (select 1 from fin.title_installments x where x.title_id = i.title_id and x.status = 'SETTLED') then 'CANCELLED'::fin.title_status else status end
    where id = i.title_id;
    v_left := v_left - v_take;
  end loop;
  return p_amount - v_left;
end $$;

-- ---------------------------------------------------------------------
-- Troca / devolução
-- p = {order_id, type: RETURN_REFUND|EXCHANGE|STORE_CREDIT, reason: SIZE|DEFECT|REGRET_7D|OTHER, refund_method?: STORE_CREDIT|CASH|PIX|CARD,
--      cash_session_id? (dinheiro), notes?, items:[{order_item_id, qty, restock_location_id?}]}
-- Troca e vale-troca sempre viram crédito do cliente; devolução escolhe o meio (padrão: Pix).
-- ---------------------------------------------------------------------
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
    insert into inv.movements (org_id, variant_id, location_id, qty, unit_cost, movement_type, source_type, source_id, source_line_id, created_by)
    values (v_org, oi.variant_id, v_loc, v_qty, oi.unit_cost_snapshot, 'SALE_RETURN', 'sales.returns', ret.id, oi.id, v_actor);
    v_total := v_total + v_amt; v_cogs := v_cogs + v_cost;
  end loop;
  if v_total <= 0 then raise exception 'Valor da devolução zerado' using errcode = 'P0093'; end if;

  -- contabilização: receita reduzida pela devolução; o meio de devolução recebe o crédito
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

  -- o que ainda precisa ser pago ao cliente vira conta a pagar (Pix/TED ou parte já recebida do cartão)
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

  if o.party_id is not null then
    insert into crm.timeline_events (org_id, party_id, kind, source_type, source_id, summary, payload)
    values (v_org, o.party_id, 'RETURN', 'sales.returns', ret.id, format('%s — R$ %s (%s)', case v_type when 'EXCHANGE' then 'Troca' else 'Devolução' end,
            replace(to_char(v_total, 'FM999999990.00'), '.', ','), ret.number), jsonb_build_object('amount', v_total, 'method', v_method));
  end if;
  perform private.enqueue('fiscal_emission', jsonb_build_object('org_id', v_org, 'order_id', o.id, 'return_id', ret.id, 'purpose', 'RETURN',
    'model', case when o.channel = 'B2B' then '55' else '65' end, 'ref', ret.id::text || ':RETURN'));
  return ret;
end $$;

-- Vincula a nova venda (paga com o vale-troca) à troca
create or replace function sales.link_exchange(p_return uuid, p_order uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('sales.write');
  update sales.returns set exchange_order_id = p_order where id = p_return and org_id = private.org_id() and type = 'EXCHANGE';
  if not found then raise exception 'Troca não encontrada'; end if;
end $$;

-- Comissão: vendas do mês menos devoluções feitas no mês (estorno na competência da devolução)
create or replace function comm.generate_statement(p_member uuid, p_competence date) returns comm.statements
language plpgsql security definer set search_path = '' as $$
declare
  m core.members;
  plan jsonb;
  comp date := date_trunc('month', p_competence)::date;
  v_from timestamptz := (comp::timestamp at time zone 'America/Sao_Paulo');
  v_to timestamptz := ((comp + interval '1 month')::timestamp at time zone 'America/Sao_Paulo');
  v_sales numeric := 0;
  v_store_rev numeric := 0;
  v_returns numeric := 0;
  v_comm numeric := 0;
  v_base numeric;
  v_bonus numeric := 0;
  r record;
  t jsonb;
  by_channel jsonb := '{}';
  st comm.statements;
  v_status text[] := array['PAID', 'COMPLETED', 'FULFILLING', 'READY_FOR_PICKUP', 'SHIPPED', 'PARTIALLY_RETURNED', 'RETURNED'];
begin
  perform private.require_perm('hr.payroll.write');
  select * into m from core.members where id = p_member and org_id = coalesce(private.org_id(), org_id);
  if m.id is null then raise exception 'Membro não encontrado'; end if;
  select value into plan from core.settings where org_id = m.org_id and key = 'commission_plan_default';
  if plan is null then raise exception 'Plano de comissão não configurado (Configurações)'; end if;

  select * into st from comm.statements where member_id = m.id and competence = comp;
  if st.id is not null and st.status in ('APPROVED', 'PAID') then return st; end if;

  for r in
    select x.channel, sum(x.amt) as amt from (
      select o.channel::text as channel, o.total * c.share_pct / 100 as amt
      from sales.orders o join sales.order_credits c on c.order_id = o.id
      where c.member_id = m.id and c.role in ('CLOSER', 'ASSIST') and o.status::text = any (v_status)
        and o.created_at >= v_from and o.created_at < v_to
      union all
      select o.channel::text, -(rt.amount * c.share_pct / 100)
      from sales.returns rt join sales.orders o on o.id = rt.order_id join sales.order_credits c on c.order_id = o.id
      where c.member_id = m.id and c.role in ('CLOSER', 'ASSIST') and rt.created_at >= v_from and rt.created_at < v_to
    ) x group by x.channel
  loop
    v_sales := v_sales + r.amt;
    v_comm := v_comm + r.amt * coalesce((plan -> 'rates_by_channel' ->> r.channel)::numeric, 0) / 100;
    by_channel := by_channel || jsonb_build_object(r.channel, round(r.amt, 2));
  end loop;

  select coalesce(sum(o.total), 0) into v_store_rev from sales.orders o
  where o.store_id = m.default_store_id and o.status::text = any (v_status) and o.created_at >= v_from and o.created_at < v_to;
  select coalesce(sum(rt.amount), 0) into v_returns from sales.returns rt join sales.orders o on o.id = rt.order_id
  where o.store_id = m.default_store_id and rt.created_at >= v_from and rt.created_at < v_to;
  v_store_rev := v_store_rev - v_returns;

  v_base := case coalesce(plan ->> 'base', 'STORE_REVENUE') when 'INDIVIDUAL_REVENUE' then v_sales else v_store_rev end;
  for t in select * from jsonb_array_elements(coalesce(plan -> 'tiers', '[]')) loop
    if v_base >= (t ->> 'from')::numeric and ((t ->> 'to') is null or v_base < (t ->> 'to')::numeric) then
      if (t ->> 'bonus') is not null then v_bonus := (t ->> 'bonus')::numeric; end if;
      if (t ->> 'pct_over') is not null then v_bonus := round((v_base - (t ->> 'from')::numeric) * (t ->> 'pct_over')::numeric / 100, 2); end if;
    end if;
  end loop;

  insert into comm.statements (org_id, member_id, store_id, competence, sales_amount, base_amount, commission, bonus, total, detail, status)
  values (m.org_id, m.id, m.default_store_id, comp, round(v_sales, 2), round(v_base, 2), round(v_comm, 2), v_bonus, round(v_comm, 2) + v_bonus,
          jsonb_build_object('by_channel', by_channel, 'store_revenue', round(v_store_rev, 2), 'returns', round(v_returns, 2), 'plan_base', coalesce(plan ->> 'base', 'STORE_REVENUE')), 'DRAFT')
  on conflict (member_id, competence) do update set sales_amount = excluded.sales_amount, base_amount = excluded.base_amount,
    commission = excluded.commission, bonus = excluded.bonus, total = excluded.total, detail = excluded.detail, status = 'DRAFT', updated_at = now()
  returning * into st;
  return st;
end $$;

-- ---------------------------------------------------------------------
-- Reservas (retenção da IA, provador, lista de espera, pedido) — o gatilho já impede reservar além do disponível
-- p = {variant_id, location_id?, store_id?, qty, reason, party_id?, conversation_id?, hold_hours?, created_by_kind?}
-- ---------------------------------------------------------------------
create or replace function inv.reserve(p jsonb) returns inv.reservations
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id(); v_actor text := coalesce(p ->> 'created_by_kind', 'HUMAN'); r inv.reservations; v_loc uuid; v_hours int; v_reason text := p ->> 'reason';
begin
  perform private.require_perm('sales.write');
  if v_reason not in ('ORDER', 'VIP_LOCKER', 'AI_HOLD', 'TRY_ON', 'B2B', 'DROP_WAITLIST') then raise exception 'Motivo de reserva inválido'; end if;
  v_loc := coalesce((p ->> 'location_id')::uuid, (select l.id from inv.locations l where l.org_id = v_org and l.store_id = (p ->> 'store_id')::uuid and l.kind = 'SALES_FLOOR' order by l.created_at limit 1));
  if v_loc is null or not exists (select 1 from inv.locations where id = v_loc and org_id = v_org) then raise exception 'Local inválido'; end if;
  v_hours := coalesce((p ->> 'hold_hours')::int, case v_reason when 'AI_HOLD' then 24 when 'VIP_LOCKER' then 48 when 'TRY_ON' then 2 else 72 end);
  if v_reason = 'AI_HOLD' then
    if v_hours > 48 then raise exception 'A IA reserva por no máximo 48 horas' using errcode = 'P0094'; end if;
    if (select count(*) from inv.reservations x where x.org_id = v_org and x.party_id = (p ->> 'party_id')::uuid and x.reason = 'AI_HOLD' and x.status = 'ACTIVE') >= 3 then
      raise exception 'Limite de 3 itens retidos pela IA por cliente' using errcode = 'P0094';
    end if;
  end if;
  insert into inv.reservations (org_id, variant_id, location_id, qty, reason, party_id, conversation_id, expires_at, created_by_kind)
  values (v_org, (p ->> 'variant_id')::uuid, v_loc, (p ->> 'qty')::numeric, v_reason, (p ->> 'party_id')::uuid, (p ->> 'conversation_id')::uuid,
          now() + make_interval(hours => v_hours), v_actor) returning * into r;
  return r;
end $$;

create or replace function inv.release_reservation(p_reservation uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('sales.write');
  update inv.reservations set status = 'RELEASED' where id = p_reservation and org_id = private.org_id() and status = 'ACTIVE';
end $$;

-- ---------------------------------------------------------------------
-- Armário VIP
-- ---------------------------------------------------------------------
create table sales.locker_drops (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  store_id uuid not null references core.stores(id),
  locker_id uuid not null references inv.lockers(id),
  party_id uuid references crm.parties(id),
  outcome text not null default 'PENDING' check (outcome in ('PENDING', 'PURCHASED_ALL', 'PARTIAL', 'RETURNED', 'EXPIRED')),
  expires_at timestamptz not null,
  order_id uuid references sales.orders(id),
  notes text,
  prepared_by uuid references core.members(id),
  dropped_at timestamptz not null default now(),
  closed_at timestamptz
);
create index on sales.locker_drops (org_id, outcome);
create unique index locker_drops_open_uq on sales.locker_drops (locker_id) where outcome = 'PENDING';
alter table inv.reservations add constraint reservations_drop_fk foreign key (drop_id) references sales.locker_drops(id);

-- p = {store_id, locker_id, party_id, hold_hours?, notes?, items:[{variant_id, qty}]}
create or replace function sales.prepare_locker(p jsonb) returns sales.locker_drops
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id(); d sales.locker_drops; lk inv.lockers; it jsonb; v_hours int := coalesce((p ->> 'hold_hours')::int, 48); v_loc uuid;
begin
  perform private.require_perm('sales.write');
  select * into lk from inv.lockers where id = (p ->> 'locker_id')::uuid and org_id = v_org for update;
  if lk.id is null then raise exception 'Armário não encontrado'; end if;
  if lk.status <> 'FREE' then raise exception 'O armário % não está livre', lk.code using errcode = 'P0095'; end if;
  if jsonb_array_length(coalesce(p -> 'items', '[]')) = 0 then raise exception 'Escolha ao menos uma peça' using errcode = 'P0095'; end if;
  if coalesce(auth.role(), '') = 'authenticated' and not private.can_store(lk.store_id) then raise exception 'Sem acesso à loja' using errcode = '42501'; end if;
  v_loc := (select l.id from inv.locations l where l.org_id = v_org and l.store_id = lk.store_id and l.kind = 'SALES_FLOOR' order by l.created_at limit 1);
  insert into sales.locker_drops (org_id, store_id, locker_id, party_id, expires_at, notes, prepared_by)
  values (v_org, lk.store_id, lk.id, (p ->> 'party_id')::uuid, now() + make_interval(hours => v_hours), p ->> 'notes', private.member_id()) returning * into d;
  for it in select * from jsonb_array_elements(p -> 'items') loop
    insert into inv.reservations (org_id, variant_id, location_id, qty, reason, party_id, locker_id, drop_id, expires_at)
    values (v_org, (it ->> 'variant_id')::uuid, v_loc, (it ->> 'qty')::numeric, 'VIP_LOCKER', d.party_id, lk.id, d.id, d.expires_at);
  end loop;
  update inv.lockers set status = 'OCCUPIED' where id = lk.id;
  return d;
end $$;

-- Fecha o armário: libera o que sobrou e registra o resultado
create or replace function sales.close_locker_drop(p_drop uuid, p_outcome text, p_order uuid default null) returns sales.locker_drops
language plpgsql security definer set search_path = '' as $$
declare d sales.locker_drops;
begin
  perform private.require_perm('sales.write');
  if p_outcome not in ('PURCHASED_ALL', 'PARTIAL', 'RETURNED') then raise exception 'Resultado inválido'; end if;
  select * into d from sales.locker_drops where id = p_drop and org_id = private.org_id() for update;
  if d.id is null then raise exception 'Armário não encontrado'; end if;
  if d.outcome <> 'PENDING' then raise exception 'Este armário já foi encerrado' using errcode = 'P0095'; end if;
  update inv.reservations set status = 'RELEASED' where drop_id = d.id and status = 'ACTIVE';
  update inv.lockers set status = 'FREE' where id = d.locker_id;
  update sales.locker_drops set outcome = p_outcome, order_id = p_order, closed_at = now() where id = d.id returning * into d;
  return d;
end $$;

create or replace function sales.expire_locker_drops() returns int
language plpgsql security definer set search_path = '' as $$
declare d record; n int := 0;
begin
  for d in select id, locker_id from sales.locker_drops where outcome = 'PENDING' and expires_at < now() loop
    update inv.reservations set status = 'EXPIRED' where drop_id = d.id and status = 'ACTIVE';
    update inv.lockers set status = 'FREE' where id = d.locker_id;
    update sales.locker_drops set outcome = 'EXPIRED', closed_at = now() where id = d.id;
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function sales.expire_locker_drops() from authenticated;

-- ---------------------------------------------------------------------
-- Pedidos remotos (WhatsApp / Instagram / link): rascunho com reserva → pagamento → finalização
-- p = {store_id, channel?, party_id, conversation_id?, idempotency_key, items:[{variant_id, qty, unit_price?}], coupon_code?,
--      shipping_total?, fulfillment_type?, hold_hours?, assisted_by_ai?, seller_member_id?, notes?}
-- Totais SEMPRE calculados aqui; preço abaixo da lista exige sales.discount.
-- ---------------------------------------------------------------------
create or replace function sales.create_remote_order(p jsonb) returns sales.orders
language plpgsql security definer set search_path = '' as $$
declare
  v_store core.stores; v_org uuid; v_location uuid; v_price_list uuid; o sales.orders; it jsonb; v_list numeric; v_unit numeric; v_qty numeric; v_disc numeric;
  v_subtotal numeric := 0; v_discount numeric := 0; v_shipping numeric := coalesce((p ->> 'shipping_total')::numeric, 0); v_coupon sales.coupons; v_cdisc numeric;
  v_can_discount boolean; v_res inv.reservations; v_hours int := coalesce((p ->> 'hold_hours')::int, 24); v_item uuid; v_ai boolean := coalesce((p ->> 'assisted_by_ai')::boolean, false);
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

  insert into sales.orders (org_id, legal_entity_id, store_id, location_id, number, channel, status, party_id, seller_member_id, profit_cost_center_id,
                            price_list_id, origin_conversation_id, assisted_by_ai, fulfillment_type, idempotency_key, created_by, attribution, notes)
  values (v_org, v_store.legal_entity_id, v_store.id, v_location, core.next_number(v_org, 'VEN'), coalesce((p ->> 'channel')::sales.channel, 'WHATSAPP'), 'PENDING_PAYMENT',
          (p ->> 'party_id')::uuid, coalesce((p ->> 'seller_member_id')::uuid, private.member_id()),
          coalesce((select s.cost_center_id from core.stores s where s.id = v_store.id), null), v_price_list, (p ->> 'conversation_id')::uuid, v_ai,
          coalesce((p ->> 'fulfillment_type')::sales.fulfillment_type, 'MOTOBOY'), p ->> 'idempotency_key', private.member_id(), coalesce(p -> 'attribution', '{}'), p ->> 'notes')
  returning * into o;
  -- venda remota: o resultado vai para o centro DIGITAL da loja de origem do cliente, quando existir
  update sales.orders set profit_cost_center_id = coalesce(
    (select cc.id from core.cost_centers cc where cc.store_id = v_store.id and cc.kind = 'CHANNEL' and cc.channel = 'DIGITAL' limit 1),
    (select cc.id from core.cost_centers cc join core.cost_centers par on par.id = cc.parent_id where par.store_id = v_store.id and cc.kind = 'CHANNEL' and cc.code ilike '%DIGITAL%' limit 1),
    profit_cost_center_id) where id = o.id;

  for it in select * from jsonb_array_elements(p -> 'items') loop
    v_qty := (it ->> 'qty')::numeric;
    v_list := catalog.current_price((it ->> 'variant_id')::uuid, v_price_list);
    if v_list is null then raise exception 'Variante % sem preço vigente', it ->> 'variant_id' using errcode = 'P0007'; end if;
    v_unit := coalesce((it ->> 'unit_price')::numeric, v_list);
    v_disc := greatest(v_list - v_unit, 0) * v_qty;
    if v_disc > 0 and not v_can_discount then raise exception 'Desconto exige permissão sales.discount' using errcode = '42501'; end if;
    insert into sales.order_items (org_id, order_id, variant_id, qty, list_price, unit_price, discount_amount, total)
    values (v_org, o.id, (it ->> 'variant_id')::uuid, v_qty, v_list, v_list, v_disc, round(v_list * v_qty - v_disc, 2)) returning id into v_item;
    -- reserva o estoque enquanto aguarda o pagamento
    insert into inv.reservations (org_id, variant_id, location_id, qty, reason, order_id, party_id, conversation_id, expires_at, created_by_kind)
    values (v_org, (it ->> 'variant_id')::uuid, v_location, v_qty, 'ORDER', o.id, o.party_id, o.origin_conversation_id, now() + make_interval(hours => v_hours),
            case when v_ai then 'AI' else 'HUMAN' end) returning * into v_res;
    update sales.order_items set reservation_id = v_res.id where id = v_item;
    v_subtotal := v_subtotal + v_list * v_qty; v_discount := v_discount + v_disc;
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

-- Registra um pagamento (webhook da adquirente/banco, Pix confirmado à mão, link pago). Idempotente por external_id.
-- p = {order_id, method, amount, installments?, acquirer?, nsu?, auth_code?, brand?, last4?, external_id?, anticipation_mode?}
create or replace function sales.register_payment(p jsonb) returns sales.orders
language plpgsql security definer set search_path = '' as $$
declare
  o sales.orders; v_method text := p ->> 'method'; v_amount numeric := round((p ->> 'amount')::numeric, 2); v_inst int := coalesce((p ->> 'installments')::int, 1);
  v_mode text; v_rate numeric; v_paid numeric;
begin
  perform private.require_perm('sales.write');
  select * into o from sales.orders where id = (p ->> 'order_id')::uuid and org_id = coalesce(private.org_id(), org_id) for update;
  if o.id is null then raise exception 'Pedido não encontrado'; end if;
  if (p ->> 'external_id') is not null and exists (select 1 from sales.payments where order_id = o.id and external_id = p ->> 'external_id') then return o; end if;
  if o.status not in ('PENDING_PAYMENT', 'CONFIRMED', 'DRAFT') then raise exception 'O pedido % não aceita pagamento (situação %)', o.number, o.status using errcode = 'P0004'; end if;
  if v_method not in ('PIX', 'DEBIT', 'CREDIT', 'PAYMENT_LINK', 'BOLETO', 'STORE_CREDIT', 'CASH') then raise exception 'Forma de pagamento inválida para pedido remoto'; end if;
  if v_amount <= 0 or v_amount > o.total - o.paid_total then raise exception 'Valor (%) acima do saldo do pedido (%)', v_amount, o.total - o.paid_total using errcode = 'P0005'; end if;
  v_mode := case when v_method in ('DEBIT', 'CREDIT', 'PAYMENT_LINK') then coalesce(p ->> 'anticipation_mode', 'D1') end;
  v_rate := case when v_method in ('DEBIT', 'CREDIT', 'PAYMENT_LINK', 'PIX') and p ->> 'acquirer' is not null then
              fin.expected_fee_rate(o.org_id, p ->> 'acquirer', case when v_method = 'PAYMENT_LINK' then 'CREDIT' else v_method end, v_inst, coalesce(v_mode, 'NATURAL')) end;
  insert into sales.payments (org_id, order_id, method, amount, installments, acquirer, nsu, auth_code, brand, last4, external_id, anticipation_mode, fee_rate_expected, fee_expected, net_expected)
  values (o.org_id, o.id, v_method::sales.payment_method, v_amount, v_inst, p ->> 'acquirer', p ->> 'nsu', p ->> 'auth_code', p ->> 'brand', p ->> 'last4', p ->> 'external_id',
          v_mode, v_rate, round(v_amount * coalesce(v_rate, 0) / 100, 2), v_amount - round(v_amount * coalesce(v_rate, 0) / 100, 2));
  v_paid := o.paid_total + v_amount;
  update sales.orders set paid_total = v_paid where id = o.id;
  update sales.payment_links set status = 'PAID' where order_id = o.id and status in ('CREATED', 'SENT') and v_paid >= o.total;
  if v_paid >= o.total then return sales.finalize_order(o.id); end if;
  select * into o from sales.orders where id = o.id;
  return o;
end $$;

create or replace function sales.cancel_order(p_order uuid, p_reason text) returns sales.orders
language plpgsql security definer set search_path = '' as $$
declare o sales.orders;
begin
  perform private.require_perm('sales.write');
  select * into o from sales.orders where id = p_order and org_id = coalesce(private.org_id(), org_id) for update;
  if o.id is null then raise exception 'Pedido não encontrado'; end if;
  if o.status not in ('DRAFT', 'CONFIRMED', 'PENDING_PAYMENT') then raise exception 'Só pedidos ainda não pagos podem ser cancelados: use a devolução' using errcode = 'P0004'; end if;
  if o.paid_total > 0 then raise exception 'O pedido tem pagamento parcial registrado: estorne-o antes de cancelar' using errcode = 'P0004'; end if;
  update inv.reservations set status = 'RELEASED' where order_id = o.id and status = 'ACTIVE';
  update sales.payment_links set status = 'CANCELLED' where order_id = o.id and status in ('CREATED', 'SENT');
  update sales.orders set status = 'CANCELLED', notes = concat_ws(' · ', notes, 'Cancelado: ' || p_reason) where id = o.id returning * into o;
  return o;
end $$;

-- Cron: cancela pedidos remotos sem pagamento cujas reservas expiraram
create or replace function sales.expire_pending_orders() returns int
language plpgsql security definer set search_path = '' as $$
declare o record; n int := 0;
begin
  for o in select id from sales.orders where status = 'PENDING_PAYMENT' and paid_total = 0
           and not exists (select 1 from inv.reservations r where r.order_id = sales.orders.id and r.status = 'ACTIVE') loop
    update sales.payment_links set status = 'EXPIRED' where order_id = o.id and status in ('CREATED', 'SENT');
    update sales.orders set status = 'CANCELLED', notes = concat_ws(' · ', notes, 'Expirado sem pagamento') where id = o.id;
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function sales.expire_pending_orders() from authenticated;

-- ---------------------------------------------------------------------
-- Link de pagamento: o registro nasce aqui; o worker chama o provedor e preenche URL/ID externo
-- ---------------------------------------------------------------------
create or replace function sales.create_payment_link(p_order uuid, p_max_installments int default 1, p_provider text default 'MERCADOPAGO') returns sales.payment_links
language plpgsql security definer set search_path = '' as $$
declare o sales.orders; l sales.payment_links;
begin
  perform private.require_perm('sales.write');
  select * into o from sales.orders where id = p_order and org_id = coalesce(private.org_id(), org_id);
  if o.id is null then raise exception 'Pedido não encontrado'; end if;
  if o.status <> 'PENDING_PAYMENT' then raise exception 'O pedido precisa estar aguardando pagamento' using errcode = 'P0004'; end if;
  update sales.payment_links set status = 'CANCELLED' where order_id = o.id and status in ('CREATED', 'SENT');
  insert into sales.payment_links (org_id, order_id, provider, amount, max_installments, expires_at)
  values (o.org_id, o.id, p_provider, o.total - o.paid_total, least(greatest(p_max_installments, 1), 12),
          (select max(r.expires_at) from inv.reservations r where r.order_id = o.id and r.status = 'ACTIVE'))
  returning * into l;
  perform private.enqueue('notifications', jsonb_build_object('org_id', o.org_id, 'kind', 'PAYMENT_LINK_REQUESTED', 'link_id', l.id, 'order_id', o.id));
  return l;
end $$;

create or replace function sales.set_payment_link(p_link uuid, p_external_id text, p_url text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('sales.write');
  update sales.payment_links set external_id = p_external_id, url = p_url where id = p_link and org_id = coalesce(private.org_id(), org_id);
end $$;

-- ---------------------------------------------------------------------
-- Entregas
-- ---------------------------------------------------------------------
create table sales.shipments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  order_id uuid not null references sales.orders(id),
  carrier text not null check (carrier in ('MOTOBOY_OWN', 'MELHOR_ENVIO', 'PICKUP_LOCKER', 'PICKUP_STORE', 'OTHER')),
  tracking text,
  label_url text,
  cost numeric(14,2) not null default 0,
  charged numeric(14,2) not null default 0,
  status text not null default 'PENDING' check (status in ('PENDING', 'IN_TRANSIT', 'DELIVERED', 'FAILED', 'CANCELLED')),
  address jsonb not null default '{}',
  notes text,
  shipped_at timestamptz,
  delivered_at timestamptz,
  created_by uuid references core.members(id),
  created_at timestamptz not null default now()
);
create index on sales.shipments (order_id);

-- p = {order_id, shipment_id?, carrier, tracking?, cost?, charged?, status?, address?, notes?}
create or replace function sales.save_shipment(p jsonb) returns sales.shipments
language plpgsql security definer set search_path = '' as $$
declare o sales.orders; s sales.shipments; v_status text := coalesce(p ->> 'status', 'PENDING');
begin
  perform private.require_perm('sales.write');
  select * into o from sales.orders where id = (p ->> 'order_id')::uuid and org_id = private.org_id();
  if o.id is null then raise exception 'Pedido não encontrado'; end if;
  if o.status not in ('PAID', 'FULFILLING', 'READY_FOR_PICKUP', 'SHIPPED', 'COMPLETED') then raise exception 'Só pedidos pagos têm entrega' using errcode = 'P0004'; end if;
  if (p ->> 'shipment_id') is not null then
    update sales.shipments set carrier = coalesce(p ->> 'carrier', carrier), tracking = coalesce(p ->> 'tracking', tracking), cost = coalesce((p ->> 'cost')::numeric, cost),
      charged = coalesce((p ->> 'charged')::numeric, charged), status = v_status, address = coalesce(p -> 'address', address), notes = coalesce(p ->> 'notes', notes),
      shipped_at = case when v_status = 'IN_TRANSIT' and shipped_at is null then now() else shipped_at end,
      delivered_at = case when v_status = 'DELIVERED' and delivered_at is null then now() else delivered_at end
    where id = (p ->> 'shipment_id')::uuid and order_id = o.id returning * into s;
  else
    insert into sales.shipments (org_id, order_id, carrier, tracking, cost, charged, status, address, notes, shipped_at, created_by)
    values (o.org_id, o.id, p ->> 'carrier', p ->> 'tracking', coalesce((p ->> 'cost')::numeric, 0), coalesce((p ->> 'charged')::numeric, 0), v_status,
            coalesce(p -> 'address', '{}'), p ->> 'notes', case when v_status = 'IN_TRANSIT' then now() end, private.member_id()) returning * into s;
  end if;
  if s.id is null then raise exception 'Entrega não encontrada'; end if;
  update sales.orders set status = case v_status when 'IN_TRANSIT' then 'SHIPPED' when 'DELIVERED' then 'COMPLETED' else status end::sales.order_status,
         completed_at = case when v_status = 'DELIVERED' then now() else completed_at end
  where id = o.id and status not in ('PARTIALLY_RETURNED', 'RETURNED', 'CANCELLED');
  return s;
end $$;

-- Retirada na loja/armário: pronto para retirar → retirado
create or replace function sales.set_order_status(p_order uuid, p_status text) returns sales.orders
language plpgsql security definer set search_path = '' as $$
declare o sales.orders;
begin
  perform private.require_perm('sales.write');
  if p_status not in ('FULFILLING', 'READY_FOR_PICKUP', 'COMPLETED') then raise exception 'Situação inválida'; end if;
  update sales.orders set status = p_status::sales.order_status, completed_at = case when p_status = 'COMPLETED' then now() else completed_at end
  where id = p_order and org_id = private.org_id() and status in ('PAID', 'FULFILLING', 'READY_FOR_PICKUP', 'SHIPPED') returning * into o;
  if o.id is null then raise exception 'Pedido não encontrado ou fora do fluxo de entrega' using errcode = 'P0004'; end if;
  return o;
end $$;

select private.apply_rls('sales', array['locker_drops', 'shipments'], 'sales.read', 'sales.write');
select private.rpc_only('sales', array['locker_drops', 'shipments']);
select private.attach_updated_at('sales');

-- Cadastra armários numerados (A01, A02, ...) até a quantidade informada
create or replace function inv.ensure_lockers(p_store uuid, p_count int) returns int
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); i int; n int := 0;
begin
  perform private.require_perm('sales.write');
  if p_count < 1 or p_count > 60 then raise exception 'Informe de 1 a 60 armários'; end if;
  if not exists (select 1 from core.stores where id = p_store and org_id = v_org) then raise exception 'Loja inválida'; end if;
  for i in 1 .. p_count loop
    insert into inv.lockers (org_id, store_id, code) values (v_org, p_store, 'A' || lpad(i::text, 2, '0')) on conflict (store_id, code) do nothing;
    if found then n := n + 1; end if;
  end loop;
  return n;
end $$;
