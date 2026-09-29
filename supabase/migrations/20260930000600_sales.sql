-- =====================================================================
-- sales: pedidos omnichannel, itens, multi-pagamento, caixa, cupons, vale-troca, trocas
-- RPC principal do PDV: sales.create_pos_order(jsonb) → cria e finaliza numa transação só
-- =====================================================================

create type sales.channel as enum ('POS', 'WHATSAPP', 'INSTAGRAM', 'TELEGRAM', 'TIKTOK', 'PAYMENT_LINK', 'B2B', 'EVENT');
create type sales.order_status as enum (
  'DRAFT', 'CONFIRMED', 'PENDING_PAYMENT', 'PAID', 'FULFILLING', 'READY_FOR_PICKUP', 'SHIPPED',
  'COMPLETED', 'CANCELLED', 'PARTIALLY_RETURNED', 'RETURNED'
);
create type sales.fulfillment_type as enum ('TAKEAWAY', 'LOCKER_PICKUP', 'STORE_PICKUP', 'MOTOBOY', 'CARRIER');
create type sales.payment_method as enum ('PIX', 'DEBIT', 'CREDIT', 'CASH', 'PAYMENT_LINK', 'BOLETO', 'STORE_CREDIT', 'PERMUTA', 'B2B_INVOICE');

create table sales.coupons (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  code text not null,
  kind text not null check (kind in ('PERCENT', 'AMOUNT')),
  value numeric(14,2) not null check (value > 0),
  affiliate_party_id uuid references crm.parties(id),           -- cupom de JOY Trainer
  max_uses int,
  per_customer_limit int,
  min_order numeric(14,2),
  valid_from timestamptz not null default now(),
  valid_to timestamptz,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (org_id, code)
);

create table sales.cash_registers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  store_id uuid not null references core.stores(id),
  name text not null,
  device_id text,
  active boolean not null default true
);

create table sales.cash_sessions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  register_id uuid not null references sales.cash_registers(id),
  store_id uuid not null references core.stores(id),
  opened_by uuid not null references core.members(id),
  opened_at timestamptz not null default now(),
  opening_float numeric(14,2) not null default 0,
  closed_by uuid references core.members(id),
  closed_at timestamptz,
  expected_cash numeric(14,2),
  counted_cash numeric(14,2),
  difference numeric(14,2),
  status text not null default 'OPEN' check (status in ('OPEN', 'CLOSED')),
  notes text
);
create unique index cash_sessions_one_open on sales.cash_sessions (register_id) where status = 'OPEN';

create table sales.cash_session_movements (
  id bigint generated always as identity primary key,
  org_id uuid not null references core.orgs(id),
  session_id uuid not null references sales.cash_sessions(id),
  type text not null check (type in ('SUPRIMENTO', 'SANGRIA', 'SALE_CASH', 'CHANGE', 'REFUND_CASH')),
  amount numeric(14,2) not null,                                 -- positivo entra na gaveta, negativo sai
  reason text,
  order_id uuid,
  created_by uuid references core.members(id),
  created_at timestamptz not null default now()
);

create table sales.orders (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  legal_entity_id uuid not null references core.legal_entities(id),
  store_id uuid not null references core.stores(id),
  location_id uuid not null references inv.locations(id),       -- de onde sai o estoque
  number text not null,
  channel sales.channel not null,
  status sales.order_status not null default 'DRAFT',
  party_id uuid references crm.parties(id),
  seller_member_id uuid references core.members(id),
  origin_conversation_id uuid,
  assisted_by_ai boolean not null default false,
  profit_cost_center_id uuid references core.cost_centers(id),
  attribution jsonb not null default '{}',                       -- campanha, anúncio, ctwa_clid, cupom, afiliado, utm
  fulfillment_type sales.fulfillment_type not null default 'TAKEAWAY',
  price_list_id uuid references catalog.price_lists(id),
  coupon_id uuid references sales.coupons(id),
  cash_session_id uuid references sales.cash_sessions(id),
  cpf_on_invoice text,                                           -- CPF na nota (opcional), só para a NFC-e
  subtotal numeric(14,2) not null default 0,
  discount_total numeric(14,2) not null default 0,
  shipping_total numeric(14,2) not null default 0,
  total numeric(14,2) not null default 0,
  cost_total numeric(14,2) not null default 0,
  paid_total numeric(14,2) not null default 0,
  customer_confirmed_message_id uuid,
  idempotency_key text not null,
  notes text,
  completed_at timestamptz,
  created_by uuid references core.members(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, number),
  unique (org_id, idempotency_key)
);
create index on sales.orders (org_id, store_id, created_at desc);
create index on sales.orders (party_id, created_at desc);

