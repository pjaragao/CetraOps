-- =====================================================================
-- Marketing › Públicos: segmentos salvos (dinâmicos ou congelados) e o filtro de público v2.
-- crm.audience(jsonb) segue com a mesma assinatura e aceita o JSON antigo; ganhou filtros de compra (RFM), de lead/origem, de relacionamento,
-- de canal alcançável, o bloco "exclude" (mesma forma, tira quem casa) e "segment_id" (parte de outro público salvo).
-- Papéis internos (fornecedora, funcionária, prestadora, transportadora, adquirente, banco), pessoas anonimizadas e mescladas nunca entram.
-- Códigos de erro: P0190 dado inválido · P0191 situação · P0192 não encontrado.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0) Auxiliares
-- ---------------------------------------------------------------------
create or replace function private.paid_order_statuses() returns text[]
language sql immutable as $$ select array['PAID', 'COMPLETED', 'FULFILLING', 'READY_FOR_PICKUP', 'SHIPPED', 'PARTIALLY_RETURNED'] $$;

create or replace function private.jsonb_texts(j jsonb) returns text[]
language sql immutable as $$ select coalesce(array(select jsonb_array_elements_text(case when jsonb_typeof(j) = 'array' then j else '[]'::jsonb end)), '{}') $$;

create or replace function private.jsonb_uuids(j jsonb) returns uuid[]
language sql immutable as $$ select coalesce(array(select jsonb_array_elements_text(case when jsonb_typeof(j) = 'array' then j else '[]'::jsonb end)::uuid), '{}') $$;

create or replace function private.jnum(d jsonb, k text) returns numeric
language sql immutable as $$ select nullif(d ->> k, '')::numeric $$;

create or replace function private.jbool(d jsonb, k text) returns boolean
language sql immutable as $$ select nullif(d ->> k, '')::boolean $$;

-- Confere tipos e nomes dos filtros (erro claro em vez de "invalid input syntax")
create or replace function private.audience_validate(d jsonb) returns void
language plpgsql immutable set search_path = '' as $$
declare
  k text; v jsonb; e text;
  a_text text[] := array['lifecycle', 'tiers', 'cities', 'tags', 'rsvp', 'sources', 'bought_sizes', 'ad_ids', 'deal_status', 'lost_reasons'];
  a_uuid text[] := array['bought_categories', 'bought_collections', 'bought_products', 'link_ids', 'affiliate_ids', 'received_campaigns', 'not_received_campaigns'];
  nums text[] := array['min_score', 'inactive_days', 'inactive_max_days', 'birthday_month', 'bought_within_days', 'period_days', 'orders_min', 'orders_max', 'spent_min', 'spent_max', 'ticket_min',
                       'bought_period_days', 'created_within_days', 'created_older_than_days', 'no_marketing_days', 'replied_within_days'];
  bools text[] := array['never_bought', 'any_link', 'from_ads', 'referred', 'has_active_coupon', 'reachable_whatsapp', 'has_email', 'ads_consent'];
  uuids text[] := array['event_id', 'segment_id'];
  re_uuid constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
