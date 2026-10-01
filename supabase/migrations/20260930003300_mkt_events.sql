-- =====================================================================
-- Marketing › Eventos & Drops: convidadas, RSVP (com lista de espera pela capacidade), orçamento e resultado (vendas das convidadas x custo).
-- Cada convidada entra no funil "Convidados de eventos" (Convidada → Confirmou → Compareceu → Comprou / Não veio) e o RSVP move a oportunidade.
-- O custo real vem do Financeiro: títulos com o centro de custo do evento (projeto) — o mesmo que aparece no DRE por projeto.
-- Códigos de erro: P0180 dado inválido · P0181 situação não permite · P0182 não encontrado.
-- =====================================================================

select private.init_schema('mkt');

create table mkt.events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  kind text not null check (kind in ('DROP', 'BREAKFAST_ACTIVATION', 'PHOTOSHOOT', 'POPUP', 'TRUNK_SHOW')),
  name text not null,
  store_id uuid references core.stores(id),
  starts_at timestamptz not null,
  ends_at timestamptz,
  venue text,
  capacity integer check (capacity is null or capacity >= 0),
  target_revenue numeric(14, 2) check (target_revenue is null or target_revenue >= 0),
  cost_center_id uuid references core.cost_centers(id),
  collection_id uuid references catalog.collections(id),
  status text not null default 'PLANNED' check (status in ('PLANNED', 'CONFIRMED', 'DONE', 'CANCELLED')),
  notes text,
  created_by uuid references core.members(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at is null or ends_at >= starts_at)
);
create index events_org_start_idx on mkt.events (org_id, starts_at desc);

create table mkt.event_guests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  event_id uuid not null references mkt.events(id) on delete cascade,
  party_id uuid not null references crm.parties(id),
  invited_by uuid references core.members(id),
  source text not null default 'MANUAL' check (source in ('MANUAL', 'TRAINER', 'CUSTOMER', 'SEGMENT', 'AI')),
  rsvp_status text not null default 'INVITED' check (rsvp_status in ('INVITED', 'CONFIRMED', 'DECLINED', 'WAITLIST', 'ATTENDED', 'NO_SHOW')),
  plus_ones integer not null default 0 check (plus_ones between 0 and 5),
  checked_in_at timestamptz,
  deal_id uuid references crm.deals(id) on delete set null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (event_id, party_id)
);
create index event_guests_party_idx on mkt.event_guests (party_id);

create table mkt.event_budget_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  event_id uuid not null references mkt.events(id) on delete cascade,
  category text not null,
  planned numeric(14, 2) not null check (planned >= 0),
  memo text,
  created_at timestamptz not null default now()
);

select private.attach_updated_at('mkt');
select private.apply_rls('mkt', array['events', 'event_guests', 'event_budget_lines'], 'crm.read', 'crm.write');
select private.rpc_only('mkt', array['events', 'event_guests', 'event_budget_lines']);
create trigger trg_audit after insert or update or delete on mkt.events for each row execute function private.audit_capture();

-- Ocupação: confirmadas + acompanhantes (quem já está dentro conta)
create or replace function private.event_headcount(p_event uuid) returns integer
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(1 + plus_ones), 0)::int from mkt.event_guests where event_id = p_event and rsvp_status in ('CONFIRMED', 'ATTENDED')
$$;

-- ---------------------------------------------------------------------
-- 1) Evento
-- p = {id?, kind, name, store_id?, starts_at, ends_at?, venue?, capacity?, target_revenue?, collection_id?, notes?, create_cost_center?}
-- ---------------------------------------------------------------------
create or replace function mkt.save_event(p jsonb) returns mkt.events
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id(); v_id uuid := nullif(p ->> 'id', '')::uuid; v_kind text := upper(coalesce(p ->> 'kind', '')); v_name text := trim(coalesce(p ->> 'name', ''));
  v_store uuid := nullif(p ->> 'store_id', '')::uuid; v_start timestamptz := nullif(p ->> 'starts_at', '')::timestamptz; v_end timestamptz := nullif(p ->> 'ends_at', '')::timestamptz;
  v_cap int := nullif(p ->> 'capacity', '')::int; v_target numeric := nullif(p ->> 'target_revenue', '')::numeric; v_coll uuid := nullif(p ->> 'collection_id', '')::uuid;
  e mkt.events; v_parent uuid; v_cc uuid; v_code text;
