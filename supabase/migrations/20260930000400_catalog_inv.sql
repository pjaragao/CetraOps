-- =====================================================================
-- catalog: produto → variante (cor × tamanho), preços, mapeamento de fornecedor
-- inv: estoque como livro-razão (movimentos só-inserção) + saldos por local + reservas
-- =====================================================================

create table catalog.brands (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  name text not null,
  unique (org_id, name)
);

create table catalog.categories (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  parent_id uuid references catalog.categories(id),
  name text not null,
  ncm_default char(8),
  unique (org_id, parent_id, name)
);

create table catalog.size_grids (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  name text not null,                                           -- ex.: 'Feminino PP-GG', 'Masculino P-GG', 'Único'
  sizes text[] not null,
  unique (org_id, name)
);

create table catalog.colors (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  name text not null,
  code text,                                                    -- código curto usado no SKU
  hex char(7),
  unique (org_id, name)
);

create table catalog.collections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  name text not null,
  kind text not null check (kind in ('CORE', 'DROP', 'CAPSULE', 'ACCESSORY')),
  launch_date date,
  event_id uuid,
  created_at timestamptz not null default now()
);

create table catalog.size_charts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  name text not null,
  measurements jsonb not null default '{}'
);

create type catalog.gender as enum ('FEM', 'MASC', 'UNISSEX');
create type catalog.assortment_class as enum ('CORE', 'DROP', 'ACCESSORY');
create type catalog.product_kind as enum ('GOODS', 'SERVICE', 'GIFT_WRAP', 'FEE');
create type catalog.product_status as enum ('DRAFT', 'ACTIVE', 'DISCONTINUED');

create table catalog.products (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  brand_id uuid references catalog.brands(id),
  category_id uuid references catalog.categories(id),
  collection_id uuid references catalog.collections(id),
  size_grid_id uuid references catalog.size_grids(id),
  size_chart_id uuid references catalog.size_charts(id),
  reference_code text not null,
  name text not null,
  description text,
  composition text,
  care text,
  gender catalog.gender not null,                               -- linhas feminina e masculina
  assortment_class catalog.assortment_class not null default 'CORE',
  product_kind catalog.product_kind not null default 'GOODS',
  ncm char(8),
  cest char(7),
  origin smallint not null default 0,
  activities text[] not null default '{}',                      -- pilates, corrida, beach tennis...
  status catalog.product_status not null default 'DRAFT',
  custom_fields jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, reference_code)
);
create index products_name_trgm on catalog.products using gin (private.norm(name) extensions.gin_trgm_ops);

create table catalog.variants (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  product_id uuid not null references catalog.products(id) on delete cascade,
  color_id uuid references catalog.colors(id),
  size text not null,
  sku text not null,                                            -- REF-COR-TAM
  gtin text,
  supplier_sku text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, sku),
  unique (product_id, color_id, size)
);
create unique index variants_gtin_uq on catalog.variants (org_id, gtin) where gtin is not null and gtin <> 'SEM GTIN';

create table catalog.price_lists (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  name text not null,
  kind text not null check (kind in ('RETAIL', 'B2B', 'EMPLOYEE', 'EVENT')),
  is_default boolean not null default false
);
create unique index price_lists_default_uq on catalog.price_lists (org_id) where is_default;

create table catalog.prices (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  price_list_id uuid not null references catalog.price_lists(id) on delete cascade,
  product_id uuid references catalog.products(id) on delete cascade,
  variant_id uuid references catalog.variants(id) on delete cascade,  -- preço específico da variante sobrepõe o do produto
  price numeric(14,2) not null check (price >= 0),
  valid_from timestamptz not null default now(),
  valid_to timestamptz,
  check ((product_id is null) <> (variant_id is null))
);
create index on catalog.prices (price_list_id, product_id);
create index on catalog.prices (price_list_id, variant_id);

-- Preço vigente de uma variante numa lista (variante > produto)
create or replace function catalog.current_price(p_variant uuid, p_price_list uuid default null) returns numeric
language sql stable security definer set search_path = '' as $$
  with v as (select id, product_id, org_id from catalog.variants where id = p_variant),
       pl as (
         select coalesce(p_price_list, (select l.id from catalog.price_lists l, v where l.org_id = v.org_id and l.is_default)) as id
       )
  select p.price from catalog.prices p, v, pl
  where p.price_list_id = pl.id
    and (p.variant_id = v.id or p.product_id = v.product_id)
    and p.valid_from <= now() and (p.valid_to is null or p.valid_to > now())
  order by (p.variant_id is not null) desc, p.valid_from desc
  limit 1
