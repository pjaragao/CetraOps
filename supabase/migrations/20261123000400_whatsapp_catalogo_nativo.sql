-- Catálogo nativo do WhatsApp (mensagens interativas `product` / `product_list`) com volta automática ao envio direto.
--
-- • Configuração por canal: product_send_mode = 'NATIVE_CATALOG' (padrão: cartões do catálogo da Meta) ou 'DIRECT' (como antes:
--   fotos como imagem + texto). meta_catalog_id = catálogo da FRANQUIA no Commerce Manager, ligado à WABA. Sem catalog_id, ou com
--   o produto fora do catálogo, ou com a Meta recusando o cartão, o worker cai no envio direto: a cliente nunca fica sem resposta.
-- • O site da marca (Shopify nacional) é só fonte de dados. O catálogo da Meta é alimentado pelo próprio CetraOps, a partir do
--   catálogo interno: um item por produto × cor (retailer_id estável = referência + código da cor), com preço, foto, estoque e link.
-- • Os produtos de uma resposta são reconhecidos pelos links de foto do catálogo no texto (o que a IA já escreve hoje): assim vale
--   para o rascunho do copiloto, para o autopiloto e para mensagens editadas ou escritas pela equipe.

alter table omni.channel_accounts
  add column if not exists product_send_mode text not null default 'NATIVE_CATALOG',
  add column if not exists meta_catalog_id text,
  add column if not exists meta_catalog_sync jsonb not null default '{}';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'channel_accounts_product_send_mode_check') then
    alter table omni.channel_accounts add constraint channel_accounts_product_send_mode_check check (product_send_mode in ('NATIVE_CATALOG', 'DIRECT'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'channel_accounts_meta_catalog_id_check') then
    alter table omni.channel_accounts add constraint channel_accounts_meta_catalog_id_check check (meta_catalog_id ~ '^[0-9]{5,25}$');
  end if;
end $$;

comment on column omni.channel_accounts.product_send_mode is 'Envio de produtos no WhatsApp: NATIVE_CATALOG (cartões do catálogo da Meta, com volta ao envio direto) ou DIRECT (fotos + texto)';
comment on column omni.channel_accounts.meta_catalog_id is 'Catálogo da franquia no Commerce Manager (ligado à WABA), alimentado pelo CetraOps';
comment on column omni.channel_accounts.meta_catalog_sync is 'Última sincronização com o catálogo da Meta: {at, ok, items, synced, errors, deleted, error, catalog_name}';

-- Itens do catálogo interno enviados ao catálogo da Meta (um por produto × cor) e a situação de cada um
create table if not exists omni.meta_catalog_items (
  org_id              uuid not null references core.orgs (id),
  channel_account_id  uuid not null references omni.channel_accounts (id) on delete cascade,
  catalog_id          text not null,
  retailer_id         text not null,
  product_id          uuid references catalog.products (id) on delete set null,
  color_id            uuid references catalog.colors (id) on delete set null,
  data_hash           text,
  status              text not null default 'PENDING' check (status in ('PENDING', 'SYNCED', 'ERROR', 'DELETED')),
  error               text,
  synced_at           timestamptz,
  updated_at          timestamptz not null default now(),
  primary key (channel_account_id, catalog_id, retailer_id)
);
create index if not exists meta_catalog_items_product on omni.meta_catalog_items (channel_account_id, product_id);
select private.apply_rls('omni', array['meta_catalog_items'], 'omni.read', 'core.admin');

create or replace function private.meta_retailer_id(p_reference text, p_color_code text, p_color uuid)
returns text language sql immutable set search_path = '' as $$
  select left(regexp_replace(upper(coalesce(nullif(trim(p_reference), ''), 'SEMREF') || '-' ||
              coalesce(nullif(trim(p_color_code), ''), left(p_color::text, 8), 'UN')), '[^A-Z0-9_-]+', '', 'g'), 100)
$$;

-- Foto pública para a Meta: o CDN da Shopify converte webp/avif em JPEG pelo parâmetro format (a Meta não aceita webp no catálogo)
create or replace function private.meta_image_url(p_url text)
returns text language sql immutable set search_path = '' as $$
  select case when p_url is null then null
              when p_url like '%cdn.shopify.com%' then p_url || case when p_url like '%?%' then '&' else '?' end || 'width=1200&format=jpg'
              else p_url end
$$;

-- Itens que o catálogo da Meta deve ter agora (produto ativo × cor com variante ativa, preço, foto e link). O worker compara o hash.
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
           (select si.url from catalog.site_items si where si.product_id = pc.product_id and si.removed_at is null and si.url is not null
             order by (si.color_id is not distinct from pc.color_id) desc, si.synced_at desc limit 1) as link,
           (select b.name from catalog.brands b where b.id = pc.brand_id) as brand
    from pc
    order by rid, pc.avail desc
  ), items as (
    select f.*, jsonb_strip_nulls(jsonb_build_object(
             'title', left(f.name || coalesce(' ' || f.color, ''), 200),
             'description', left(coalesce(nullif(trim(regexp_replace(regexp_replace(coalesce(f.description, ''), '<[^>]+>', ' ', 'g'), '\s+', ' ', 'g')), ''), f.name)
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
                            'catalog_id', ca.meta_catalog_id, 'mode', ca.product_send_mode, 'items', v_items);
end $$;

-- Resultado de uma sincronização: situação de cada item e o resumo no canal
create or replace function omni.meta_catalog_record(p_channel uuid, p_catalog text, p_items jsonb, p_summary jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare ca omni.channel_accounts;
begin
  select * into ca from omni.channel_accounts where id = p_channel;
  if ca.id is null then return; end if;
  insert into omni.meta_catalog_items as t (org_id, channel_account_id, catalog_id, retailer_id, product_id, color_id, data_hash, status, error, synced_at, updated_at)
  select ca.org_id, ca.id, p_catalog, x.retailer_id, x.product_id, x.color_id, x.hash, x.status, x.error,
         case when x.status in ('SYNCED', 'DELETED') then now() end, now()
  from jsonb_to_recordset(coalesce(p_items, '[]')) as x(retailer_id text, product_id uuid, color_id uuid, hash text, status text, error text)
  where x.retailer_id is not null
  on conflict (channel_account_id, catalog_id, retailer_id) do update
    set product_id = coalesce(excluded.product_id, t.product_id), color_id = coalesce(excluded.color_id, t.color_id),
        data_hash = case when excluded.status = 'SYNCED' then excluded.data_hash else t.data_hash end,
        status = excluded.status, error = excluded.error, synced_at = coalesce(excluded.synced_at, t.synced_at), updated_at = now();
  update omni.channel_accounts set meta_catalog_sync = coalesce(p_summary, '{}') || jsonb_build_object('at', now(), 'catalog_id', p_catalog)
  where id = ca.id;
end $$;

-- Produtos citados (links de foto do catálogo) num texto, com o retailer_id quando o item está no catálogo da Meta do canal
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
           'retailer_id', mi.retailer_id)) order by h.ord), '[]')
  from hits h
  cross join ca
  join catalog.products p on p.id = h.product_id
  left join catalog.colors col on col.id = h.color_id
  left join lateral (select i.retailer_id from omni.meta_catalog_items i
                     where i.channel_account_id = ca.id and i.catalog_id = ca.meta_catalog_id and i.product_id = h.product_id and i.status = 'SYNCED'
                     order by (i.color_id is not distinct from h.color_id) desc, i.retailer_id limit 1) mi on true