begin
  perform private.require_perm('crm.write');
  if length(v_name) not between 3 and 120 then raise exception 'O nome do evento tem de 3 a 120 caracteres' using errcode = 'P0180'; end if;
  if v_kind not in ('DROP', 'BREAKFAST_ACTIVATION', 'PHOTOSHOOT', 'POPUP', 'TRUNK_SHOW') then raise exception 'Tipo de evento inválido' using errcode = 'P0180'; end if;
  if v_start is null then raise exception 'Informe a data e a hora do evento' using errcode = 'P0180'; end if;
  if v_end is not null and v_end < v_start then raise exception 'O fim não pode ser antes do início' using errcode = 'P0180'; end if;
  if v_cap is not null and v_cap < 0 then raise exception 'A capacidade não pode ser negativa' using errcode = 'P0180'; end if;
  if v_target is not null and v_target < 0 then raise exception 'A meta de vendas não pode ser negativa' using errcode = 'P0180'; end if;
  if v_store is not null and not exists (select 1 from core.stores where id = v_store and org_id = v_org) then raise exception 'Loja inválida' using errcode = 'P0180'; end if;
  if v_coll is not null and not exists (select 1 from catalog.collections where id = v_coll and org_id = v_org) then raise exception 'Coleção inválida' using errcode = 'P0180'; end if;
  if v_id is null then
    insert into mkt.events (org_id, kind, name, store_id, starts_at, ends_at, venue, capacity, target_revenue, collection_id, notes, created_by)
    values (v_org, v_kind, v_name, v_store, v_start, v_end, nullif(trim(coalesce(p ->> 'venue', '')), ''), v_cap, v_target, v_coll, nullif(trim(coalesce(p ->> 'notes', '')), ''), private.member_id()) returning * into e;
    if coalesce((p ->> 'create_cost_center')::boolean, false) then
      select id into v_parent from core.cost_centers where org_id = v_org and kind = 'STORE' and (store_id = v_store or v_store is null) order by (store_id = v_store) desc nulls last, created_at limit 1;
      if v_parent is null then select id into v_parent from core.cost_centers where org_id = v_org and kind = 'CORPORATE' order by created_at limit 1; end if;
      v_code := 'EVT-' || to_char(v_start at time zone 'America/Sao_Paulo', 'YYMMDD') || '-' || upper(substr(md5(e.id::text), 1, 3));
      insert into core.cost_centers (org_id, parent_id, code, name, kind, store_id, valid_from) values (v_org, v_parent, v_code, 'Evento — ' || v_name, 'PROJECT_EVENT', v_store, (v_start at time zone 'America/Sao_Paulo')::date)
      returning id into v_cc;
      update mkt.events set cost_center_id = v_cc where id = e.id returning * into e;
    end if;
  else
    update mkt.events set kind = v_kind, name = v_name, store_id = v_store, starts_at = v_start, ends_at = v_end, venue = nullif(trim(coalesce(p ->> 'venue', '')), ''),
           capacity = v_cap, target_revenue = v_target, collection_id = v_coll, notes = nullif(trim(coalesce(p ->> 'notes', '')), '')
    where id = v_id and org_id = v_org returning * into e;
    if e.id is null then raise exception 'Evento não encontrado' using errcode = 'P0182'; end if;
  end if;
  return e;
end $$;

-- Fecha o evento: quem confirmou e não apareceu vira "não veio"
create or replace function mkt.set_event_status(p_id uuid, p_status text) returns mkt.events
language plpgsql security definer set search_path = '' as $$
declare e mkt.events; g record; v_lost uuid;
begin
  perform private.require_perm('crm.write');
  if p_status not in ('PLANNED', 'CONFIRMED', 'DONE', 'CANCELLED') then raise exception 'Situação inválida' using errcode = 'P0180'; end if;
  select * into e from mkt.events where id = p_id and org_id = private.org_id() for update;
  if e.id is null then raise exception 'Evento não encontrado' using errcode = 'P0182'; end if;
  if e.status in ('DONE', 'CANCELLED') and p_status <> e.status then raise exception 'Evento encerrado não muda de situação' using errcode = 'P0181'; end if;
  update mkt.events set status = p_status where id = e.id returning * into e;
  if p_status = 'DONE' then
    for g in select * from mkt.event_guests where event_id = e.id and rsvp_status = 'CONFIRMED' loop
      update mkt.event_guests set rsvp_status = 'NO_SHOW' where id = g.id;
      if g.deal_id is not null then
        select s.id into v_lost from crm.deals d join crm.pipeline_stages s on s.pipeline_id = d.pipeline_id and s.is_lost where d.id = g.deal_id limit 1;
        if v_lost is not null then perform crm.move_deal(g.deal_id, v_lost, 'Confirmou e não compareceu'); end if;
      end if;
    end loop;
  end if;
  return e;
