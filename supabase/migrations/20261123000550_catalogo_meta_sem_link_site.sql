-- Catálogo da Meta sem NENHUM link para o site da marca (23/11/2026). O site é da marca nacional: mandar o cliente para lá
-- leva a venda embora. O link de cada item (o "ver no site" do cartão) passa a abrir o WhatsApp da própria loja (wa.me), com a
-- mensagem "Quero saber da peça <código>", e qualquer link é tirado da descrição. O worker grava o número do canal
-- (public_address) se estiver vazio. Como o conteúdo muda, a próxima sincronização reenvia todos os itens à Meta.

create or replace function omni.meta_catalog_feed(p_channel uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare ca omni.channel_accounts; v_brand text; v_items jsonb;
begin
  select * into ca from omni.channel_accounts where id = p_channel;
  if ca.id is null then return jsonb_build_object('found', false); end if;
  select coalesce((select nullif(trim(nome_fantasia), '') from core.legal_entities where org_id = ca.org_id and kind = 'OPERATING' order by created_at limit 1),
                  (select name from core.orgs where id = ca.org_id)) into v_brand;
  with pc as (
    select p.id as product_id, v.color_id, p.name, p.reference_code, p.description, p.backorder, p.brand_id,
           max(col.name) as color, max(col.code) as color_code,
           min(catalog.current_price(v.id)) as price,
           coalesce(sum(st.avail), 0) as avail,
           private.sort_sizes(array_agg(v.size) filter (where st.avail > 0)) as sizes
    from catalog.products p
    join catalog.variants v on v.product_id = p.id and v.active
    left join catalog.colors col on col.id = v.color_id
    left join lateral (select coalesce(sum(sl.available), 0) as avail from inv.stock_levels sl join inv.locations l on l.id = sl.location_id and l.is_sellable
                       and (ca.store_id is null or l.store_id = ca.store_id) where sl.variant_id = v.id) st on true
    where p.org_id = ca.org_id and p.status = 'ACTIVE' and p.product_kind = 'GOODS'
    group by p.id, v.color_id
  ), full_items as (
    select distinct on (rid) pc.*, private.meta_retailer_id(pc.reference_code, pc.color_code, pc.color_id) as rid,
           (select private.catalog_photo_url(ca.org_id, m.storage_path, m.source_url) from catalog.product_media m
             where m.product_id = pc.product_id order by (m.color_id is not distinct from pc.color_id) desc, m.position limit 1) as photo,
           -- nunca o site da marca (levaria a venda embora): o "ver no site" do cartão abre o WhatsApp da própria loja
           case when nullif(ca.public_address, '') is not null
                then 'https://wa.me/' || ca.public_address || '?text=Quero%20saber%20da%20pe%C3%A7a%20' || private.meta_retailer_id(pc.reference_code, pc.color_code, pc.color_id) end as link,
           (select b.name from catalog.brands b where b.id = pc.brand_id) as brand
    from pc
    order by rid, pc.avail desc
  ), items as (
    select f.*, jsonb_strip_nulls(jsonb_build_object(
             'title', left(f.name || coalesce(' ' || f.color, ''), 200),
             'description', left(coalesce(nullif(trim(regexp_replace(regexp_replace(regexp_replace(coalesce(f.description, ''), '<[^>]+>', ' ', 'g'),
                                                   '(https?://|www\.)\S+|\S+\.com(\.br)?\S*', '', 'gi'), '\s+', ' ', 'g')), ''), f.name)
                                 || case when cardinality(f.sizes) > 0 then ' Tamanhos disponíveis: ' || array_to_string(f.sizes, ', ') || '.' else '' end, 5000),
             'availability', case when f.avail > 0 then 'in stock' when f.backorder then 'available for order' else 'out of stock' end,
             'inventory', greatest(f.avail, 0)::int,
             'condition', 'new',
             'price', to_char(f.price, 'FM999999990.00') || ' BRL',
             'link', f.link,
             'image_link', private.meta_image_url(f.photo),
             'brand', coalesce(f.brand, v_brand, 'Loja'),
             'color', f.color,
             'item_group_id', left(regexp_replace(upper(f.reference_code), '[^A-Z0-9_-]+', '', 'g'), 100))) as data
    from full_items f
    where f.price is not null and f.price > 0 and f.photo is not null and f.link is not null
  )
  select coalesce(jsonb_agg(jsonb_build_object('retailer_id', i.rid, 'product_id', i.product_id, 'color_id', i.color_id,
                                               'hash', md5(i.data::text), 'data', i.data) order by i.rid), '[]')
    into v_items from items i;
  return jsonb_build_object('found', true, 'org_id', ca.org_id, 'channel', ca.channel, 'connection_id', ca.connection_id,
                            'phone_number_id', ca.provider_account_id, 'public_address', ca.public_address,
                            'catalog_id', ca.meta_catalog_id, 'mode', ca.product_send_mode, 'items', v_items);
end $$;

select private.lock_functions();
