-- =====================================================================
-- Origem dos dados do catálogo
--  O catálogo agora vem de várias fontes (site da marca, catálogo e pedido em PDF, planilha, NF-e, ajuste manual). Produto, variação,
--  cor, foto e preço guardam de onde vieram, quando e por quem (source, source_ref, source_by, source_at), e catalog.source_log guarda
--  cada inclusão, alteração (campo a campo, de → para) e exclusão com a origem, a data e o usuário.
--  • Quem grava avisa a origem com private.catalog_source(origem, documento) — vale até o fim da transação. Sem aviso: MANUAL quando há
--    usuário (tela), SISTEMA quando não há (worker/rotina).
--  • PDF guarda o usuário e o arquivo/pedido (source_ref); site guarda o link do produto; NF-e guarda o número da nota.
--  • As colunas de origem não mudam depois da inclusão (alteração vai para o histórico).
--  • Dados anteriores: SITE quando ligados ao site da marca; os criados pela importação de PDF de 13/10 (antes deste registro) ficam
--    como PDF, com o usuário da única sessão ativa no horário; o resto fica LEGADO (origem não registrada).
-- =====================================================================

create or replace function private.catalog_source(p_source text, p_ref text default null) returns void
language plpgsql set search_path = '' as $$
begin
  if p_source not in ('SITE', 'PDF_CATALOGO', 'PDF_PEDIDO', 'PLANILHA', 'NFE', 'MANUAL', 'SISTEMA') then
    raise exception 'Origem de dado inválida: %', p_source using errcode = 'P0360';
  end if;
  perform set_config('catalog.source', p_source, true);
  perform set_config('catalog.source_ref', coalesce(left(trim(p_ref), 300), ''), true);
end $$;
revoke execute on function private.catalog_source(text, text) from public, anon, authenticated;

create table catalog.source_log (
  id bigint generated always as identity primary key,
  org_id uuid not null references core.orgs(id),
  entity text not null check (entity in ('PRODUCT', 'VARIANT', 'COLOR', 'MEDIA', 'PRICE')),
  entity_id uuid not null,
  product_id uuid,                 -- sem FK: o histórico fica mesmo se o produto for apagado
  action text not null check (action in ('INSERT', 'UPDATE', 'DELETE')),
  source text not null check (source in ('SITE', 'PDF_CATALOGO', 'PDF_PEDIDO', 'PLANILHA', 'NFE', 'MANUAL', 'SISTEMA', 'LEGADO')),
  source_ref text,
  member_id uuid references core.members(id),
  changes jsonb,                   -- inclusão: os campos gravados; alteração: {campo: {de, para}}
  created_at timestamptz not null default now()
);
create index source_log_product_idx on catalog.source_log (product_id, created_at desc);
create index source_log_org_idx on catalog.source_log (org_id, created_at desc);
alter table catalog.source_log enable row level security;
create policy p_read on catalog.source_log for select to authenticated
  using (org_id = (select private.org_id()) and (select private.has_perm('catalog.read')));
comment on table catalog.source_log is 'Histórico de origem do catálogo: quem/quando/de onde incluiu, alterou ou excluiu produto, variação, cor, foto ou preço';