$$;

-- Worker (envio): modo do canal, catálogo e os produtos do texto da mensagem
create or replace function omni.message_products(p_message uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare m omni.messages; ca omni.channel_accounts;
begin
  select * into m from omni.messages where id = p_message;
  if m.id is null then return jsonb_build_object('found', false); end if;
  select * into ca from omni.channel_accounts where id = m.channel_account_id;
  return jsonb_build_object('found', true, 'mode', ca.product_send_mode, 'catalog_id', ca.meta_catalog_id,
                            'products', private.text_products(ca.id, m.body));
end $$;

-- Inbox (rascunho do copiloto): os cartões que sairiam com este texto
create or replace function omni.text_products(p_conversation uuid, p_text text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare cv omni.conversations; ca omni.channel_accounts; v_products jsonb;
begin
  perform private.require_perm('omni.read');
  select * into cv from omni.conversations where id = p_conversation;
  if cv.id is null or (coalesce(auth.role(), '') = 'authenticated' and cv.org_id <> private.org_id()) then
    raise exception 'Conversa não encontrada' using errcode = 'P0002';
  end if;
  select * into ca from omni.channel_accounts where id = cv.channel_account_id;
  v_products := private.text_products(ca.id, p_text);
  return jsonb_build_object('channel', ca.channel, 'mode', ca.product_send_mode, 'catalog_ready', ca.meta_catalog_id is not null,
                            'native', ca.channel = 'WHATSAPP' and ca.product_send_mode = 'NATIVE_CATALOG' and ca.meta_catalog_id is not null,
                            'products', (select coalesce(jsonb_agg(x || jsonb_build_object('photo', x ->> 'url')), '[]') from jsonb_array_elements(v_products) x));
end $$;

-- Carrinho enviado pela cliente pelo catálogo (mensagem `order` do webhook) → texto legível para a inbox e para a IA
create or replace function omni.describe_order(p_provider_account text, p_order jsonb)
returns text language sql stable security definer set search_path = '' as $$
  with ca as (select * from omni.channel_accounts where channel = 'WHATSAPP' and provider_account_id = p_provider_account limit 1),
  it as (
    select x.ord, x.e ->> 'product_retailer_id' as rid, coalesce((x.e ->> 'quantity')::numeric, 1) as qty, (x.e ->> 'item_price')::numeric as price
    from jsonb_array_elements(coalesce(p_order -> 'product_items', '[]')) with ordinality as x(e, ord)
  ), named as (
    select it.*, coalesce((select p.name || coalesce(' (' || col.name || ')', '')
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

-- Configuração na tela do canal
create or replace function omni.set_product_settings(p_id uuid, p jsonb)
returns omni.channel_accounts language plpgsql security definer set search_path = '' as $$
declare ca omni.channel_accounts; v_mode text := coalesce(nullif(p ->> 'product_send_mode', ''), 'NATIVE_CATALOG');
        v_catalog text := nullif(regexp_replace(coalesce(p ->> 'meta_catalog_id', ''), '\s', '', 'g'), '');
begin
  perform private.require_perm('core.admin');
  if v_mode not in ('NATIVE_CATALOG', 'DIRECT') then raise exception 'Modo de envio inválido' using errcode = '22023'; end if;
  if v_catalog is not null and v_catalog !~ '^[0-9]{5,25}$' then
    raise exception 'O ID do catálogo é só números (Commerce Manager › Configurações do catálogo)' using errcode = '22023';
  end if;
  update omni.channel_accounts set product_send_mode = v_mode, meta_catalog_id = v_catalog,
         meta_catalog_sync = case when meta_catalog_id is distinct from v_catalog then '{}' else meta_catalog_sync end
  where id = p_id and org_id = private.org_id() returning * into ca;
  if ca.id is null then raise exception 'Canal não encontrado' using errcode = 'P0322'; end if;
  if ca.channel = 'WHATSAPP' and ca.meta_catalog_id is not null then
    perform private.enqueue('catalog_sync', jsonb_build_object('org_id', ca.org_id, 'kind', 'META', 'channel_account_id', ca.id));
  end if;
  return ca;
end $$;

create or replace function omni.request_meta_catalog_sync(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare ca omni.channel_accounts;
begin
  perform private.require_perm('core.admin');
  select * into ca from omni.channel_accounts where id = p_id and org_id = private.org_id();
  if ca.id is null then raise exception 'Canal não encontrado' using errcode = 'P0322'; end if;
  if ca.meta_catalog_id is null then raise exception 'Informe o ID do catálogo da Meta antes de sincronizar' using errcode = '22023'; end if;
  perform private.enqueue('catalog_sync', jsonb_build_object('org_id', ca.org_id, 'kind', 'META', 'channel_account_id', ca.id));
end $$;

-- Agendamento: estoque e preço mudam ao longo do dia; o worker só manda à Meta o que mudou (hash por item)
create or replace function private.enqueue_meta_catalog_sync()
returns integer language plpgsql security definer set search_path = '' as $$
declare r record; n int := 0;
begin
  for r in select id, org_id from omni.channel_accounts where channel = 'WHATSAPP' and status = 'ACTIVE' and meta_catalog_id is not null loop
    perform private.enqueue('catalog_sync', jsonb_build_object('org_id', r.org_id, 'kind', 'META', 'channel_account_id', r.id));
    n := n + 1;
  end loop;
  return n;
end $$;

do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'centralops-meta-catalog';
  perform cron.schedule('centralops-meta-catalog', '15 */2 * * *', $c$select private.enqueue_meta_catalog_sync()$c$);
end $$;

insert into private.internal_functions (fqname) values
  ('omni.meta_catalog_feed'), ('omni.meta_catalog_record'), ('omni.message_products'), ('omni.describe_order'),
  ('private.text_products'), ('private.enqueue_meta_catalog_sync')
on conflict do nothing;
select private.lock_functions();