$$;

create table catalog.product_media (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  product_id uuid not null references catalog.products(id) on delete cascade,
  color_id uuid references catalog.colors(id),
  storage_path text not null,
  position int not null default 0
);

-- Aprendizado do match NF-e → SKU (cProd/cEAN do fornecedor)
create table catalog.supplier_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  supplier_party_id uuid not null references crm.parties(id),
  supplier_cprod text not null,
  supplier_ean text,
  supplier_desc text,
  variant_id uuid not null references catalog.variants(id),
  factor numeric(12,4) not null default 1,
  confidence numeric(4,3),
  confirmed_by uuid references core.members(id),
  created_at timestamptz not null default now(),
  unique (org_id, supplier_party_id, supplier_cprod)
);

-- ---------------------------------------------------------------------
-- inv
-- ---------------------------------------------------------------------
create type inv.location_kind as enum (
  'SALES_FLOOR', 'BACKROOM', 'VIP_LOCKERS', 'IN_TRANSIT', 'CONSIGNMENT_AT_PARTNER', 'POPUP', 'DAMAGED', 'MARKETING'
);

create table inv.locations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  store_id uuid references core.stores(id),
  legal_entity_id uuid not null references core.legal_entities(id),
  name text not null,
  kind inv.location_kind not null,
  is_sellable boolean not null default true,
  allow_negative boolean not null default false,
  created_at timestamptz not null default now()
);

create table inv.lockers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  store_id uuid not null references core.stores(id),
  code text not null,
  status text not null default 'FREE' check (status in ('FREE', 'OCCUPIED', 'DISABLED')),
  unique (store_id, code)
);

create type inv.movement_type as enum (
  'INITIAL_BALANCE', 'PURCHASE_RECEIPT', 'SALE', 'SALE_RETURN', 'EXCHANGE_IN', 'EXCHANGE_OUT',
  'TRANSFER_OUT', 'TRANSFER_IN', 'COUNT_ADJUST', 'LOSS', 'DAMAGE', 'SPONSORSHIP_IN_KIND',
  'MARKETING_GIFT', 'CONSIGNMENT_OUT', 'CONSIGNMENT_RETURN', 'SUPPLIER_RETURN'
);

create table inv.movements (
  id bigint generated always as identity primary key,
  org_id uuid not null references core.orgs(id),
  occurred_at timestamptz not null default now(),
  variant_id uuid not null references catalog.variants(id),
  location_id uuid not null references inv.locations(id),
  qty numeric(12,3) not null check (qty <> 0),                 -- positivo entra, negativo sai
  unit_cost numeric(14,4),
  total_cost numeric(14,2),
  movement_type inv.movement_type not null,
  source_type text,
  source_id uuid,
  source_line_id uuid,
  reversal_of_id bigint references inv.movements(id),
  notes text,
  created_by uuid references core.members(id),
  created_at timestamptz not null default now()
);
create index on inv.movements (variant_id, location_id, occurred_at);
create index on inv.movements (source_type, source_id);

create table inv.stock_levels (
  org_id uuid not null references core.orgs(id),
  location_id uuid not null references inv.locations(id),
  variant_id uuid not null references catalog.variants(id),
  on_hand numeric(12,3) not null default 0,
  reserved numeric(12,3) not null default 0,
  available numeric(12,3) generated always as (on_hand - reserved) stored,
  updated_at timestamptz not null default now(),
  primary key (location_id, variant_id)
);

create table inv.item_costs (
  org_id uuid not null references core.orgs(id),
  legal_entity_id uuid not null references core.legal_entities(id),
  variant_id uuid not null references catalog.variants(id),
  avg_cost numeric(14,4) not null default 0,
  last_cost numeric(14,4),
  updated_at timestamptz not null default now(),
  primary key (legal_entity_id, variant_id)
);

-- Aplica o movimento ao saldo, bloqueia estoque negativo e atualiza custo médio nas entradas de compra
create or replace function private.apply_movement() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_loc record;
  v_new_on_hand numeric;
  v_prev_qty numeric;
  v_prev_avg numeric;
