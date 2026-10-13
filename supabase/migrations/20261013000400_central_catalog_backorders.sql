-- =====================================================================
-- Central (assistente da equipe) em dia com a semana: catálogo do site, encomendas, malinhas, alertas de preço
--  • catalog.search_products: procura também em categoria, linha, descrição e composição; devolve foto, linha, categoria,
--    "aceita encomenda", aviso de modelagem e o preço "de" do site quando a peça está em promoção lá.
--  • Cartões novos: 'encomenda' (sales.create_backorder) e 'malinha' (inv.create_loan), com a mesma confirmação dos outros.
--  • Consultas novas (uma chamada cada): sales.backorder_overview, inv.loans_overview, catalog.recent_price_changes.
--  • Resumo do dia: encomendas que chegaram, malinhas vencidas e preços que mudaram em peça com estoque.
-- =====================================================================

create or replace function catalog.search_products(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id(); v_store uuid := nullif(p ->> 'store_id', '')::uuid; v_code text := upper(trim(coalesce(p ->> 'code', '')));
  v_q text := private.norm(coalesce(p ->> 'query', '')); v_tokens text[]; v_size text := upper(trim(coalesce(p ->> 'size', '')));
  v_color text := regexp_replace(private.norm(coalesce(p ->> 'color', '')), '(as|os|es|a|o|e|s)$', ''); v_out jsonb;
begin
  perform private.require_perm('catalog.read');
  v_tokens := array(select '%' || case when length(t) >= 5 then regexp_replace(t, '(as|os|es|a|o|e|s)$', '') else t end || '%'
                    from unnest(regexp_split_to_array(v_q, '\s+')) t
                    where length(t) >= 2 and t <> all (array['de', 'da', 'do', 'das', 'dos', 'com', 'para', 'pra', 'um', 'uma', 'que', 'tem', 'em', 'no', 'na', 'nos', 'nas', 'os', 'as']));
  if v_code = '' and cardinality(v_tokens) = 0 then return '[]'::jsonb; end if;
  select coalesce(jsonb_agg(x.j order by x.main_hit desc, x.total_available desc, x.name), '[]') into v_out from (
    select p2.name, coalesce(sum(st.avail), 0) as total_available,
           bool_or(cardinality(v_tokens) = 0 or private.norm(p2.name || ' ' || p2.reference_code || ' ' || coalesce(cat.name, '') || ' ' || coalesce(col.name, '')) like all (v_tokens)) as main_hit,
           jsonb_strip_nulls(jsonb_build_object('product_id', p2.id, 'name', p2.name, 'reference', p2.reference_code, 'gender', p2.gender,
             'category', cat.name, 'line', coll.name, 'backorder', p2.backorder, 'fit_note', nullif(p2.custom_fields -> 'site' ->> 'fit', ''),
             'photo', (select jsonb_build_object('path', m.storage_path, 'source', m.source_url) from catalog.product_media m left join catalog.colors mc on mc.id = m.color_id
                       where m.product_id = p2.id order by (v_color <> '' and private.norm(coalesce(mc.name, '')) like '%' || v_color || '%') desc, m.position limit 1),
             'site_compare_at', (select max(si.compare_at_price) from catalog.site_items si where si.product_id = p2.id and si.removed_at is null and si.compare_at_price > si.price),
             'variants', jsonb_agg(jsonb_build_object('variant_id', v.id, 'sku', v.sku, 'gtin', v.gtin, 'size', v.size, 'color', col.name, 'color_id', col.id,
                                                      'price', catalog.current_price(v.id), 'available', st.avail)
                                   order by col.name, coalesce(array_position(array['PP', 'P', 'M', 'G', 'GG', 'XG'], v.size), 50), v.size))) as j
    from catalog.products p2
    join catalog.variants v on v.product_id = p2.id and v.active
    left join catalog.colors col on col.id = v.color_id
    left join catalog.categories cat on cat.id = p2.category_id
    left join catalog.collections coll on coll.id = p2.collection_id
    left join lateral (select coalesce(sum(sl.available), 0) as avail from inv.stock_levels sl join inv.locations l on l.id = sl.location_id and l.is_sellable
                       and (v_store is null or l.store_id = v_store) where sl.variant_id = v.id) st on true
    where p2.org_id = v_org and p2.status <> 'DISCONTINUED'
      and (v_code = '' or v.gtin = v_code or upper(v.sku) = v_code or upper(p2.reference_code) = v_code)
      and (cardinality(v_tokens) = 0 or private.norm(p2.name || ' ' || p2.reference_code || ' ' || coalesce(col.name, '') || ' ' || coalesce(cat.name, '') || ' ' ||
                                                     coalesce(coll.name, '') || ' ' || coalesce(p2.description, '') || ' ' || coalesce(p2.composition, '')) like all (v_tokens))
      and (v_color = '' or private.norm(col.name) like '%' || v_color || '%')
      and (v_size = '' or upper(v.size) = v_size)
    group by p2.id, p2.name, p2.reference_code, p2.gender, p2.backorder, p2.custom_fields, cat.name, coll.name
    order by 3 desc, coalesce(sum(st.avail), 0) desc, p2.name
    limit greatest(1, least(coalesce((p ->> 'limit')::int, 6), 20))) x;
  return v_out;
end $$;

-- ---------------------------------------------------------------------
-- Encomendas: o que está aberto, esperando fornecedor e o que já chegou
-- ---------------------------------------------------------------------
create or replace function sales.backorder_overview(p_limit int default 20) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); v_items jsonb; v_counts jsonb;
begin
  perform private.require_perm('sales.read');
  select jsonb_build_object('open', count(*) filter (where b.status = 'OPEN'),
                            'arrived_waiting', count(*) filter (where b.status = 'ARRIVED' and o.status not in ('COMPLETED', 'CANCELLED', 'RETURNED')),
                            'without_po', count(*) filter (where b.status = 'OPEN' and b.po_id is null))
    into v_counts
  from sales.backorder_items b join sales.orders o on o.id = b.order_id where b.org_id = v_org;
  select coalesce(jsonb_agg(x.j order by x.created_at), '[]') into v_items from (
    select b.created_at, jsonb_strip_nulls(jsonb_build_object(
             'order_id', o.id, 'order_number', o.number, 'customer', pa.display_name, 'party_id', pa.id,
             'item', pr.name || coalesce(' · ' || col.name, '') || ' · ' || v.size, 'qty', b.qty, 'status', b.status,
             'po_number', po.number, 'po_status', po.status, 'days', (private.today_sp() - (b.created_at at time zone 'America/Sao_Paulo')::date),
             'paid', o.paid_total, 'total', o.total)) as j
    from sales.backorder_items b
    join sales.orders o on o.id = b.order_id
    join catalog.variants v on v.id = b.variant_id join catalog.products pr on pr.id = v.product_id
    left join catalog.colors col on col.id = v.color_id
    left join crm.parties pa on pa.id = o.party_id
    left join purch.purchase_orders po on po.id = b.po_id
    where b.org_id = v_org and (b.status = 'OPEN' or (b.status = 'ARRIVED' and o.status not in ('COMPLETED', 'CANCELLED', 'RETURNED')))
    order by b.created_at limit greatest(1, least(p_limit, 100))) x;
  return jsonb_build_object('counts', v_counts, 'items', v_items);
