-- =====================================================================
-- Encomenda de peças da coleção que não estão no estoque
--  • catalog.products.backorder: liga/desliga "aceita encomenda" por produto (ou em lote: coleção, categoria, todos os do site).
--    Produto que veio do site nunca é apagado pela sincronização: some do site, continua no catálogo e pode ser encomendado.
--  • sales.create_backorder: cria o pedido da cliente (aguardando pagamento, sem reservar estoque) e, para cada peça, entra no pedido
--    de compra em RASCUNHO do fornecedor das encomendas (ou abre um), com a observação de qual venda pediu; abre a tarefa
--    "Fechar pedido de compra" (uma por pedido de compra), que se conclui sozinha quando o pedido é aprovado.
--  • Quando a peça chega (entrada de compra), reserva para a encomenda mais antiga, avisa e cria a tarefa de avisar a cliente.
--  • A encomenda aceita sinal (pagamento parcial); o restante só depois que todas as peças chegarem (o pagamento total baixa o estoque).
--  • Pedido cancelado tira a peça do pedido de compra ainda em rascunho. A rotina que vence pedidos sem pagamento não toca encomendas.
-- Códigos: P0350 dado inválido · P0351 configuração faltando · P0352 situação não permite.
-- =====================================================================

alter table catalog.products add column if not exists backorder boolean not null default false;

create table sales.backorder_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  order_id uuid not null references sales.orders(id) on delete cascade,
  order_item_id uuid not null references sales.order_items(id) on delete cascade,
  variant_id uuid not null references catalog.variants(id),
  qty numeric(12,3) not null check (qty > 0),
  po_id uuid references purch.purchase_orders(id) on delete set null,
  status text not null default 'OPEN' check (status in ('OPEN', 'ARRIVED', 'CANCELLED')),
  reservation_id uuid references inv.reservations(id),
  arrived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on sales.backorder_items (variant_id, status, created_at);
create index on sales.backorder_items (order_id);
select private.apply_rls('sales', array['backorder_items'], 'sales.read', 'sales.write');
select private.rpc_only('sales', array['backorder_items']);
select private.attach_updated_at('sales');

-- fornecedor padrão das encomendas: o fornecedor da marca, se já estiver no cadastro
insert into core.settings (org_id, key, value)
select o.id, 'backorders', jsonb_build_object('supplier_party_id', (
  select p.id from crm.parties p join crm.party_roles r on r.party_id = p.id and r.role = 'SUPPLIER'
  where p.org_id = o.id and p.display_name ilike 'si_ com%rcio de vestu%' order by p.created_at limit 1))
from core.orgs o
on conflict (org_id, key) do nothing;