begin
  select l.legal_entity_id, l.allow_negative into v_loc from inv.locations l where l.id = new.location_id;

  -- Custo: saída sem custo informado usa o custo médio vigente
  if new.unit_cost is null then
    select ic.avg_cost into new.unit_cost from inv.item_costs ic
    where ic.legal_entity_id = v_loc.legal_entity_id and ic.variant_id = new.variant_id;
  end if;
  new.total_cost := round(coalesce(new.unit_cost, 0) * new.qty, 2);

  -- Custo médio ponderado por estabelecimento (entradas de compra)
  if new.movement_type = 'PURCHASE_RECEIPT' and new.qty > 0 then
    select coalesce(sum(sl.on_hand), 0) into v_prev_qty
    from inv.stock_levels sl join inv.locations l on l.id = sl.location_id
    where sl.variant_id = new.variant_id and l.legal_entity_id = v_loc.legal_entity_id;
    select ic.avg_cost into v_prev_avg from inv.item_costs ic
    where ic.legal_entity_id = v_loc.legal_entity_id and ic.variant_id = new.variant_id;

    insert into inv.item_costs as ic (org_id, legal_entity_id, variant_id, avg_cost, last_cost)
    values (new.org_id, v_loc.legal_entity_id, new.variant_id, new.unit_cost, new.unit_cost)
    on conflict (legal_entity_id, variant_id) do update set
      avg_cost = case when greatest(v_prev_qty, 0) + new.qty = 0 then new.unit_cost
                      else round((greatest(v_prev_qty, 0) * coalesce(v_prev_avg, 0) + new.qty * new.unit_cost)
                                 / (greatest(v_prev_qty, 0) + new.qty), 4) end,
      last_cost = new.unit_cost,
      updated_at = now();
  end if;

  insert into inv.stock_levels as sl (org_id, location_id, variant_id, on_hand)
  values (new.org_id, new.location_id, new.variant_id, new.qty)
  on conflict (location_id, variant_id) do update set on_hand = sl.on_hand + new.qty, updated_at = now()
  returning sl.on_hand into v_new_on_hand;

  if v_new_on_hand < 0 and not v_loc.allow_negative then
    raise exception 'Estoque insuficiente para a variante % no local % (saldo resultante %)',
      new.variant_id, new.location_id, v_new_on_hand using errcode = 'P0002';
  end if;
  return new;
end $$;

create trigger trg_apply_movement before insert on inv.movements
  for each row execute function private.apply_movement();
create trigger trg_movements_immutable before update or delete on inv.movements
  for each row execute function private.forbid_mutation();

