-- =====================================================================
-- Atendimento (IA das clientes) em dia com o catálogo do site, as encomendas e o horário das lojas
--  • search_catalog: procura também em categoria, linha, descrição, composição e etiquetas do site; devolve foto, linha, composição,
--    aviso de modelagem e se a peça pode ser encomendada. "Só com estoque" passa a aceitar a peça encomendável (dizendo qual é o caso).
--  • check_stock_by_size: cada variação diz se pode ser encomendada quando não há estoque.
--  • get_product_details (nova): descrição, composição, cuidados, modelagem, guia de tamanhos em texto e fotos por cor.
--  • get_store_info (nova): endereço, horário dos próximos 7 dias, exceções dos próximos 14 e se está aberta agora.
--  • get_order_status: situação do pedido também em texto para a cliente.
--  • core.stores.address: endereço da loja para as clientes (o da empresa é o endereço fiscal, não o da loja).
--  • Foto: enquanto o bucket não tem endereço público (core.settings 'catalog_media'.public_base_url), a IA recebe o link de origem do site.
-- O preço "de/por" do site NÃO vai para a IA das clientes (decisão pendente dos sócios).
-- =====================================================================

alter table core.stores add column if not exists address jsonb not null default '{}';

insert into core.settings (org_id, key, value)
select id, 'catalog_media', '{"public_base_url": null}'::jsonb from core.orgs
on conflict (org_id, key) do nothing;

