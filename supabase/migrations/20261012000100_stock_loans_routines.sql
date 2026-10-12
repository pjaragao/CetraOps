-- =====================================================================
-- Estoque na prática, malinhas/campanhas, rotina da loja e avisos sem repetição
--  1) Contagem de estoque: abrir, bipar (somar ou fixar), cancelar e lançar. A vendedora conta (inv.count); quem tem inv.write lança.
--     Contagem COMPLETA zera o que estava no sistema e não foi contado; PARCIAL só mexe no que foi contado.
--  2) Ajuste avulso com motivo (perda, avaria, brinde de marketing, correção) — inv.write.
--  3) Custo na entrada de estoque inicial/contagem (custo médio passa a nascer também do estoque inicial).
--  4) Importação de catálogo com quantidade, custo, marca e coleção (a quantidade FIXA o saldo do local: reimportar não duplica).
--  5) Malinhas (peças levadas pela cliente para provar) e peças em campanha (fotos, influenciadoras, eventos):
--     saem do balcão para um local "fora da loja" (não vendável), voltam, viram venda, perda, avaria ou brinde.
--  6) Rotina de abertura e fechamento da loja: itens automáticos (conferidos nos dados) + itens marcados à mão.
--  7) core.notify não repete o mesmo aviso não lido (conta as repetições).
--  8) Limpeza do histórico do pg_cron e aviso de malinhas vencidas.
-- =====================================================================

alter type inv.location_kind add value if not exists 'WITH_CUSTOMER';

insert into core.permission_catalog (key, area, label, description, position)
values ('inv.count', 'Estoque', 'Contar estoque', 'Bipar peças numa contagem. Lançar a contagem e ajustar o saldo continua exigindo "Movimentar estoque".', 57)
on conflict (key) do nothing;

-- vendedora conta estoque
insert into core.role_permissions (role_id, permission_key)
select r.id, 'inv.count' from core.roles r where r.key = 'seller' on conflict do nothing;

-- ---------------------------------------------------------------------
-- 1) Contagem
-- ---------------------------------------------------------------------
alter table inv.counts add column if not exists notes text,
  add column if not exists created_by uuid references core.members(id),
  add column if not exists posted_by uuid references core.members(id),
  add column if not exists adjusted int;
alter table inv.count_items add column if not exists unit_cost numeric(14,4),
  add column if not exists updated_at timestamptz not null default now();

select private.rpc_only('inv', array['counts', 'count_items']);

create or replace function private.require_any_perm(p_perms text[]) returns void
language plpgsql stable security definer set search_path = '' as $$
declare p text;
begin
  foreach p in array p_perms loop
    if private.has_perm(p) then return; end if;
  end loop;
  raise exception 'Sem permissão: %', array_to_string(p_perms, ' ou ') using errcode = '42501';
end $$;

-- p_kind: FULL (local inteiro) | CYCLE (parcial)
create or replace function inv.start_count(p_location uuid, p_kind text default 'FULL', p_notes text default null) returns inv.counts
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); c inv.counts; l inv.locations;
begin
  perform private.require_any_perm(array['inv.count', 'inv.write']);
  if p_kind not in ('FULL', 'CYCLE') then raise exception 'Tipo de contagem inválido' using errcode = 'P0301'; end if;
  select * into l from inv.locations where id = p_location and org_id = v_org;
  if l.id is null then raise exception 'Local não encontrado' using errcode = 'P0301'; end if;
  if l.store_id is not null and coalesce(auth.role(), '') = 'authenticated' and not private.can_store(l.store_id) then
    raise exception 'Sem acesso à loja' using errcode = '42501';
  end if;
  if exists (select 1 from inv.counts where location_id = p_location and status = 'OPEN') then
    raise exception 'Já existe uma contagem aberta neste local: termine ou cancele a anterior' using errcode = 'P0301';
  end if;
  insert into inv.counts (org_id, location_id, kind, notes, created_by)
  values (v_org, p_location, p_kind, nullif(trim(coalesce(p_notes, '')), ''), private.member_id()) returning * into c;
  return c;
end $$;

-- Bipe (ADD soma) ou digitação (SET fixa). Quantidade zero com SET remove a linha.
create or replace function inv.count_item(p_count uuid, p_variant uuid, p_qty numeric, p_mode text default 'ADD', p_unit_cost numeric default null) returns inv.count_items
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); c inv.counts; it inv.count_items;
begin
  perform private.require_any_perm(array['inv.count', 'inv.write']);
  select * into c from inv.counts where id = p_count and org_id = v_org for update;
  if c.id is null then raise exception 'Contagem não encontrada' using errcode = 'P0301'; end if;
  if c.status <> 'OPEN' then raise exception 'Contagem já encerrada' using errcode = 'P0301'; end if;
  if p_mode not in ('ADD', 'SET') then raise exception 'Modo inválido' using errcode = 'P0301'; end if;
  if p_qty is null or (p_mode = 'SET' and p_qty < 0) or p_qty <> trunc(p_qty) or abs(p_qty) > 100000 then
    raise exception 'Quantidade inválida' using errcode = 'P0301';
  end if;
  if p_unit_cost is not null and p_unit_cost < 0 then raise exception 'Custo inválido' using errcode = 'P0301'; end if;
  if not exists (select 1 from catalog.variants where id = p_variant and org_id = v_org) then raise exception 'Peça não encontrada' using errcode = 'P0301'; end if;

  if p_mode = 'SET' and p_qty = 0 then
    delete from inv.count_items where count_id = c.id and variant_id = p_variant returning * into it;
    return it;
  end if;
  insert into inv.count_items as ci (count_id, org_id, variant_id, counted, unit_cost)
  values (c.id, v_org, p_variant, greatest(p_qty, 0), p_unit_cost)
  on conflict (count_id, variant_id) do update
    set counted = case when p_mode = 'ADD' then greatest(ci.counted + p_qty, 0) else p_qty end,
        unit_cost = coalesce(p_unit_cost, ci.unit_cost), updated_at = now()
  returning * into it;
  return it;
end $$;

