-- =====================================================================
-- Fotos do catálogo guardadas no próprio Storage (bucket público `catalog-media`)
--  • Antes, as fotos do site eram só links para o CDN da Shopify: se a marca trocasse a foto ou tirasse o produto do site, a imagem sumia
--    do PDV, do catálogo e das etiquetas.
--  • catalog.product_media ganha `source_url` (link de origem); `storage_path` passa a ser o caminho no bucket depois da cópia
--    (enquanto não copia, continua o link — a web aceita os dois).
--  • O worker (fila catalog_sync, ao fim da sincronização completa ou com kind = MEDIA) pede as pendentes em catalog.media_to_mirror,
--    baixa, grava em catalog-media/<org>/<referência>/<código da cor>/<hash>.<ext> e confirma em catalog.set_media_mirror.
--  • A sincronização casa as fotos pelo link de origem: a cópia já guardada não é refeita a cada dia.
-- Bucket público: são as mesmas fotos do site da marca (abrem em etiqueta, link e WhatsApp sem login).
-- =====================================================================

alter table catalog.product_media
  add column if not exists source_url text,
  add column if not exists content_hash text,
  add column if not exists bytes int,
  add column if not exists mirrored_at timestamptz,
  add column if not exists mirror_error text,
  add column if not exists mirror_tried_at timestamptz;

-- o que veio do site até aqui era link: vira a origem
update catalog.product_media set source_url = storage_path where storage_path like 'http%' and source_url is null;
create index if not exists product_media_pending_idx on catalog.product_media (org_id) where source_url is not null and storage_path like 'http%';
create index if not exists product_media_product_idx on catalog.product_media (product_id, color_id, position);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('catalog-media', 'catalog-media', true, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
on conflict (id) do nothing;
-- escrita pela web (foto subida pela loja): só quem cuida do catálogo, dentro da pasta da organização; o worker usa a chave de serviço
create policy catalog_media_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'catalog-media' and (storage.foldername(name))[1] = (select private.org_id())::text and (select private.has_perm('catalog.write')));
create policy catalog_media_update on storage.objects for update to authenticated
  using (bucket_id = 'catalog-media' and (storage.foldername(name))[1] = (select private.org_id())::text and (select private.has_perm('catalog.write')));
create policy catalog_media_delete on storage.objects for delete to authenticated
  using (bucket_id = 'catalog-media' and (storage.foldername(name))[1] = (select private.org_id())::text and (select private.has_perm('catalog.write')));

-- Fotos ainda só no link de origem (as que falharam há menos de 6 h ficam para depois)
create or replace function catalog.media_to_mirror(p_org uuid, p_limit int default 200) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'url', m.source_url, 'reference', p.reference_code, 'color_code', coalesce(c.code, 'x'))), '[]')
  from (select * from catalog.product_media m
        where m.org_id = p_org and m.source_url is not null and m.storage_path like 'http%'
          and (m.mirror_tried_at is null or m.mirror_tried_at < now() - interval '6 hours')
        order by m.product_id, m.position limit greatest(1, least(p_limit, 1000))) m
  join catalog.products p on p.id = m.product_id
  left join catalog.colors c on c.id = m.color_id
$$;

-- Resultado da cópia: com caminho, a foto passa a ser servida do bucket; com erro, guarda o motivo e o link continua valendo
create or replace function catalog.set_media_mirror(p_id uuid, p_path text, p_hash text default null, p_bytes int default null, p_error text default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_path is not null and p_path !~ '^[0-9a-f-]{36}/' then raise exception 'Caminho inválido' using errcode = 'P0340'; end if;
  update catalog.product_media set
    storage_path = coalesce(p_path, storage_path), content_hash = coalesce(p_hash, content_hash), bytes = coalesce(p_bytes, bytes),
    mirrored_at = case when p_path is not null then now() else mirrored_at end,
    mirror_error = case when p_path is not null then null else left(p_error, 300) end, mirror_tried_at = now()
  where id = p_id;
end $$;

-- Sincronização: a cópia guardada é mantida (só a foto que saiu do site é apagada)
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
end $$;

-- Pedido manual de cópia das fotos (Catálogo › Sincronizar fotos)
create or replace function catalog.request_media_mirror() returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('catalog.write');
  perform private.enqueue('catalog_sync', jsonb_build_object('org_id', private.org_id(), 'kind', 'MEDIA'));
end $$;

-- primeira cópia: o worker novo (que sobe depois desta migration) já encontra o pedido na fila
select private.enqueue('catalog_sync', jsonb_build_object('org_id', s.org_id, 'kind', 'MEDIA'))
from core.settings s where s.key = 'catalog_site' and coalesce((s.value ->> 'enabled')::boolean, false);

insert into private.internal_functions (fqname) values ('catalog.media_to_mirror'), ('catalog.set_media_mirror') on conflict do nothing;
select private.lock_functions();