create table sales.order_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  order_id uuid not null references sales.orders(id) on delete cascade,
  variant_id uuid not null references catalog.variants(id),
  qty numeric(12,3) not null check (qty > 0),
  list_price numeric(14,2) not null,
  unit_price numeric(14,2) not null check (unit_price >= 0),
  discount_amount numeric(14,2) not null default 0,
  discount_reason text,
  total numeric(14,2) not null,
  unit_cost_snapshot numeric(14,4),
  reservation_id uuid references inv.reservations(id),
  commissionable boolean not null default true,
  returned_qty numeric(12,3) not null default 0,
  cfop text, csosn text, ncm text
);
create index on sales.order_items (order_id);

-- Crédito da venda (base de comissão): fechador humano, assistência, IA, "casa"
create table sales.order_credits (
  order_id uuid not null references sales.orders(id) on delete cascade,
  org_id uuid not null references core.orgs(id),
  member_id uuid references core.members(id),
  role text not null check (role in ('CLOSER', 'ASSIST', 'AI', 'HOUSE')),
  share_pct numeric(5,2) not null check (share_pct between 0 and 100)
);
create unique index order_credits_uq on sales.order_credits (order_id, role, coalesce(member_id, '00000000-0000-0000-0000-000000000000'::uuid));

create table sales.payments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  order_id uuid not null references sales.orders(id) on delete cascade,
  method sales.payment_method not null,
  amount numeric(14,2) not null check (amount > 0),
  installments smallint not null default 1 check (installments between 1 and 24),
  acquirer text,                                                 -- STONE, SIPAG, MERCADOPAGO (cartão/link); banco no Pix
  acquirer_connection_id uuid references core.integration_connections(id),
  terminal_id text,
  nsu text,
  auth_code text,
  brand text,
  last4 char(4),
  external_id text,
  anticipation_mode text check (anticipation_mode in ('NATURAL', 'D1')),
  fee_rate_expected numeric(7,4),
  fee_expected numeric(14,2),
  net_expected numeric(14,2),
  status text not null default 'CAPTURED' check (status in ('PENDING', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'REFUNDED', 'CHARGEBACK')),
  created_at timestamptz not null default now()
);
create index on sales.payments (order_id);

create table sales.payment_links (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  order_id uuid not null references sales.orders(id),
  provider text not null,
  external_id text,
  url text,
  amount numeric(14,2) not null,
  max_installments smallint not null default 1,
  expires_at timestamptz,
  status text not null default 'CREATED' check (status in ('CREATED', 'SENT', 'PAID', 'EXPIRED', 'CANCELLED')),
  sent_message_id uuid,
  created_at timestamptz not null default now()
);

create table sales.coupon_redemptions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  coupon_id uuid not null references sales.coupons(id),
  order_id uuid not null references sales.orders(id),
  party_id uuid references crm.parties(id),
  amount numeric(14,2) not null,
  created_at timestamptz not null default now()
);

-- Vale-troca e crédito de afiliado: passivo, só-inserção
create table sales.store_credit_ledger (
  id bigint generated always as identity primary key,
  org_id uuid not null references core.orgs(id),
  party_id uuid not null references crm.parties(id),
  amount numeric(14,2) not null,                                 -- positivo concede, negativo resgata/expira
  reason text not null check (reason in ('RETURN', 'AFFILIATE_COMMISSION', 'GOODWILL', 'REDEMPTION', 'EXPIRATION')),
  source_type text,
  source_id uuid,
  expires_at date,
  created_by uuid references core.members(id),
  created_at timestamptz not null default now()
);
create index on sales.store_credit_ledger (party_id);
create trigger trg_store_credit_immutable before update or delete on sales.store_credit_ledger
  for each row execute function private.forbid_mutation();

create or replace function sales.store_credit_balance(p_party uuid) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(amount), 0) from sales.store_credit_ledger where party_id = p_party
$$;

create table sales.returns (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  number text not null,
  order_id uuid not null references sales.orders(id),
  type text not null check (type in ('RETURN_REFUND', 'EXCHANGE', 'STORE_CREDIT')),
  reason text not null check (reason in ('SIZE', 'DEFECT', 'REGRET_7D', 'OTHER')),
  amount numeric(14,2) not null default 0,
  fiscal_document_id uuid,
  exchange_order_id uuid references sales.orders(id),
  notes text,
  created_by uuid references core.members(id),
  created_at timestamptz not null default now(),
  unique (org_id, number)
);

create table sales.return_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  return_id uuid not null references sales.returns(id) on delete cascade,
  order_item_id uuid not null references sales.order_items(id),
  qty numeric(12,3) not null check (qty > 0),
  restock_location_id uuid references inv.locations(id)
);

alter table crm.deals add constraint deals_won_order_fk foreign key (won_order_id) references sales.orders(id);
alter table inv.reservations add constraint reservations_order_fk foreign key (order_id) references sales.orders(id);