create or replace function inv.cancel_count(p_count uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_any_perm(array['inv.count', 'inv.write']);
  update inv.counts set status = 'CANCELLED' where id = p_count and org_id = private.org_id() and status = 'OPEN';
  if not found then raise exception 'Contagem não encontrada ou já encerrada' using errcode = 'P0301'; end if;
end $$;

-- Lança a contagem: ajusta cada peça pela diferença. COMPLETA zera o que não foi contado.
create or replace function inv.post_count(p_count uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare
  c inv.counts; it record; v_n int := 0; v_first boolean;
begin
  perform private.require_perm('inv.write');
  select * into c from inv.counts where id = p_count and org_id = private.org_id() for update;
  if c.id is null then raise exception 'Contagem não encontrada' using errcode = 'P0301'; end if;
  if c.status <> 'OPEN' then raise exception 'Contagem já lançada ou cancelada' using errcode = 'P0301'; end if;

  -- contagem completa: o que tem saldo e não foi contado vira zero
  if c.kind = 'FULL' then
    insert into inv.count_items (count_id, org_id, variant_id, counted)
    select c.id, c.org_id, sl.variant_id, 0 from inv.stock_levels sl
    where sl.location_id = c.location_id and sl.on_hand <> 0
      and not exists (select 1 from inv.count_items ci where ci.count_id = c.id and ci.variant_id = sl.variant_id);
  end if;

  for it in
    select ci.id, ci.variant_id, ci.counted, ci.unit_cost, coalesce(sl.on_hand, 0) as on_hand, coalesce(sl.reserved, 0) as reserved
    from inv.count_items ci left join inv.stock_levels sl on sl.location_id = c.location_id and sl.variant_id = ci.variant_id
    where ci.count_id = c.id
  loop
    update inv.count_items set expected = it.on_hand where id = it.id;
    if it.counted < it.reserved then
      raise exception 'A peça % tem % reservada(s) e só % contada(s): libere a reserva antes de lançar',
        (select sku from catalog.variants where id = it.variant_id), it.reserved, it.counted using errcode = 'P0302';
    end if;
    if it.counted <> it.on_hand then
      v_first := not exists (select 1 from inv.movements m where m.variant_id = it.variant_id and m.location_id = c.location_id);
      insert into inv.movements (org_id, variant_id, location_id, qty, unit_cost, movement_type, source_type, source_id, notes, created_by)
      values (c.org_id, it.variant_id, c.location_id, it.counted - it.on_hand,
              case when it.counted > it.on_hand then it.unit_cost end,
              case when v_first then 'INITIAL_BALANCE'::inv.movement_type else 'COUNT_ADJUST'::inv.movement_type end,
              'inv.counts', c.id, 'Contagem de estoque', private.member_id());
      v_n := v_n + 1;
    end if;
  end loop;

  update inv.counts set status = 'POSTED', posted_at = now(), posted_by = private.member_id(), adjusted = v_n where id = c.id;
  return v_n;
end $$;

-- ---------------------------------------------------------------------
-- 2) Ajuste avulso. p = {location_id, reason: LOSS|DAMAGE|MARKETING_GIFT|CORRECTION, notes, items:[{variant_id, qty}]}
--    qty positiva só em CORRECTION (entrada); nos demais é saída (o sinal é aplicado aqui).
-- ---------------------------------------------------------------------
create or replace function inv.adjust_stock(p jsonb) returns int
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id(); v_loc inv.locations; it jsonb; v_reason text := upper(coalesce(p ->> 'reason', '')); v_qty numeric; v_n int := 0;
  v_notes text := nullif(trim(coalesce(p ->> 'notes', '')), ''); v_id uuid := gen_random_uuid();
begin
  perform private.require_perm('inv.write');
  if v_reason not in ('LOSS', 'DAMAGE', 'MARKETING_GIFT', 'CORRECTION') then raise exception 'Motivo inválido' using errcode = 'P0303'; end if;
  if v_notes is null or length(v_notes) < 3 then raise exception 'Explique o motivo do ajuste' using errcode = 'P0303'; end if;
  select * into v_loc from inv.locations where id = (p ->> 'location_id')::uuid and org_id = v_org;
  if v_loc.id is null then raise exception 'Local não encontrado' using errcode = 'P0303'; end if;
  if jsonb_array_length(coalesce(p -> 'items', '[]')) = 0 then raise exception 'Informe ao menos uma peça' using errcode = 'P0303'; end if;
  for it in select * from jsonb_array_elements(p -> 'items') loop
    v_qty := (it ->> 'qty')::numeric;
    if v_qty is null or v_qty = 0 or v_qty <> trunc(v_qty) then raise exception 'Quantidade inválida' using errcode = 'P0303'; end if;
    if v_reason <> 'CORRECTION' then v_qty := -abs(v_qty); end if;
    if not exists (select 1 from catalog.variants where id = (it ->> 'variant_id')::uuid and org_id = v_org) then raise exception 'Peça não encontrada' using errcode = 'P0303'; end if;
    insert into inv.movements (org_id, variant_id, location_id, qty, movement_type, source_type, source_id, notes, created_by)
    values (v_org, (it ->> 'variant_id')::uuid, v_loc.id, v_qty,
            case v_reason when 'LOSS' then 'LOSS' when 'DAMAGE' then 'DAMAGE' when 'MARKETING_GIFT' then 'MARKETING_GIFT' else 'COUNT_ADJUST' end::inv.movement_type,
            'inv.adjust', v_id, v_notes, private.member_id());
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- ---------------------------------------------------------------------
-- 3) Custo médio também nasce do estoque inicial e das entradas de contagem com custo informado
-- ---------------------------------------------------------------------
create or replace function private.apply_movement() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_loc record;
  v_new_on_hand numeric;
  v_prev_qty numeric;
  v_prev_avg numeric;
  v_cost_given boolean := new.unit_cost is not null;
begin
  select l.legal_entity_id, l.allow_negative into v_loc from inv.locations l where l.id = new.location_id;

  if new.unit_cost is null then
    select ic.avg_cost into new.unit_cost from inv.item_costs ic
    where ic.legal_entity_id = v_loc.legal_entity_id and ic.variant_id = new.variant_id;
  end if;
  new.total_cost := round(coalesce(new.unit_cost, 0) * new.qty, 2);

  if new.qty > 0 and (new.movement_type = 'PURCHASE_RECEIPT'
                      or (v_cost_given and new.movement_type in ('INITIAL_BALANCE', 'COUNT_ADJUST'))) then
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

-- Matriz de estoque com o tipo do local (o PDV e o Estoque somam só o que é vendável)
create or replace view inv.v_stock_matrix with (security_invoker = true) as
select sl.org_id, l.store_id, sl.location_id, l.name as location_name, p.id as product_id, p.reference_code,
       p.name as product_name, p.gender, c.name as color, v.id as variant_id, v.sku, v.size,
       sl.on_hand, sl.reserved, sl.available, l.is_sellable, l.kind::text as location_kind
