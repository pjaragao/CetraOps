-- =====================================================================
-- Catálogo vindo do site oficial da marca (loja Shopify: siewear.com)
--  • catalog.site_items: um item do site = um modelo numa cor (o SKU do site é modelo(5) + cor(3) + tamanho).
--  • catalog.upsert_site_product(p): grava/atualiza produto (por modelo), cor, variantes (SKU do site = SKU da etiqueta da marca),
--    descrição, composição, cuidados, categoria, linha, gênero, guia de tamanho, fotos da cor e preço de venda.
--  • catalog.apply_site_prices(p): rotina só de preço; muda o preço vigente e registra em catalog.price_changes.
--  • Mudança de preço em peça com estoque → aviso para quem cuida do catálogo.
--  • Fila catalog_sync (worker) + pg_cron: catálogo completo 1×/dia, preços a cada 6 h. Liga/desliga em core.settings('catalog_site').
-- Códigos: P0340 dado inválido.
-- =====================================================================

create table catalog.site_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  source text not null default 'SIEWEAR',
  external_id text not null,
  handle text not null,
  url text,
  title text not null,
  product_id uuid references catalog.products(id) on delete set null,
  color_id uuid references catalog.colors(id),
  product_type text,
  tags text[] not null default '{}',
  collections text[] not null default '{}',
  available boolean not null default true,
  price numeric(14,2),
  compare_at_price numeric(14,2),
  images jsonb not null default '[]',
  site_updated_at timestamptz,
  synced_at timestamptz not null default now(),
  removed_at timestamptz,
  unique (org_id, source, external_id)
);
create index on catalog.site_items (product_id);

create table catalog.price_changes (
  id bigint generated always as identity primary key,
  org_id uuid not null references core.orgs(id),
  product_id uuid not null references catalog.products(id) on delete cascade,
  variant_id uuid references catalog.variants(id) on delete cascade,
  old_price numeric(14,2),
  new_price numeric(14,2) not null,
  compare_at_price numeric(14,2),
  in_stock numeric(12,3) not null default 0,
  source text not null default 'SIEWEAR',
  changed_at timestamptz not null default now(),
  notified boolean not null default false
);
create index on catalog.price_changes (org_id, changed_at desc);