end $$;

-- ---------------------------------------------------------------------
-- 2) Convidadas e RSVP
-- ---------------------------------------------------------------------
create or replace function mkt.invite_guests(p_event uuid, p_parties uuid[], p_source text default 'MANUAL') returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id(); e mkt.events; v_pipe uuid; v_stage uuid; v_party uuid; v_n int := 0; v_deal uuid; v_src text := upper(coalesce(p_source, 'MANUAL'));
begin
  perform private.require_perm('crm.write');
  select * into e from mkt.events where id = p_event and org_id = v_org;
  if e.id is null then raise exception 'Evento não encontrado' using errcode = 'P0182'; end if;
  if e.status in ('DONE', 'CANCELLED') then raise exception 'Evento encerrado não recebe convidadas' using errcode = 'P0181'; end if;
  if v_src not in ('MANUAL', 'TRAINER', 'CUSTOMER', 'SEGMENT', 'AI') then raise exception 'Origem inválida' using errcode = 'P0180'; end if;
  if coalesce(cardinality(p_parties), 0) = 0 then raise exception 'Escolha quem convidar' using errcode = 'P0180'; end if;
  select id into v_pipe from crm.pipelines where org_id = v_org and kind = 'EVENT' and active order by name limit 1;
  select id into v_stage from crm.pipeline_stages where pipeline_id = v_pipe order by position limit 1;
  foreach v_party in array p_parties loop
    continue when not exists (select 1 from crm.parties where id = v_party and org_id = v_org and merged_into_id is null and anonymized_at is null);
    continue when exists (select 1 from mkt.event_guests where event_id = e.id and party_id = v_party);
    v_deal := null;
    if v_stage is not null then
      insert into crm.deals (org_id, party_id, pipeline_id, stage_id, title, owner_member_id) values (v_org, v_party, v_pipe, v_stage, left(e.name, 120), private.member_id()) returning id into v_deal;
    end if;
    insert into mkt.event_guests (org_id, event_id, party_id, invited_by, source, deal_id) values (v_org, e.id, v_party, private.member_id(), v_src, v_deal);
    perform private.timeline(v_org, v_party, 'EVENT_INVITED', 'mkt.events', e.id, 'Convidada para ' || e.name);
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- CONFIRMED acima da capacidade vira lista de espera. ATTENDED marca a presença. Move a oportunidade da convidada no funil.
create or replace function mkt.set_rsvp(p_guest uuid, p_status text, p_plus_ones integer default null) returns mkt.event_guests
language plpgsql security definer set search_path = '' as $$
declare
  g mkt.event_guests; e mkt.events; v_status text := upper(coalesce(p_status, '')); v_pos int; v_stage uuid; v_used int; v_plus int;