-- Reservas (pedido, Armário VIP, retenção da IA, provador, B2B, lista de espera de drop)
create table inv.reservations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  variant_id uuid not null references catalog.variants(id),
  location_id uuid not null references inv.locations(id),
  qty numeric(12,3) not null check (qty > 0),
  reason text not null check (reason in ('ORDER', 'VIP_LOCKER', 'AI_HOLD', 'TRY_ON', 'B2B', 'DROP_WAITLIST')),
  order_id uuid,
  party_id uuid references crm.parties(id),
  conversation_id uuid,
  locker_id uuid references inv.lockers(id),
  expires_at timestamptz,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'CONSUMED', 'RELEASED', 'EXPIRED')),
  created_by_kind text not null default 'HUMAN' check (created_by_kind in ('HUMAN', 'AI', 'SYSTEM')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on inv.reservations (expires_at) where status = 'ACTIVE';

-- Mantém stock_levels.reserved coerente e bloqueia reservar além do disponível
create or replace function private.apply_reservation() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_delta numeric := 0;
  v_available numeric;
begin
  if tg_op = 'INSERT' and new.status = 'ACTIVE' then
    v_delta := new.qty;
  elsif tg_op = 'UPDATE' then
    if old.status = 'ACTIVE' and new.status <> 'ACTIVE' then v_delta := -old.qty;
    elsif old.status = 'ACTIVE' and new.status = 'ACTIVE' then v_delta := new.qty - old.qty;
    end if;
  end if;
  if v_delta = 0 then return new; end if;

  insert into inv.stock_levels as sl (org_id, location_id, variant_id, reserved)
  values (new.org_id, new.location_id, new.variant_id, v_delta)
  on conflict (location_id, variant_id) do update set reserved = sl.reserved + v_delta, updated_at = now()
  returning sl.available into v_available;

  if v_delta > 0 and v_available < 0 then
    raise exception 'Quantidade indisponível para reserva (disponível ficaria %)', v_available using errcode = 'P0003';
  end if;
  return new;
end $$;
create trigger trg_apply_reservation after insert or update of status, qty on inv.reservations
  for each row execute function private.apply_reservation();

create or replace function inv.expire_reservations() returns int
language sql security definer set search_path = '' as $$
  with x as (
    update inv.reservations set status = 'EXPIRED'
    where status = 'ACTIVE' and expires_at is not null and expires_at < now()
    returning 1
  ) select count(*)::int from x
$$;

create table inv.transfers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  number text not null,
  from_location_id uuid not null references inv.locations(id),
  to_location_id uuid not null references inv.locations(id),
  status text not null default 'DRAFT' check (status in ('DRAFT', 'IN_TRANSIT', 'RECEIVED', 'CANCELLED')),
  fiscal_document_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table inv.transfer_items (
  id uuid primary key default gen_random_uuid(),
  transfer_id uuid not null references inv.transfers(id) on delete cascade,
  org_id uuid not null references core.orgs(id),
  variant_id uuid not null references catalog.variants(id),
  qty numeric(12,3) not null check (qty > 0),
  qty_received numeric(12,3)
);

create table inv.counts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  location_id uuid not null references inv.locations(id),
  kind text not null check (kind in ('FULL', 'CYCLE', 'BLIND')),
  status text not null default 'OPEN' check (status in ('OPEN', 'POSTED', 'CANCELLED')),
  posted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table inv.count_items (
  id uuid primary key default gen_random_uuid(),
  count_id uuid not null references inv.counts(id) on delete cascade,
  org_id uuid not null references core.orgs(id),
  variant_id uuid not null references catalog.variants(id),
  expected numeric(12,3),
  counted numeric(12,3) not null,
  unique (count_id, variant_id)
);

-- Posta uma contagem: gera COUNT_ADJUST (ou INITIAL_BALANCE na primeira contagem) pela diferença
create or replace function inv.post_count(p_count uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare
  c record;
  it record;
  v_on_hand numeric;
  v_n int := 0;
begin
  select * into c from inv.counts where id = p_count for update;
  if c.status <> 'OPEN' then raise exception 'Contagem já postada ou cancelada'; end if;
  perform private.require_perm('inv.write');

  for it in select * from inv.count_items where count_id = p_count loop
    select coalesce(on_hand, 0) into v_on_hand from inv.stock_levels
    where location_id = c.location_id and variant_id = it.variant_id;
    v_on_hand := coalesce(v_on_hand, 0);
    update inv.count_items set expected = v_on_hand where id = it.id;
    if it.counted <> v_on_hand then
      insert into inv.movements (org_id, variant_id, location_id, qty, movement_type, source_type, source_id, created_by)
      values (c.org_id, it.variant_id, c.location_id, it.counted - v_on_hand,
              case when exists (select 1 from inv.movements m where m.variant_id = it.variant_id and m.location_id = c.location_id)
                   then 'COUNT_ADJUST'::inv.movement_type else 'INITIAL_BALANCE'::inv.movement_type end,
              'inv.counts', c.id, private.member_id());
      v_n := v_n + 1;
    end if;
  end loop;

  update inv.counts set status = 'POSTED', posted_at = now() where id = p_count;
  return v_n;
end $$;

-- Matriz de estoque produto × tamanho × local
create view inv.v_stock_matrix with (security_invoker = true) as
select sl.org_id, l.store_id, sl.location_id, l.name as location_name, p.id as product_id, p.reference_code,
       p.name as product_name, p.gender, c.name as color, v.id as variant_id, v.sku, v.size,
       sl.on_hand, sl.reserved, sl.available
from inv.stock_levels sl
join inv.locations l on l.id = sl.location_id
join catalog.variants v on v.id = sl.variant_id
join catalog.products p on p.id = v.product_id
left join catalog.colors c on c.id = v.color_id;

select private.attach_updated_at('catalog');
select private.attach_updated_at('inv');