-- ---------------------------------------------------------------------
-- Utilitários
-- ---------------------------------------------------------------------
-- HTML simples (textos e tabela de medidas do site) → texto; tabela vira linhas "| a | b |"
create or replace function private.html_text(p_html text) returns text
language plpgsql immutable set search_path = '' as $$
declare s text := coalesce(p_html, ''); e text[]; pair text[];
begin
  if s = '' then return null; end if;
  s := regexp_replace(s, '\s+', ' ', 'g');
  s := regexp_replace(s, '</p>\s*(?=</t[dh]>)', '', 'gi');                 -- parágrafo dentro da célula não quebra a linha da tabela
  s := regexp_replace(s, '<t[dh][^>]*>\s*', '', 'gi');
  s := regexp_replace(s, '\s*</t[dh]>', ' | ', 'gi');
  s := regexp_replace(s, '<tr[^>]*>\s*', E'\n| ', 'gi');
  s := regexp_replace(s, '</tr>|</table>', E'\n', 'gi');
  s := regexp_replace(s, '<br\s*/?>|</p>|</li>|</h[1-6]>|</div>', E'\n', 'gi');
  s := regexp_replace(s, '<li[^>]*>', '- ', 'gi');
  s := regexp_replace(s, '<[^>]+>', '', 'g');
  foreach e slice 1 in array array[
    ['&nbsp;', ' '], ['&amp;', '&'], ['&quot;', '"'], ['&#39;', ''''], ['&lt;', '<'], ['&gt;', '>'], ['&ordm;', 'º'], ['&ordf;', 'ª'],
    ['&aacute;', 'á'], ['&eacute;', 'é'], ['&iacute;', 'í'], ['&oacute;', 'ó'], ['&uacute;', 'ú'], ['&Aacute;', 'Á'], ['&Eacute;', 'É'], ['&Iacute;', 'Í'],
    ['&Oacute;', 'Ó'], ['&Uacute;', 'Ú'], ['&atilde;', 'ã'], ['&otilde;', 'õ'], ['&Atilde;', 'Ã'], ['&Otilde;', 'Õ'], ['&acirc;', 'â'], ['&ecirc;', 'ê'],
    ['&ocirc;', 'ô'], ['&Acirc;', 'Â'], ['&Ecirc;', 'Ê'], ['&Ocirc;', 'Ô'], ['&agrave;', 'à'], ['&Agrave;', 'À'], ['&ccedil;', 'ç'], ['&Ccedil;', 'Ç'], ['&uuml;', 'ü']] loop
    s := replace(s, e[1], e[2]);
  end loop;
  s := regexp_replace(s, '[ \t]+', ' ', 'g');
  s := regexp_replace(s, ' *\n *', E'\n', 'g');
  s := regexp_replace(s, '\| *\n', E'|\n', 'g');
  s := regexp_replace(s, '\|\n\n+\|', E'|\n|', 'g');                       -- linhas da tabela sem linha em branco entre elas
  s := regexp_replace(s, '\n{3,}', E'\n\n', 'g');
  return nullif(trim(both E' \n' from s), '');
end $$;

create or replace function private.sort_sizes(p text[]) returns text[]
language sql immutable set search_path = '' as $$
  select coalesce(array_agg(s order by coalesce(array_position(array['RN', 'PP', 'P', 'M', 'G', 'GG', 'XG', 'XGG', 'EG', 'EGG', 'G1', 'G2', 'G3', 'U', 'UN'], s), 50),
                                     case when s ~ '^[0-9]+$' then s::int end, s), '{}')
  from (select distinct s from unnest(p) s where s is not null) x
$$;

-- Endereço da foto para fora do sistema: bucket público se configurado; senão, o link de origem (site da marca)
create or replace function private.catalog_photo_url(p_org uuid, p_path text, p_source text) returns text
language sql stable security definer set search_path = '' as $$
  select case when p_path like 'http%' then p_path
              when nullif(s.value ->> 'public_base_url', '') is not null
                then rtrim(s.value ->> 'public_base_url', '/') || '/storage/v1/object/public/catalog-media/' || p_path
              else p_source end
  from (select 1) x left join core.settings s on s.org_id = p_org and s.key = 'catalog_media'
$$;

create or replace function private.order_status_label(p text) returns text
language sql immutable set search_path = '' as $$
  select case p
    when 'DRAFT' then 'em montagem' when 'CONFIRMED' then 'confirmado' when 'PENDING_PAYMENT' then 'aguardando pagamento'
    when 'PAID' then 'pago, em separação' when 'FULFILLING' then 'em separação' when 'READY_FOR_PICKUP' then 'pronto para retirar'
    when 'SHIPPED' then 'enviado' when 'COMPLETED' then 'concluído' when 'CANCELLED' then 'cancelado'
    when 'PARTIALLY_RETURNED' then 'com troca/devolução de parte das peças' when 'RETURNED' then 'devolvido' else lower(p) end
$$;

-- ---------------------------------------------------------------------
-- search_catalog
-- ---------------------------------------------------------------------
create or replace function agent.t_search_catalog(c omni.conversations, a jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_store uuid; v_q text := private.norm(coalesce(a ->> 'query', '')); v_tokens text[]; v_in_stock boolean := coalesce((a ->> 'in_stock_only')::boolean, true);
  v_max numeric := (a ->> 'price_max')::numeric; v_color text := nullif(regexp_replace(private.norm(coalesce(a ->> 'color', '')), '(as|os|es|a|o|e|s)$', ''), '');
  v_cat text := nullif(private.norm(coalesce(a ->> 'category', '')), ''); v_out jsonb;
begin
  select ca.store_id into v_store from omni.channel_accounts ca where ca.id = c.channel_account_id;
  v_tokens := array(select '%' || case when length(t) >= 5 then regexp_replace(t, '(as|os|es|a|o|e|s)$', '') else t end || '%' from unnest(regexp_split_to_array(v_q, '\s+')) t
                    where length(t) >= 2 and t <> all (array['de', 'da', 'do', 'das', 'dos', 'com', 'para', 'pra', 'um', 'uma', 'que', 'tem', 'em', 'no', 'na', 'nos', 'nas', 'os', 'as']));
  with base as (
    select p.id, p.name, p.reference_code, p.gender, p.backorder, p.composition, nullif(p.custom_fields -> 'site' ->> 'fit', '') as fit_note,
           cat.name as category, coll.name as line,
           private.norm(p.name || ' ' || p.reference_code || ' ' || coalesce(cat.name, '')) as key_main,
           private.norm(coalesce(coll.name, '') || ' ' || coalesce(p.description, '') || ' ' || coalesce(p.composition, '') || ' ' ||
                        coalesce((select string_agg(t, ' ') from jsonb_array_elements_text(case when jsonb_typeof(p.custom_fields -> 'site' -> 'tags') = 'array'
                                                                                              then p.custom_fields -> 'site' -> 'tags' else '[]' end) t), '')) as key_more
    from catalog.products p
    left join catalog.categories cat on cat.id = p.category_id
    left join catalog.collections coll on coll.id = p.collection_id
    where p.org_id = c.org_id and p.status = 'ACTIVE' and p.product_kind = 'GOODS'
      and (v_cat is null or private.norm(coalesce(cat.name, '')) like '%' || v_cat || '%' or private.norm(coalesce(coll.name, '')) like '%' || v_cat || '%')
  ), vars as (
    select b.*, v.size, col.name as color, st.avail, catalog.current_price(v.id) as price,
           (cardinality(v_tokens) = 0 or (b.key_main || ' ' || private.norm(coalesce(col.name, ''))) like all (v_tokens)) as main_hit
    from base b
    join catalog.variants v on v.product_id = b.id and v.active
    left join catalog.colors col on col.id = v.color_id
    left join lateral (select coalesce(sum(sl.available), 0) as avail from inv.stock_levels sl join inv.locations l on l.id = sl.location_id and l.is_sellable
                       and (v_store is null or l.store_id = v_store) where sl.variant_id = v.id) st on true
    where (v_color is null or private.norm(coalesce(col.name, '')) like '%' || v_color || '%')
      and (cardinality(v_tokens) = 0 or (b.key_main || ' ' || private.norm(coalesce(col.name, '')) || ' ' || b.key_more) like all (v_tokens))
  ), agg as (
    select id, name, reference_code, gender, backorder, composition, fit_note, category, line, bool_or(main_hit) as main_hit,
           min(price) as price, coalesce(sum(avail), 0) as total,
           private.sort_sizes(array_agg(size) filter (where avail > 0)) as sizes_in_stock,
           coalesce(array_agg(distinct color) filter (where avail > 0 and color is not null), '{}') as colors_in_stock,
           case when backorder then private.sort_sizes(array_agg(size) filter (where avail <= 0)) else '{}' end as sizes_backorder,
           case when backorder then coalesce(array_agg(distinct color) filter (where color is not null), '{}') else '{}' end as colors_all
    from vars
    group by id, name, reference_code, gender, backorder, composition, fit_note, category, line
    having (not v_in_stock or coalesce(sum(avail), 0) > 0 or backorder) and (v_max is null or min(price) <= v_max)
    order by bool_or(main_hit) desc, (coalesce(sum(avail), 0) > 0) desc, coalesce(sum(avail), 0) desc, name
    limit 8
  )
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'product_id', g.id, 'name', g.name, 'reference', g.reference_code, 'gender', g.gender, 'category', g.category, 'line', g.line,
           'price', g.price, 'composition', g.composition, 'fit_note', g.fit_note,
           'availability', case when g.total > 0 then 'IN_STOCK' when g.backorder then 'BACKORDER' else 'OUT_OF_STOCK' end,
           'colors', g.colors_in_stock, 'sizes_in_stock', g.sizes_in_stock, 'total_available', g.total,
           'backorder_sizes', case when g.backorder then to_jsonb(g.sizes_backorder) end,
           'backorder_colors', case when g.backorder then to_jsonb(g.colors_all) end,
           'photo', (select private.catalog_photo_url(c.org_id, m.storage_path, m.source_url)
                     from catalog.product_media m left join catalog.colors mc on mc.id = m.color_id
                     where m.product_id = g.id
                     order by (v_color is not null and private.norm(coalesce(mc.name, '')) like '%' || v_color || '%') desc,
                              (mc.name = any (g.colors_in_stock)) desc nulls last, m.position limit 1)))), '[]') into v_out
  from agg g;
  return jsonb_strip_nulls(jsonb_build_object('ok', true, 'products', v_out,
    'hint', case when v_out @? '$[*] ? (@.availability == "BACKORDER")'
                 then 'Peça BACKORDER: sem estoque na loja, mas pode ser encomendada. Ofereça a encomenda e, se a cliente quiser, transfira com request_handoff (BACKORDER) informando modelo, cor e tamanho. Não prometa prazo.' end));
end $$;

-- ---------------------------------------------------------------------
-- check_stock_by_size
-- ---------------------------------------------------------------------
create or replace function agent.t_check_stock(c omni.conversations, a jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_store uuid; v_out jsonb;
begin
  select ca.store_id into v_store from omni.channel_accounts ca where ca.id = c.channel_account_id;
  select coalesce(jsonb_agg(jsonb_build_object('variant_id', v.id, 'sku', v.sku, 'size', v.size, 'color', col.name, 'available', st.avail, 'price', catalog.current_price(v.id),
                                               'backorder_ok', p.backorder and st.avail <= 0)
                            order by col.name, coalesce(array_position(array['PP', 'P', 'M', 'G', 'GG', 'XG'], v.size), 50), v.size), '[]') into v_out
  from catalog.variants v
  join catalog.products p on p.id = v.product_id
  left join catalog.colors col on col.id = v.color_id
  left join lateral (select coalesce(sum(sl.available), 0) as avail from inv.stock_levels sl join inv.locations l on l.id = sl.location_id and l.is_sellable
                     and (v_store is null or l.store_id = v_store) where sl.variant_id = v.id) st on true
  where v.org_id = c.org_id and v.active
    and (v.product_id = nullif(a ->> 'product_id', '')::uuid or v.id = nullif(a ->> 'variant_id', '')::uuid or v.sku = upper(nullif(a ->> 'sku', '')))
    and ((a ->> 'color') is null or private.norm(col.name) like '%' || regexp_replace(private.norm(a ->> 'color'), '(as|os|es|a|o|e|s)$', '') || '%');
  if v_out = '[]' then return jsonb_build_object('ok', false, 'error', 'Produto não encontrado', 'code', 'NOT_FOUND'); end if;
  return jsonb_build_object('ok', true, 'variants', v_out);
end $$;

-- ---------------------------------------------------------------------
-- get_product_details (nova)
-- ---------------------------------------------------------------------
create or replace function agent.t_product_details(c omni.conversations, a jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare p catalog.products; v_out jsonb; v_store uuid; v_stock jsonb;
begin
  select * into p from catalog.products where id = nullif(a ->> 'product_id', '')::uuid and org_id = c.org_id and status = 'ACTIVE';
  if p.id is null then return jsonb_build_object('ok', false, 'error', 'Produto não encontrado', 'code', 'NOT_FOUND'); end if;
  select ca.store_id into v_store from omni.channel_accounts ca where ca.id = c.channel_account_id;
  -- tamanhos com estoque por cor (o "tem?" da cliente costuma vir junto da pergunta de detalhe)
  select jsonb_object_agg(x.color, x.sizes) into v_stock from (
    select coalesce(col.name, 'Única') as color, to_jsonb(private.sort_sizes(array_agg(v.size))) as sizes
    from catalog.variants v left join catalog.colors col on col.id = v.color_id
    where v.product_id = p.id and v.active
      and (select coalesce(sum(sl.available), 0) from inv.stock_levels sl join inv.locations l on l.id = sl.location_id and l.is_sellable
           and (v_store is null or l.store_id = v_store) where sl.variant_id = v.id) > 0
    group by coalesce(col.name, 'Única')) x;
  select jsonb_strip_nulls(jsonb_build_object(
    'product_id', p.id, 'name', p.name, 'reference', p.reference_code, 'gender', p.gender,
    'category', (select name from catalog.categories where id = p.category_id), 'line', (select name from catalog.collections where id = p.collection_id),
    'description', private.html_text(p.description), 'composition', p.composition, 'care', private.html_text(p.care),
    'fit_note', nullif(p.custom_fields -> 'site' ->> 'fit', ''), 'backorder', p.backorder, 'sizes_in_stock_by_color', coalesce(v_stock, '{}'),
    'size_guide', (select private.html_text(sc.measurements ->> 'html') from catalog.size_charts sc where sc.id = p.size_chart_id),
    'photos', (select jsonb_object_agg(coalesce(x.color, 'Única'), x.urls) from (
                 select mc.name as color, (array_agg(private.catalog_photo_url(c.org_id, m.storage_path, m.source_url) order by m.position))[1:3] as urls
                 from catalog.product_media m left join catalog.colors mc on mc.id = m.color_id where m.product_id = p.id group by mc.name) x)))
  into v_out;
  return jsonb_build_object('ok', true, 'product', v_out,
    'hint', 'Responda só com o que está aqui; sem cuidados cadastrados, consulte search_knowledge ou diga que vai confirmar.');
end $$;

-- ---------------------------------------------------------------------
-- get_store_info (nova)
-- ---------------------------------------------------------------------
create or replace function private.store_public_info(p_store uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s core.stores; d date := private.today_sp(); k int; days jsonb := '[]'; exc jsonb; iv jsonb; v_open boolean; v_conf boolean;
begin
  select * into s from core.stores where id = p_store;
  v_conf := private.store_hours_configured(s.id);
  if v_conf then
    for k in 0..6 loop
      select coalesce(jsonb_agg(to_char(i.s at time zone 'America/Sao_Paulo', 'HH24:MI') || '–' || to_char(i.e at time zone 'America/Sao_Paulo', 'HH24:MI') order by i.s), '[]')
        into iv from private.store_intervals(s.id, d + k) i;
      days := days || jsonb_build_object('date', d + k, 'weekday', (array['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'])[extract(dow from d + k)::int + 1],
                                         'hours', case when jsonb_array_length(iv) = 0 then to_jsonb('fechada'::text) else iv end);
    end loop;
    select exists (select 1 from private.store_intervals(s.id, d) i where now() >= i.s and now() < i.e) into v_open;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('date', x.day, 'closed', x.closed, 'note', x.note,
                                               'hours', case when x.closed then null else x.hours end) order by x.day), '[]')
    into exc from core.store_hours_exceptions x where x.store_id = s.id and x.day between d and d + 14;
  return jsonb_strip_nulls(jsonb_build_object(
    'store_id', s.id, 'name', s.name,
    'address', case when s.address <> '{}' then s.address end,
    'hours_configured', v_conf, 'open_now', v_open, 'next_7_days', case when v_conf then days end,
    'exceptions_next_14_days', case when exc <> '[]' then exc end));
end $$;

create or replace function agent.t_store_info(c omni.conversations, a jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_store uuid; v_out jsonb;
begin
  select ca.store_id into v_store from omni.channel_accounts ca where ca.id = c.channel_account_id;
  select coalesce(jsonb_agg(private.store_public_info(s.id) order by s.name), '[]') into v_out
  from core.stores s where s.org_id = c.org_id and s.status = 'ACTIVE' and (v_store is null or s.id = v_store);
  if v_out = '[]' then return jsonb_build_object('ok', false, 'error', 'Nenhuma loja aberta cadastrada: transfira para uma pessoa', 'code', 'NOT_FOUND'); end if;
  return jsonb_strip_nulls(jsonb_build_object('ok', true, 'stores', v_out,
    'hint', case when v_out @? '$[*] ? (@.hours_configured == false)' or not (v_out @? '$[*].address')
                 then 'O que não veio aqui (horário ou endereço) ainda não está cadastrado: diga que vai confirmar com a equipe, sem inventar.' end));
end $$;

-- ---------------------------------------------------------------------
-- get_order_status: situação também em texto
-- ---------------------------------------------------------------------
create or replace function agent.t_order_status(c omni.conversations, a jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_out jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object('number', o.number, 'status', o.status, 'status_text', private.order_status_label(o.status::text),
      'total', o.total, 'paid', o.paid_total, 'fulfillment', o.fulfillment_type,
      'date', (o.created_at at time zone 'America/Sao_Paulo')::date,
      'backorder_items', (select nullif(count(*), 0) from sales.backorder_items b where b.order_id = o.id and b.status = 'OPEN'),
      'shipment', (select jsonb_build_object('carrier', s.carrier, 'tracking', s.tracking, 'status', s.status) from sales.shipments s where s.order_id = o.id order by s.created_at desc limit 1))
      order by o.created_at desc), '[]') into v_out
  from (select * from sales.orders where party_id = c.party_id and status <> 'DRAFT' and ((a ->> 'number') is null or upper(number) = upper(a ->> 'number')) order by created_at desc limit 3) o;
  if v_out = '[]' then return jsonb_build_object('ok', false, 'error', 'Nenhum pedido encontrado para esta cliente', 'code', 'NOT_FOUND'); end if;
  return jsonb_build_object('ok', true, 'orders', v_out) ||
    case when v_out @? '$[*] ? (@.backorder_items > 0)' then jsonb_build_object('hint', 'backorder_items: peças encomendadas que ainda não chegaram (não prometa data).') else '{}' end;
end $$;

-- ---------------------------------------------------------------------
-- Endereço da loja (Configurações › Lojas)
-- ---------------------------------------------------------------------
create or replace function core.set_store_address(p_store uuid, p jsonb) returns core.stores
language plpgsql security definer set search_path = '' as $$
declare s core.stores; v jsonb := '{}'; k text;
begin
  perform private.require_perm('core.admin');
  foreach k in array array['street', 'number', 'complement', 'district', 'city', 'uf', 'cep', 'reference'] loop
    if nullif(trim(coalesce(p ->> k, '')), '') is not null then v := v || jsonb_build_object(k, left(trim(p ->> k), 120)); end if;
  end loop;
  update core.stores set address = v where id = p_store and org_id = private.org_id() returning * into s;
  if s.id is null then raise exception 'Loja não encontrada' using errcode = 'P0501'; end if;
  return s;
end $$;

-- ---------------------------------------------------------------------
-- Roteamento das ferramentas
-- ---------------------------------------------------------------------
create or replace function agent.call_tool(p_ctx jsonb, p_tool text, p_args jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c omni.conversations; v_t0 timestamptz := clock_timestamp(); v_res jsonb; v_run uuid := nullif(p_ctx ->> 'run', '')::uuid; v_args jsonb := coalesce(p_args, '{}');
begin
  c := agent.ctx_conversation(p_ctx);
  if jsonb_typeof(p_ctx -> 'caps') <> 'array' or not (p_ctx -> 'caps') ? p_tool then
    raise exception 'Ferramenta % não permitida neste contexto', p_tool using errcode = '42501';
  end if;
  -- IDs de cliente/organização/conversa vindos do modelo são descartados: vale só o do ctx
  v_args := v_args - 'party_id' - 'org_id' - 'conversation_id' - 'party' - 'org' - 'conv';
  begin
    v_res := case p_tool
      when 'search_catalog' then agent.t_search_catalog(c, v_args)
      when 'check_stock_by_size' then agent.t_check_stock(c, v_args)
      when 'get_product_details' then agent.t_product_details(c, v_args)
      when 'get_store_info' then agent.t_store_info(c, v_args)
      when 'get_customer_360' then agent.t_customer_360(c, v_args)
      when 'get_order_status' then agent.t_order_status(c, v_args)
      when 'get_policies' then agent.t_get_policies(c, v_args)
      when 'search_knowledge' then agent.t_search_knowledge(c, v_args)
      when 'list_upcoming_events' then agent.t_list_upcoming_events(c, v_args)
      when 'rsvp_event' then agent.t_rsvp_event(c, v_args)
      when 'register_interest' then agent.t_register_interest(c, v_args)
      when 'apply_coupon' then agent.t_apply_coupon(c, v_args)
      when 'create_reservation' then agent.t_create_reservation(c, v_args)
      when 'schedule_locker' then agent.t_schedule_locker(c, v_args)
      when 'create_order_draft' then agent.t_create_order_draft(c, v_args || jsonb_build_object('_run', coalesce(v_run::text, 'x')))
      when 'confirm_order_draft' then agent.t_confirm_order_draft(c, v_args)
      when 'create_payment_link' then agent.t_create_payment_link(c, v_args)
      when 'register_consent' then agent.t_register_consent(c, v_args)
      when 'update_customer_profile' then agent.t_update_profile(c, v_args)
      when 'remember_customer_fact' then agent.t_remember_fact(c, v_args)
      when 'request_handoff' then agent.t_request_handoff(p_ctx, c, v_args)
      when 'propose_reply' then agent.t_propose_reply(c, v_args)
      else jsonb_build_object('ok', false, 'error', 'Ferramenta desconhecida: ' || p_tool, 'code', 'UNKNOWN_TOOL')
    end;
  exception when others then
    v_res := jsonb_build_object('ok', false, 'error', sqlerrm, 'code', sqlstate);
  end;
  if v_run is not null and exists (select 1 from ai.runs where id = v_run and org_id = c.org_id) then
    insert into ai.tool_calls (run_id, tool, args, result_digest, ok, ms)
    values (v_run, p_tool, v_args, v_res, coalesce((v_res ->> 'ok')::boolean, false), (extract(epoch from clock_timestamp() - v_t0) * 1000)::int);
  end if;
  return v_res;
end $$;

revoke execute on function agent.t_product_details(omni.conversations, jsonb), agent.t_store_info(omni.conversations, jsonb),
                           agent.t_search_catalog(omni.conversations, jsonb), agent.t_check_stock(omni.conversations, jsonb),
                           agent.t_order_status(omni.conversations, jsonb) from public, anon, authenticated;
grant execute on function agent.t_product_details(omni.conversations, jsonb), agent.t_store_info(omni.conversations, jsonb),
                          agent.t_search_catalog(omni.conversations, jsonb), agent.t_check_stock(omni.conversations, jsonb),
                          agent.t_order_status(omni.conversations, jsonb) to agent_rpc, service_role;

insert into private.internal_functions (fqname) values
  ('private.store_public_info'), ('private.catalog_photo_url')
on conflict do nothing;
select private.lock_functions();