-- ---------------------------------------------------------------------
-- Liga/desliga encomenda. p = {enabled, product_ids?[], collection_id?, category_id?, site?: true (todos os do site)}
-- ---------------------------------------------------------------------
create or replace function catalog.set_backorder(p jsonb) returns int
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); n int; v_on boolean := coalesce((p ->> 'enabled')::boolean, true);
begin
  perform private.require_perm('catalog.write');
  update catalog.products pr set backorder = v_on
  where pr.org_id = v_org and (
       (p ? 'product_ids' and pr.id in (select (x)::uuid from jsonb_array_elements_text(p -> 'product_ids') x))
    or (nullif(p ->> 'collection_id', '') is not null and pr.collection_id = (p ->> 'collection_id')::uuid)
    or (nullif(p ->> 'category_id', '') is not null and pr.category_id = (p ->> 'category_id')::uuid)
    or (coalesce((p ->> 'site')::boolean, false) and exists (select 1 from catalog.site_items si where si.product_id = pr.id)));
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function sales.set_backorder_supplier(p_party uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('purch.write');
  if not exists (select 1 from crm.party_roles r join crm.parties p on p.id = r.party_id where r.party_id = p_party and r.role = 'SUPPLIER' and p.org_id = private.org_id()) then
    raise exception 'Escolha um fornecedor do cadastro' using errcode = 'P0350';
  end if;
  insert into core.settings (org_id, key, value) values (private.org_id(), 'backorders', jsonb_build_object('supplier_party_id', p_party))
  on conflict (org_id, key) do update set value = core.settings.value || jsonb_build_object('supplier_party_id', p_party), updated_at = now();
end $$;

-- ---------------------------------------------------------------------
-- Encomenda. p = {store_id, party_id, channel?, notes?, items:[{variant_id, qty, unit_price?}]}
-- ---------------------------------------------------------------------
create or replace function sales.create_backorder(p jsonb) returns sales.orders
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id(); s core.stores; o sales.orders; po purch.purchase_orders; it jsonb; v record; v_loc uuid; v_supplier uuid;
  v_price numeric; v_qty numeric; v_item uuid; v_cost numeric; v_total numeric := 0; v_party text; v_task uuid; v_lines text := '';
begin
  perform private.require_perm('sales.write');
  select * into s from core.stores where id = (p ->> 'store_id')::uuid and org_id = v_org;
  if s.id is null then raise exception 'Loja não encontrada' using errcode = 'P0350'; end if;
  if coalesce(auth.role(), '') = 'authenticated' and not private.can_store(s.id) then raise exception 'Sem acesso à loja' using errcode = '42501'; end if;
  select display_name into v_party from crm.parties where id = (p ->> 'party_id')::uuid and org_id = v_org;
  if v_party is null then raise exception 'Escolha a cliente da encomenda' using errcode = 'P0350'; end if;
  if jsonb_array_length(coalesce(p -> 'items', '[]')) = 0 then raise exception 'Escolha ao menos uma peça' using errcode = 'P0350'; end if;
  select (value ->> 'supplier_party_id')::uuid into v_supplier from core.settings where org_id = v_org and key = 'backorders';
  if v_supplier is null then raise exception 'Defina o fornecedor das encomendas (Vender › Encomendas)' using errcode = 'P0351'; end if;
  v_loc := (select id from inv.locations where store_id = s.id and kind = 'SALES_FLOOR' order by created_at limit 1);
  if v_loc is null then raise exception 'Loja sem local de venda' using errcode = 'P0351'; end if;

  insert into sales.orders (org_id, legal_entity_id, store_id, location_id, number, channel, status, party_id, seller_member_id, fulfillment_type,
                            subtotal, total, idempotency_key, notes, created_by)
  values (v_org, s.legal_entity_id, s.id, v_loc, core.next_number(v_org, 'VEN'), coalesce(nullif(p ->> 'channel', ''), 'POS')::sales.channel, 'PENDING_PAYMENT',
          (p ->> 'party_id')::uuid, private.member_id(), 'TAKEAWAY', 0, 0, 'encomenda:' || gen_random_uuid(),
          concat_ws(' · ', 'ENCOMENDA (peças a pedir ao fornecedor)', nullif(trim(coalesce(p ->> 'notes', '')), '')), private.member_id())
  returning * into o;

  -- pedido de compra em rascunho do fornecedor nesta loja (complementa) ou um novo
  select * into po from purch.purchase_orders where org_id = v_org and supplier_party_id = v_supplier and store_id = s.id and status = 'DRAFT'
  order by created_at limit 1 for update;
  if po.id is null then
    insert into purch.purchase_orders (org_id, legal_entity_id, location_id, store_id, supplier_party_id, number, notes, total, created_by)
    values (v_org, s.legal_entity_id, v_loc, s.id, v_supplier, core.next_number(v_org, 'PC'), 'Encomendas de clientes (gerado pelo sistema)', 0, private.member_id())
    returning * into po;
  end if;

  for it in select * from jsonb_array_elements(p -> 'items') loop
    v_qty := coalesce((it ->> 'qty')::numeric, 1);
    if v_qty <= 0 or v_qty <> trunc(v_qty) or v_qty > 50 then raise exception 'Quantidade inválida' using errcode = 'P0350'; end if;
    select va.id, va.sku, pr.name, pr.backorder, c.name as color, va.size into v from catalog.variants va join catalog.products pr on pr.id = va.product_id
      left join catalog.colors c on c.id = va.color_id where va.id = (it ->> 'variant_id')::uuid and va.org_id = v_org;
    if v.id is null then raise exception 'Peça não encontrada' using errcode = 'P0350'; end if;
    if not v.backorder then raise exception '% não está liberado para encomenda', v.name using errcode = 'P0352'; end if;
    v_price := coalesce(nullif(it ->> 'unit_price', '')::numeric, catalog.current_price(v.id));
    if v_price is null or v_price <= 0 then raise exception '% (%) está sem preço', v.name, v.sku using errcode = 'P0350'; end if;

    insert into sales.order_items (org_id, order_id, variant_id, qty, list_price, unit_price, total)
    values (v_org, o.id, v.id, v_qty, v_price, v_price, round(v_price * v_qty, 2)) returning id into v_item;
    insert into sales.backorder_items (org_id, order_id, order_item_id, variant_id, qty, po_id) values (v_org, o.id, v_item, v.id, v_qty, po.id);
    v_total := v_total + round(v_price * v_qty, 2);

    v_cost := coalesce((select coalesce(ic.last_cost, ic.avg_cost) from inv.item_costs ic where ic.variant_id = v.id and ic.legal_entity_id = s.legal_entity_id), 0);
    if exists (select 1 from purch.po_items where po_id = po.id and variant_id = v.id) then
      update purch.po_items set qty_ordered = qty_ordered + v_qty where po_id = po.id and variant_id = v.id;
    else
      insert into purch.po_items (org_id, po_id, variant_id, qty_ordered, unit_cost) values (v_org, po.id, v.id, v_qty, v_cost);
    end if;
    v_lines := v_lines || format(E'\n%s × %s %s %s (%s)', v_qty::int, v.name, coalesce(v.color, ''), v.size, v.sku);
  end loop;

  update sales.orders set subtotal = v_total, total = v_total where id = o.id returning * into o;
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
  return o;
end $$;

-- tarefa de fechar se conclui quando o pedido de compra sai do rascunho
create or replace function private.on_po_status() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.status = 'DRAFT' and new.status <> 'DRAFT' then
    update crm.tasks set status = case when new.status = 'CANCELLED' then 'CANCELLED' else 'DONE' end, completed_at = now(),
      outcome_note = 'Pedido de compra ' || new.number || case when new.status = 'CANCELLED' then ' cancelado' else ' fechado' end
    where source_rule = 'po_close:' || new.id and status = 'OPEN';
  end if;
  return new;
end $$;
drop trigger if exists trg_po_status_tasks on purch.purchase_orders;
create trigger trg_po_status_tasks after update of status on purch.purchase_orders for each row execute function private.on_po_status();

-- chegada: entrada de compra reserva a peça para a encomenda mais antiga e avisa
create or replace function private.on_backorder_arrival() returns trigger
language plpgsql security definer set search_path = '' as $$
declare b record; r inv.reservations; v_av numeric; v_name text;
begin
  if new.movement_type <> 'PURCHASE_RECEIPT' or new.qty <= 0 then return new; end if;
  for b in select bi.*, o.party_id, o.number, o.store_id from sales.backorder_items bi join sales.orders o on o.id = bi.order_id
           join inv.locations l on l.id = new.location_id
           where bi.variant_id = new.variant_id and bi.status = 'OPEN' and o.status = 'PENDING_PAYMENT' and (l.store_id is null or o.store_id = l.store_id)
           order by bi.created_at for update of bi loop
    select available into v_av from inv.stock_levels where location_id = new.location_id and variant_id = new.variant_id;
    exit when coalesce(v_av, 0) < b.qty;
    insert into inv.reservations (org_id, variant_id, location_id, qty, reason, order_id, party_id, created_by_kind)
    values (b.org_id, b.variant_id, new.location_id, b.qty, 'ORDER', b.order_id, b.party_id, 'SYSTEM') returning * into r;
    update sales.order_items set reservation_id = r.id where id = b.order_item_id;
    update sales.backorder_items set status = 'ARRIVED', arrived_at = now(), reservation_id = r.id where id = b.id;
    select display_name into v_name from crm.parties where id = b.party_id;
    if not exists (select 1 from sales.backorder_items where order_id = b.order_id and status = 'OPEN') then
      perform core.notify(b.org_id, 'BACKORDER_ARRIVED', 'Chegou a encomenda ' || b.number || ' de ' || coalesce(v_name, 'cliente') || ': peças separadas',
                          jsonb_build_object('order_id', b.order_id, 'href', '/vender/pedidos/' || b.order_id), 'sales.write');
      insert into crm.tasks (org_id, party_id, type, title, body, due_at, source_rule)
      values (b.org_id, b.party_id, 'FOLLOW_UP', 'Avisar ' || split_part(coalesce(v_name, 'a cliente'), ' ', 1) || ' que a encomenda ' || b.number || ' chegou',
              'As peças já estão separadas no nome dela. Combine a retirada e receba o restante.', now() + interval '4 hours', 'backorder:' || b.order_id)
      on conflict do nothing;
    end if;
  end loop;
  return new;
end $$;
drop trigger if exists trg_backorder_arrival on inv.movements;
create trigger trg_backorder_arrival after insert on inv.movements for each row execute function private.on_backorder_arrival();

-- sinal sim; total só com tudo chegado (o pagamento total baixa o estoque)
create or replace function private.guard_backorder_payment() returns trigger
language plpgsql security definer set search_path = '' as $$
declare o sales.orders;
begin
  if not exists (select 1 from sales.backorder_items where order_id = new.order_id and status = 'OPEN') then return new; end if;
  select * into o from sales.orders where id = new.order_id;
  if o.paid_total + new.amount >= o.total then
    raise exception 'A encomenda % ainda não chegou: registre um sinal (menor que o total) e receba o restante quando as peças chegarem', o.number using errcode = 'P0352';
  end if;
  return new;
end $$;
drop trigger if exists trg_guard_backorder_payment on sales.payments;
create trigger trg_guard_backorder_payment before insert on sales.payments for each row execute function private.guard_backorder_payment();

-- cancelou a venda: tira as peças do pedido de compra ainda em rascunho
create or replace function private.on_backorder_order_cancel() returns trigger
language plpgsql security definer set search_path = '' as $$
declare b record;
begin
  if new.status = 'CANCELLED' and old.status <> 'CANCELLED' then
    for b in select * from sales.backorder_items where order_id = new.id and status = 'OPEN' loop
      update purch.po_items pi set qty_ordered = pi.qty_ordered - b.qty
      from purch.purchase_orders po where po.id = pi.po_id and po.id = b.po_id and po.status = 'DRAFT' and pi.variant_id = b.variant_id;
      delete from purch.po_items where po_id = b.po_id and variant_id = b.variant_id and qty_ordered <= 0;
      update purch.purchase_orders set total = (select coalesce(sum(qty_ordered * unit_cost), 0) from purch.po_items where po_id = b.po_id),
        notes = concat_ws(E'\n', notes, 'Encomenda ' || new.number || ' cancelada') where id = b.po_id and status = 'DRAFT';
    end loop;
    update sales.backorder_items set status = 'CANCELLED' where order_id = new.id and status <> 'CANCELLED';
  end if;
  return new;
end $$;
drop trigger if exists trg_backorder_cancel on sales.orders;
create trigger trg_backorder_cancel after update of status on sales.orders for each row execute function private.on_backorder_order_cancel();

-- a rotina de pedidos sem pagamento não vence encomenda
create or replace function sales.expire_pending_orders() returns integer
language plpgsql security definer set search_path = '' as $$
declare o record; n int := 0;
begin
  for o in select id from sales.orders where status = 'PENDING_PAYMENT' and paid_total = 0
           and not exists (select 1 from inv.reservations r where r.order_id = sales.orders.id and r.status = 'ACTIVE')
           and not exists (select 1 from sales.backorder_items b where b.order_id = sales.orders.id) loop
    update sales.payment_links set status = 'EXPIRED' where order_id = o.id and status in ('CREATED', 'SENT');
    update sales.orders set status = 'CANCELLED', notes = concat_ws(' · ', notes, 'Expirado sem pagamento') where id = o.id;
    n := n + 1;
  end loop;
  return n;
end $$;

insert into private.internal_functions (fqname) values ('private.on_po_status'), ('private.on_backorder_arrival'), ('private.guard_backorder_payment'), ('private.on_backorder_order_cancel')
on conflict do nothing;
select private.lock_functions();
