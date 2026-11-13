-- Destino das sobras (13/11/2026). "Resolver" só escondia a linha: agora cada sobra / peça fora da NF tem um destino de verdade.
--  • COMPENSAR com um faltante parecido (outro tamanho/cor, preço parecido): a peça que chegou passa a valer pelo item da nota que faltou.
--    A linha da nota é dividida (a parte compensada vira uma linha própria com a peça que veio, no mesmo valor), então o lançamento
--    no estoque e no financeiro segue exatamente o mesmo caminho e a nota continua fechando.
--  • DAR ENTRADA SEM NF: entra no estoque do local do recebimento e fica "a definir", sem prazo: depois vira presente da marca
--    (entrada como patrocínio em espécie, custo zero) ou fica "NF a lançar" e, quando a nota chegar, é vinculada a ela.
--  • NÃO DAR ENTRADA E DEVOLVER: fica "a devolver" até marcar como devolvida.
--  • Tudo pode ser reaberto (a sobra volta a aparecer e os efeitos são desfeitos).
--  • Editar a quantidade da sobra e apagar: apagar vai para a LIXEIRA, que guarda 30 dias e permite restaurar.
--  • O que foi "resolvido" pelo botão antigo (que só escondia) volta a aparecer como pendente.

-- 1) o botão antigo só escondia: tudo volta a aparecer
update purch.receipt_scan_events set discarded_at = null, discarded_by = null where discarded_at is not null;

create table if not exists purch.extra_resolutions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  receipt_id uuid references purch.receipts(id) on delete set null,
  receipt_number text,
  action text not null check (action in ('COMPENSATE', 'ENTRY_NO_NF', 'RETURN')),
  status text not null default 'OPEN' check (status in ('OPEN', 'DONE')),                       -- OPEN: a devolver / a definir / NF a lançar
  destination text check (destination in ('GIFT', 'NF_LATER', 'NF_LINKED')),
  kind text not null, code text not null, label text, sku text, photo text,
  variant_id uuid references catalog.variants(id),
  qty numeric(12,3) not null check (qty > 0),
  note text,
  detail jsonb not null default '{}',
  created_by uuid references core.members(id),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references core.members(id)
);
create index if not exists extra_resolutions_open_idx on purch.extra_resolutions (org_id, status);
create index if not exists extra_resolutions_receipt_idx on purch.extra_resolutions (receipt_id);
select private.apply_rls('purch', array['extra_resolutions'], 'purch.read', 'purch.write');
select private.rpc_only('purch', array['extra_resolutions']);

alter table purch.receipt_scan_events add column if not exists resolution_id uuid references purch.extra_resolutions(id) on delete set null;
alter table purch.receipt_items add column if not exists compensation_id uuid references purch.extra_resolutions(id) on delete set null;

-- ---------- auxiliares ----------
-- quantidade pendente de uma leitura de sobra: o que passou (sobra) ou a quantidade lida (fora da nota / desconhecida)
create or replace function private.event_xq(p_result jsonb, p_qty numeric) returns numeric
language sql immutable set search_path = '' as $$
  select case when p_result ->> 'status' in ('EXCESS', 'PARTIAL_EXCESS') then coalesce((p_result ->> 'excess')::numeric, 0) else p_qty end
$$;

create or replace function private.event_set_xq(p_event bigint, p_xq numeric) returns void
language sql security definer set search_path = '' as $$
  update purch.receipt_scan_events e set
    result = case when e.result ->> 'status' in ('EXCESS', 'PARTIAL_EXCESS') then jsonb_set(e.result, '{excess}', to_jsonb(p_xq)) else e.result end,
    qty = case when e.result ->> 'status' in ('EXCESS', 'PARTIAL_EXCESS') then e.qty else p_xq end
  where e.id = p_event
$$;

