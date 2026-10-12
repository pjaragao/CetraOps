-- =====================================================================
-- Categorias sem duplicar: a regra única (org, pai, nome) não valia para categoria sem pai (NULL é sempre "diferente"), e "calça"
-- e "Calça" eram categorias diferentes. Junta as repetidas (produtos passam para a mais antiga), cria a regra certa e as funções
-- de importação e do site passam a achar a categoria sem diferenciar maiúsculas, acentos de espaço ou plural simples.
-- =====================================================================

-- 1) junta as repetidas (mesmo pai, mesmo nome sem diferenciar maiúsculas/espaços); fica a mais antiga, com o nome bem escrito
with g as (
  select id, org_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid) as pid, lower(trim(name)) as k,
         first_value(id) over (partition by org_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(trim(name))
                               order by (name = initcap(lower(trim(name)))) desc, (ncm_default is not null) desc, id) as keep
  from catalog.categories
), moved as (
  update catalog.products p set category_id = g.keep from g where p.category_id = g.id and g.id <> g.keep returning 1
), moved_children as (
  update catalog.categories c set parent_id = g.keep from g where c.parent_id = g.id and g.id <> g.keep returning 1
)
delete from catalog.categories c using g where c.id = g.id and g.id <> g.keep
  and (select count(*) from moved) >= 0 and (select count(*) from moved_children) >= 0;

update catalog.categories set name = upper(left(trim(name), 1)) || substr(trim(name), 2) where name <> upper(left(trim(name), 1)) || substr(trim(name), 2);

create unique index if not exists categories_unique_name on catalog.categories
  (org_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(trim(name)));