from inv.stock_levels sl
join inv.locations l on l.id = sl.location_id
join catalog.variants v on v.id = sl.variant_id
join catalog.products p on p.id = v.product_id
left join catalog.colors c on c.id = v.color_id;

-- ---------------------------------------------------------------------
-- 4) Importação de catálogo com estoque e custo
-- p = [{reference_code, name, gender, category?, ncm?, color, color_code?, size, gtin?, price?, qty?, cost?, brand?, collection?}]
-- p_location: onde a quantidade é fixada (padrão: balcão da loja). A quantidade FIXA o saldo; reimportar não soma.
-- ---------------------------------------------------------------------
create or replace function catalog.import_rows(p jsonb, p_location uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id();
  r jsonb;
  v_cat uuid; v_color uuid; v_prod uuid; v_var uuid; v_pl uuid; v_grid uuid; v_brand uuid; v_coll uuid;
  v_products int := 0; v_variants int := 0; v_prices int := 0; v_stock int := 0;
  v_errors jsonb := '[]';
  v_i int := 0;
  v_sku text; v_qty numeric; v_cost numeric; v_on_hand numeric; v_loc inv.locations; v_le uuid;
begin
  perform private.require_perm('catalog.write');
  if v_org is null then raise exception 'Sem organização no token' using errcode = '42501'; end if;
  select id into v_pl from catalog.price_lists where org_id = v_org and is_default;

  if exists (select 1 from jsonb_array_elements(p) e where coalesce(e ->> 'qty', '') <> '' or coalesce(e ->> 'cost', '') <> '') then
    perform private.require_perm('inv.write');
    if p_location is not null then
      select * into v_loc from inv.locations where id = p_location and org_id = v_org;
    else
      select * into v_loc from inv.locations where org_id = v_org and kind = 'SALES_FLOOR'
        order by created_at limit 1;
    end if;
    if v_loc.id is null then raise exception 'Local de estoque não encontrado para a quantidade' using errcode = 'P0304'; end if;
    v_le := v_loc.legal_entity_id;
  end if;

  for r in select * from jsonb_array_elements(p) loop
    v_i := v_i + 1;
    begin
      if coalesce(r ->> 'reference_code', '') = '' or coalesce(r ->> 'size', '') = '' or coalesce(r ->> 'name', '') = '' then
        raise exception 'referência, nome e tamanho são obrigatórios';
      end if;
      if upper(r ->> 'gender') not in ('FEM', 'MASC', 'UNISSEX') then
        raise exception 'gênero deve ser FEM, MASC ou UNISSEX';
      end if;
      v_qty := nullif(r ->> 'qty', '')::numeric;
      v_cost := nullif(r ->> 'cost', '')::numeric;
      if v_qty is not null and (v_qty < 0 or v_qty <> trunc(v_qty)) then raise exception 'quantidade deve ser um número inteiro ≥ 0'; end if;
      if v_cost is not null and v_cost < 0 then raise exception 'custo inválido'; end if;
      if nullif(r ->> 'price', '') is not null and (r ->> 'price')::numeric < 0 then raise exception 'preço inválido'; end if;

      v_cat := null;
      if coalesce(r ->> 'category', '') <> '' then
        insert into catalog.categories (org_id, name, ncm_default) values (v_org, trim(r ->> 'category'), nullif(r ->> 'ncm', ''))
        on conflict (org_id, parent_id, name) do nothing;
        select id into v_cat from catalog.categories where org_id = v_org and name = trim(r ->> 'category') and parent_id is null;
      end if;
      v_brand := null;
      if coalesce(trim(r ->> 'brand'), '') <> '' then
        insert into catalog.brands (org_id, name) values (v_org, trim(r ->> 'brand')) on conflict (org_id, name) do nothing;
        select id into v_brand from catalog.brands where org_id = v_org and name = trim(r ->> 'brand');
      end if;
      v_coll := null;
      if coalesce(trim(r ->> 'collection'), '') <> '' then
        select id into v_coll from catalog.collections where org_id = v_org and name = trim(r ->> 'collection') limit 1;
        if v_coll is null then
          insert into catalog.collections (org_id, name, kind) values (v_org, trim(r ->> 'collection'), 'DROP') returning id into v_coll;
        end if;
      end if;

      insert into catalog.colors (org_id, name, code) values (v_org, trim(coalesce(r ->> 'color', 'Única')),
        upper(coalesce(nullif(r ->> 'color_code', ''), left(regexp_replace(private.norm(coalesce(r ->> 'color', 'UN')), '[^a-z]', '', 'g'), 3))))
      on conflict (org_id, name) do nothing;
      select id into v_color from catalog.colors where org_id = v_org and name = trim(coalesce(r ->> 'color', 'Única'));

      select id into v_grid from catalog.size_grids where org_id = v_org
        and name = case upper(r ->> 'gender') when 'MASC' then 'Masculino P-GG' else 'Feminino PP-GG' end;

      insert into catalog.products (org_id, category_id, size_grid_id, reference_code, name, gender, ncm, status, brand_id, collection_id)
      values (v_org, v_cat, v_grid, upper(trim(r ->> 'reference_code')), trim(r ->> 'name'),
              upper(r ->> 'gender')::catalog.gender, nullif(regexp_replace(coalesce(r ->> 'ncm', ''), '\D', '', 'g'), ''), 'ACTIVE', v_brand, v_coll)
      on conflict (org_id, reference_code) do update set name = excluded.name, category_id = coalesce(excluded.category_id, catalog.products.category_id),
        ncm = coalesce(excluded.ncm, catalog.products.ncm), brand_id = coalesce(excluded.brand_id, catalog.products.brand_id),
        collection_id = coalesce(excluded.collection_id, catalog.products.collection_id)
      returning id into v_prod;
      v_products := v_products + 1;

      v_sku := upper(trim(r ->> 'reference_code')) || '-' || (select code from catalog.colors where id = v_color) || '-' || upper(trim(r ->> 'size'));
      insert into catalog.variants (org_id, product_id, color_id, size, sku, gtin)
      values (v_org, v_prod, v_color, upper(trim(r ->> 'size')), v_sku, nullif(regexp_replace(coalesce(r ->> 'gtin', ''), '\D', '', 'g'), ''))
      on conflict (product_id, color_id, size) do update set gtin = coalesce(excluded.gtin, catalog.variants.gtin)
      returning id into v_var;
      v_variants := v_variants + 1;

      if nullif(r ->> 'price', '') is not null then
        update catalog.prices set valid_to = now()
        where price_list_id = v_pl and product_id = v_prod and variant_id is null and valid_to is null and price <> (r ->> 'price')::numeric;
        if not exists (select 1 from catalog.prices where price_list_id = v_pl and product_id = v_prod and variant_id is null and valid_to is null) then
          insert into catalog.prices (org_id, price_list_id, product_id, price) values (v_org, v_pl, v_prod, (r ->> 'price')::numeric);
          v_prices := v_prices + 1;
        end if;
      end if;

      if v_qty is not null then
        select coalesce(on_hand, 0) into v_on_hand from inv.stock_levels where location_id = v_loc.id and variant_id = v_var;
        v_on_hand := coalesce(v_on_hand, 0);
        if v_qty <> v_on_hand then
          insert into inv.movements (org_id, variant_id, location_id, qty, unit_cost, movement_type, source_type, notes, created_by)
          values (v_org, v_var, v_loc.id, v_qty - v_on_hand, case when v_qty > v_on_hand then v_cost end,
                  case when exists (select 1 from inv.movements m where m.variant_id = v_var and m.location_id = v_loc.id)
                       then 'COUNT_ADJUST'::inv.movement_type else 'INITIAL_BALANCE'::inv.movement_type end,
                  'catalog.import', 'Importação de catálogo', private.member_id());
          v_stock := v_stock + 1;
        end if;
      end if;
      if v_cost is not null and v_le is not null then
        insert into inv.item_costs (org_id, legal_entity_id, variant_id, avg_cost, last_cost)
        values (v_org, v_le, v_var, v_cost, v_cost)
        on conflict (legal_entity_id, variant_id) do update set last_cost = excluded.last_cost,
          avg_cost = case when inv.item_costs.avg_cost = 0 then excluded.avg_cost else inv.item_costs.avg_cost end, updated_at = now();
      end if;
    exception when others then
      v_errors := v_errors || jsonb_build_object('linha', v_i, 'erro', sqlerrm);
    end;
  end loop;

  return jsonb_build_object('linhas', v_i, 'produtos', v_products, 'variantes', v_variants, 'precos', v_prices, 'estoque', v_stock, 'erros', v_errors);
end $$;
drop function if exists catalog.import_rows(jsonb);

-- ---------------------------------------------------------------------
-- 5) Malinhas e peças em campanha
-- ---------------------------------------------------------------------
create table inv.loans (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  store_id uuid not null references core.stores(id),
  number text not null,
  kind text not null check (kind in ('TRY_ON', 'CAMPAIGN')),
  party_id uuid references crm.parties(id),
  campaign_id uuid references mkt.campaigns(id),
  purpose text,
  from_location_id uuid not null references inv.locations(id),
  out_location_id uuid not null references inv.locations(id),
  due_at timestamptz not null,
  status text not null default 'OPEN' check (status in ('OPEN', 'CLOSED', 'CANCELLED')),
  order_id uuid references sales.orders(id),
  notes text,
  created_by uuid references core.members(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz,
  overdue_notified_at timestamptz,
  check (kind = 'CAMPAIGN' or party_id is not null)
);
create index on inv.loans (org_id, status, due_at);
create index on inv.loans (party_id);

create table inv.loan_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  loan_id uuid not null references inv.loans(id) on delete cascade,
  variant_id uuid not null references catalog.variants(id),
  qty numeric(12,3) not null check (qty > 0 and qty = trunc(qty)),
  unit_price numeric(14,2),
  returned numeric(12,3) not null default 0,
  sold numeric(12,3) not null default 0,
  lost numeric(12,3) not null default 0,
  damaged numeric(12,3) not null default 0,
  gifted numeric(12,3) not null default 0,
  unique (loan_id, variant_id),
  check (returned >= 0 and sold >= 0 and lost >= 0 and damaged >= 0 and gifted >= 0),
  check (returned + sold + lost + damaged + gifted <= qty)
);

