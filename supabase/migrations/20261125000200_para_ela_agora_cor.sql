-- "Para ela agora": cada sugestão leva a cor (para ir ao carrinho da conversa com a peça certa).
CREATE OR REPLACE FUNCTION crm.for_her_now(p_party uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  p crm.parties; v_sizes text[]; v_last uuid; v_last_cat uuid; v_last_col uuid; res jsonb;
  v_paid text[] := array['PAID', 'COMPLETED', 'FULFILLING', 'READY_FOR_PICKUP', 'SHIPPED', 'PARTIALLY_RETURNED'];
begin
  perform private.require_perm('crm.read');
  select * into p from crm.parties where id = p_party and org_id = private.org_id();
  if p.id is null then raise exception 'Pessoa não encontrada' using errcode = 'P0372'; end if;
  v_sizes := array(select distinct upper(v) from jsonb_each_text(p.sizes) x(k, v) where v <> '');
  select pr.id, pr.category_id, pr.collection_id into v_last, v_last_cat, v_last_col
  from sales.orders o join sales.order_items oi on oi.order_id = o.id join catalog.variants va on va.id = oi.variant_id join catalog.products pr on pr.id = va.product_id
  where o.party_id = p.id and o.status::text = any (v_paid) order by o.created_at desc limit 1;

  with stock as (
    select va.id as variant_id, va.product_id, va.color_id, upper(va.size) as size, sum(sl.available) as available
    from catalog.variants va join inv.stock_levels sl on sl.variant_id = va.id join inv.locations l on l.id = sl.location_id and l.is_sellable
    where va.org_id = p.org_id and va.active group by 1, 2, 3, 4 having sum(sl.available) > 0
  ), bought as (
    select distinct va.product_id from sales.orders o join sales.order_items oi on oi.order_id = o.id join catalog.variants va on va.id = oi.variant_id
    where o.party_id = p.id and o.status::text = any (v_paid)
  ), arrivals as (
    select distinct on (pr.id) pr.id, pr.name, s.size, s.color_id, col.name as color, catalog.current_price(s.variant_id) as price
    from stock s left join catalog.colors col on col.id = s.color_id join catalog.products pr on pr.id = s.product_id and pr.status = 'ACTIVE'
      and (p.gender is null or pr.gender::text in ('UNISSEX', case when p.gender ilike 'f%' then 'FEM' when p.gender ilike 'm%' then 'MASC' end))
    where s.size = any (v_sizes) and pr.id not in (select product_id from bought)
      and exists (select 1 from inv.movements mv join catalog.variants v2 on v2.id = mv.variant_id where v2.product_id = pr.id and mv.movement_type = 'PURCHASE_RECEIPT' and mv.occurred_at > now() - interval '30 days')
    order by pr.id, s.size limit 6
  ), matches as (
    select distinct on (pr.id) pr.id, pr.name, s.size, s.color_id, col.name as color, catalog.current_price(s.variant_id) as price
    from stock s left join catalog.colors col on col.id = s.color_id join catalog.products pr on pr.id = s.product_id and pr.status = 'ACTIVE'
      and (p.gender is null or pr.gender::text in ('UNISSEX', case when p.gender ilike 'f%' then 'FEM' when p.gender ilike 'm%' then 'MASC' end))
    where v_last is not null and pr.id <> v_last and pr.id not in (select product_id from bought)
      and (pr.collection_id = v_last_col or (v_last_cat is not null and pr.category_id <> v_last_cat))
      and (cardinality(v_sizes) = 0 or s.size = any (v_sizes))
    order by pr.id, (pr.collection_id = v_last_col) desc, s.size limit 6
  )
  select jsonb_build_object(
    'sizes', to_jsonb(v_sizes),
    'arrivals', coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('product_id', id, 'color_id', color_id, 'color', color, 'name', name, 'size', size, 'price', price))) from arrivals), '[]'),
    'matches', coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('product_id', id, 'color_id', color_id, 'color', color, 'name', name, 'size', size, 'price', price))) from matches), '[]'),
    'last_purchase', (select name from catalog.products where id = v_last),
    'reservations', (select count(*) from inv.reservations r where r.party_id = p.id and r.status = 'ACTIVE'),
    'store_credit', coalesce((select sum(amount) from sales.store_credit_ledger where party_id = p.id and (expires_at is null or expires_at >= private.today_sp())), 0),
    'interest_waiting', (select count(*) from crm.interest_alerts where party_id = p.id and status = 'WAITING'),
    'birthday_in_days', case when p.birth_date is null then null
      else ((make_date(extract(year from private.today_sp())::int, extract(month from p.birth_date)::int, least(extract(day from p.birth_date)::int, 28)) - private.today_sp() + 365) % 365) end,
    'events', coalesce((select jsonb_agg(jsonb_build_object('name', e.name, 'starts_at', e.starts_at, 'rsvp', g.rsvp_status)) from mkt.event_guests g join mkt.events e on e.id = g.event_id
                        where g.party_id = p.id and e.starts_at > now() and e.status in ('PLANNED', 'CONFIRMED')), '[]'),
    'tier', p.tier, 'benefits', private.tier_benefits(p.org_id) -> p.tier::text
  ) into res;
  return res;
end $function$;

select private.lock_functions();
