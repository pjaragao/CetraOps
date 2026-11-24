-- Carrinho sempre com tamanho, no WhatsApp e na inbox (23/11/2026).
--
-- 1. Catálogo da Meta por TAMANHO: um item por produto × cor × tamanho (retailer_id = REFERÊNCIA-COR-TAMANHO, item_group_id =
--    REFERÊNCIA-COR, título "Nome Cor · Tam. M", estoque e preço do próprio tamanho). Assim o carrinho que a cliente manda pelo
--    WhatsApp já vem com o tamanho. Os itens antigos (sem tamanho) somem do catálogo na próxima sincronização.
--    No envio, cada peça vira os cartões dos tamanhos em estoque (uma seção por peça na lista de produtos).
-- 2. Carrinho enviado pela cliente = o carrinho da conversa: entra com tamanho e quantidade e tira as peças só mostradas
--    (e o carrinho anterior dela). O que o atendente pôs à mão ou veio do PDV fica.
-- 3. Mesma peça com e sem tamanho não se repete: a versão com tamanho substitui a sem tamanho.
-- 4. A IA vê o carrinho e registra o tamanho/quantidade que a cliente escolheu (propose_reply.cart); o atendente escolhe o
--    tamanho direto no carrinho da inbox.

alter table omni.meta_catalog_items add column if not exists size text;
alter table omni.meta_catalog_items add column if not exists variant_id uuid references catalog.variants (id) on delete set null;

create or replace function private.meta_variant_retailer_id(p_reference text, p_color_code text, p_color uuid, p_size text)
returns text language sql immutable set search_path = '' as $$
  select left(private.meta_retailer_id(p_reference, p_color_code, p_color) || '-' ||
              coalesce(nullif(regexp_replace(upper(coalesce(p_size, '')), '[^A-Z0-9]+', '', 'g'), ''), 'UN'), 100)
$$;