-- consome até p_qty peças das leituras pendentes (do mais antigo ao mais novo), dividindo a última se for preciso, e marca com a resolução
create or replace function private.take_extra_events(p_org uuid, p_events bigint[], p_qty numeric, p_resolution uuid) returns numeric
language plpgsql security definer set search_path = '' as $$
declare ev purch.receipt_scan_events; v_left numeric := p_qty; v_xq numeric; v_take numeric; v_rv numeric;
begin
  for ev in select * from purch.receipt_scan_events e
             where e.id = any(p_events) and e.org_id = p_org and e.discarded_at is null and e.resolution_id is null order by e.id for update
  loop
    exit when v_left <= 0;
    v_xq := private.event_xq(ev.result, ev.qty);
    if v_xq <= 0 then continue; end if;
    v_take := least(v_left, v_xq);
    if v_take >= v_xq then
      update purch.receipt_scan_events set resolution_id = p_resolution where id = ev.id;
    else
      v_rv := least(ev.reviewed_qty, v_take);
      insert into purch.receipt_scan_events (org_id, receipt_id, item_id, link_id, member_id, code, qty, result, at, reviewed_qty, resolution_id)
      values (ev.org_id, ev.receipt_id, ev.item_id, ev.link_id, ev.member_id, ev.code, v_take,
              case when ev.result ->> 'status' in ('EXCESS', 'PARTIAL_EXCESS') then jsonb_set(ev.result, '{excess}', to_jsonb(v_take)) else ev.result end,
              ev.at, v_rv, p_resolution);
      perform private.event_set_xq(ev.id, v_xq - v_take);
      update purch.receipt_scan_events set reviewed_qty = reviewed_qty - v_rv where id = ev.id;
    end if;
    v_left := v_left - v_take;
  end loop;
  return p_qty - v_left;
end $$;

-- linhas de sobra (agrupadas por peça): pendentes ou na lixeira; por nota quando p_by_receipt
create or replace function private.extras_rows(p_receipts uuid[], p_by_receipt boolean, p_trash boolean) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('kind', g.kind, 'code', g.code, 'label', g.label, 'sku', g.sku, 'photo', g.photo, 'variant_id', g.variant_id,
                                               'qty', g.qty, 'reviewed', g.reviewed, 'events', g.events, 'last_at', g.last_at,
                                               'receipt_id', g.receipt_id, 'trashed_at', g.trashed_at) order by g.last_at desc), '[]'::jsonb)
  from (
    select x.kind, x.key, case when p_by_receipt then x.receipt_id end as receipt_id,
           (array_agg(x.code order by x.id desc))[1] as code,
           (array_agg(x.label order by x.id desc))[1] as label,
           (array_agg(x.sku order by x.id desc))[1] as sku,
           (array_agg(x.photo order by x.id desc))[1] as photo,
           (array_agg(x.variant_id order by x.id desc))[1] as variant_id,
           sum(x.qty) as qty, sum(least(x.reviewed, x.qty)) as reviewed, jsonb_agg(x.id order by x.id) as events,
           max(x.at) as last_at, max(x.trashed_at) as trashed_at
      from (
        select e.id, e.at, e.code, e.receipt_id, e.reviewed_qty as reviewed, e.discarded_at as trashed_at,
               case when e.result ->> 'status' in ('EXCESS', 'PARTIAL_EXCESS') then 'EXCESS' else e.result ->> 'status' end as kind,
               coalesce(e.result ->> 'variant_id', e.result ->> 'item_id', upper(e.code)) as key,
               coalesce(e.result ->> 'label', e.result ->> 'description') as label,
               e.result ->> 'sku' as sku, e.result ->> 'photo' as photo, e.result ->> 'variant_id' as variant_id,
               private.event_xq(e.result, e.qty) as qty
          from purch.receipt_scan_events e
         where e.receipt_id = any(p_receipts) and e.resolution_id is null
           and ((p_trash and e.discarded_at is not null) or (not p_trash and e.discarded_at is null))
           and e.result ->> 'status' in ('EXCESS', 'PARTIAL_EXCESS', 'NOT_IN_NOTE', 'UNKNOWN')
      ) x
     where x.qty > 0
     group by x.kind, x.key, case when p_by_receipt then x.receipt_id end
  ) g
$$;

create or replace function private.receipt_extras(p_receipts uuid[]) returns jsonb
language sql stable security definer set search_path = '' as $$
  select private.extras_rows(p_receipts, false, false)
$$;

-- ---------- lixeira (30 dias) e quantidade ----------
create or replace function private.purge_extras_trash(p_org uuid) returns void
language sql security definer set search_path = '' as $$
  delete from purch.receipt_scan_events where org_id = p_org and discarded_at is not null and resolution_id is null and discarded_at < now() - interval '30 days'