select private.apply_rls('inv', array['loans', 'loan_items'], 'sales.read', 'sales.write');
select private.rpc_only('inv', array['loans', 'loan_items']);
select private.attach_updated_at('inv');

-- local "fora da loja" de cada loja (criado na primeira vez)
create or replace function private.loan_location(p_store uuid, p_kind text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare s core.stores; v_id uuid; v_kind inv.location_kind := case p_kind when 'CAMPAIGN' then 'MARKETING' else 'WITH_CUSTOMER' end::inv.location_kind;
begin
  select * into s from core.stores where id = p_store;
  select id into v_id from inv.locations where store_id = p_store and kind = v_kind order by created_at limit 1;
  if v_id is null then
    insert into inv.locations (org_id, store_id, legal_entity_id, name, kind, is_sellable, allow_negative)
    values (s.org_id, s.id, s.legal_entity_id,
            case p_kind when 'CAMPAIGN' then 'Peças em campanha' else 'Malinhas com clientes' end, v_kind, false, false)
    returning id into v_id;
  end if;
  return v_id;
end $$;

-- p = {store_id, kind: TRY_ON|CAMPAIGN, party_id?, campaign_id?, purpose?, due_at? | due_days?, notes?, items:[{variant_id, qty}]}
create or replace function inv.create_loan(p jsonb) returns inv.loans
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id(); s core.stores; l inv.loans; it jsonb; v_kind text := upper(coalesce(p ->> 'kind', 'TRY_ON'));
  v_from uuid; v_out uuid; v_due timestamptz; v_qty numeric; v_var uuid; v_avail numeric;
begin
  perform private.require_perm('sales.write');
  if v_kind not in ('TRY_ON', 'CAMPAIGN') then raise exception 'Tipo inválido' using errcode = 'P0305'; end if;
  select * into s from core.stores where id = (p ->> 'store_id')::uuid and org_id = v_org;
  if s.id is null then raise exception 'Loja não encontrada' using errcode = 'P0305'; end if;
  if coalesce(auth.role(), '') = 'authenticated' and not private.can_store(s.id) then raise exception 'Sem acesso à loja' using errcode = '42501'; end if;
  if v_kind = 'TRY_ON' and nullif(p ->> 'party_id', '') is null then raise exception 'Escolha a cliente da malinha' using errcode = 'P0305'; end if;
  if nullif(p ->> 'party_id', '') is not null and not exists (select 1 from crm.parties where id = (p ->> 'party_id')::uuid and org_id = v_org) then
    raise exception 'Pessoa não encontrada' using errcode = 'P0305';
  end if;
  if nullif(p ->> 'campaign_id', '') is not null and not exists (select 1 from mkt.campaigns where id = (p ->> 'campaign_id')::uuid and org_id = v_org) then
    raise exception 'Campanha não encontrada' using errcode = 'P0305';
  end if;
  if v_kind = 'CAMPAIGN' and nullif(p ->> 'party_id', '') is null and nullif(p ->> 'campaign_id', '') is null and coalesce(trim(p ->> 'purpose'), '') = '' then
    raise exception 'Diga para quem ou para qual campanha as peças vão' using errcode = 'P0305';
  end if;
  if jsonb_array_length(coalesce(p -> 'items', '[]')) = 0 then raise exception 'Escolha ao menos uma peça' using errcode = 'P0305'; end if;
  v_due := coalesce(nullif(p ->> 'due_at', '')::timestamptz,
                    now() + make_interval(days => coalesce(nullif(p ->> 'due_days', '')::int, case v_kind when 'CAMPAIGN' then 7 else 2 end)));
  if v_due <= now() or v_due > now() + interval '90 days' then raise exception 'Prazo de devolução inválido (até 90 dias)' using errcode = 'P0305'; end if;

  v_from := (select id from inv.locations where store_id = s.id and kind = 'SALES_FLOOR' order by created_at limit 1);
  if v_from is null then raise exception 'Loja sem local de venda' using errcode = 'P0305'; end if;
  v_out := private.loan_location(s.id, v_kind);

  insert into inv.loans (org_id, store_id, number, kind, party_id, campaign_id, purpose, from_location_id, out_location_id, due_at, notes, created_by)
  values (v_org, s.id, core.next_number(v_org, case v_kind when 'CAMPAIGN' then 'CMP' else 'MAL' end), v_kind,
          nullif(p ->> 'party_id', '')::uuid, nullif(p ->> 'campaign_id', '')::uuid, nullif(trim(coalesce(p ->> 'purpose', '')), ''),
          v_from, v_out, v_due, nullif(trim(coalesce(p ->> 'notes', '')), ''), private.member_id())
  returning * into l;

  for it in select * from jsonb_array_elements(p -> 'items') loop
    v_var := (it ->> 'variant_id')::uuid; v_qty := coalesce((it ->> 'qty')::numeric, 1);
    if v_qty <= 0 or v_qty <> trunc(v_qty) or v_qty > 50 then raise exception 'Quantidade inválida' using errcode = 'P0305'; end if;
    if not exists (select 1 from catalog.variants where id = v_var and org_id = v_org) then raise exception 'Peça não encontrada' using errcode = 'P0305'; end if;
    select coalesce(available, 0) into v_avail from inv.stock_levels where location_id = v_from and variant_id = v_var;
    if coalesce(v_avail, 0) < v_qty then
      raise exception 'A peça % não tem % disponível na loja', (select sku from catalog.variants where id = v_var), v_qty using errcode = 'P0306';
    end if;
    insert into inv.loan_items (org_id, loan_id, variant_id, qty, unit_price)
    values (v_org, l.id, v_var, v_qty, (select catalog.current_price(v_var)))
    on conflict (loan_id, variant_id) do update set qty = inv.loan_items.qty + excluded.qty;
    insert into inv.movements (org_id, variant_id, location_id, qty, movement_type, source_type, source_id, notes, created_by) values
      (v_org, v_var, v_from, -v_qty, 'TRANSFER_OUT', 'inv.loans', l.id, l.number, private.member_id()),
      (v_org, v_var, v_out, v_qty, 'TRANSFER_IN', 'inv.loans', l.id, l.number, private.member_id());
  end loop;
  return l;
end $$;

-- Acerto (pode ser parcial): p = [{item_id, returned?, sold?, lost?, damaged?, gifted?}] — quantidades desta vez.
-- devolvida e vendida voltam ao balcão (a venda é feita no PDV); perda/avaria/brinde saem do estoque.
-- Devolve {loan, sold:[{variant_id, qty, unit_price}]} para a tela abrir a venda já preenchida.
create or replace function inv.settle_loan(p_loan uuid, p jsonb, p_notes text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id(); l inv.loans; it jsonb; li inv.loan_items; r numeric; s numeric; lo numeric; d numeric; g numeric;
  v_sold jsonb := '[]'; v_back numeric;
begin
  perform private.require_perm('sales.write');
  select * into l from inv.loans where id = p_loan and org_id = v_org for update;
  if l.id is null then raise exception 'Malinha não encontrada' using errcode = 'P0305'; end if;
  if l.status <> 'OPEN' then raise exception 'Esta saída já foi encerrada' using errcode = 'P0305'; end if;
  if coalesce(auth.role(), '') = 'authenticated' and not private.can_store(l.store_id) then raise exception 'Sem acesso à loja' using errcode = '42501'; end if;

  for it in select * from jsonb_array_elements(coalesce(p, '[]')) loop
    select * into li from inv.loan_items where id = (it ->> 'item_id')::uuid and loan_id = l.id for update;
    if li.id is null then raise exception 'Item não pertence a esta saída' using errcode = 'P0305'; end if;
    r := coalesce((it ->> 'returned')::numeric, 0); s := coalesce((it ->> 'sold')::numeric, 0); lo := coalesce((it ->> 'lost')::numeric, 0);
    d := coalesce((it ->> 'damaged')::numeric, 0); g := coalesce((it ->> 'gifted')::numeric, 0);
    if least(r, s, lo, d, g) < 0 or r <> trunc(r) or s <> trunc(s) or lo <> trunc(lo) or d <> trunc(d) or g <> trunc(g) then
      raise exception 'Quantidades inválidas' using errcode = 'P0305';
    end if;
    if r + s + lo + d + g = 0 then continue; end if;
    if g > 0 and l.kind <> 'CAMPAIGN' then raise exception 'Brinde só em peças de campanha (na malinha, use vendida)' using errcode = 'P0305'; end if;
    if li.returned + li.sold + li.lost + li.damaged + li.gifted + r + s + lo + d + g > li.qty then
      raise exception 'A peça % tem só % pendente(s)', (select sku from catalog.variants where id = li.variant_id),
        li.qty - (li.returned + li.sold + li.lost + li.damaged + li.gifted) using errcode = 'P0305';
    end if;
    v_back := r + s;
    if v_back > 0 then
      insert into inv.movements (org_id, variant_id, location_id, qty, movement_type, source_type, source_id, notes, created_by) values
        (v_org, li.variant_id, l.out_location_id, -v_back, 'TRANSFER_OUT', 'inv.loans', l.id, l.number || ' (volta)', private.member_id()),
        (v_org, li.variant_id, l.from_location_id, v_back, 'TRANSFER_IN', 'inv.loans', l.id, l.number || ' (volta)', private.member_id());
    end if;
    if lo > 0 then
      insert into inv.movements (org_id, variant_id, location_id, qty, movement_type, source_type, source_id, notes, created_by)
      values (v_org, li.variant_id, l.out_location_id, -lo, 'LOSS', 'inv.loans', l.id, l.number || ' (não voltou)', private.member_id());
    end if;
    if d > 0 then
      insert into inv.movements (org_id, variant_id, location_id, qty, movement_type, source_type, source_id, notes, created_by)
      values (v_org, li.variant_id, l.out_location_id, -d, 'DAMAGE', 'inv.loans', l.id, l.number || ' (avariada)', private.member_id());
    end if;
    if g > 0 then
      insert into inv.movements (org_id, variant_id, location_id, qty, movement_type, source_type, source_id, notes, created_by)
      values (v_org, li.variant_id, l.out_location_id, -g, 'MARKETING_GIFT', 'inv.loans', l.id, l.number || ' (ficou como brinde/permuta)', private.member_id());
    end if;
    update inv.loan_items set returned = returned + r, sold = sold + s, lost = lost + lo, damaged = damaged + d, gifted = gifted + g where id = li.id;
    if s > 0 then v_sold := v_sold || jsonb_build_object('variant_id', li.variant_id, 'qty', s, 'unit_price', li.unit_price); end if;
  end loop;

  if not exists (select 1 from inv.loan_items where loan_id = l.id and returned + sold + lost + damaged + gifted < qty) then
    update inv.loans set status = 'CLOSED', closed_at = now(), notes = coalesce(nullif(trim(coalesce(p_notes, '')), ''), notes) where id = l.id returning * into l;
  elsif nullif(trim(coalesce(p_notes, '')), '') is not null then
    update inv.loans set notes = trim(p_notes) where id = l.id returning * into l;
  end if;
  return jsonb_build_object('loan', to_jsonb(l), 'sold', v_sold);
end $$;

create or replace function inv.extend_loan(p_loan uuid, p_due timestamptz) returns inv.loans
language plpgsql security definer set search_path = '' as $$
declare l inv.loans;
begin
  perform private.require_perm('sales.write');
  if p_due <= now() or p_due > now() + interval '90 days' then raise exception 'Prazo inválido (até 90 dias)' using errcode = 'P0305'; end if;
  update inv.loans set due_at = p_due, overdue_notified_at = null where id = p_loan and org_id = private.org_id() and status = 'OPEN' returning * into l;
  if l.id is null then raise exception 'Saída não encontrada ou encerrada' using errcode = 'P0305'; end if;
  return l;
end $$;

-- liga a venda feita no PDV à malinha (para o histórico)
create or replace function inv.link_loan_order(p_loan uuid, p_order uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('sales.write');
  update inv.loans set order_id = p_order where id = p_loan and org_id = private.org_id()
    and exists (select 1 from sales.orders o where o.id = p_order and o.org_id = private.org_id());
end $$;

-- pg_cron: avisa uma vez por saída vencida
create or replace function private.sweep_overdue_loans() returns int
language plpgsql security definer set search_path = '' as $$
declare r record; n int := 0;
begin
  for r in select l.id, l.org_id, l.number, l.kind, coalesce(p.display_name, l.purpose, 'campanha') as who
           from inv.loans l left join crm.parties p on p.id = l.party_id
           where l.status = 'OPEN' and l.due_at < now() and l.overdue_notified_at is null loop
    perform core.notify(r.org_id, 'LOAN_OVERDUE',
      case r.kind when 'CAMPAIGN' then 'Peças de campanha ' else 'Malinha ' end || r.number || ' (' || r.who || ') passou do prazo de devolução',
      jsonb_build_object('loan_id', r.id), 'sales.write');
    update inv.loans set overdue_notified_at = now() where id = r.id;
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------------
-- 6) Rotina de abertura e fechamento
-- ---------------------------------------------------------------------
create table sales.routine_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  store_id uuid not null references core.stores(id),
  kind text not null check (kind in ('OPENING', 'CLOSING')),
  run_date date not null,
  checks jsonb not null default '{}',
  notes text,
  summary jsonb,
  completed_at timestamptz,
  completed_by uuid references core.members(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (store_id, kind, run_date)
);
select private.apply_rls('sales', array['routine_runs'], 'sales.read', 'sales.write');
select private.rpc_only('sales', array['routine_runs']);
select private.attach_updated_at('sales');

create or replace function private.routine_template(p_org uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce((select value from core.settings where org_id = p_org and key = 'store_routines'), jsonb_build_object(
    'opening', jsonb_build_array(
      jsonb_build_object('key', 'maquininha', 'label', 'Ligar a maquininha e conferir bateria e papel'),
      jsonb_build_object('key', 'loja', 'label', 'Araras, vitrine e provador arrumados'),
      jsonb_build_object('key', 'mensagens', 'label', 'Ver a lista do dia e responder as mensagens da noite')),
    'closing', jsonb_build_array(
      jsonb_build_object('key', 'stone', 'label', 'Conferir o total da maquininha com as vendas do sistema'),
      jsonb_build_object('key', 'dinheiro', 'label', 'Sangria ou depósito do dinheiro (deixar só o troco)'),
      jsonb_build_object('key', 'loja', 'label', 'Peças no lugar, luzes apagadas e loja trancada'))))
$$;

-- Itens automáticos (conferidos nos dados) + manuais (do modelo), com o que já foi marcado hoje
create or replace function sales.routine_status(p_store uuid, p_kind text, p_date date default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id(); v_date date := coalesce(p_date, (now() at time zone 'America/Sao_Paulo')::date);
  run sales.routine_runs; v_items jsonb := '[]'; m jsonb; v_open int; v_pending int; v_drafts int; v_overdue int; v_due_today int; v_tasks int;
  v_sales int; v_total numeric; v_from timestamptz; v_to timestamptz;
begin
  perform private.require_perm('sales.read');
  if p_kind not in ('OPENING', 'CLOSING') then raise exception 'Rotina inválida' using errcode = 'P0307'; end if;
  if not exists (select 1 from core.stores where id = p_store and org_id = v_org) then raise exception 'Loja não encontrada' using errcode = 'P0307'; end if;
  v_from := v_date::timestamp at time zone 'America/Sao_Paulo'; v_to := v_from + interval '1 day';
  select * into run from sales.routine_runs where store_id = p_store and kind = p_kind and run_date = v_date;

  select count(*) into v_open from sales.cash_sessions where store_id = p_store and status = 'OPEN';
  select count(*) into v_overdue from inv.loans where store_id = p_store and status = 'OPEN' and due_at < now();
  select count(*) into v_due_today from inv.loans where store_id = p_store and status = 'OPEN' and due_at >= now() and due_at < v_to;

  if p_kind = 'OPENING' then
    select count(*) into v_tasks from crm.tasks t where t.org_id = v_org and t.status = 'OPEN' and t.due_at < v_to;
    v_items := jsonb_build_array(
      jsonb_build_object('key', 'auto_caixa', 'auto', true, 'ok', v_open > 0, 'label', 'Caixa aberto com o troco',
        'detail', case when v_open > 0 then 'aberto' else 'abra o caixa em Vender › Caixa' end, 'href', '/vender/caixa'),
      jsonb_build_object('key', 'auto_malinhas', 'auto', true, 'ok', v_overdue = 0, 'label', 'Malinhas e peças de campanha no prazo',
        'detail', case when v_overdue = 0 then case when v_due_today > 0 then v_due_today || ' voltam hoje' else 'nenhuma vencida' end
                       else v_overdue || ' vencida(s): cobrar a devolução' end, 'href', '/vender/malinhas'),
      jsonb_build_object('key', 'auto_tarefas', 'auto', true, 'ok', true, 'label', 'Tarefas do dia',
        'detail', case when v_tasks > 0 then v_tasks || ' para hoje' else 'nada pendente' end, 'href', '/clientes/tarefas'));
  else
    select count(*), coalesce(sum(o.total), 0) into v_sales, v_total from sales.orders o
    where o.store_id = p_store and o.status in ('PAID', 'FULFILLING', 'READY_FOR_PICKUP', 'SHIPPED', 'COMPLETED', 'PARTIALLY_RETURNED')
      and o.created_at >= v_from and o.created_at < v_to;
    select count(*) into v_pending from sales.orders o
    where o.store_id = p_store and o.status in ('PAID', 'FULFILLING', 'READY_FOR_PICKUP', 'SHIPPED', 'COMPLETED')
      and o.created_at >= v_from and o.created_at < v_to
      and not exists (select 1 from fiscal.documents d where d.order_id = o.id and d.status in ('AUTHORIZED', 'PROCESSING'));
    select count(*) into v_drafts from sales.orders o where o.store_id = p_store and o.status = 'DRAFT' and o.created_at < v_to;
    v_items := jsonb_build_array(
      jsonb_build_object('key', 'auto_notas', 'auto', true, 'ok', v_pending = 0, 'label', 'Todas as vendas do dia com NFC-e',
        'detail', case when v_pending = 0 then v_sales || ' venda(s), ' || to_char(v_total, 'FM999G999G990D00') else v_pending || ' venda(s) sem nota' end,
        'href', '/vender/pedidos'),
      jsonb_build_object('key', 'auto_rascunhos', 'auto', true, 'ok', v_drafts = 0, 'label', 'Sem vendas esquecidas em rascunho',
        'detail', case when v_drafts = 0 then 'nenhum rascunho' else v_drafts || ' rascunho(s): concluir ou descartar' end, 'href', '/vender/pedidos'),
      jsonb_build_object('key', 'auto_malinhas', 'auto', true, 'ok', v_overdue = 0, 'label', 'Malinhas e peças de campanha no prazo',
        'detail', case when v_overdue = 0 then 'nenhuma vencida' else v_overdue || ' vencida(s)' end, 'href', '/vender/malinhas'),
      jsonb_build_object('key', 'auto_caixa', 'auto', true, 'ok', v_open = 0, 'label', 'Caixa fechado e conferido',
        'detail', case when v_open = 0 then 'fechado' else 'feche o caixa em Vender › Caixa' end, 'href', '/vender/caixa'));
  end if;

  for m in select * from jsonb_array_elements(private.routine_template(v_org) -> (case p_kind when 'OPENING' then 'opening' else 'closing' end)) loop
    v_items := v_items || jsonb_build_object('key', m ->> 'key', 'auto', false, 'label', m ->> 'label',
      'ok', coalesce((run.checks -> (m ->> 'key') ->> 'done')::boolean, false),
      'by', run.checks -> (m ->> 'key') ->> 'by', 'at', run.checks -> (m ->> 'key') ->> 'at');
  end loop;

  return jsonb_build_object('date', v_date, 'kind', p_kind, 'items', v_items,
    'completed_at', run.completed_at, 'completed_by', (select display_name from core.members where id = run.completed_by), 'notes', run.notes,
    'summary', run.summary);
end $$;

create or replace function sales.routine_check(p_store uuid, p_kind text, p_key text, p_done boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); v_date date := (now() at time zone 'America/Sao_Paulo')::date; v_name text;
begin
  perform private.require_perm('sales.write');
  if p_kind not in ('OPENING', 'CLOSING') then raise exception 'Rotina inválida' using errcode = 'P0307'; end if;
  if not exists (select 1 from core.stores where id = p_store and org_id = v_org) then raise exception 'Loja não encontrada' using errcode = 'P0307'; end if;
  if not exists (select 1 from jsonb_array_elements(private.routine_template(v_org) -> (case p_kind when 'OPENING' then 'opening' else 'closing' end)) e
                 where e ->> 'key' = p_key) then raise exception 'Item da rotina não encontrado' using errcode = 'P0307'; end if;
  select display_name into v_name from core.members where id = private.member_id();
  insert into sales.routine_runs as rr (org_id, store_id, kind, run_date, checks)
  values (v_org, p_store, p_kind, v_date, jsonb_build_object(p_key, jsonb_build_object('done', p_done, 'by', v_name, 'at', now())))
  on conflict (store_id, kind, run_date) do update set checks = rr.checks || excluded.checks;
end $$;

-- Conclui a rotina (com o que estiver pendente registrado no resumo). No fechamento, avisa quem administra.
create or replace function sales.routine_complete(p_store uuid, p_kind text, p_notes text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); v_date date := (now() at time zone 'America/Sao_Paulo')::date; st jsonb; v_pending jsonb; v_store text;
begin
  perform private.require_perm('sales.write');
  st := sales.routine_status(p_store, p_kind, v_date);
  select coalesce(jsonb_agg(i ->> 'label'), '[]') into v_pending from jsonb_array_elements(st -> 'items') i where not (i ->> 'ok')::boolean;
  insert into sales.routine_runs as rr (org_id, store_id, kind, run_date, completed_at, completed_by, notes, summary)
  values (v_org, p_store, p_kind, v_date, now(), private.member_id(), nullif(trim(coalesce(p_notes, '')), ''), jsonb_build_object('pending', v_pending, 'items', st -> 'items'))
  on conflict (store_id, kind, run_date) do update set completed_at = now(), completed_by = private.member_id(),
    notes = coalesce(excluded.notes, rr.notes), summary = excluded.summary;
  if p_kind = 'CLOSING' then
    select name into v_store from core.stores where id = p_store;
    perform core.notify(v_org, 'STORE_CLOSED', 'Fechamento de ' || v_store || ': ' ||
      coalesce((select i ->> 'detail' from jsonb_array_elements(st -> 'items') i where i ->> 'key' = 'auto_notas'), '') ||
      case when jsonb_array_length(v_pending) > 0 then ' · pendente: ' || (select string_agg(x, '; ') from jsonb_array_elements_text(v_pending) x) else ' · tudo certo' end,
      jsonb_build_object('store_id', p_store, 'date', v_date, 'notes', p_notes), 'core.admin');
  end if;
  return jsonb_build_object('pending', v_pending);
end $$;

create or replace function sales.save_routine_template(p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare k text; e jsonb; v_keys text[];
begin
  perform private.require_perm('core.admin');
  foreach k in array array['opening', 'closing'] loop
    if jsonb_typeof(p -> k) <> 'array' or jsonb_array_length(p -> k) > 20 then raise exception 'Lista inválida' using errcode = 'P0307'; end if;
    v_keys := array[]::text[];
    for e in select * from jsonb_array_elements(p -> k) loop
      if coalesce(e ->> 'key', '') !~ '^[a-z0-9_]{1,30}$' or e ->> 'key' like 'auto_%' or length(coalesce(trim(e ->> 'label'), '')) not between 3 and 140 then
        raise exception 'Item inválido: %', coalesce(e ->> 'label', '?') using errcode = 'P0307';
      end if;
      if (e ->> 'key') = any(v_keys) then raise exception 'Item repetido' using errcode = 'P0307'; end if;
      v_keys := v_keys || (e ->> 'key');
    end loop;
  end loop;
  insert into core.settings (org_id, key, value) values (private.org_id(), 'store_routines', jsonb_build_object('opening', p -> 'opening', 'closing', p -> 'closing'))
  on conflict (org_id, key) do update set value = excluded.value, updated_at = now();
end $$;

-- ---------------------------------------------------------------------
-- 7) Avisos sem repetição: o mesmo aviso ainda não lido não é criado de novo (conta as repetições)
-- ---------------------------------------------------------------------
create or replace function core.notify(p_org uuid, p_kind text, p_title text, p_payload jsonb default '{}', p_perm text default null, p_member uuid default null) returns int
language plpgsql security definer set search_path = '' as $$
declare n int; r int;
begin
  with targets as (
    select m.id from core.members m
    where m.org_id = p_org and m.status = 'ACTIVE' and (p_member is null or m.id = p_member)
      and (p_perm is null or exists (
        select 1 from core.member_roles mr join core.roles ro on ro.id = mr.role_id
        left join core.role_permissions rp on rp.role_id = ro.id and rp.permission_key = p_perm
        where mr.member_id = m.id and (ro.is_superuser or rp.permission_key is not null)))
  ), bumped as (
    update core.notifications nt
    set payload = nt.payload || jsonb_build_object('repeticoes', coalesce((nt.payload ->> 'repeticoes')::int, 1) + 1, 'ultima_vez', now())
    where nt.org_id = p_org and nt.kind = p_kind and nt.title = p_title and nt.read_at is null
      and nt.member_id in (select id from targets) and nt.created_at > now() - interval '7 days'
    returning nt.member_id
  )
  insert into core.notifications (org_id, member_id, kind, title, payload)
  select p_org, t.id, p_kind, p_title, p_payload from targets t where t.id not in (select member_id from bumped);
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------------------------------------------------------------------
-- 8) Rotinas agendadas
-- ---------------------------------------------------------------------
create or replace function private.purge_cron_history() returns int
language plpgsql security definer set search_path = '' as $$
declare n int := 0;
begin
  begin
    delete from cron.job_run_details where end_time < now() - interval '7 days';
    get diagnostics n = row_count;
  exception when others then
    n := 0;   -- no Supabase Cloud a tabela pode não aceitar delete deste papel: sem erro
  end;
  return n;
end $$;

do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname in ('centralops-overdue-loans', 'centralops-purge-cron-history');
  perform cron.schedule('centralops-overdue-loans', '7 * * * *', 'select private.sweep_overdue_loans()');
  perform cron.schedule('centralops-purge-cron-history', '50 5 * * *', 'select private.purge_cron_history()');
end $$;

-- ---------------------------------------------------------------------
-- 9) A trava de privilégios passa a cobrir mkt e aff (criados depois da lista original): nenhuma função executável sem login
-- ---------------------------------------------------------------------
create or replace function private.lock_functions() returns void
language plpgsql security definer set search_path = '' as $$
declare s text; r record;
begin
  foreach s in array array['core', 'crm', 'catalog', 'inv', 'sales', 'fin', 'fiscal', 'omni', 'ai', 'hr', 'comm', 'purch', 'mkt', 'aff'] loop
    execute format('revoke execute on all functions in schema %I from public, anon', s);
    execute format('grant execute on all functions in schema %I to authenticated, service_role', s);
  end loop;
  for r in select p.oid::regprocedure as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           join private.internal_functions f on f.fqname = n.nspname || '.' || p.proname loop
    execute format('revoke execute on function %s from public, anon, authenticated', r.fn);   -- (funções do schema private nascem executáveis por PUBLIC)
    execute format('grant execute on function %s to service_role', r.fn);
  end loop;
end $$;

insert into private.internal_functions (fqname) values
  ('private.loan_location'), ('private.sweep_overdue_loans'), ('private.routine_template'), ('private.purge_cron_history'), ('private.require_any_perm')
on conflict do nothing;

select private.lock_functions();