-- ============ 1. Feed: um item por tamanho ============
create or replace function omni.meta_catalog_feed(p_channel uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare ca omni.channel_accounts; v_brand text; v_items jsonb;
begin
  select * into ca from omni.channel_accounts where id = p_channel;
  if ca.id is null then return jsonb_build_object('found', false); end if;
  select coalesce((select nullif(trim(nome_fantasia), '') from core.legal_entities where org_id = ca.org_id and kind = 'OPERATING' order by created_at limit 1),
                  (select name from core.orgs where id = ca.org_id)) into v_brand;
  with vv as (
    select p.id as product_id, v.id as variant_id, v.color_id, v.size, p.name, p.reference_code, p.description, p.backorder, p.brand_id,
           col.name as color, col.code as color_code, catalog.current_price(v.id) as price,
           coalesce((select sum(sl.available) from inv.stock_levels sl join inv.locations l on l.id = sl.location_id and l.is_sellable
                     and (ca.store_id is null or l.store_id = ca.store_id) where sl.variant_id = v.id), 0) as avail
    from catalog.products p
    join catalog.variants v on v.product_id = p.id and v.active
    left join catalog.colors col on col.id = v.color_id
    where p.org_id = ca.org_id and p.status = 'ACTIVE' and p.product_kind = 'GOODS'
  ), grp as (
    select vv.product_id, vv.color_id,
           private.sort_sizes(array_agg(vv.size) filter (where vv.avail > 0)) as sizes,
           (select private.catalog_photo_url(ca.org_id, m.storage_path, m.source_url) from catalog.product_media m
             where m.product_id = vv.product_id order by (m.color_id is not distinct from vv.color_id) desc, m.position limit 1) as photo
    from vv group by vv.product_id, vv.color_id
  ), full_items as (
    select distinct on (rid) vv.*, g.sizes, g.photo,
           private.meta_variant_retailer_id(vv.reference_code, vv.color_code, vv.color_id, vv.size) as rid,
           private.meta_retailer_id(vv.reference_code, vv.color_code, vv.color_id) as group_id,
           -- nunca o site da marca (levaria a venda embora): o "ver no site" do cartão abre o WhatsApp da própria loja
           case when nullif(ca.public_address, '') is not null
                then 'https://wa.me/' || ca.public_address || '?text=Quero%20saber%20da%20pe%C3%A7a%20'
                     || private.meta_variant_retailer_id(vv.reference_code, vv.color_code, vv.color_id, vv.size) end as link,
           (select b.name from catalog.brands b where b.id = vv.brand_id) as brand
    from vv join grp g on g.product_id = vv.product_id and g.color_id is not distinct from vv.color_id
    order by rid, vv.avail desc
  ), items as (
    select f.*, jsonb_strip_nulls(jsonb_build_object(
             'title', left(f.name || coalesce(' ' || f.color, '') || coalesce(' · Tam. ' || nullif(trim(f.size), ''), ''), 200),
             'description', left(coalesce(nullif(trim(regexp_replace(regexp_replace(regexp_replace(coalesce(f.description, ''), '<[^>]+>', ' ', 'g'),
                                                   '(https?://|www\.)\S+|\S+\.com(\.br)?\S*', '', 'gi'), '\s+', ' ', 'g')), ''), f.name)
                                 || coalesce(' Tamanho ' || nullif(trim(f.size), '') || '.', '')
                                 || case when cardinality(f.sizes) > 0 then ' Tamanhos disponíveis: ' || array_to_string(f.sizes, ', ') || '.' else '' end, 5000),
             'availability', case when f.avail > 0 then 'in stock' when f.backorder then 'available for order' else 'out of stock' end,
             'inventory', greatest(f.avail, 0)::int,
             'condition', 'new',
             'price', to_char(f.price, 'FM999999990.00') || ' BRL',
             'link', f.link,
             'image_link', private.meta_image_url(f.photo),
             'brand', coalesce(f.brand, v_brand, 'Loja'),
             'color', f.color,
             'size', nullif(trim(f.size), ''),
             'item_group_id', f.group_id)) as data
    from full_items f
    where f.price is not null and f.price > 0 and f.photo is not null and f.link is not null
  )
  select coalesce(jsonb_agg(jsonb_build_object('retailer_id', i.rid, 'product_id', i.product_id, 'color_id', i.color_id,
                                               'variant_id', i.variant_id, 'size', i.size,
                                               'hash', md5(i.data::text), 'data', i.data) order by i.rid), '[]')
    into v_items from items i;
  return jsonb_build_object('found', true, 'org_id', ca.org_id, 'channel', ca.channel, 'connection_id', ca.connection_id,
                            'phone_number_id', ca.provider_account_id, 'public_address', ca.public_address,
                            'catalog_id', ca.meta_catalog_id, 'mode', ca.product_send_mode, 'items', v_items);
end $$;

create or replace function omni.meta_catalog_record(p_channel uuid, p_catalog text, p_items jsonb, p_summary jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare ca omni.channel_accounts;
begin
  select * into ca from omni.channel_accounts where id = p_channel;
  if ca.id is null then return; end if;
  insert into omni.meta_catalog_items as t (org_id, channel_account_id, catalog_id, retailer_id, product_id, color_id, variant_id, size,
                                            data_hash, status, error, synced_at, updated_at)
  select ca.org_id, ca.id, p_catalog, x.retailer_id, x.product_id, x.color_id,
         (select v.id from catalog.variants v where v.id = x.variant_id), x.size, x.hash, x.status, x.error,
         case when x.status in ('SYNCED', 'DELETED') then now() end, now()
  from jsonb_to_recordset(coalesce(p_items, '[]')) as x(retailer_id text, product_id uuid, color_id uuid, variant_id uuid, size text,
                                                       hash text, status text, error text)
  where x.retailer_id is not null
  on conflict (channel_account_id, catalog_id, retailer_id) do update
    set product_id = coalesce(excluded.product_id, t.product_id), color_id = coalesce(excluded.color_id, t.color_id),
        variant_id = coalesce(excluded.variant_id, t.variant_id), size = coalesce(excluded.size, t.size),
        data_hash = case when excluded.status = 'SYNCED' then excluded.data_hash else t.data_hash end,
        status = excluded.status, error = excluded.error, synced_at = coalesce(excluded.synced_at, t.synced_at), updated_at = now();
  update omni.channel_accounts set meta_catalog_sync = coalesce(p_summary, '{}') || jsonb_build_object('at', now(), 'catalog_id', p_catalog)
  where id = ca.id;
end $$;

-- Produtos citados num texto. `retailer_ids`: os itens da Meta (tamanhos) da peça, em estoque primeiro e na ordem de tamanho;
-- `retailer_id` é o primeiro (compatível com quem só manda um cartão).
create or replace function private.text_products(p_channel uuid, p_text text)
returns jsonb language sql stable security definer set search_path = '' as $$
  with ca as (select * from omni.channel_accounts where id = p_channel),
  urls as (
    select u.ord, rtrim(u.m[1], '.,;:!?') as url
    from regexp_matches(coalesce(p_text, ''), '(https?://[^\s<>"'')\]]+)', 'g') with ordinality as u(m, ord)
  ), hits as (
    select distinct on (u.ord) u.ord, u.url, pm.product_id, pm.color_id
    from urls u, ca
    join catalog.product_media pm on pm.org_id = ca.org_id
    where split_part(pm.source_url, '?', 1) = split_part(u.url, '?', 1)
       or split_part(u.url, '?', 1) like '%/storage/v1/object/public/catalog-media/' || pm.storage_path
    order by u.ord, pm.position
  )
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'url', h.url, 'product_id', h.product_id, 'color_id', h.color_id, 'name', p.name, 'color', col.name,
           'price', (select min(catalog.current_price(v.id)) from catalog.variants v where v.product_id = h.product_id and v.active
                      and (h.color_id is null or v.color_id = h.color_id)),
           'retailer_id', mi.ids[1], 'retailer_ids', to_jsonb(mi.ids))) order by h.ord), '[]')
  from hits h
  cross join ca
  join catalog.products p on p.id = h.product_id
  left join catalog.colors col on col.id = h.color_id
  left join lateral (
    select array_agg(s.retailer_id order by s.sized desc, s.in_stock desc, s.sort_key nulls last, s.retailer_id) filter (where s.best) as ids
    from (select i.retailer_id, i.size is not null as sized,
                 coalesce((select sum(sl.available) from inv.stock_levels sl join inv.locations l on l.id = sl.location_id and l.is_sellable
                           and (ca.store_id is null or l.store_id = ca.store_id) where sl.variant_id = i.variant_id), 0) > 0 as in_stock,
                 array_position(private.sort_sizes((select array_agg(v.size) from catalog.variants v where v.product_id = h.product_id and v.active)), i.size) as sort_key,
                 -- só a cor certa (ou, sem cor no item, a primeira que houver) e, se já houver itens por tamanho, só eles
                 (i.color_id is not distinct from coalesce((select i2.color_id from omni.meta_catalog_items i2
                                                            where i2.channel_account_id = ca.id and i2.catalog_id = ca.meta_catalog_id and i2.product_id = h.product_id
                                                              and i2.status = 'SYNCED' order by (i2.color_id is not distinct from h.color_id) desc limit 1), i.color_id))
                 and (i.size is not null or not exists (select 1 from omni.meta_catalog_items i3 where i3.channel_account_id = ca.id and i3.catalog_id = ca.meta_catalog_id
                                                         and i3.product_id = h.product_id and i3.color_id is not distinct from i.color_id
                                                         and i3.status = 'SYNCED' and i3.size is not null)) as best
          from omni.meta_catalog_items i
          where i.channel_account_id = ca.id and i.catalog_id = ca.meta_catalog_id and i.product_id = h.product_id and i.status = 'SYNCED') s
    having count(*) filter (where s.best) > 0
  ) mi on true