end $$;

-- ---------------------------------------------------------------------
-- Malinhas e peças em campanha abertas
-- ---------------------------------------------------------------------
create or replace function inv.loans_overview(p_kind text default null, p_limit int default 20) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); v_items jsonb;
begin
  perform private.require_perm('sales.read');
  select coalesce(jsonb_agg(x.j order by x.due_at), '[]') into v_items from (
    select l.due_at, jsonb_strip_nulls(jsonb_build_object(
             'loan_id', l.id, 'number', l.number, 'kind', l.kind, 'customer', pa.display_name, 'party_id', pa.id, 'campaign', cp.name, 'purpose', l.purpose,
             'due', (l.due_at at time zone 'America/Sao_Paulo')::date, 'overdue', l.due_at < now(),
             'pieces_out', (select coalesce(sum(i.qty - i.returned - i.sold - i.lost - i.damaged - i.gifted), 0) from inv.loan_items i where i.loan_id = l.id),
             'value_out', (select coalesce(sum((i.qty - i.returned - i.sold - i.lost - i.damaged - i.gifted) * coalesce(i.unit_price, 0)), 0) from inv.loan_items i where i.loan_id = l.id))) as j
    from inv.loans l
    left join crm.parties pa on pa.id = l.party_id
    left join mkt.campaigns cp on cp.id = l.campaign_id
    where l.org_id = v_org and l.status = 'OPEN' and (p_kind is null or l.kind = upper(p_kind))
    order by l.due_at limit greatest(1, least(p_limit, 100))) x;
  return jsonb_build_object('open', (select count(*) from inv.loans where org_id = v_org and status = 'OPEN' and (p_kind is null or kind = upper(p_kind))),
                            'overdue', (select count(*) from inv.loans where org_id = v_org and status = 'OPEN' and due_at < now() and (p_kind is null or kind = upper(p_kind))),
                            'items', v_items);
end $$;