begin
  perform private.require_perm('crm.write');
  if v_status not in ('INVITED', 'CONFIRMED', 'DECLINED', 'WAITLIST', 'ATTENDED', 'NO_SHOW') then raise exception 'Situação inválida' using errcode = 'P0180'; end if;
  select * into g from mkt.event_guests where id = p_guest and org_id = private.org_id() for update;
  if g.id is null then raise exception 'Convidada não encontrada' using errcode = 'P0182'; end if;
  select * into e from mkt.events where id = g.event_id for update;
  if e.status = 'CANCELLED' then raise exception 'Evento cancelado' using errcode = 'P0181'; end if;
  v_plus := coalesce(p_plus_ones, g.plus_ones);
  if v_plus not between 0 and 5 then raise exception 'Acompanhantes: de 0 a 5' using errcode = 'P0180'; end if;
  if v_status in ('CONFIRMED', 'ATTENDED') and g.rsvp_status not in ('CONFIRMED', 'ATTENDED') and e.capacity is not null then
    v_used := private.event_headcount(e.id);
    if v_used + 1 + v_plus > e.capacity then
      if v_status = 'ATTENDED' then raise exception 'Evento lotado: confirme a capacidade antes de registrar a presença' using errcode = 'P0181'; end if;
      v_status := 'WAITLIST';
    end if;
  end if;
  update mkt.event_guests set rsvp_status = v_status, plus_ones = v_plus, checked_in_at = case when v_status = 'ATTENDED' then coalesce(checked_in_at, now()) else null end where id = g.id returning * into g;
  if g.deal_id is not null then
    v_pos := case v_status when 'CONFIRMED' then 2 when 'ATTENDED' then 3 else 1 end;
    if v_status in ('DECLINED', 'NO_SHOW') then
      select s.id into v_stage from crm.deals d join crm.pipeline_stages s on s.pipeline_id = d.pipeline_id and s.is_lost where d.id = g.deal_id limit 1;
      if v_stage is not null then perform crm.move_deal(g.deal_id, v_stage, case v_status when 'DECLINED' then 'Recusou o convite' else 'Não compareceu' end); end if;
    else
      select s.id into v_stage from crm.deals d join crm.pipeline_stages s on s.pipeline_id = d.pipeline_id and s.position = v_pos where d.id = g.deal_id limit 1;
      if v_stage is not null then perform crm.move_deal(g.deal_id, v_stage); end if;
    end if;
  end if;
  perform private.timeline(g.org_id, g.party_id, 'EVENT_RSVP', 'mkt.events', e.id, e.name || ': ' || case v_status when 'CONFIRMED' then 'confirmou presença' when 'DECLINED' then 'recusou' when 'WAITLIST' then 'na lista de espera' when 'ATTENDED' then 'compareceu' when 'NO_SHOW' then 'não compareceu' else 'convite pendente' end);
  return g;
end $$;

create or replace function mkt.remove_guest(p_guest uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare g mkt.event_guests;
begin
  perform private.require_perm('crm.write');
  select * into g from mkt.event_guests where id = p_guest and org_id = private.org_id() for update;
  if g.id is null then raise exception 'Convidada não encontrada' using errcode = 'P0182'; end if;
  if g.rsvp_status = 'ATTENDED' then raise exception 'Quem compareceu não sai da lista' using errcode = 'P0181'; end if;
  delete from mkt.event_guests where id = g.id;
  if g.deal_id is not null then delete from crm.deals where id = g.deal_id and status = 'OPEN' and won_order_id is null; end if;
end $$;

-- ---------------------------------------------------------------------
-- 3) Orçamento por categoria
-- ---------------------------------------------------------------------
create or replace function mkt.save_budget_line(p jsonb) returns mkt.event_budget_lines
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); v_id uuid := nullif(p ->> 'id', '')::uuid; v_event uuid := nullif(p ->> 'event_id', '')::uuid; v_cat text := trim(coalesce(p ->> 'category', ''));
        v_planned numeric := nullif(p ->> 'planned', '')::numeric; l mkt.event_budget_lines;
begin
  perform private.require_perm('crm.write');
  if length(v_cat) not between 2 and 60 then raise exception 'A categoria tem de 2 a 60 caracteres' using errcode = 'P0180'; end if;
  if v_planned is null or v_planned < 0 then raise exception 'Informe o valor orçado' using errcode = 'P0180'; end if;
  if v_id is null then
    if not exists (select 1 from mkt.events where id = v_event and org_id = v_org) then raise exception 'Evento não encontrado' using errcode = 'P0182'; end if;
    insert into mkt.event_budget_lines (org_id, event_id, category, planned, memo) values (v_org, v_event, v_cat, v_planned, nullif(trim(coalesce(p ->> 'memo', '')), '')) returning * into l;
  else
    update mkt.event_budget_lines set category = v_cat, planned = v_planned, memo = nullif(trim(coalesce(p ->> 'memo', '')), '') where id = v_id and org_id = v_org returning * into l;
    if l.id is null then raise exception 'Linha não encontrada' using errcode = 'P0182'; end if;
  end if;
  return l;