$$;

-- Carrinho do catálogo → texto legível (com o tamanho)
create or replace function omni.describe_order(p_provider_account text, p_order jsonb)
returns text language sql stable security definer set search_path = '' as $$
  with ca as (select * from omni.channel_accounts where channel = 'WHATSAPP' and provider_account_id = p_provider_account limit 1),
  it as (
    select x.ord, x.e ->> 'product_retailer_id' as rid, coalesce((x.e ->> 'quantity')::numeric, 1) as qty, (x.e ->> 'item_price')::numeric as price
    from jsonb_array_elements(coalesce(p_order -> 'product_items', '[]')) with ordinality as x(e, ord)
  ), named as (
    select it.*, coalesce((select p.name || coalesce(' (' || col.name || ')', '') || coalesce(' tam. ' || i.size, '')
                           from ca join omni.meta_catalog_items i on i.channel_account_id = ca.id and i.retailer_id = it.rid
                           join catalog.products p on p.id = i.product_id left join catalog.colors col on col.id = i.color_id
                           order by i.updated_at desc limit 1), it.rid) as label
    from it
  )
  select '🛒 Carrinho enviado pelo catálogo do WhatsApp:' || E'\n' ||
         coalesce((select string_agg('• ' || trim(to_char(qty, 'FM999990.##')) || '× ' || label ||
                                     coalesce(' — R$ ' || replace(to_char(price, 'FM999999990.00'), '.', ','), ''), E'\n' order by ord) from named), '(sem itens)') ||
         coalesce(E'\nTotal: R$ ' || replace(to_char((select sum(qty * price) from named where price is not null), 'FM999999990.00'), '.', ','), '') ||
         coalesce(E'\n' || nullif(trim(p_order ->> 'text'), ''), '')