$$;

-- apagar: vai para a lixeira (só o que ainda está pendente)
create or replace function purch.discard_scan_extras(p_events bigint[]) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  perform private.require_perm('purch.write');
  if p_events is null or cardinality(p_events) > 500 then raise exception 'Leituras demais de uma vez' using errcode = 'P0086'; end if;
  perform private.purge_extras_trash(private.org_id());
  update purch.receipt_scan_events set discarded_at = now(), discarded_by = private.member_id()
   where id = any(p_events) and org_id = private.org_id() and discarded_at is null and resolution_id is null;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function purch.restore_extras(p_events bigint[]) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  perform private.require_perm('purch.write');
  if p_events is null or cardinality(p_events) > 500 then raise exception 'Leituras demais de uma vez' using errcode = 'P0086'; end if;
  update purch.receipt_scan_events set discarded_at = null, discarded_by = null
   where id = any(p_events) and org_id = private.org_id() and discarded_at is not null and resolution_id is null;
  get diagnostics n = row_count;
  return n;
end $$;

-- editar a quantidade da sobra (0 = apagar, vai para a lixeira)
create or replace function purch.set_extra_qty(p_events bigint[], p_qty numeric) returns numeric
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); ev purch.receipt_scan_events; v_total numeric := 0; v_diff numeric; v_xq numeric; v_last bigint;
begin
  perform private.require_perm('purch.write');
  if p_events is null or cardinality(p_events) > 500 or p_qty is null or p_qty < 0 or p_qty <> trunc(p_qty) then raise exception 'Quantidade inválida' using errcode = 'P0086'; end if;
  select coalesce(sum(private.event_xq(e.result, e.qty)), 0), max(e.id) into v_total, v_last from purch.receipt_scan_events e
   where e.id = any(p_events) and e.org_id = v_org and e.discarded_at is null and e.resolution_id is null;
  if v_last is null or v_total <= 0 then raise exception 'Sobra não encontrada ou já resolvida' using errcode = 'P0460'; end if;
  if p_qty = v_total then return v_total; end if;
  if p_qty > v_total then
    select * into ev from purch.receipt_scan_events where id = v_last for update;
    perform private.event_set_xq(ev.id, private.event_xq(ev.result, ev.qty) + (p_qty - v_total));
    return p_qty;
  end if;
  v_diff := v_total - p_qty;                                        -- tira do mais novo para o mais antigo; o que zera vai para a lixeira
  for ev in select * from purch.receipt_scan_events e where e.id = any(p_events) and e.org_id = v_org and e.discarded_at is null and e.resolution_id is null order by e.id desc for update loop
    exit when v_diff <= 0;
    v_xq := private.event_xq(ev.result, ev.qty);
    if v_xq <= 0 then continue; end if;
    if v_xq <= v_diff then
      update purch.receipt_scan_events set discarded_at = now(), discarded_by = private.member_id() where id = ev.id;
      v_diff := v_diff - v_xq;
    else
      perform private.event_set_xq(ev.id, v_xq - v_diff);
      update purch.receipt_scan_events set reviewed_qty = least(reviewed_qty, v_xq - v_diff) where id = ev.id;
      v_diff := 0;
    end if;
  end loop;
  return p_qty;
end $$;