-- 2) acha ou cria a categoria (raiz) pelo nome, sem diferenciar maiúsculas
create or replace function private.category_for(p_org uuid, p_name text, p_ncm text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_name text := nullif(regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g'), '');
begin
  if v_name is null then return null; end if;
  v_name := upper(left(v_name, 1)) || substr(v_name, 2);
  select id into v_id from catalog.categories where org_id = p_org and parent_id is null and lower(name) = lower(v_name) limit 1;
  if v_id is null then
    insert into catalog.categories (org_id, name, ncm_default) values (p_org, v_name, nullif(regexp_replace(coalesce(p_ncm, ''), '\D', '', 'g'), ''))
    on conflict do nothing returning id into v_id;
    if v_id is null then select id into v_id from catalog.categories where org_id = p_org and parent_id is null and lower(name) = lower(v_name) limit 1; end if;
  end if;
  return v_id;
end $$;

-- 3) importação de planilha e catálogo do site usando a busca acima
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
        v_cat := private.category_for(v_org, r ->> 'category', nullif(r ->> 'ncm', ''));
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

create or replace function catalog.upsert_site_product(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := (p ->> 'org_id')::uuid; v_src text := coalesce(p ->> 'source', 'SIEWEAR');
  v_brand uuid; v_cat uuid; v_coll uuid; v_color uuid; v_prod uuid; v_grid uuid; v_chart uuid; v_var uuid;
  v_color_name text := trim(coalesce(nullif(p ->> 'color_name', ''), 'Única')); v_code text := p ->> 'color_code';
  v_gender catalog.gender := case when upper(p ->> 'gender') = 'MASC' then 'MASC' else 'FEM' end;
  it jsonb; v_prices jsonb := '[]'; v_new boolean := false; v_changes int; img text; i int := 0;
begin
  if v_org is null or coalesce(p ->> 'model_code', '') !~ '^[0-9A-Za-z]{3,12}$' or coalesce(p ->> 'external_id', '') = '' then
    raise exception 'Produto do site inválido' using errcode = 'P0340';
  end if;

  insert into catalog.brands (org_id, name) values (v_org, 'SIÉ') on conflict (org_id, name) do nothing;
  select id into v_brand from catalog.brands where org_id = v_org and name = 'SIÉ';

  if coalesce(p ->> 'category', '') <> '' then
    v_cat := private.category_for(v_org, p ->> 'category');
  end if;
  if coalesce(p ->> 'line', '') <> '' then
    select id into v_coll from catalog.collections where org_id = v_org and name = trim(p ->> 'line') limit 1;
    if v_coll is null then insert into catalog.collections (org_id, name, kind) values (v_org, trim(p ->> 'line'), 'CORE') returning id into v_coll; end if;
  end if;
  if coalesce(p ->> 'size_chart', '') <> '' then
    select id into v_chart from catalog.size_charts where org_id = v_org and name = 'Site: ' || (p ->> 'size_chart') limit 1;
  end if;

  -- cor: pelo código da marca (3 dígitos); nome do site (se o nome já for de outra cor, leva o código junto)
  select id into v_color from catalog.colors where org_id = v_org and code = v_code limit 1;
  if v_color is null then   -- cor cadastrada à mão com o mesmo nome (sem código da marca): adota e grava o código
    update catalog.colors set code = v_code where id = (select id from catalog.colors where org_id = v_org and name = v_color_name and coalesce(code, '') !~ '^[0-9]{3}$' limit 1)
    returning id into v_color;
  end if;
  if v_color is null then
    if exists (select 1 from catalog.colors where org_id = v_org and name = v_color_name) then v_color_name := v_color_name || ' (' || v_code || ')'; end if;
    insert into catalog.colors (org_id, name, code) values (v_org, v_color_name, v_code) returning id into v_color;
  end if;

  select id into v_grid from catalog.size_grids where org_id = v_org and name = case v_gender when 'MASC' then 'Masculino P-GG' else 'Feminino PP-GG' end;
  select id into v_prod from catalog.products where org_id = v_org and reference_code = p ->> 'model_code';
  if v_prod is null then
    insert into catalog.products (org_id, brand_id, category_id, collection_id, size_grid_id, size_chart_id, reference_code, name, description, composition, care, gender, status, custom_fields)
    values (v_org, v_brand, v_cat, v_coll, v_grid, v_chart, p ->> 'model_code', trim(p ->> 'model_name'), nullif(p ->> 'description', ''), nullif(p ->> 'composition', ''),
            nullif(p ->> 'care', ''), v_gender, 'ACTIVE', jsonb_build_object('site', jsonb_build_object('fit', p ->> 'fit', 'tags', p -> 'tags')))
    returning id into v_prod;
    v_new := true;
  else
    -- o site é a fonte dos textos e da classificação; o que estiver vazio no site não apaga o que a loja escreveu
    update catalog.products set
      name = coalesce(nullif(trim(p ->> 'model_name'), ''), name), brand_id = coalesce(brand_id, v_brand),
      category_id = coalesce(v_cat, category_id), collection_id = coalesce(v_coll, collection_id), size_chart_id = coalesce(v_chart, size_chart_id),
      size_grid_id = coalesce(size_grid_id, v_grid), description = coalesce(nullif(p ->> 'description', ''), description),
      composition = coalesce(nullif(p ->> 'composition', ''), composition), care = coalesce(nullif(p ->> 'care', ''), care), gender = v_gender,
      custom_fields = custom_fields || jsonb_build_object('site', coalesce(custom_fields -> 'site', '{}') || jsonb_build_object('fit', p ->> 'fit', 'tags', p -> 'tags'))
    where id = v_prod;
  end if;

  for it in select * from jsonb_array_elements(coalesce(p -> 'variants', '[]')) loop
    continue when coalesce(it ->> 'sku', '') = '' or coalesce(it ->> 'size', '') = '';
    select id into v_var from catalog.variants where org_id = v_org and sku = upper(it ->> 'sku');
    if v_var is null then
      select id into v_var from catalog.variants where product_id = v_prod and color_id = v_color and size = upper(trim(it ->> 'size'));
    end if;
    if v_var is null then
      insert into catalog.variants (org_id, product_id, color_id, size, sku, supplier_sku)
      values (v_org, v_prod, v_color, upper(trim(it ->> 'size')), upper(it ->> 'sku'), it ->> 'external_id') returning id into v_var;
      it := it || '{"new": true}';
    else
      update catalog.variants set sku = upper(it ->> 'sku'), supplier_sku = it ->> 'external_id', active = true where id = v_var;
    end if;
    if nullif(it ->> 'price', '') is not null then
      v_prices := v_prices || jsonb_build_object('variant_id', v_var, 'price', (it ->> 'price')::numeric, 'compare_at', it ->> 'compare_at', 'new', coalesce((it ->> 'new')::boolean, false));
    end if;
  end loop;
  v_changes := case when jsonb_array_length(v_prices) > 0 then private.set_site_price(v_org, v_prod, v_prices, v_src) else 0 end;

  -- fotos da cor: as do site substituem as anteriores vindas do site (as que a loja subiu ficam)
  delete from catalog.product_media where product_id = v_prod and color_id = v_color and storage_path like 'http%';
  for img in select jsonb_array_elements_text(coalesce(p -> 'images', '[]')) loop
    i := i + 1;
    insert into catalog.product_media (org_id, product_id, color_id, storage_path, position) values (v_org, v_prod, v_color, img, i);
  end loop;

  insert into catalog.site_items as si (org_id, source, external_id, handle, url, title, product_id, color_id, product_type, tags, collections, available, price, compare_at_price, images, site_updated_at, synced_at, removed_at)
  values (v_org, v_src, p ->> 'external_id', p ->> 'handle', p ->> 'url', p ->> 'title', v_prod, v_color, nullif(p ->> 'product_type', ''),
          coalesce((select array_agg(x) from jsonb_array_elements_text(p -> 'tags') x), '{}'), coalesce((select array_agg(x) from jsonb_array_elements_text(p -> 'collections') x), '{}'),
          coalesce((p ->> 'available')::boolean, true), nullif(p ->> 'price', '')::numeric, nullif(p ->> 'compare_at', '')::numeric, coalesce(p -> 'images', '[]'),
          nullif(p ->> 'site_updated_at', '')::timestamptz, now(), null)
  on conflict (org_id, source, external_id) do update set handle = excluded.handle, url = excluded.url, title = excluded.title, product_id = excluded.product_id,
    color_id = excluded.color_id, product_type = excluded.product_type, tags = excluded.tags, collections = excluded.collections, available = excluded.available,
    price = excluded.price, compare_at_price = excluded.compare_at_price, images = excluded.images, site_updated_at = excluded.site_updated_at, synced_at = now(), removed_at = null;

  return jsonb_build_object('product_id', v_prod, 'new', v_new, 'price_changes', v_changes);
end $$;

insert into private.internal_functions (fqname) values ('private.category_for') on conflict do nothing;
select private.lock_functions();