$$;

-- ============ 2/3. Carrinho ============
-- Põe (ou reativa) uma peça. Com tamanho, substitui a mesma peça sem tamanho; sem tamanho, não duplica a que já tem tamanho.
create or replace function private.cart_put(p_conversation uuid, p_product uuid, p_color uuid, p_size text, p_qty numeric, p_source text,
                                            p_message uuid default null, p_member uuid default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_id uuid; v_size text := nullif(trim(coalesce(p_size, '')), '');
begin
  select org_id into v_org from omni.conversations where id = p_conversation;
  if v_org is null or p_product is null then return null; end if;
  if v_size is null then
    select id into v_id from omni.cart_items
    where conversation_id = p_conversation and product_id = p_product and color_id is not distinct from p_color and size is not null and status = 'ACTIVE'
    order by updated_at desc limit 1;
    if v_id is not null then return v_id; end if;
  end if;
  insert into omni.cart_items as t (org_id, conversation_id, product_id, color_id, size, qty, source, message_id, added_by)
  values (v_org, p_conversation, p_product, p_color, v_size, greatest(coalesce(p_qty, 1), 1), p_source, p_message, p_member)
  on conflict (conversation_id, product_id, coalesce(color_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(size, '')) do update
    set status = 'ACTIVE', removed_at = null, updated_at = now(),
        qty = case when excluded.source in ('ORDER', 'PDV', 'MANUAL') then excluded.qty else t.qty end,
        source = case when t.status <> 'ACTIVE' or excluded.source in ('ORDER', 'PDV') then excluded.source else t.source end,
        message_id = coalesce(excluded.message_id, t.message_id)
  returning id into v_id;
  if v_size is not null then
    update omni.cart_items set status = 'REMOVED', removed_at = now(), updated_at = now()
    where conversation_id = p_conversation and product_id = p_product and color_id is not distinct from p_color and size is null and status = 'ACTIVE';
  end if;
  return v_id;
end $$;

-- Define tamanho/quantidade de um item (ou tira). Tamanho só se existir na peça/cor; se a peça já estiver no carrinho nesse
-- tamanho, junta as duas linhas.
create or replace function private.cart_set(p_item uuid, p_size text, p_qty numeric, p_remove boolean default false)
returns uuid language plpgsql security definer set search_path = '' as $$
declare ci omni.cart_items; v_size text; v_other uuid;
begin
  select * into ci from omni.cart_items where id = p_item and status = 'ACTIVE';
  if ci.id is null then return null; end if;
  if coalesce(p_remove, false) then
    update omni.cart_items set status = 'REMOVED', removed_at = now(), updated_at = now() where id = ci.id;
    return ci.id;
  end if;
  if nullif(trim(coalesce(p_size, '')), '') is not null then
    select v.size into v_size from catalog.variants v
    where v.product_id = ci.product_id and v.active and (ci.color_id is null or v.color_id = ci.color_id)
      and upper(v.size) = upper(regexp_replace(trim(p_size), '^(tam\.?|tamanho)\s*', '', 'i'))
    limit 1;
    if v_size is null then raise exception 'Tamanho % não existe nesta peça', p_size using errcode = '22023'; end if;
    if v_size is distinct from ci.size then
      select id into v_other from omni.cart_items
      where conversation_id = ci.conversation_id and product_id = ci.product_id and color_id is not distinct from ci.color_id and size = v_size and id <> ci.id;
      if v_other is not null then delete from omni.cart_items where id = v_other; end if;
      update omni.cart_items set size = v_size, updated_at = now() where id = ci.id;
    end if;
  end if;
  if p_qty is not null and p_qty > 0 then
    update omni.cart_items set qty = least(p_qty, 99), updated_at = now() where id = ci.id;
  end if;
  return ci.id;
end $$;

-- Captura automática. Carrinho da cliente (catálogo do WhatsApp) passa a ser o carrinho: sai o que era só mostrado e o carrinho
-- anterior dela; entra cada item com tamanho e quantidade.
create or replace function private.cart_capture()
returns trigger language plpgsql security definer set search_path = '' as $$
declare r jsonb;
begin
  begin
    if new.direction = 'OUT' and new.body ~ 'https?://' then
      for r in select * from jsonb_array_elements(private.text_products(new.channel_account_id, new.body)) loop
        perform private.cart_put(new.conversation_id, (r ->> 'product_id')::uuid, (r ->> 'color_id')::uuid, null, 1, 'SHOWN', new.id);
      end loop;
    elsif new.direction = 'IN' and jsonb_typeof(new.payload -> 'order' -> 'product_items') = 'array' then
      update omni.cart_items set status = 'REMOVED', removed_at = now(), updated_at = now()
      where conversation_id = new.conversation_id and status = 'ACTIVE' and source in ('SHOWN', 'ORDER');
      for r in select x from jsonb_array_elements(new.payload -> 'order' -> 'product_items') x loop
        perform private.cart_put(new.conversation_id, i.product_id, i.color_id, i.size, coalesce((r ->> 'quantity')::numeric, 1), 'ORDER', new.id)
        from omni.meta_catalog_items i
        where i.channel_account_id = new.channel_account_id and i.retailer_id = r ->> 'product_retailer_id' and i.product_id is not null
        order by i.updated_at desc limit 1;
      end loop;
    end if;
  exception when others then
    raise warning 'carrinho da conversa não atualizado (mensagem %): %', new.id, sqlerrm;
  end;
  return null;
end $$;

-- Inbox: atendente escolhe tamanho/quantidade no carrinho
create or replace function omni.cart_set_size(p_item uuid, p_size text, p_qty numeric default null)
returns uuid language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('omni.write');
  if not exists (select 1 from omni.cart_items where id = p_item and (coalesce(auth.role(), '') <> 'authenticated' or org_id = private.org_id())) then
    raise exception 'Item não encontrado' using errcode = 'P0002';
  end if;
  return private.cart_set(p_item, p_size, p_qty);
end $$;

-- Lateral da inbox: itens com os tamanhos da peça (para escolher)
create or replace function omni.conversation_cart(p_conversation uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare cv omni.conversations; v_store uuid; v_items jsonb;
begin
  perform private.require_perm('omni.read');
  select * into cv from omni.conversations where id = p_conversation;
  if cv.id is null or (coalesce(auth.role(), '') = 'authenticated' and cv.org_id <> private.org_id()) then
    raise exception 'Conversa não encontrada' using errcode = 'P0002';
  end if;
  select store_id into v_store from omni.channel_accounts where id = cv.channel_account_id;
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'id', ci.id, 'product_id', ci.product_id, 'color_id', ci.color_id, 'name', p.name, 'reference', p.reference_code, 'color', col.name,
           'size', ci.size, 'qty', ci.qty, 'source', ci.source, 'price', pr.price,
           'available', (select coalesce(sum((x ->> 'available')::numeric), 0) from jsonb_array_elements(vs.variants) x where ci.size is null or x ->> 'size' = ci.size),
           'sizes_in_stock', (select to_jsonb(private.sort_sizes(array_agg(x ->> 'size'))) from jsonb_array_elements(vs.variants) x where (x ->> 'available')::numeric > 0),
           'variants', vs.variants,
           'photo', (select private.catalog_photo_url(cv.org_id, m.storage_path, m.source_url) from catalog.product_media m
                     where m.product_id = ci.product_id order by (m.color_id is not distinct from ci.color_id) desc, m.position limit 1),
           'added_at', ci.created_at)) order by ci.created_at), '[]')
    into v_items
  from omni.cart_items ci
  join catalog.products p on p.id = ci.product_id
  left join catalog.colors col on col.id = ci.color_id
  left join lateral (select min(catalog.current_price(v.id)) as price from catalog.variants v
                     where v.product_id = ci.product_id and v.active and (ci.color_id is null or v.color_id = ci.color_id)
                       and (ci.size is null or v.size = ci.size)) pr on true
  left join lateral (
    select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'size', s.size, 'price', s.price, 'available', s.avail)
                              order by s.sort_key nulls last, s.size), '[]') as variants
    from (select v.id, v.size, catalog.current_price(v.id) as price,
                 coalesce((select sum(sl.available) from inv.stock_levels sl join inv.locations l on l.id = sl.location_id and l.is_sellable
                           and (v_store is null or l.store_id = v_store) where sl.variant_id = v.id), 0) as avail,
                 array_position(private.sort_sizes((select array_agg(v2.size) from catalog.variants v2 where v2.product_id = ci.product_id and v2.active
                                                     and (ci.color_id is null or v2.color_id = ci.color_id))), v.size) as sort_key
          from catalog.variants v
          where v.product_id = ci.product_id and v.active and (ci.color_id is null or v.color_id = ci.color_id)) s) vs on true
  where ci.conversation_id = cv.id and ci.status = 'ACTIVE';
  return v_items;