do $$
declare t text;
begin
  foreach t in array array['products', 'variants', 'colors', 'product_media', 'prices'] loop
    execute format($f$alter table catalog.%I
      add column source text check (source in ('SITE', 'PDF_CATALOGO', 'PDF_PEDIDO', 'PLANILHA', 'NFE', 'MANUAL', 'SISTEMA', 'LEGADO')),
      add column source_ref text,
      add column source_by uuid references core.members(id),
      add column source_at timestamptz$f$, t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Dados que já existiam
-- ---------------------------------------------------------------------
-- importação de PDF feita em 13/10 antes deste registro: começa no primeiro preço de atacado gravado (só o PDF grava atacado)
create temp table pdf_window on commit drop as
  select org_id, min(wholesale_cost_at) - interval '5 minutes' as since from catalog.products where wholesale_cost_at is not null group by org_id;
-- única sessão ativa no horário da importação (Paulo Jr); em outro banco o membro não existe e fica sem usuário
create temp table pdf_member on commit drop as
  select id from core.members where id = 'cc110b5a-00c5-4f23-b895-5e8dfcf5a9d6';

update catalog.products p set source = case when exists (select 1 from catalog.site_items s where s.product_id = p.id) then 'SITE' else 'LEGADO' end,
  source_at = p.created_at;

update catalog.variants v set
  source = case
    when w.since is not null and v.created_at >= w.since and v.supplier_sku = v.sku then 'PDF_PEDIDO'
    when w.since is not null and v.created_at >= w.since and v.supplier_sku is null then 'PDF_CATALOGO'
    when v.supplier_sku ~ '^\d+$' or exists (select 1 from catalog.site_items s where s.product_id = v.product_id and s.color_id = v.color_id) then 'SITE'
    else 'LEGADO' end,
  source_at = v.created_at
from catalog.variants v2 left join pdf_window w on w.org_id = v2.org_id
where v2.id = v.id;
update catalog.variants set source_by = (select id from pdf_member), source_ref = 'importado antes do registro de origem'
where source in ('PDF_PEDIDO', 'PDF_CATALOGO');

-- cor: a origem da primeira variação que a usa (a cor nasce junto com ela)
update catalog.colors c set source = coalesce(f.source, case when exists (select 1 from catalog.site_items s where s.color_id = c.id) then 'SITE' else 'LEGADO' end),
  source_at = f.created_at, source_by = f.source_by, source_ref = f.source_ref
from catalog.colors c2
left join lateral (select v.source, v.created_at, v.source_by, v.source_ref from catalog.variants v where v.color_id = c2.id order by v.created_at limit 1) f on true
where c2.id = c.id;
update catalog.colors c set source = 'SITE', source_by = null, source_ref = null
where source not in ('PDF_PEDIDO', 'PDF_CATALOGO') and exists (select 1 from catalog.site_items s where s.color_id = c.id);

update catalog.product_media set source = case when source_url is not null then 'SITE' else 'LEGADO' end, source_at = mirrored_at;
update catalog.prices pr set source = case when exists (select 1 from catalog.site_items s where s.product_id = coalesce(pr.product_id, (select v.product_id from catalog.variants v where v.id = pr.variant_id))) then 'SITE' else 'LEGADO' end,
  source_at = pr.valid_from;

-- histórico da importação de PDF anterior: variações e cores incluídas e o preço de atacado gravado
insert into catalog.source_log (org_id, entity, entity_id, product_id, action, source, source_ref, member_id, changes, created_at)
select org_id, 'VARIANT', id, product_id, 'INSERT', source, source_ref, source_by, jsonb_build_object('sku', sku, 'size', size), source_at
from catalog.variants where source in ('PDF_PEDIDO', 'PDF_CATALOGO');
insert into catalog.source_log (org_id, entity, entity_id, product_id, action, source, source_ref, member_id, changes, created_at)
select org_id, 'COLOR', id, null, 'INSERT', source, source_ref, source_by, jsonb_build_object('name', name, 'code', code), source_at
from catalog.colors where source in ('PDF_PEDIDO', 'PDF_CATALOGO');
insert into catalog.source_log (org_id, entity, entity_id, product_id, action, source, source_ref, member_id, changes, created_at)
select org_id, 'PRODUCT', id, id, 'UPDATE', 'PDF_PEDIDO', 'importado antes do registro de origem', (select id from pdf_member),
       jsonb_build_object('wholesale_cost', jsonb_build_object('de', null, 'para', wholesale_cost)), wholesale_cost_at
from catalog.products where wholesale_cost_at is not null;

alter table catalog.products alter column source set not null;
alter table catalog.variants alter column source set not null;
alter table catalog.colors alter column source set not null;
alter table catalog.product_media alter column source set not null;
alter table catalog.prices alter column source set not null;

-- ---------------------------------------------------------------------
-- Gatilho: origem na inclusão e histórico de tudo
-- ---------------------------------------------------------------------
create or replace function private.short_json(j jsonb) returns jsonb language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(j) = 'string' and length(j #>> '{}') > 200 then to_jsonb(left(j #>> '{}', 200) || '…') else j end
$$;

create or replace function private.catalog_track() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_entity text := tg_argv[0];
  v_src text := nullif(current_setting('catalog.source', true), '');
  v_ref text := nullif(current_setting('catalog.source_ref', true), '');
  v_by uuid := private.member_id();
  v_old jsonb; v_new jsonb; v_row jsonb; v_changes jsonb := '{}'; k text; v_prod uuid;
  -- campos técnicos (cópia da foto no Storage, posição, vigência do preço) não entram no histórico
  skip text[] := array['id', 'org_id', 'created_at', 'updated_at', 'source', 'source_ref', 'source_by', 'source_at',
                       'storage_path', 'content_hash', 'bytes', 'mirrored_at', 'mirror_error', 'mirror_tried_at', 'position', 'valid_from', 'valid_to',
                       'wholesale_cost_at'];
begin
  v_src := coalesce(v_src, case when v_by is not null then 'MANUAL' else 'SISTEMA' end);
  if tg_op = 'INSERT' then
    new.source := v_src; new.source_ref := v_ref; new.source_by := v_by; new.source_at := now();
    v_new := to_jsonb(new);
    for k in select jsonb_object_keys(v_new) loop
      continue when k = any(skip) or v_new -> k = 'null'::jsonb;
      v_changes := v_changes || jsonb_build_object(k, private.short_json(v_new -> k));
    end loop;
  elsif tg_op = 'UPDATE' then
    new.source := old.source; new.source_ref := old.source_ref; new.source_by := old.source_by; new.source_at := old.source_at;
    v_old := to_jsonb(old); v_new := to_jsonb(new);
    for k in select jsonb_object_keys(v_new) loop
      continue when k = any(skip) or (v_new -> k) is not distinct from (v_old -> k);
      v_changes := v_changes || jsonb_build_object(k, jsonb_build_object('de', private.short_json(v_old -> k), 'para', private.short_json(v_new -> k)));
    end loop;
    if v_changes = '{}' then return new; end if;
  else
    v_old := to_jsonb(old);
    v_changes := null;
  end if;
  v_row := coalesce(v_new, v_old);
  v_prod := case v_entity when 'PRODUCT' then (v_row ->> 'id')::uuid when 'COLOR' then null
            else coalesce((v_row ->> 'product_id')::uuid, (select va.product_id from catalog.variants va where va.id = (v_row ->> 'variant_id')::uuid)) end;
  insert into catalog.source_log (org_id, entity, entity_id, product_id, action, source, source_ref, member_id, changes)
  values ((v_row ->> 'org_id')::uuid, v_entity, (v_row ->> 'id')::uuid, v_prod, tg_op, v_src, v_ref, v_by, v_changes);
  return case when tg_op = 'DELETE' then old else new end;
end $$;
revoke execute on function private.catalog_track() from public, anon, authenticated;

create trigger trg_source before insert or update or delete on catalog.products for each row execute function private.catalog_track('PRODUCT');
create trigger trg_source before insert or update or delete on catalog.variants for each row execute function private.catalog_track('VARIANT');
create trigger trg_source before insert or update or delete on catalog.colors for each row execute function private.catalog_track('COLOR');
create trigger trg_source before insert or update or delete on catalog.product_media for each row execute function private.catalog_track('MEDIA');
create trigger trg_source before insert or update or delete on catalog.prices for each row execute function private.catalog_track('PRICE');

-- ---------------------------------------------------------------------
-- Quem grava avisa a origem
-- ---------------------------------------------------------------------

-- Site da marca (igual a 20261013000200 / 20261012000300, avisando a origem)
CREATE OR REPLACE FUNCTION catalog.upsert_site_product(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_org uuid := (p ->> 'org_id')::uuid; v_src text := coalesce(p ->> 'source', 'SIEWEAR');
  v_brand uuid; v_cat uuid; v_coll uuid; v_color uuid; v_prod uuid; v_grid uuid; v_chart uuid; v_var uuid;
  v_color_name text := trim(coalesce(nullif(p ->> 'color_name', ''), 'Única')); v_code text := p ->> 'color_code';
  v_gender catalog.gender := case when upper(p ->> 'gender') = 'MASC' then 'MASC' else 'FEM' end;
  it jsonb; v_prices jsonb := '[]'; v_new boolean := false; v_changes int; img text; i int := 0;
begin
  perform private.catalog_source('SITE', p ->> 'url');
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

  -- fotos da cor: casadas pelo link de origem, para não perder a cópia já guardada no Storage; só sai a foto que o site tirou
  delete from catalog.product_media where product_id = v_prod and color_id = v_color and source_url is not null
    and source_url not in (select jsonb_array_elements_text(coalesce(p -> 'images', '[]')));
  for img in select jsonb_array_elements_text(coalesce(p -> 'images', '[]')) loop
    i := i + 1;
    update catalog.product_media set position = i where product_id = v_prod and color_id = v_color and source_url = img;
    if not found then
      insert into catalog.product_media (org_id, product_id, color_id, storage_path, source_url, position) values (v_org, v_prod, v_color, img, img, i);
    end if;
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
end $function$;

CREATE OR REPLACE FUNCTION catalog.apply_site_prices(p_org uuid, p jsonb, p_source text DEFAULT 'SIEWEAR'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r record; n int := 0; m int := 0;
begin
  perform private.catalog_source('SITE', p_source);
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
end $function$;

-- Planilha (igual a 20261012000100, avisando a origem por linha)
CREATE OR REPLACE FUNCTION catalog.import_rows(p jsonb, p_location uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
      -- planilha; o cadastro rápido do recebimento usa a mesma função e informa NF-e
      if coalesce(nullif(r ->> 'source', ''), 'PLANILHA') not in ('PLANILHA', 'NFE') then raise exception 'origem inválida'; end if;
      perform private.catalog_source(coalesce(nullif(r ->> 'source', ''), 'PLANILHA'), nullif(r ->> 'document', ''));
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
end $function$;

-- PDF / NF-e (igual a 20261013000900, com origem por linha, e NCM, EAN, SKU e categoria para o recebimento)
create or replace function catalog.apply_brand_items(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id();
  it jsonb; i int := 0;
  v_pl uuid; v_prod catalog.products; v_color catalog.colors; v_var uuid; v_sku text; v_ref text; v_size text; v_code text; v_name text;
  v_new_prod boolean; v_new_color boolean; v_new_var boolean;
  v_out jsonb := '[]'; v_errors jsonb := '[]';
  n_prod int := 0; n_color int := 0; n_var int := 0;
begin
  perform private.require_perm('catalog.write');
  if jsonb_typeof(p) <> 'array' or jsonb_array_length(p) > 2000 then raise exception 'Lista de itens inválida (máx. 2.000)' using errcode = 'P0360'; end if;
  select id into v_pl from catalog.price_lists where org_id = v_org and is_default;

  for it in select * from jsonb_array_elements(p) loop
    i := i + 1;
    begin
      -- origem de cada linha: pedido ou catálogo em PDF (com o arquivo), NF-e (cadastro pelo recebimento) ou tela
      if coalesce(nullif(it ->> 'source', ''), 'MANUAL') not in ('PDF_PEDIDO', 'PDF_CATALOGO', 'NFE', 'MANUAL') then raise exception 'origem inválida'; end if;
      perform private.catalog_source(coalesce(nullif(it ->> 'source', ''), 'MANUAL'), nullif(it ->> 'document', ''));
      v_new_prod := false; v_new_color := false; v_new_var := false; v_prod := null; v_color := null;
      v_size := upper(trim(coalesce(it ->> 'size', '')));
      if v_size = '' or length(v_size) > 10 then raise exception 'tamanho inválido'; end if;

      -- produto: escolhido na tela ou pelo modelo (referência)
      if nullif(it ->> 'product_id', '') is not null then
        select * into v_prod from catalog.products where id = (it ->> 'product_id')::uuid and org_id = v_org;
        if v_prod.id is null then raise exception 'produto não encontrado'; end if;
      else
        v_ref := upper(trim(coalesce(it ->> 'reference', '')));
        if v_ref = '' then raise exception 'falta a referência (modelo) do produto'; end if;
        select * into v_prod from catalog.products where org_id = v_org and reference_code = v_ref;
        if v_prod.id is null then
          if length(trim(coalesce(it ->> 'name', ''))) < 2 then raise exception 'produto % não existe: informe o nome', v_ref; end if;
          insert into catalog.products (org_id, category_id, ncm, size_grid_id, reference_code, name, composition, gender, status)
          values (v_org,
                  case when nullif(trim(coalesce(it ->> 'category', '')), '') is not null then private.category_for(v_org, trim(it ->> 'category'), nullif(it ->> 'ncm', '')) end,
                  nullif(regexp_replace(coalesce(it ->> 'ncm', ''), '\D', '', 'g'), ''),
                  (select id from catalog.size_grids where org_id = v_org and name = case upper(coalesce(it ->> 'gender', 'FEM')) when 'MASC' then 'Masculino P-GG' else 'Feminino PP-GG' end),
                  v_ref, trim(it ->> 'name'), nullif(trim(coalesce(it ->> 'composition', '')), ''),
                  (case upper(coalesce(it ->> 'gender', 'FEM')) when 'MASC' then 'MASC' when 'UNISSEX' then 'UNISSEX' else 'FEM' end)::catalog.gender, 'ACTIVE')
          returning * into v_prod;
          v_new_prod := true; n_prod := n_prod + 1;
        end if;
      end if;
      -- texto vazio da loja é preenchido; o que já existe (site ou cadastro) não é trocado
      if v_prod.composition is null and nullif(trim(coalesce(it ->> 'composition', '')), '') is not null then
        update catalog.products set composition = trim(it ->> 'composition') where id = v_prod.id returning * into v_prod;
      end if;
      -- NCM da nota preenche o produto que ainda não tem
      if v_prod.ncm is null and coalesce(it ->> 'ncm', '') ~ '^\d{8}$' then
        update catalog.products set ncm = it ->> 'ncm' where id = v_prod.id returning * into v_prod;
      end if;
      if nullif(it ->> 'wholesale_cost', '') is not null then
        if (it ->> 'wholesale_cost')::numeric < 0 then raise exception 'preço de atacado inválido'; end if;
        update catalog.products set wholesale_cost = (it ->> 'wholesale_cost')::numeric, wholesale_cost_at = now()
        where id = v_prod.id and wholesale_cost is distinct from (it ->> 'wholesale_cost')::numeric;
      end if;
      if coalesce((it ->> 'backorder')::boolean, false) then
        update catalog.products set backorder = true where id = v_prod.id and not backorder;
      end if;

      -- cor: escolhida na tela, pelo código da marca ou pelo nome
      v_code := upper(trim(coalesce(it ->> 'color_code', '')));
      v_name := trim(coalesce(it ->> 'color_name', ''));
      if nullif(it ->> 'color_id', '') is not null then
        select * into v_color from catalog.colors where id = (it ->> 'color_id')::uuid and org_id = v_org;
        if v_color.id is null then raise exception 'cor não encontrada'; end if;
      elsif v_code <> '' then
        select * into v_color from catalog.colors where org_id = v_org and upper(code) = v_code
        order by (private.norm(name) = private.norm(v_name)) desc, name limit 1;
      elsif v_name <> '' then
        select * into v_color from catalog.colors where org_id = v_org
          and private.norm(regexp_replace(name, '\s*\(\w+\)$', '')) = private.norm(v_name)
        order by (private.norm(name) = private.norm(v_name)) desc, name limit 1;
      else
        raise exception 'falta a cor';
      end if;
      if v_color.id is null then
        if v_name = '' then raise exception 'cor % não cadastrada: informe o nome', v_code; end if;
        if v_code = '' then v_code := upper(left(regexp_replace(private.norm(v_name), '[^a-z0-9]', '', 'g'), 3)); end if;
        if v_code = '' or length(v_code) > 10 then raise exception 'código de cor inválido'; end if;
        -- mesmo nome com outro código (ex.: Preto 004 e Preto 019): o nome leva o código, como no site
        if exists (select 1 from catalog.colors where org_id = v_org and name = v_name) then v_name := v_name || ' (' || v_code || ')'; end if;
        insert into catalog.colors (org_id, name, code) values (v_org, v_name, v_code) returning * into v_color;
        v_new_color := true; n_color := n_color + 1;
      end if;
      if coalesce(v_color.code, '') = '' then raise exception 'a cor % está sem código: corrija no cadastro de cores', v_color.name; end if;

      -- variante no padrão da etiqueta da marca: modelo + código da cor + tamanho
      select id, sku into v_var, v_sku from catalog.variants where product_id = v_prod.id and color_id = v_color.id and size = v_size;
      if v_var is null then
        v_sku := coalesce(nullif(upper(trim(coalesce(it ->> 'sku', ''))), ''), v_prod.reference_code || upper(v_color.code) || v_size);
        if exists (select 1 from catalog.variants where org_id = v_org and sku = v_sku) then
          raise exception 'já existe outra peça com o SKU %', v_sku;
        end if;
        insert into catalog.variants (org_id, product_id, color_id, size, sku, supplier_sku, gtin)
        values (v_org, v_prod.id, v_color.id, v_size, v_sku, nullif(trim(coalesce(it ->> 'supplier_sku', '')), ''),
                case when coalesce(it ->> 'gtin', '') ~ '^\d{8,14}$' and it ->> 'gtin' !~ '^0+$'
                      and not exists (select 1 from catalog.variants g where g.org_id = v_org and g.gtin = it ->> 'gtin') then it ->> 'gtin' end)
        returning id into v_var;
        v_new_var := true; n_var := n_var + 1;
      else
        update catalog.variants set active = true where id = v_var and not active;
      end if;

      -- preço de venda só entra se o produto ainda não tem (o do site/cadastro manda)
      if nullif(it ->> 'price', '') is not null and (it ->> 'price')::numeric > 0 and v_pl is not null
         and catalog.current_price(v_var, v_pl) is null then
        insert into catalog.prices (org_id, price_list_id, product_id, price) values (v_org, v_pl, v_prod.id, round((it ->> 'price')::numeric, 2));
      end if;

      v_out := v_out || jsonb_build_object('i', i, 'variant_id', v_var, 'sku', v_sku, 'product_id', v_prod.id, 'color_id', v_color.id,
                                           'reference', v_prod.reference_code, 'color_code', v_color.code,
                                           'new_product', v_new_prod, 'new_color', v_new_color, 'new_variant', v_new_var);
    exception when others then
      v_errors := v_errors || jsonb_build_object('i', i, 'erro', sqlerrm);
    end;
  end loop;

  return jsonb_build_object('items', v_out, 'erros', v_errors, 'produtos_novos', n_prod, 'cores_novas', n_color, 'variantes_novas', n_var);
end $$;

-- Fotos enviadas pela tela (catálogo em PDF): o arquivo já está no Storage; aqui ficam o registro, a origem e a posição.
-- Foto repetida (mesmo resumo) no mesmo produto é ignorada.
create or replace function catalog.add_media(p jsonb) returns int
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id(); v_prod uuid; v_color uuid; v_pos int; it jsonb; n int := 0;
begin
  perform private.require_perm('catalog.write');
  if coalesce(nullif(p ->> 'source', ''), 'MANUAL') not in ('PDF_CATALOGO', 'MANUAL') then raise exception 'Origem inválida' using errcode = 'P0360'; end if;
  select id into v_prod from catalog.products where id = (p ->> 'product_id')::uuid and org_id = v_org;
  select id into v_color from catalog.colors where id = nullif(p ->> 'color_id', '')::uuid and org_id = v_org;
  if v_prod is null then raise exception 'Produto não encontrado' using errcode = 'P0360'; end if;
  perform private.catalog_source(coalesce(nullif(p ->> 'source', ''), 'MANUAL'), nullif(p ->> 'document', ''));
  select coalesce(max(position), -1) + 1 into v_pos from catalog.product_media where product_id = v_prod;
  for it in select * from jsonb_array_elements(coalesce(p -> 'items', '[]')) loop
    -- só caminhos da própria empresa no bucket do catálogo
    if coalesce(it ->> 'path', '') !~ ('^' || v_org::text || '/[^/]+/[^/]+/[0-9a-f]{20}\.jpg$') then raise exception 'Caminho de foto inválido' using errcode = 'P0360'; end if;
    continue when exists (select 1 from catalog.product_media where product_id = v_prod and content_hash = it ->> 'hash');
    insert into catalog.product_media (org_id, product_id, color_id, storage_path, position, content_hash, bytes, mirrored_at)
    values (v_org, v_prod, v_color, it ->> 'path', v_pos, it ->> 'hash', nullif(it ->> 'bytes', '')::int, now());
    v_pos := v_pos + 1; n := n + 1;
  end loop;
  return n;
end $$;

select private.lock_functions();