-- ---------------------------------------------------------------------
-- Preços que mudaram (site da marca), as peças com estoque primeiro
-- ---------------------------------------------------------------------
create or replace function catalog.recent_price_changes(p_days int default 7, p_limit int default 30) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); v_out jsonb;
begin
  perform private.require_perm('catalog.read');
  select coalesce(jsonb_agg(x.j order by x.stock desc, x.changed_at desc), '[]') into v_out from (
    select max(pc.in_stock) as stock, max(pc.changed_at) as changed_at,
           jsonb_build_object('product_id', p.id, 'product', p.name, 'reference', p.reference_code, 'old_price', min(pc.old_price), 'new_price', max(pc.new_price),
                              'compare_at', max(pc.compare_at_price), 'in_stock', max(pc.in_stock), 'variants', count(*), 'changed_at', max(pc.changed_at)) as j
    from catalog.price_changes pc join catalog.products p on p.id = pc.product_id
    where pc.org_id = v_org and pc.changed_at >= now() - make_interval(days => greatest(1, least(p_days, 90))) and pc.old_price is not null
    group by p.id, p.name, p.reference_code, pc.old_price, pc.new_price
    order by max(pc.in_stock) desc, max(pc.changed_at) desc limit greatest(1, least(p_limit, 100))) x;
  return v_out;
end $$;

-- ---------------------------------------------------------------------
-- Cartões 'encomenda' e 'malinha'
-- ---------------------------------------------------------------------
create or replace function private.assistant_tool_perm(p_tool text) returns text
language sql immutable as $$
  select case p_tool
    when 'venda_pdv' then 'sales.write' when 'cadastrar_pessoa' then 'crm.write' when 'reserva' then 'sales.write' when 'avise_me' then 'crm.write'
    when 'tarefa' then 'crm.write' when 'preferencias' then 'crm.write' when 'conta_pagar' then 'fin.write' when 'baixa' then 'fin.write'
    when 'abrir_caixa' then 'sales.write' when 'fechar_caixa' then 'sales.write' when 'campanha_rascunho' then 'crm.write'
    when 'encomenda' then 'sales.write' when 'malinha' then 'sales.write' end
$$;

do $x$
declare v_def text; v_old text := $y$  when 'cadastrar_pessoa' then
    v_party := private.assistant_new_party(g);$y$;
begin
  select pg_get_functiondef('private.assistant_dispatch(ai.assistant_actions)'::regprocedure) into v_def;
  if position(v_old in v_def) = 0 then raise exception 'assistant_dispatch mudou: ajuste este patch'; end if;
  v_def := replace(v_def, v_old, $y$  when 'encomenda' then
    o := sales.create_backorder(g || jsonb_build_object('idempotency_key', a.idempotency_key::text));
    return jsonb_build_object('target_type', 'sales.orders', 'target_id', o.id, 'number', o.number, 'total', o.total, 'href', '/vender/pedidos/' || o.id);
  when 'malinha' then
    declare l inv.loans;
    begin
      l := inv.create_loan(g);
      return jsonb_build_object('target_type', 'inv.loans', 'target_id', l.id, 'number', l.number, 'href', '/vender/malinhas');
    end;
$y$ || v_old);
  execute v_def;
end $x$;

-- ---------------------------------------------------------------------
-- Resumo do dia: encomendas que chegaram, malinhas vencidas, preços alterados em peça com estoque
-- ---------------------------------------------------------------------
do $x$
declare v_def text; v_old text := $y$  if private.has_perm('ai.read') then$y$;
begin
  select pg_get_functiondef('ai.daily_briefing()'::regprocedure) into v_def;
  if position(v_old in v_def) = 0 then raise exception 'ai.daily_briefing mudou: ajuste este patch'; end if;
  v_def := replace(v_def, v_old, $y$  if private.has_perm('sales.read') then
    select count(distinct b.order_id) into n from sales.backorder_items b join sales.orders o on o.id = b.order_id
    where b.org_id = v_org and b.status = 'ARRIVED' and o.status not in ('COMPLETED', 'CANCELLED', 'RETURNED');
    if n > 0 then items := items || jsonb_build_object('key', 'encomendas_chegaram', 'count', n, 'tone', 'warning', 'href', '/vender/encomendas'); end if;
    select count(*) into n from sales.backorder_items b where b.org_id = v_org and b.status = 'OPEN' and b.po_id is null;
    if n > 0 then items := items || jsonb_build_object('key', 'encomendas_sem_pedido', 'count', n, 'tone', 'warning', 'href', '/vender/encomendas'); end if;
    select count(*) into n from inv.loans where org_id = v_org and status = 'OPEN' and due_at < now();
    if n > 0 then items := items || jsonb_build_object('key', 'malinhas_vencidas', 'count', n, 'tone', 'danger', 'href', '/vender/malinhas'); end if;
  end if;
  if private.has_perm('catalog.read') then
    select count(distinct product_id) into n from catalog.price_changes where org_id = v_org and in_stock > 0 and old_price is not null and changed_at >= now() - interval '2 days';
    if n > 0 then items := items || jsonb_build_object('key', 'precos_alterados', 'count', n, 'tone', 'warning', 'href', '/produtos/site'); end if;
  end if;

$y$ || v_old);
  execute v_def;
end $x$;

select private.lock_functions();