begin
  if jsonb_typeof(d) is distinct from 'object' then raise exception 'Definição de público inválida' using errcode = 'P0190'; end if;
  for k, v in select * from jsonb_each(d) loop
    if jsonb_typeof(v) = 'null' then continue; end if;
    if k = any (a_text) then
      if jsonb_typeof(v) <> 'array' then raise exception 'O filtro % deve ser uma lista', k using errcode = 'P0190'; end if;
    elsif k = any (a_uuid) then
      if jsonb_typeof(v) <> 'array' then raise exception 'O filtro % deve ser uma lista', k using errcode = 'P0190'; end if;
      for e in select jsonb_array_elements_text(v) loop
        if e !~ re_uuid then raise exception 'O filtro % tem um identificador inválido', k using errcode = 'P0190'; end if;
      end loop;
    elsif k = any (nums) then
      if not (jsonb_typeof(v) = 'number' or (jsonb_typeof(v) = 'string' and (v #>> '{}') ~ '^-?[0-9]+(\.[0-9]+)?$' )) then raise exception 'O filtro % deve ser um número', k using errcode = 'P0190'; end if;
    elsif k = any (bools) then
      if jsonb_typeof(v) <> 'boolean' then raise exception 'O filtro % deve ser sim ou não', k using errcode = 'P0190'; end if;
    elsif k = any (uuids) then
      if jsonb_typeof(v) <> 'string' or (v #>> '{}') !~ re_uuid then
        if not (jsonb_typeof(v) = 'string' and (v #>> '{}') = '') then raise exception 'O filtro % tem um identificador inválido', k using errcode = 'P0190'; end if;
      end if;
    elsif k = 'exclude' then
      perform private.audience_validate(v);
    else
      raise exception 'Filtro desconhecido: %', k using errcode = 'P0190';
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 1) Públicos salvos
-- ---------------------------------------------------------------------
create table mkt.segments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  name text not null check (length(name) between 3 and 80),
  description text,
  definition jsonb not null default '{}',
  kind text not null default 'DYNAMIC' check (kind in ('DYNAMIC', 'STATIC')),     -- STATIC = lista congelada em segment_members
  cached_count integer,
  cached_at timestamptz,
  created_by uuid references core.members(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index segments_name_uq on mkt.segments (org_id, lower(name));

create table mkt.segment_members (
  segment_id uuid not null references mkt.segments(id) on delete cascade,
  party_id uuid not null references crm.parties(id) on delete cascade,
  org_id uuid not null references core.orgs(id),
  primary key (segment_id, party_id)
);
create index segment_members_party_idx on mkt.segment_members (party_id);

alter table mkt.campaigns add column segment_id uuid references mkt.segments(id) on delete set null;

select private.attach_updated_at('mkt');
select private.apply_rls('mkt', array['segments', 'segment_members'], 'crm.read', 'crm.write');
select private.rpc_only('mkt', array['segments', 'segment_members']);
create trigger trg_audit after insert or update or delete on mkt.segments for each row execute function private.audit_capture();

-- ---------------------------------------------------------------------
-- 2) Filtro de público v2 (núcleo, sem checar permissão: quem chama já checou)
-- ---------------------------------------------------------------------
create or replace function private.audience_run(p_org uuid, p_def jsonb, p_depth integer, p_limit integer) returns table (party_id uuid)
language plpgsql stable security definer set search_path = '' as $$
declare
  d jsonb := coalesce(p_def, '{}');
  v_life text[] := private.jsonb_texts(d -> 'lifecycle'); v_tiers text[] := private.jsonb_texts(d -> 'tiers');
  v_cities text[] := array(select lower(x) from unnest(private.jsonb_texts(d -> 'cities')) x); v_tags text[] := private.jsonb_texts(d -> 'tags');
  v_rsvp text[] := private.jsonb_texts(d -> 'rsvp'); v_sources text[] := array(select lower(x) from unnest(private.jsonb_texts(d -> 'sources')) x);
  v_sizes text[] := array(select upper(x) from unnest(private.jsonb_texts(d -> 'bought_sizes')) x); v_adids text[] := private.jsonb_texts(d -> 'ad_ids');
  v_deal text[] := private.jsonb_texts(d -> 'deal_status'); v_lost text[] := private.jsonb_texts(d -> 'lost_reasons');
  v_cats uuid[] := private.jsonb_uuids(d -> 'bought_categories'); v_cols uuid[] := private.jsonb_uuids(d -> 'bought_collections'); v_prods uuid[] := private.jsonb_uuids(d -> 'bought_products');
  v_links uuid[] := private.jsonb_uuids(d -> 'link_ids'); v_affs uuid[] := private.jsonb_uuids(d -> 'affiliate_ids');
  v_recv uuid[] := private.jsonb_uuids(d -> 'received_campaigns'); v_nrecv uuid[] := private.jsonb_uuids(d -> 'not_received_campaigns');
  v_score int := private.jnum(d, 'min_score'); v_inactive int := private.jnum(d, 'inactive_days'); v_inactive_max int := private.jnum(d, 'inactive_max_days');
  v_bmonth int := private.jnum(d, 'birthday_month'); v_bought_days int := private.jnum(d, 'bought_within_days'); v_period int := private.jnum(d, 'period_days');
  v_omin int := private.jnum(d, 'orders_min'); v_omax int := private.jnum(d, 'orders_max'); v_smin numeric := private.jnum(d, 'spent_min'); v_smax numeric := private.jnum(d, 'spent_max');
  v_tmin numeric := private.jnum(d, 'ticket_min'); v_bperiod int := private.jnum(d, 'bought_period_days');
  v_new int := private.jnum(d, 'created_within_days'); v_old int := private.jnum(d, 'created_older_than_days');
  v_nomkt int := private.jnum(d, 'no_marketing_days'); v_replied int := private.jnum(d, 'replied_within_days');
  v_never boolean := private.jbool(d, 'never_bought'); v_anylink boolean := private.jbool(d, 'any_link'); v_ads boolean := private.jbool(d, 'from_ads'); v_ref boolean := private.jbool(d, 'referred');
  v_coupon boolean := private.jbool(d, 'has_active_coupon'); v_wa boolean := private.jbool(d, 'reachable_whatsapp'); v_mail boolean := private.jbool(d, 'has_email'); v_adc boolean := private.jbool(d, 'ads_consent');
  v_event uuid := nullif(d ->> 'event_id', '')::uuid; v_seg uuid := nullif(d ->> 'segment_id', '')::uuid;
  v_need_ord boolean := v_omin is not null or v_omax is not null or v_smin is not null or v_smax is not null or v_tmin is not null;
  v_ex uuid[] := '{}'; v_inc uuid[]; s mkt.segments; v_paid text[] := private.paid_order_statuses();
begin
  if p_depth > 3 then raise exception 'Públicos dentro de públicos: no máximo 3 níveis' using errcode = 'P0190'; end if;
  if jsonb_typeof(d -> 'exclude') = 'object' and d -> 'exclude' <> '{}'::jsonb then
    v_ex := array(select a.party_id from private.audience_q(p_org, d -> 'exclude', p_depth + 1, 100000) a);
  end if;
  if v_seg is not null then
    select * into s from mkt.segments where id = v_seg and org_id = p_org;
    if s.id is null then raise exception 'Público salvo não encontrado' using errcode = 'P0192'; end if;
    if s.kind = 'STATIC' then v_inc := array(select m.party_id from mkt.segment_members m where m.segment_id = s.id);
    else v_inc := array(select a.party_id from private.audience_q(p_org, s.definition, p_depth + 1, 100000) a); end if;
  end if;
  return query
    with ord as (
      select o.party_id as pid, count(*) as n, coalesce(sum(o.total), 0) as spent
      from sales.orders o where v_need_ord and o.org_id = p_org and o.status::text = any (v_paid) and o.party_id is not null
        and (v_period is null or o.created_at >= now() - make_interval(days => v_period))
      group by o.party_id)
    select p.id from crm.parties p
    left join ord on ord.pid = p.id
    where p.org_id = p_org and p.merged_into_id is null and p.anonymized_at is null
      and not exists (select 1 from crm.party_roles r where r.party_id = p.id and r.role in ('EMPLOYEE', 'SUPPLIER', 'SERVICE_PROVIDER', 'CARRIER', 'ACQUIRER', 'BANK'))
      and (v_inc is null or p.id = any (v_inc)) and p.id <> all (v_ex)
      -- quem é
      and (cardinality(v_life) = 0 or p.lifecycle_stage::text = any (v_life))
      and (cardinality(v_tiers) = 0 or p.tier::text = any (v_tiers))
      and (v_score is null or p.lead_score >= v_score)
      and (v_bmonth is null or extract(month from p.birth_date) = v_bmonth)
      and (cardinality(v_cities) = 0 or lower(p.city) = any (v_cities))
      and (cardinality(v_tags) = 0 or p.tags && v_tags)
      and (cardinality(v_sources) = 0 or lower(p.source) = any (v_sources))
      and (v_event is null or exists (select 1 from mkt.event_guests g where g.event_id = v_event and g.party_id = p.id and (cardinality(v_rsvp) = 0 or g.rsvp_status = any (v_rsvp))))
      -- compra
      and (v_inactive is null or p.last_purchase_at is null or p.last_purchase_at < now() - make_interval(days => v_inactive))
      and (v_inactive_max is null or p.last_purchase_at >= now() - make_interval(days => v_inactive_max))
      and (v_bought_days is null or p.last_purchase_at >= now() - make_interval(days => v_bought_days))
      and (v_never is null or (p.first_purchase_at is null) = v_never)
      and (v_omin is null or coalesce(ord.n, 0) >= v_omin)
      and (v_omax is null or coalesce(ord.n, 0) <= v_omax)
      and (v_smin is null or coalesce(ord.spent, 0) >= v_smin)
      and (v_smax is null or coalesce(ord.spent, 0) <= v_smax)
      and (v_tmin is null or coalesce(ord.spent / nullif(ord.n, 0), 0) >= v_tmin)
      and ((cardinality(v_cats) = 0 and cardinality(v_cols) = 0 and cardinality(v_prods) = 0 and cardinality(v_sizes) = 0) or exists (
            select 1 from sales.orders o join sales.order_items i on i.order_id = o.id join catalog.variants va on va.id = i.variant_id join catalog.products pr on pr.id = va.product_id
            where o.party_id = p.id and o.status::text = any (v_paid)
              and (v_bperiod is null or o.created_at >= now() - make_interval(days => v_bperiod))
              and (cardinality(v_cats) = 0 or pr.category_id = any (v_cats)) and (cardinality(v_cols) = 0 or pr.collection_id = any (v_cols))
              and (cardinality(v_prods) = 0 or pr.id = any (v_prods)) and (cardinality(v_sizes) = 0 or upper(va.size) = any (v_sizes))))
      -- lead e origem
      and (v_new is null or p.created_at >= now() - make_interval(days => v_new))
      and (v_old is null or p.created_at < now() - make_interval(days => v_old))
      and (v_anylink is null or exists (select 1 from mkt.attribution_touches t where t.party_id = p.id and t.kind = 'LINK') = v_anylink)
      and (cardinality(v_links) = 0 or exists (select 1 from mkt.attribution_touches t where t.party_id = p.id and t.tracking_link_id = any (v_links)))
      and (v_ads is null or exists (select 1 from mkt.attribution_touches t where t.party_id = p.id and t.kind = 'AD') = v_ads)
      and (cardinality(v_adids) = 0 or exists (select 1 from mkt.attribution_touches t where t.party_id = p.id and t.ad_id = any (v_adids)))
      and (v_ref is null or (exists (select 1 from crm.referrals rf where rf.friend_party = p.id)
                             or exists (select 1 from mkt.attribution_touches t join mkt.tracking_links l on l.id = t.tracking_link_id where t.party_id = p.id and l.affiliate_party_id is not null)) = v_ref)
      and (cardinality(v_affs) = 0 or exists (select 1 from crm.referrals rf where rf.friend_party = p.id and rf.referrer_party = any (v_affs))
                                   or exists (select 1 from mkt.attribution_touches t join mkt.tracking_links l on l.id = t.tracking_link_id where t.party_id = p.id and l.affiliate_party_id = any (v_affs)))
      and (cardinality(v_deal) = 0 or exists (select 1 from crm.deals dl where dl.party_id = p.id and dl.status = any (v_deal) and (cardinality(v_lost) = 0 or dl.lost_reason = any (v_lost))))
      and (cardinality(v_deal) > 0 or cardinality(v_lost) = 0 or exists (select 1 from crm.deals dl where dl.party_id = p.id and dl.lost_reason = any (v_lost)))
      -- relacionamento
      and (v_coupon is null or exists (
            select 1 from sales.coupons cp where cp.org_id = p_org and cp.party_id = p.id and cp.active and cp.valid_from <= now() and (cp.valid_to is null or cp.valid_to > now())
              and (cp.max_uses is null or (select count(*) from sales.coupon_redemptions r where r.coupon_id = cp.id) < cp.max_uses)) = v_coupon)
      and (cardinality(v_recv) = 0 or exists (select 1 from mkt.campaign_recipients r where r.party_id = p.id and r.campaign_id = any (v_recv) and r.status in ('QUEUED', 'SENT')))
      and (cardinality(v_nrecv) = 0 or not exists (select 1 from mkt.campaign_recipients r where r.party_id = p.id and r.campaign_id = any (v_nrecv) and r.status in ('QUEUED', 'SENT')))
      and (v_nomkt is null or not exists (
            select 1 from omni.messages m join omni.conversations c on c.id = m.conversation_id join omni.templates t on t.id = (m.payload ->> 'template_id')::uuid
            where c.party_id = p.id and m.direction = 'OUT' and m.type = 'TEMPLATE' and t.category = 'MARKETING' and m.status <> 'FAILED' and m.created_at > now() - make_interval(days => v_nomkt)))
      and (v_replied is null or exists (
            select 1 from omni.messages m join omni.conversations c on c.id = m.conversation_id where c.party_id = p.id and m.direction = 'IN' and m.created_at > now() - make_interval(days => v_replied)))
      -- canal alcançável
      and (v_wa is null or ((private.party_wa_id(p.id) is not null
                             and coalesce((select cc.granted from crm.v_current_consents cc where cc.party_id = p.id and cc.purpose = 'MARKETING_WHATSAPP'), false)) = v_wa))
      and (v_mail is null or exists (select 1 from crm.party_contact_points cp where cp.party_id = p.id and cp.type = 'EMAIL') = v_mail)
      and (v_adc is null or ((coalesce((select cc.granted from crm.v_current_consents cc where cc.party_id = p.id and cc.purpose = 'MARKETING_ADS'), false)
                              and (private.party_wa_id(p.id) is not null or exists (select 1 from crm.party_contact_points cp where cp.party_id = p.id and cp.type = 'EMAIL'))) = v_adc))
    order by p.lead_score desc, p.created_at
    limit p_limit;
end $$;

-- Porta de entrada: valida os filtros antes de interpretá-los (erro claro em vez de "invalid input syntax")
create or replace function private.audience_q(p_org uuid, p_def jsonb, p_depth integer default 0, p_limit integer default 20000) returns table (party_id uuid)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.audience_validate(coalesce(p_def, '{}'));
  return query select a.party_id from private.audience_run(p_org, coalesce(p_def, '{}'), p_depth, p_limit) a;
end $$;

create or replace function crm.audience(p_def jsonb) returns table (party_id uuid)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_perm('crm.read');
  return query select a.party_id from private.audience_q(private.org_id(), p_def, 0, 20000) a;
end $$;

-- ---------------------------------------------------------------------
-- 3) Prévia: quantas pessoas, quantas dá para alcançar em cada canal e como se distribuem
-- ---------------------------------------------------------------------
create or replace function mkt.segment_preview(p_def jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); v_out jsonb;
begin
  perform private.require_perm('crm.read');
  with a as materialized (
    select x.party_id as pid, p.display_name, p.lifecycle_stage::text as stage, p.tier::text as tier, p.lead_score, p.created_at,
           private.party_wa_id(x.party_id) as wa,
           coalesce((select c.granted from crm.v_current_consents c where c.party_id = x.party_id and c.purpose = 'MARKETING_WHATSAPP'), false) as cw,
           coalesce((select c.granted from crm.v_current_consents c where c.party_id = x.party_id and c.purpose = 'MARKETING_ADS'), false) as ca,
           exists (select 1 from crm.party_contact_points cp where cp.party_id = x.party_id and cp.type = 'EMAIL') as mail
    from private.audience_q(v_org, p_def, 0, 20000) x join crm.parties p on p.id = x.party_id)
  select jsonb_build_object(
    'total', (select count(*) from a),
    'whatsapp', (select count(*) from a where wa is not null and cw),
    'no_phone', (select count(*) from a where wa is null),
    'no_consent', (select count(*) from a where wa is not null and not cw),
    'ads', (select count(*) from a where ca and (wa is not null or mail)),
    'email', (select count(*) from a where mail),
    'by_stage', (select coalesce(jsonb_object_agg(stage, n), '{}') from (select stage, count(*) n from a group by 1) g),
    'by_tier', (select coalesce(jsonb_object_agg(tier, n), '{}') from (select tier, count(*) n from a group by 1) g),
    'sample', (select coalesce(jsonb_agg(display_name), '[]') from (select display_name from a order by lead_score desc, created_at limit 5) g),
    'capped', (select count(*) >= 20000 from a))
  into v_out;
  return v_out;
end $$;

-- ---------------------------------------------------------------------
-- 4) Cadastro
-- p = {id?, name, description?, definition, kind?}
-- ---------------------------------------------------------------------
create or replace function mkt.save_segment(p jsonb) returns mkt.segments
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id(); v_id uuid := nullif(p ->> 'id', '')::uuid; v_name text := trim(coalesce(p ->> 'name', '')); v_def jsonb := coalesce(p -> 'definition', '{}');
  v_kind text := upper(coalesce(nullif(p ->> 'kind', ''), 'DYNAMIC')); s mkt.segments; v_n int;
begin
  perform private.require_perm('crm.write');
  if length(v_name) not between 3 and 80 then raise exception 'O nome do público tem de 3 a 80 caracteres' using errcode = 'P0190'; end if;
  if v_kind not in ('DYNAMIC', 'STATIC') then raise exception 'Tipo de público inválido' using errcode = 'P0190'; end if;
  perform private.audience_validate(v_def);
  if v_id is not null and (v_def ->> 'segment_id') = v_id::text then raise exception 'Um público não pode usar a si mesmo' using errcode = 'P0190'; end if;
  begin
    if v_id is null then
      insert into mkt.segments (org_id, name, description, definition, kind, created_by) values (v_org, v_name, nullif(trim(coalesce(p ->> 'description', '')), ''), v_def, v_kind, private.member_id()) returning * into s;
    else
      update mkt.segments set name = v_name, description = nullif(trim(coalesce(p ->> 'description', '')), ''), definition = v_def, kind = v_kind where id = v_id and org_id = v_org returning * into s;
      if s.id is null then raise exception 'Público não encontrado' using errcode = 'P0192'; end if;
    end if;
  exception when unique_violation then
    raise exception 'Já existe um público com o nome %', v_name using errcode = 'P0190';
  end;
  if s.kind = 'STATIC' then
    delete from mkt.segment_members where segment_id = s.id;
    insert into mkt.segment_members (segment_id, party_id, org_id) select s.id, a.party_id, v_org from private.audience_q(v_org, s.definition, 0, 20000) a;
    get diagnostics v_n = row_count;
  else
    delete from mkt.segment_members where segment_id = s.id;
    select count(*) into v_n from private.audience_q(v_org, s.definition, 0, 20000);
  end if;
  update mkt.segments set cached_count = v_n, cached_at = now() where id = s.id returning * into s;
  return s;
end $$;

-- Recalcula a contagem (e a lista, se for congelado)
create or replace function mkt.refresh_segment(p_id uuid) returns mkt.segments
language plpgsql security definer set search_path = '' as $$
declare s mkt.segments; v_n int;
begin
  perform private.require_perm('crm.write');
  select * into s from mkt.segments where id = p_id and org_id = private.org_id();
  if s.id is null then raise exception 'Público não encontrado' using errcode = 'P0192'; end if;
  if s.kind = 'STATIC' then
    delete from mkt.segment_members where segment_id = s.id;
    insert into mkt.segment_members (segment_id, party_id, org_id) select s.id, a.party_id, s.org_id from private.audience_q(s.org_id, s.definition, 0, 20000) a;
    get diagnostics v_n = row_count;
  else
    select count(*) into v_n from private.audience_q(s.org_id, s.definition, 0, 20000);
  end if;
  update mkt.segments set cached_count = v_n, cached_at = now() where id = s.id returning * into s;
  return s;
end $$;

create or replace function mkt.delete_segment(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := private.org_id();
begin
  perform private.require_perm('crm.write');
  if exists (select 1 from mkt.campaigns c where c.segment_id = p_id and c.org_id = v_org and c.status = 'DRAFT') then
    raise exception 'Este público está em uma campanha em rascunho: troque o público ou exclua o rascunho antes' using errcode = 'P0191';
  end if;
  if exists (select 1 from mkt.segments s where s.org_id = v_org and s.id <> p_id and (s.definition ->> 'segment_id' = p_id::text or s.definition #>> '{exclude,segment_id}' = p_id::text)) then
    raise exception 'Outro público usa este: troque-o antes de excluir' using errcode = 'P0191';
  end if;
  delete from mkt.segments where id = p_id and org_id = v_org;
  if not found then raise exception 'Público não encontrado' using errcode = 'P0192'; end if;
end $$;

-- Contagem diária dos públicos dinâmicos
create or replace function private.refresh_segment_counts() returns integer
language plpgsql security definer set search_path = '' as $$
declare s record; n integer := 0; v_n int;
begin
  for s in select * from mkt.segments loop
    begin
      if s.kind = 'DYNAMIC' then
        select count(*) into v_n from private.audience_q(s.org_id, s.definition, 0, 20000);
        update mkt.segments set cached_count = v_n, cached_at = now() where id = s.id;
        n := n + 1;
      end if;
    exception when others then null;                                -- um público quebrado não derruba os outros
    end;
  end loop;
  return n;
end $$;
select cron.schedule('centralops-segment-counts', '45 6 * * *', $$ select private.refresh_segment_counts() $$);   -- 03:45 BRT

insert into private.internal_functions (fqname) values ('private.audience_q'), ('private.audience_run'), ('private.audience_validate'), ('private.refresh_segment_counts'), ('private.paid_order_statuses'),
  ('private.jsonb_texts'), ('private.jsonb_uuids'), ('private.jnum'), ('private.jbool') on conflict do nothing;
select private.lock_functions();