end $$;

-- Conversas em que a cliente já mandou o carrinho: sai o que foi só mostrado (ou pedido) antes dele
update omni.cart_items ci set status = 'REMOVED', removed_at = now(), updated_at = now()
where ci.status = 'ACTIVE' and ci.source in ('SHOWN', 'ORDER')
  and exists (select 1 from omni.messages om where om.conversation_id = ci.conversation_id and om.direction = 'IN' and om.payload ? 'order'
              and om.created_at > coalesce((select m.created_at from omni.messages m where m.id = ci.message_id), ci.created_at));

-- ============ 4. IA ============
-- Worker: o carrinho resumido para o prompt (n = número que a IA usa para se referir ao item)
create or replace function omni.cart_for_ai(p_conversation uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'n', x.n, 'id', x.id, 'name', x.name, 'color', x.color, 'size', x.size, 'qty', x.qty, 'source', x.source,
           'sizes', to_jsonb(x.sizes))) order by x.n), '[]')
  from (select row_number() over (order by ci.created_at, ci.id) as n, ci.id, p.name, col.name as color, ci.size, ci.qty, ci.source,
               private.sort_sizes((select array_agg(v.size) from catalog.variants v where v.product_id = ci.product_id and v.active
                                   and (ci.color_id is null or v.color_id = ci.color_id))) as sizes
        from omni.cart_items ci
        join catalog.products p on p.id = ci.product_id
        left join catalog.colors col on col.id = ci.color_id
        where ci.conversation_id = p_conversation and ci.status = 'ACTIVE') x
$$;

-- Worker: aplica o que a IA registrou ([{id, size?, qty?, remove?}]); item inválido é ignorado (nunca derruba a resposta)
create or replace function omni.cart_ai_apply(p_conversation uuid, p_items jsonb)
returns integer language plpgsql security definer set search_path = '' as $$
declare r jsonb; n int := 0;
begin
  for r in select * from jsonb_array_elements(case when jsonb_typeof(p_items) = 'array' then p_items else '[]' end) loop
    begin
      if exists (select 1 from omni.cart_items where id = (r ->> 'id')::uuid and conversation_id = p_conversation and status = 'ACTIVE') then
        perform private.cart_set((r ->> 'id')::uuid, r ->> 'size', (r ->> 'qty')::numeric, coalesce((r ->> 'remove')::boolean, false));
        n := n + 1;
      end if;
    exception when others then
      raise warning 'item do carrinho não atualizado pela IA (%): %', r, sqlerrm;
    end;
  end loop;
  return n;
end $$;

insert into private.internal_functions (fqname) values
  ('private.cart_set'), ('omni.cart_for_ai'), ('omni.cart_ai_apply')
on conflict do nothing;
select private.lock_functions();