-- ---------------------------------------------------------------------
-- Finalização: estoque, recebíveis, caixa, cliente, timeline e outbox fiscal — tudo numa transação
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
  v_expected date;
  v_cost_total numeric := 0;
  v_unit_cost numeric;
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
      insert into fin.titles (org_id, legal_entity_id, store_id, direction, number, party_id, document_kind,
                              issue_date, competence_date, description, total_amount, origin_type, origin_id,
                              cost_center_id, approval_status, created_by)
      values (o.org_id, o.legal_entity_id, o.store_id, 'RECEIVABLE', core.next_number(o.org_id, 'REC'),
              case when pay.method in ('BOLETO', 'B2B_INVOICE') then o.party_id end,
              pay.method::text, current_date, current_date,
              format('Venda %s — %s %sx', o.number, pay.method, pay.installments), pay.amount,
              'ORDER', o.id, o.profit_cost_center_id, 'APPROVED', o.created_by)
      returning id into v_title;

      for v_n in 1 .. pay.installments loop
        v_inst_amount := case when v_n < pay.installments then round(pay.amount / pay.installments, 2)
                              else pay.amount - round(pay.amount / pay.installments, 2) * (pay.installments - 1) end;
        v_inst_fee := round(v_inst_amount * coalesce(pay.fee_rate_expected, 0) / 100, 2);
        v_expected := case
          when pay.method = 'PIX' then current_date
          when pay.method = 'DEBIT' or pay.anticipation_mode = 'D1' then current_date + 1
          when pay.method in ('CREDIT', 'PAYMENT_LINK') then current_date + 30 * v_n
          when pay.method in ('BOLETO', 'B2B_INVOICE') then current_date + 30
          else current_date end;
        insert into fin.title_installments (org_id, title_id, n, due_date, expected_date, amount, fee_expected)
        values (o.org_id, v_title, v_n, v_expected, v_expected, v_inst_amount, v_inst_fee);
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
            format('Compra %s — R$ %s (%s)', o.number, to_char(o.total, 'FM999G999G990D00'), o.channel),
            jsonb_build_object('total', o.total, 'channel', o.channel));
  end if;

  -- 4) Outbox: emissão fiscal (NFC-e no balcão) e evento de conversão (CAPI)
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

-- PDV: cria o pedido completo (itens + pagamentos) e finaliza, de forma idempotente.
-- p = {idempotency_key, store_id, location_id?, channel?, party_id?, seller_member_id?, cash_session_id?,
--      cpf_on_invoice?, coupon_code?, items:[{variant_id, qty, unit_price?, discount_amount?, discount_reason?, reservation_id?}],
--      payments:[{method, amount, installments?, acquirer?, anticipation_mode?, nsu?, auth_code?, brand?, last4?, terminal_id?}]}
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

  -- Idempotência: mesma chave devolve o pedido já criado
  select * into o from sales.orders where org_id = v_org and idempotency_key = p ->> 'idempotency_key';
  if o.id is not null then return o; end if;
  if coalesce(p ->> 'idempotency_key', '') = '' then raise exception 'idempotency_key obrigatório'; end if;
  if jsonb_array_length(coalesce(p -> 'items', '[]')) = 0 then raise exception 'Pedido sem itens'; end if;

  v_location := coalesce((p ->> 'location_id')::uuid,
    (select l.id from inv.locations l where l.store_id = v_store.id and l.kind = 'SALES_FLOOR' order by l.created_at limit 1));
  if v_location is null then raise exception 'Loja sem local de estoque de venda'; end if;
  select id into v_price_list from catalog.price_lists where org_id = v_org and is_default;
  v_can_discount := coalesce(auth.role(), '') <> 'authenticated' or private.has_perm('sales.discount');

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
    v_list := catalog.current_price((it ->> 'variant_id')::uuid, v_price_list);
    if v_list is null then raise exception 'Variante % sem preço vigente', it ->> 'variant_id' using errcode = 'P0007'; end if;
    v_unit := coalesce((it ->> 'unit_price')::numeric, v_list);
    v_disc := coalesce((it ->> 'discount_amount')::numeric, 0) + greatest(v_list - v_unit, 0) * v_qty;
    if v_disc > 0 and not v_can_discount then
      raise exception 'Desconto exige permissão sales.discount' using errcode = '42501';
    end if;
    insert into sales.order_items (org_id, order_id, variant_id, qty, list_price, unit_price, discount_amount,
                                   discount_reason, total, reservation_id)
    values (v_org, o.id, (it ->> 'variant_id')::uuid, v_qty, v_list, v_list, v_disc, it ->> 'discount_reason',
            round(v_list * v_qty - v_disc, 2), (it ->> 'reservation_id')::uuid);
    v_subtotal := v_subtotal + v_list * v_qty;
    v_discount := v_discount + v_disc;
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

select private.attach_updated_at('sales');