create table catalog.site_sync_runs (
  id bigint generated always as identity primary key,
  org_id uuid not null references core.orgs(id),
  kind text not null check (kind in ('FULL', 'PRICES')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'RUNNING' check (status in ('RUNNING', 'OK', 'ERROR')),
  stats jsonb not null default '{}',
  error text
);

select private.apply_rls('catalog', array['site_items', 'price_changes', 'site_sync_runs'], 'catalog.read', 'catalog.write');
select private.rpc_only('catalog', array['site_items', 'price_changes', 'site_sync_runs']);

-- produtos: endereço do produto no site e "guia de tamanho" já existem (size_chart_id); medidas guardam o HTML da tabela do site
-- ---------------------------------------------------------------------
-- Preço vigente das variantes vindas do site (registra a mudança quando já havia preço)
-- ---------------------------------------------------------------------
create or replace function private.set_site_price(p_org uuid, p_product uuid, p_prices jsonb, p_source text) returns int
language plpgsql security definer set search_path = '' as $$
-- p_prices = [{variant_id, price, compare_at}]
declare
  v_pl uuid; it jsonb; v_old numeric; v_new numeric; v_prod_price numeric; n int := 0; v_stock numeric;
begin
  select id into v_pl from catalog.price_lists where org_id = p_org and is_default;
  if v_pl is null then return 0; end if;
  select price into v_prod_price from catalog.prices where price_list_id = v_pl and product_id = p_product and variant_id is null and valid_to is null;

  -- registra as mudanças (antes de mexer) só quando já havia preço: a primeira carga não é "mudança"
  for it in select * from jsonb_array_elements(p_prices) loop
    v_new := (it ->> 'price')::numeric;
    v_old := catalog.current_price((it ->> 'variant_id')::uuid, v_pl);
    -- variante criada agora (primeira carga, cor nova) não é mudança de preço
    if v_old is not null and v_old <> v_new and not coalesce((it ->> 'new')::boolean, false) then
      select coalesce(sum(sl.on_hand), 0) into v_stock from inv.stock_levels sl join inv.locations l on l.id = sl.location_id
      where sl.variant_id = (it ->> 'variant_id')::uuid and l.kind in ('SALES_FLOOR', 'BACKROOM', 'VIP_LOCKERS', 'WITH_CUSTOMER', 'MARKETING', 'POPUP');
      insert into catalog.price_changes (org_id, product_id, variant_id, old_price, new_price, compare_at_price, in_stock, source)
      values (p_org, p_product, (it ->> 'variant_id')::uuid, v_old, v_new, nullif(it ->> 'compare_at', '')::numeric, v_stock, p_source);
      n := n + 1;
    end if;
  end loop;

  -- o site manda o preço por variante (cada cor chega separada): grava por variante; o do produto é só a referência para as que não têm
  if v_prod_price is null then
    insert into catalog.prices (org_id, price_list_id, product_id, price)
    select p_org, v_pl, p_product, min((x ->> 'price')::numeric) from jsonb_array_elements(p_prices) x;
  end if;
  for it in select * from jsonb_array_elements(p_prices) loop
    v_new := (it ->> 'price')::numeric;
    continue when exists (select 1 from catalog.prices where price_list_id = v_pl and variant_id = (it ->> 'variant_id')::uuid and valid_to is null and price = v_new);
    update catalog.prices set valid_to = now() where price_list_id = v_pl and variant_id = (it ->> 'variant_id')::uuid and valid_to is null;
    insert into catalog.prices (org_id, price_list_id, variant_id, price) values (p_org, v_pl, (it ->> 'variant_id')::uuid, v_new);
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------------
-- Um produto do site (modelo + cor). Chamado pelo worker (service_role).
-- p = {org_id, source, external_id, handle, url, title, model_code, model_name, color_code, color_name, product_type, category,
--      tags[], collections[], line, gender, description, composition, care, fit, size_chart (nome), images[], available,
--      price, compare_at, site_updated_at, variants:[{external_id, sku, size, price, compare_at, available}]}
-- ---------------------------------------------------------------------
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
    insert into catalog.categories (org_id, name) values (v_org, trim(p ->> 'category')) on conflict (org_id, parent_id, name) do nothing;
    select id into v_cat from catalog.categories where org_id = v_org and name = trim(p ->> 'category') and parent_id is null;
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

-- Guia de tamanho do site (tabela em HTML) por nome ("Feminino", "Masculino")
create or replace function catalog.upsert_site_size_chart(p_org uuid, p_name text, p_html text, p_collections jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  select id into v_id from catalog.size_charts where org_id = p_org and name = 'Site: ' || p_name limit 1;
  if v_id is null then
    insert into catalog.size_charts (org_id, name, measurements) values (p_org, 'Site: ' || p_name, jsonb_build_object('html', p_html, 'source', 'SIEWEAR', 'collections', p_collections)) returning id into v_id;
  else
    update catalog.size_charts set measurements = jsonb_build_object('html', p_html, 'source', 'SIEWEAR', 'collections', p_collections) where id = v_id;
  end if;
  return v_id;
end $$;

-- Rotina só de preço: p = [{sku, price, compare_at}] → muda o preço das variantes conhecidas
create or replace function catalog.apply_site_prices(p_org uuid, p jsonb, p_source text default 'SIEWEAR') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r record; n int := 0; m int := 0;
begin
  for r in
    select v.product_id, jsonb_agg(jsonb_build_object('variant_id', v.id, 'price', (x ->> 'price')::numeric, 'compare_at', x ->> 'compare_at')) as prices
    from jsonb_array_elements(p) x join catalog.variants v on v.org_id = p_org and v.sku = upper(x ->> 'sku')
    where nullif(x ->> 'price', '') is not null
    group by v.product_id
  loop
    n := n + private.set_site_price(p_org, r.product_id, r.prices, p_source);
    m := m + 1;
  end loop;
  update catalog.site_items si set price = (select min((x ->> 'price')::numeric) from jsonb_array_elements(p) x join catalog.variants v on v.sku = upper(x ->> 'sku') where v.product_id = si.product_id and v.color_id = si.color_id),
    synced_at = now() where si.org_id = p_org and si.source = p_source;
  return jsonb_build_object('products', m, 'price_changes', n);
end $$;

-- Fim de uma rodada: marca o que sumiu do site e avisa mudanças de preço em peças com estoque (uma vez)
create or replace function catalog.finish_site_sync(p_org uuid, p_run bigint, p_status text, p_stats jsonb, p_error text default null, p_seen jsonb default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v_n int; v_list text;
begin
  if p_seen is not null then
    update catalog.site_items set removed_at = now() where org_id = p_org and removed_at is null
      and external_id not in (select jsonb_array_elements_text(p_seen));
  end if;
  update catalog.site_sync_runs set finished_at = now(), status = p_status, stats = coalesce(p_stats, '{}'), error = p_error where id = p_run;

  select count(*), string_agg(distinct pr.name || ' ' || coalesce(to_char(pc.old_price, 'FM999G990D00'), '?') || ' → ' || to_char(pc.new_price, 'FM999G990D00'), '; ')
    into v_n, v_list
  from catalog.price_changes pc join catalog.products pr on pr.id = pc.product_id
  where pc.org_id = p_org and not pc.notified and pc.in_stock > 0;
  if v_n > 0 then
    perform core.notify(p_org, 'PRICE_CHANGED', 'Preço mudou no site em peças do seu estoque: ' || left(v_list, 220),
                        jsonb_build_object('count', v_n, 'href', '/produtos/site'), 'catalog.write');
  end if;
  update catalog.price_changes set notified = true where org_id = p_org and not notified;
  if p_status = 'ERROR' then
    perform core.notify(p_org, 'INTEGRATION_ERROR', 'Sincronização do catálogo do site falhou: ' || left(coalesce(p_error, 'erro'), 160), jsonb_build_object('href', '/produtos/site'), 'catalog.write');
  end if;
end $$;

create or replace function catalog.start_site_sync(p_org uuid, p_kind text) returns bigint
language sql security definer set search_path = '' as $$
  insert into catalog.site_sync_runs (org_id, kind) values (p_org, p_kind) returning id
$$;

-- ---------------------------------------------------------------------
-- Fila, liga/desliga e agendamento
-- ---------------------------------------------------------------------
do $$ begin
  if not exists (select 1 from pgmq.meta where queue_name = 'catalog_sync') then perform pgmq.create('catalog_sync'); perform pgmq.create('catalog_sync_dlq'); end if;
end $$;

insert into core.settings (org_id, key, value)
select id, 'catalog_site', jsonb_build_object('enabled', true, 'base_url', 'https://siewear.com', 'source', 'SIEWEAR') from core.orgs
on conflict (org_id, key) do nothing;

create or replace function private.enqueue_catalog_sync(p_kind text) returns int
language plpgsql security definer set search_path = '' as $$
declare r record; n int := 0;
begin
  for r in select org_id, value from core.settings where key = 'catalog_site' and coalesce((value ->> 'enabled')::boolean, false) loop
    perform private.enqueue('catalog_sync', jsonb_build_object('org_id', r.org_id, 'kind', p_kind));
    n := n + 1;
  end loop;
  return n;
end $$;

-- botão "Sincronizar agora" (tela de Produtos)
create or replace function catalog.request_site_sync(p_kind text default 'FULL') returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('catalog.write');
  if p_kind not in ('FULL', 'PRICES') then raise exception 'Tipo inválido' using errcode = 'P0340'; end if;
  if exists (select 1 from catalog.site_sync_runs where org_id = private.org_id() and status = 'RUNNING' and started_at > now() - interval '30 minutes') then
    raise exception 'Já há uma sincronização em andamento' using errcode = 'P0340';
  end if;
  perform private.enqueue('catalog_sync', jsonb_build_object('org_id', private.org_id(), 'kind', p_kind));
end $$;

create or replace function catalog.set_site_sync(p_enabled boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('core.admin');
  insert into core.settings (org_id, key, value) values (private.org_id(), 'catalog_site', jsonb_build_object('enabled', p_enabled, 'base_url', 'https://siewear.com', 'source', 'SIEWEAR'))
  on conflict (org_id, key) do update set value = core.settings.value || jsonb_build_object('enabled', p_enabled), updated_at = now();
end $$;

do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname in ('centralops-catalog-site-full', 'centralops-catalog-site-prices');
  perform cron.schedule('centralops-catalog-site-full', '20 8 * * *', $c$select private.enqueue_catalog_sync('FULL')$c$);      -- 05:20 em São Paulo
  perform cron.schedule('centralops-catalog-site-prices', '40 */6 * * *', $c$select private.enqueue_catalog_sync('PRICES')$c$);
end $$;

insert into private.internal_functions (fqname) values
  ('catalog.upsert_site_product'), ('catalog.upsert_site_size_chart'), ('catalog.apply_site_prices'), ('catalog.finish_site_sync'), ('catalog.start_site_sync'),
  ('private.set_site_price'), ('private.enqueue_catalog_sync')
on conflict do nothing;

select private.lock_functions();
