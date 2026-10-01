-- =====================================================================
-- Retenção (plano de marketing e atendimento, Fase 3):
-- • Níveis com benefícios (core.settings 'tier_benefits'): o que cada nível ganha, mostrado na ficha e para a IA.
-- • Pré-venda VIP de drops: o evento ganha a data da pré-venda e da abertura ao público; um clique convida as VIPs.
-- • "Para ela agora": novidades no tamanho dela, peças que combinam com a última compra, reservas, vale-troca,
--   aniversário e convites — no painel da conversa e na ficha.
-- Códigos de erro: P0370 dado inválido · P0371 situação não permite · P0372 não encontrado.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Benefícios por nível
-- ---------------------------------------------------------------------
create or replace function private.tier_benefits(p_org uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'STANDARD', jsonb_build_array('Avise-me quando chegar o tamanho', 'Convite para os eventos abertos', 'Mimo de aniversário'),
    'VIP', jsonb_build_array('Pré-venda dos drops 48 h antes', 'Provador ou Armário VIP reservado', 'Convite para eventos fechados', 'Mimo de aniversário'),
    'VIP_BLACK', jsonb_build_array('Tudo do VIP', 'Atendimento direto da sócia', 'Peças separadas antes do lançamento'))
    || coalesce((select value from core.settings where org_id = p_org and key = 'tier_benefits'), '{}')
$$;

create or replace function crm.save_tier_benefits(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); k text; c jsonb := '{}';
begin
  perform private.require_perm('core.admin');
  for k in select unnest(array['STANDARD', 'VIP', 'VIP_BLACK']) loop
    if p ? k then
      if jsonb_typeof(p -> k) <> 'array' or jsonb_array_length(p -> k) > 8 then raise exception 'Até 8 benefícios por nível' using errcode = 'P0370'; end if;
      c := c || jsonb_build_object(k, (select coalesce(jsonb_agg(left(trim(x), 120)), '[]') from jsonb_array_elements_text(p -> k) x where trim(x) <> ''));
    end if;
  end loop;
  insert into core.settings (org_id, key, value) values (v_org, 'tier_benefits', c) on conflict (org_id, key) do update set value = core.settings.value || excluded.value;
  return private.tier_benefits(v_org);
end $$;

create or replace function crm.tier_benefits() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_perm('crm.read');
  return private.tier_benefits(private.org_id());
end $$;

-- ---------------------------------------------------------------------
-- 2) Pré-venda VIP
-- ---------------------------------------------------------------------
alter table mkt.events add column if not exists presale_starts_at timestamptz;
alter table mkt.events add column if not exists public_starts_at timestamptz;

create or replace function mkt.set_event_presale(p_event uuid, p_presale timestamptz, p_public timestamptz) returns mkt.events
language plpgsql security definer set search_path = '' as $$
declare e mkt.events;
begin
  perform private.require_perm('crm.write');
  if p_presale is not null and p_public is not null and p_public <= p_presale then raise exception 'A abertura ao público vem depois da pré-venda' using errcode = 'P0370'; end if;
  update mkt.events set presale_starts_at = p_presale, public_starts_at = p_public where id = p_event and org_id = private.org_id() returning * into e;
  if e.id is null then raise exception 'Evento não encontrado' using errcode = 'P0372'; end if;
  return e;
end $$;

-- Convida as VIP e VIP Black (até 200, pelas de maior gasto) — o convite e o RSVP seguem o fluxo normal do evento
create or replace function mkt.invite_vips(p_event uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_ids uuid[];
begin
  perform private.require_perm('crm.write');
  if not exists (select 1 from mkt.events where id = p_event and org_id = private.org_id() and status in ('PLANNED', 'CONFIRMED')) then
    raise exception 'Evento não encontrado ou encerrado' using errcode = 'P0372';
  end if;
  select array(select p.id from crm.parties p left join crm.customer_metrics m on m.party_id = p.id
               where p.org_id = private.org_id() and p.tier in ('VIP', 'VIP_BLACK') and p.anonymized_at is null and p.merged_into_id is null
                 and not exists (select 1 from mkt.event_guests g where g.event_id = p_event and g.party_id = p.id)
               order by coalesce(m.revenue_12m, 0) desc limit 200) into v_ids;
  if coalesce(cardinality(v_ids), 0) = 0 then raise exception 'Nenhuma VIP para convidar (ou todas já convidadas)' using errcode = 'P0371'; end if;
  return mkt.invite_guests(p_event, v_ids, 'SEGMENT');
end $$;

-- ---------------------------------------------------------------------
-- 3) "Para ela agora"
-- ---------------------------------------------------------------------
create or replace function crm.for_her_now(p_party uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
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
    select va.id as variant_id, va.product_id, upper(va.size) as size, sum(sl.available) as available
    from catalog.variants va join inv.stock_levels sl on sl.variant_id = va.id join inv.locations l on l.id = sl.location_id and l.is_sellable
    where va.org_id = p.org_id and va.active group by 1, 2, 3 having sum(sl.available) > 0
  ), bought as (
    select distinct va.product_id from sales.orders o join sales.order_items oi on oi.order_id = o.id join catalog.variants va on va.id = oi.variant_id
    where o.party_id = p.id and o.status::text = any (v_paid)
  ), arrivals as (
    select distinct on (pr.id) pr.id, pr.name, s.size, catalog.current_price(s.variant_id) as price
    from stock s join catalog.products pr on pr.id = s.product_id and pr.status = 'ACTIVE'
      and (p.gender is null or pr.gender::text in ('UNISSEX', case when p.gender ilike 'f%' then 'FEM' when p.gender ilike 'm%' then 'MASC' end))
    where s.size = any (v_sizes) and pr.id not in (select product_id from bought)
      and exists (select 1 from inv.movements mv join catalog.variants v2 on v2.id = mv.variant_id where v2.product_id = pr.id and mv.movement_type = 'PURCHASE_RECEIPT' and mv.occurred_at > now() - interval '30 days')
    order by pr.id, s.size limit 6
  ), matches as (
    select distinct on (pr.id) pr.id, pr.name, s.size, catalog.current_price(s.variant_id) as price
    from stock s join catalog.products pr on pr.id = s.product_id and pr.status = 'ACTIVE'
      and (p.gender is null or pr.gender::text in ('UNISSEX', case when p.gender ilike 'f%' then 'FEM' when p.gender ilike 'm%' then 'MASC' end))
    where v_last is not null and pr.id <> v_last and pr.id not in (select product_id from bought)
      and (pr.collection_id = v_last_col or (v_last_cat is not null and pr.category_id <> v_last_cat))
      and (cardinality(v_sizes) = 0 or s.size = any (v_sizes))
    order by pr.id, (pr.collection_id = v_last_col) desc, s.size limit 6
  )
  select jsonb_build_object(
    'sizes', to_jsonb(v_sizes),
    'arrivals', coalesce((select jsonb_agg(jsonb_build_object('product_id', id, 'name', name, 'size', size, 'price', price)) from arrivals), '[]'),
    'matches', coalesce((select jsonb_agg(jsonb_build_object('product_id', id, 'name', name, 'size', size, 'price', price)) from matches), '[]'),
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
end $$;

insert into private.internal_functions (fqname) values ('private.tier_benefits') on conflict do nothing;
select private.lock_functions();