end $$;

create or replace function mkt.delete_budget_line(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('crm.write');
  delete from mkt.event_budget_lines where id = p_id and org_id = private.org_id();
  if not found then raise exception 'Linha não encontrada' using errcode = 'P0182'; end if;
end $$;

-- ---------------------------------------------------------------------
-- 4) Resultado: vendas das convidadas na janela do evento (1 dia antes até 7 dias depois do fim), margem e custo real do Financeiro
-- ---------------------------------------------------------------------
create or replace function mkt.event_results(p_event uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  e mkt.events; v_from timestamptz; v_to timestamptz; v_status text[] := array['PAID', 'COMPLETED', 'FULFILLING', 'READY_FOR_PICKUP', 'SHIPPED', 'PARTIALLY_RETURNED'];
  v_rev numeric; v_cost numeric; v_orders int; v_buyers int; v_spent numeric := 0; v_planned numeric; v_counts jsonb; v_margin numeric;
begin
  perform private.require_perm('crm.read');
  select * into e from mkt.events where id = p_event and org_id = private.org_id();
  if e.id is null then raise exception 'Evento não encontrado' using errcode = 'P0182'; end if;
  v_from := e.starts_at - interval '1 day'; v_to := coalesce(e.ends_at, e.starts_at) + interval '7 days';
  select coalesce(sum(o.total), 0), coalesce(sum(o.cost_total), 0), count(*), count(distinct o.party_id) into v_rev, v_cost, v_orders, v_buyers
  from sales.orders o where o.org_id = e.org_id and o.party_id in (select party_id from mkt.event_guests where event_id = e.id) and o.status::text = any (v_status) and o.created_at >= v_from and o.created_at < v_to;
  select coalesce(sum(planned), 0) into v_planned from mkt.event_budget_lines where event_id = e.id;
  if e.cost_center_id is not null then
    select coalesce(sum(l.amount), 0) into v_spent from fin.title_lines l join fin.titles t on t.id = l.title_id where l.cost_center_id = e.cost_center_id and t.direction = 'PAYABLE' and t.status <> 'CANCELLED' and t.approval_status = 'APPROVED';
  end if;
  select coalesce(jsonb_object_agg(rsvp_status, n), '{}') into v_counts from (select rsvp_status, count(*) as n from mkt.event_guests where event_id = e.id group by 1) x;
  v_margin := v_rev - v_cost;
  return jsonb_build_object('guests', v_counts, 'headcount', private.event_headcount(e.id), 'capacity', e.capacity, 'revenue', round(v_rev, 2), 'cost_of_goods', round(v_cost, 2), 'margin', round(v_margin, 2),
    'orders', v_orders, 'buyers', v_buyers, 'avg_ticket', case when v_orders > 0 then round(v_rev / v_orders, 2) end, 'target_revenue', e.target_revenue,
    'planned', round(v_planned, 2), 'spent', round(v_spent, 2), 'roi', case when v_spent > 0 then round((v_margin - v_spent) / v_spent, 4) end,
    'window', jsonb_build_object('from', v_from, 'to', v_to));
end $$;

-- Quanto cada convidada comprou na janela
create or replace function mkt.event_guest_sales(p_event uuid) returns table (party_id uuid, orders integer, revenue numeric)
language plpgsql stable security definer set search_path = '' as $$
declare e mkt.events; v_status text[] := array['PAID', 'COMPLETED', 'FULFILLING', 'READY_FOR_PICKUP', 'SHIPPED', 'PARTIALLY_RETURNED'];
begin
  perform private.require_perm('crm.read');
  select * into e from mkt.events where id = p_event and org_id = private.org_id();
  if e.id is null then raise exception 'Evento não encontrado' using errcode = 'P0182'; end if;
  return query select o.party_id, count(*)::int, sum(o.total) from sales.orders o
    where o.org_id = e.org_id and o.party_id in (select g.party_id from mkt.event_guests g where g.event_id = e.id) and o.status::text = any (v_status)
      and o.created_at >= e.starts_at - interval '1 day' and o.created_at < coalesce(e.ends_at, e.starts_at) + interval '7 days' group by o.party_id;
end $$;

insert into private.internal_functions (fqname) values ('private.event_headcount') on conflict do nothing;
select private.lock_functions();