-- ---------- o que fazer com a sobra ----------
-- p = {action: COMPENSATE | ENTRY_NO_NF | RETURN, events: [ids da linha], qty?, variant_id? (peça do catálogo, quando a leitura não tem),
--      target_item_id? (COMPENSATE: item da nota que faltou), note?}
create or replace function purch.resolve_extra(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id();
  v_action text := upper(coalesce(p ->> 'action', ''));
  v_events bigint[];
  ev purch.receipt_scan_events; rc purch.receipts; trc purch.receipts; ti purch.receipt_items; r purch.extra_resolutions;
  v_pending numeric; v_qty numeric; v_variant uuid; v_res uuid := gen_random_uuid(); v_status text := 'OPEN';
  v_kind text; v_detail jsonb := '{}'::jsonb; v_mv bigint; v_missing numeric; v_amt numeric; v_n int; v_new uuid;
  v_note text := nullif(btrim(coalesce(p ->> 'note', '')), '');
begin
  perform private.require_perm('purch.write');
  if v_action not in ('COMPENSATE', 'ENTRY_NO_NF', 'RETURN') then raise exception 'Escolha o que fazer com a peça' using errcode = 'P0086'; end if;
  if jsonb_typeof(p -> 'events') is distinct from 'array' then raise exception 'Escolha a sobra' using errcode = 'P0086'; end if;
  v_events := array(select x::bigint from jsonb_array_elements_text(p -> 'events') x);
  select * into ev from purch.receipt_scan_events e where e.id = any(v_events) and e.org_id = v_org and e.discarded_at is null and e.resolution_id is null order by e.id limit 1;
  if ev.id is null then raise exception 'Esta sobra já foi resolvida ou apagada' using errcode = 'P0460'; end if;
  select coalesce(sum(private.event_xq(e.result, e.qty)), 0) into v_pending from purch.receipt_scan_events e
   where e.id = any(v_events) and e.org_id = v_org and e.discarded_at is null and e.resolution_id is null;
  v_qty := coalesce(nullif(p ->> 'qty', '')::numeric, v_pending);
  if v_qty is null or v_qty <= 0 or v_qty > v_pending or v_qty <> trunc(v_qty) then
    raise exception 'Quantidade inválida: há % peça(s) pendente(s) nesta linha', trim_scale(v_pending) using errcode = 'P0086';
  end if;
  select * into rc from purch.receipts where id = ev.receipt_id and org_id = v_org;
  if rc.id is null then raise exception 'Recebimento não encontrado'; end if;
  v_variant := coalesce(nullif(p ->> 'variant_id', '')::uuid, nullif(ev.result ->> 'variant_id', '')::uuid);
  if v_action in ('COMPENSATE', 'ENTRY_NO_NF') and (v_variant is null or not exists (select 1 from catalog.variants where id = v_variant and org_id = v_org and active)) then
    raise exception 'Escolha a peça do catálogo que chegou' using errcode = 'P0086';
  end if;
  v_kind := case when ev.result ->> 'status' in ('EXCESS', 'PARTIAL_EXCESS') then 'EXCESS' else ev.result ->> 'status' end;

  insert into purch.extra_resolutions (id, org_id, receipt_id, receipt_number, action, status, kind, code, label, sku, photo, variant_id, qty, note, created_by)
  values (v_res, v_org, rc.id, rc.number, v_action, 'OPEN', v_kind, ev.code, coalesce(ev.result ->> 'label', ev.result ->> 'description'), ev.result ->> 'sku',
          ev.result ->> 'photo', v_variant, v_qty, v_note, private.member_id());

  if v_action = 'ENTRY_NO_NF' then
    perform private.require_perm('inv.write');
    insert into inv.movements (org_id, occurred_at, variant_id, location_id, qty, movement_type, source_type, source_id, notes, created_by)
    values (v_org, now(), v_variant, rc.location_id, v_qty, 'COUNT_ADJUST', 'purch.extra_resolutions', v_res,
            'Entrada sem NF (a definir) — recebimento ' || rc.number, private.member_id())
    returning id into v_mv;
    v_detail := jsonb_build_object('movement_id', v_mv, 'effective_movement_id', v_mv, 'location_id', rc.location_id);

  elsif v_action = 'COMPENSATE' then
    select * into ti from purch.receipt_items where id = nullif(p ->> 'target_item_id', '')::uuid and org_id = v_org for update;
    if ti.id is null then raise exception 'Escolha o item da nota que faltou' using errcode = 'P0086'; end if;
    select * into trc from purch.receipts where id = ti.receipt_id;
    if trc.status = 'POSTED' then raise exception 'A nota deste item já foi lançada no estoque' using errcode = 'P0083'; end if;
    v_missing := ti.qty_nfe - coalesce(ti.qty_counted, 0);
    if v_qty > v_missing then raise exception 'Este item da nota só tem % peça(s) faltando', trim_scale(v_missing) using errcode = 'P0086'; end if;
    v_amt := round(ti.item_total * v_qty / ti.qty_nfe, 2);
    if v_qty = ti.qty_nfe then
      -- a linha inteira faltava: ela passa a ser da peça que veio
      v_detail := jsonb_build_object('mode', 'RELINK', 'item_id', ti.id, 'prev_variant', ti.variant_id, 'prev_status', ti.match_status, 'prev_counted', ti.qty_counted);
      update purch.receipt_items set variant_id = v_variant, match_status = 'MANUAL', match_confidence = null, qty_counted = ti.qty_nfe, compensation_id = v_res where id = ti.id;
    else
      -- parte da linha: vira uma linha própria com a peça que veio, no mesmo valor (a soma da nota não muda)
      select coalesce(max(n_item), 0) + 1 into v_n from purch.receipt_items where receipt_id = ti.receipt_id;
      insert into purch.receipt_items (org_id, receipt_id, n_item, supplier_cprod, cean, description, ncm, cfop, unit, qty_nfe, qty_counted,
                                       unit_cost_nfe, item_total, landed_unit_cost, variant_id, match_status, compensation_id)
      values (ti.org_id, ti.receipt_id, v_n, ti.supplier_cprod, null, 'COMPENSAÇÃO: ' || coalesce(ti.description, ''), ti.ncm, ti.cfop, ti.unit, v_qty, v_qty,
              ti.unit_cost_nfe, v_amt, round(v_amt / v_qty, 4), v_variant, 'MANUAL', v_res)
      returning id into v_new;
      update purch.receipt_items set qty_nfe = ti.qty_nfe - v_qty, item_total = ti.item_total - v_amt,
             landed_unit_cost = round((ti.item_total - v_amt) / (ti.qty_nfe - v_qty), 4) where id = ti.id;
      v_detail := jsonb_build_object('mode', 'SPLIT', 'item_id', ti.id, 'new_item_id', v_new, 'amount', v_amt, 'qty', v_qty);
    end if;
    v_detail := v_detail || jsonb_build_object('target_receipt_id', ti.receipt_id, 'target_label', ti.description);
    update purch.receipts set status = 'PENDING_CHECK', checked_by = null, checked_at = null where id = ti.receipt_id and status = 'CHECKED';
    v_status := 'DONE';
  end if;

  perform private.take_extra_events(v_org, v_events, v_qty, v_res);
  update purch.extra_resolutions set detail = v_detail, status = v_status,
         decided_at = case when v_status = 'DONE' then now() end, decided_by = case when v_status = 'DONE' then private.member_id() end
   where id = v_res returning * into r;
  return to_jsonb(r);
end $$;

-- reabre: a sobra volta a aparecer e os efeitos são desfeitos
create or replace function purch.reopen_extra_resolution(p_resolution uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id(); r purch.extra_resolutions; m inv.movements; trc purch.receipts; ti purch.receipt_items;
begin
  perform private.require_perm('purch.write');
  select * into r from purch.extra_resolutions where id = p_resolution and org_id = v_org for update;
  if r.id is null then raise exception 'Resolução não encontrada' using errcode = 'P0460'; end if;
  if r.action = 'ENTRY_NO_NF' then
    perform private.require_perm('inv.write');
    if r.destination = 'NF_LINKED' then raise exception 'Esta entrada já foi vinculada a uma NF-e: desfaça o vínculo na nota antes' using errcode = 'P0083'; end if;
    select * into m from inv.movements where id = (r.detail ->> 'effective_movement_id')::bigint;
    if m.id is not null then
      insert into inv.movements (org_id, occurred_at, variant_id, location_id, qty, unit_cost, movement_type, source_type, source_id, reversal_of_id, notes, created_by)
      values (v_org, now(), m.variant_id, m.location_id, -m.qty, m.unit_cost, 'COUNT_ADJUST', 'purch.extra_resolutions', r.id, m.id,
              'Entrada sem NF desfeita (sobra reaberta)', private.member_id());
    end if;
  elsif r.action = 'COMPENSATE' then
    select * into ti from purch.receipt_items where id = (r.detail ->> 'item_id')::uuid and org_id = v_org for update;
    select * into trc from purch.receipts where id = (r.detail ->> 'target_receipt_id')::uuid;
    if trc.id is not null and trc.status = 'POSTED' then raise exception 'A nota já foi lançada no estoque: estorne o recebimento antes de reabrir a sobra' using errcode = 'P0083'; end if;
    if ti.id is not null then
      if r.detail ->> 'mode' = 'RELINK' then
        update purch.receipt_items set variant_id = nullif(r.detail ->> 'prev_variant', '')::uuid, match_status = coalesce(r.detail ->> 'prev_status', 'UNMATCHED'),
               qty_counted = nullif(r.detail ->> 'prev_counted', '')::numeric, compensation_id = null where id = ti.id;
      else
        update purch.receipt_items set qty_nfe = qty_nfe + (r.detail ->> 'qty')::numeric, item_total = item_total + (r.detail ->> 'amount')::numeric,
               landed_unit_cost = round((item_total + (r.detail ->> 'amount')::numeric) / (qty_nfe + (r.detail ->> 'qty')::numeric), 4) where id = ti.id;
        delete from purch.receipt_items where id = (r.detail ->> 'new_item_id')::uuid;
      end if;
      update purch.receipts set status = 'PENDING_CHECK', checked_by = null, checked_at = null where id = ti.receipt_id and status = 'CHECKED';
    end if;
  end if;
  update purch.receipt_scan_events set resolution_id = null where resolution_id = r.id;
  delete from purch.extra_resolutions where id = r.id;
end $$;

-- devolução: marcar como devolvida
create or replace function purch.mark_extra_returned(p_resolution uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('purch.write');
  update purch.extra_resolutions set status = 'DONE', decided_at = now(), decided_by = private.member_id()
   where id = p_resolution and org_id = private.org_id() and action = 'RETURN' and status = 'OPEN';
  if not found then raise exception 'Devolução não encontrada ou já concluída' using errcode = 'P0460'; end if;
end $$;

-- entrada sem NF: definir depois e sem prazo — presente da marca ou NF a lançar
create or replace function purch.define_no_nf_entry(p_resolution uuid, p_destination text, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare r purch.extra_resolutions; m inv.movements; v_dest text := upper(coalesce(p_destination, '')); v_gift bigint; rc purch.receipts;
begin
  perform private.require_perm('purch.write');
  perform private.require_perm('inv.write');
  if v_dest not in ('GIFT', 'NF_LATER') then raise exception 'Escolha: presente da marca ou NF a lançar depois' using errcode = 'P0086'; end if;
  select * into r from purch.extra_resolutions where id = p_resolution and org_id = private.org_id() for update;
  if r.id is null or r.action <> 'ENTRY_NO_NF' then raise exception 'Entrada sem NF não encontrada' using errcode = 'P0460'; end if;
  if r.destination in ('GIFT', 'NF_LINKED') then raise exception 'Esta entrada já foi definida (reabra a sobra para mudar)' using errcode = 'P0083'; end if;
  if v_dest = 'GIFT' then
    select * into m from inv.movements where id = (r.detail ->> 'movement_id')::bigint;
    if m.id is null then raise exception 'Movimento de estoque da entrada não encontrado'; end if;
    -- reclassifica sem mexer no saldo: entra como patrocínio em espécie (custo zero) e sai a entrada genérica
    insert into inv.movements (org_id, occurred_at, variant_id, location_id, qty, unit_cost, movement_type, source_type, source_id, notes, created_by)
    values (r.org_id, now(), m.variant_id, m.location_id, r.qty, 0, 'SPONSORSHIP_IN_KIND', 'purch.extra_resolutions', r.id,
            'Presente da marca (entrada sem NF)' || coalesce(' — recebimento ' || r.receipt_number, ''), private.member_id())
    returning id into v_gift;
    insert into inv.movements (org_id, occurred_at, variant_id, location_id, qty, unit_cost, movement_type, source_type, source_id, reversal_of_id, notes, created_by)
    values (r.org_id, now(), m.variant_id, m.location_id, -r.qty, m.unit_cost, 'COUNT_ADJUST', 'purch.extra_resolutions', r.id, m.id,
            'Reclassificada como presente da marca', private.member_id());
    update purch.extra_resolutions set destination = 'GIFT', status = 'DONE', note = coalesce(nullif(btrim(p_note), ''), note), decided_at = now(), decided_by = private.member_id(),
           detail = detail || jsonb_build_object('effective_movement_id', v_gift, 'gift_movement_id', v_gift) where id = r.id;
  else
    update purch.extra_resolutions set destination = 'NF_LATER', status = 'OPEN', note = coalesce(nullif(btrim(p_note), ''), note) where id = r.id;
  end if;
end $$;

-- entrada sem NF "a lançar depois": quando a nota chega, vincula ao item dela (o estoque passa a entrar pelo lançamento da nota)
create or replace function purch.link_no_nf_entry(p_resolution uuid, p_receipt uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r purch.extra_resolutions; rc purch.receipts; ti purch.receipt_items; m inv.movements; v_org uuid := private.org_id();
begin
  perform private.require_perm('purch.write');
  perform private.require_perm('inv.write');
  select * into r from purch.extra_resolutions where id = p_resolution and org_id = v_org for update;
  if r.id is null or r.action <> 'ENTRY_NO_NF' or r.destination is not null and r.destination <> 'NF_LATER' then
    raise exception 'Entrada sem NF não encontrada ou já definida' using errcode = 'P0460';
  end if;
  select * into rc from purch.receipts where id = p_receipt and org_id = v_org;
  if rc.id is null then raise exception 'Nota não encontrada' using errcode = 'P0460'; end if;
  if rc.status = 'POSTED' then raise exception 'Esta nota já foi lançada no estoque' using errcode = 'P0083'; end if;
  select * into ti from purch.receipt_items i
   where i.receipt_id = rc.id and i.variant_id = r.variant_id and i.qty_nfe - coalesce(i.qty_counted, 0) >= r.qty order by i.n_item limit 1 for update;
  if ti.id is null then raise exception 'A nota não tem essa peça com saldo para % unidade(s)', trim_scale(r.qty) using errcode = 'P0083'; end if;
  select * into m from inv.movements where id = (r.detail ->> 'effective_movement_id')::bigint;
  if m.id is not null then
    insert into inv.movements (org_id, occurred_at, variant_id, location_id, qty, unit_cost, movement_type, source_type, source_id, reversal_of_id, notes, created_by)
    values (v_org, now(), m.variant_id, m.location_id, -m.qty, m.unit_cost, 'COUNT_ADJUST', 'purch.extra_resolutions', r.id, m.id,
            'Entrada sem NF vinculada à NF-e do recebimento ' || rc.number || ' (passa a entrar pelo lançamento da nota)', private.member_id());
  end if;
  update purch.receipt_items set qty_counted = coalesce(qty_counted, 0) + r.qty where id = ti.id;
  update purch.receipts set status = 'PENDING_CHECK', checked_by = null, checked_at = null where id = rc.id and status = 'CHECKED';
  update purch.extra_resolutions set destination = 'NF_LINKED', status = 'DONE', decided_at = now(), decided_by = private.member_id(),
         detail = detail || jsonb_build_object('linked_receipt_id', rc.id, 'linked_item_id', ti.id, 'linked_receipt_number', rc.number) where id = r.id;
end $$;

-- visão geral: pendentes, resolvidas (a devolver, a definir, compensadas…) e lixeira. p_receipts nulo = todas as notas (página de sobras)
create or replace function purch.extras_overview(p_receipts uuid[] default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); v_ids uuid[];
begin
  perform private.require_perm('purch.read');
  perform private.purge_extras_trash(v_org);
  v_ids := array(select r.id from purch.receipts r where r.org_id = v_org and (p_receipts is null or r.id = any(p_receipts)));
  return jsonb_build_object(
    'pending', private.extras_rows(v_ids, p_receipts is null, false),
    'trash', private.extras_rows(v_ids, p_receipts is null, true),
    'resolutions', coalesce((
      select jsonb_agg(jsonb_build_object('id', x.id, 'receipt_id', x.receipt_id, 'receipt_number', x.receipt_number, 'action', x.action, 'status', x.status,
               'destination', x.destination, 'kind', x.kind, 'code', x.code, 'label', x.label, 'sku', x.sku, 'photo', x.photo, 'variant_id', x.variant_id,
               'qty', x.qty, 'note', x.note, 'detail', x.detail, 'created_at', x.created_at, 'decided_at', x.decided_at) order by x.created_at desc)
        from purch.extra_resolutions x where x.org_id = v_org and (p_receipts is null or x.receipt_id = any(v_ids))), '[]'::jsonb));
end $$;

insert into private.internal_functions (fqname) values
  ('private.event_xq'), ('private.event_set_xq'), ('private.take_extra_events'), ('private.extras_rows'), ('private.purge_extras_trash')
on conflict do nothing;
select private.lock_functions();
