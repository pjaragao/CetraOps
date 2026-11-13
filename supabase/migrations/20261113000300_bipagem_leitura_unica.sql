-- Leitura única (13/11/2026): uma peça apareceu com 6 leituras de uma vez quando o celular "engasgou" — a tela reenviava a leitura que
-- tinha dado tempo esgotado, mas o servidor já tinha somado. Agora cada leitura carrega um id (criado no aparelho, guardado junto na fila)
-- e o servidor, vendo o mesmo id de novo, devolve o resultado de antes sem somar. Vale para bipar e para revisar, no computador e no link.
-- (A trava de leituras repetidas em menos de 0,5 s e o ajuste da câmera lenta ficam na tela.)

create table if not exists purch.scan_dedup (
  client_id uuid primary key,
  org_id uuid not null references core.orgs(id),
  result jsonb not null,
  at timestamptz not null default now()
);
alter table purch.scan_dedup enable row level security;
revoke all on purch.scan_dedup from anon, authenticated;

drop function if exists private.receipt_scan_group(uuid, uuid[], text, numeric, uuid, uuid);
drop function if exists private.receipt_review_group(uuid, uuid[], text, numeric, uuid, uuid);

-- ---------- bipar ----------
create or replace function private.receipt_scan_group(p_org uuid, p_receipts uuid[], p_code text, p_qty numeric, p_member uuid, p_link uuid, p_client uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_code text := btrim(coalesce(p_code, ''));
  v_digits boolean;
  v_ids uuid[]; v_suppliers uuid[]; v_vars uuid[];
  ri purch.receipt_items;
  v_left numeric := p_qty; v_room numeric; v_add numeric;
  v_alloc jsonb := '[]'::jsonb; v_cands jsonb := '[]'::jsonb;
  v_first uuid; v_first_rc uuid; v_pick uuid; v_pick_rc uuid; v_rc uuid;
  v_sum_nfe numeric; v_sum_cnt numeric;
  v_var catalog.variants; v_res jsonb; v_ev bigint; v_prev jsonb; v_final jsonb;
begin
  if v_code = '' or length(v_code) > 80 then raise exception 'Código vazio ou longo demais' using errcode = 'P0086'; end if;
  if p_qty is null or p_qty <= 0 or p_qty > 10000 then raise exception 'Quantidade por leitura inválida' using errcode = 'P0086'; end if;
  if p_receipts is null or cardinality(p_receipts) = 0 or cardinality(p_receipts) > 20 then raise exception 'Escolha de 1 a 20 notas' using errcode = 'P0086'; end if;

  -- trava as notas sempre na mesma ordem (dois aparelhos bipando ao mesmo tempo não se travam um ao outro)
  perform 1 from purch.receipts where id = any(p_receipts) and org_id = p_org order by id for update;
  select coalesce(array_agg(x.id order by x.ord), '{}'::uuid[]) into v_ids
    from unnest(p_receipts) with ordinality as x(id, ord)
    join purch.receipts rc on rc.id = x.id and rc.org_id = p_org
   where rc.status <> 'POSTED';
  if cardinality(v_ids) = 0 then
    if exists (select 1 from purch.receipts where id = any(p_receipts) and org_id = p_org) then
      raise exception 'Recebimento já lançado no estoque' using errcode = 'P0083';
    end if;
    raise exception 'Recebimento não encontrado';
  end if;
  v_digits := v_code ~ '^\d{8,14}$';

  -- a mesma leitura reenviada (rede lenta, tentativa repetida) devolve o resultado de antes e NÃO soma de novo
  if p_client is not null then
    select d.result into v_prev from purch.scan_dedup d where d.client_id = p_client and d.org_id = p_org;
    if found then return v_prev || jsonb_build_object('duplicate', true); end if;
  end if;

  select array_agg(distinct supplier_party_id) into v_suppliers from purch.receipts where id = any(v_ids);
  select array_agg(distinct id) into v_vars from (
    select v.id from catalog.variants v
     where v.org_id = p_org and (upper(v.sku) = upper(v_code) or (v_digits and v.gtin = v_code) or upper(v.supplier_sku) = upper(v_code))
    union
    select si.variant_id from catalog.supplier_items si
     where si.org_id = p_org and si.supplier_party_id = any(v_suppliers) and si.variant_id is not null
       and (upper(si.supplier_cprod) = upper(v_code) or (v_digits and si.supplier_ean = v_code))
  ) s;

  -- as linhas das notas com esta peça: primeiro as que ainda faltam, na ordem das notas escolhidas
  for ri in
    select i.* from purch.receipt_items i
     where i.receipt_id = any(v_ids)
       and ((v_digits and i.cean = v_code and i.cean !~ '^0+$') or upper(i.supplier_cprod) = upper(v_code) or i.variant_id = any(coalesce(v_vars, '{}')))
     order by (coalesce(i.qty_counted, 0) < i.qty_nfe) desc, array_position(v_ids, i.receipt_id), i.n_item
     for update
  loop
    v_cands := v_cands || jsonb_build_array(ri.id);
    if v_first is null then v_first := ri.id; v_first_rc := ri.receipt_id; end if;
    v_room := ri.qty_nfe - coalesce(ri.qty_counted, 0);
    if v_left > 0 and v_room > 0 then
      v_add := least(v_left, v_room);
      update purch.receipt_items set qty_counted = coalesce(qty_counted, 0) + v_add where id = ri.id;
      update purch.receipts set status = 'PENDING_CHECK', checked_by = null, checked_at = null where id = ri.receipt_id and status = 'CHECKED';
      v_left := v_left - v_add;
      if v_pick is null then v_pick := ri.id; v_pick_rc := ri.receipt_id; end if;
      v_alloc := v_alloc || jsonb_build_array(jsonb_build_object('receipt_id', ri.receipt_id, 'item_id', ri.id, 'added', v_add,
                                                                'qty_counted', coalesce(ri.qty_counted, 0) + v_add, 'qty_nfe', ri.qty_nfe));
    end if;
  end loop;

  if v_first is null then
    if coalesce(array_length(v_vars, 1), 0) > 0 then
      select * into v_var from catalog.variants where id = v_vars[1];
      v_res := jsonb_build_object('status', 'NOT_IN_NOTE', 'code', v_code, 'variant_id', v_var.id, 'sku', v_var.sku,
        'label', (select concat_ws(' · ', p.name, c.name, v_var.size) from catalog.products p left join catalog.colors c on c.id = v_var.color_id where p.id = v_var.product_id),
        'photo', (select m.storage_path from catalog.product_media m where m.product_id = v_var.product_id
                   order by (m.color_id is not distinct from v_var.color_id) desc, m.position limit 1));
    else
      v_res := jsonb_build_object('status', 'UNKNOWN', 'code', v_code);
    end if;
    v_rc := v_ids[1];
  else
    -- o total da peça nas notas juntas (é o "3/5" que a pessoa vê)
    select coalesce(sum(qty_nfe), 0), coalesce(sum(coalesce(qty_counted, 0)), 0) into v_sum_nfe, v_sum_cnt
      from purch.receipt_items where id in (select x::uuid from jsonb_array_elements_text(v_cands) x);
    v_res := purch.receipt_item_view(coalesce(v_pick, v_first)) || jsonb_build_object(
      'status', case when p_qty - v_left = 0 then 'EXCESS' when v_left > 0 then 'PARTIAL_EXCESS' else 'OK' end,
      'code', v_code, 'added', p_qty - v_left, 'excess', v_left, 'qty_nfe', v_sum_nfe, 'qty_counted', v_sum_cnt,
      'allocations', v_alloc, 'candidates', v_cands);
    v_rc := coalesce(v_pick_rc, v_first_rc);
  end if;

  insert into purch.receipt_scan_events (org_id, receipt_id, item_id, link_id, member_id, code, qty, result)
  values (p_org, v_rc, coalesce(v_pick, v_first), p_link, p_member, v_code, p_qty, v_res) returning id into v_ev;
  v_final := v_res || jsonb_build_object('event_id', v_ev);
  if p_client is not null then
    insert into purch.scan_dedup (client_id, org_id, result) values (p_client, p_org, v_final) on conflict do nothing;
    if random() < 0.02 then delete from purch.scan_dedup where at < now() - interval '2 days'; end if;
  end if;
  return v_final;
end $$;

-- ---------- revisar ----------
create or replace function private.receipt_review_group(p_org uuid, p_receipts uuid[], p_code text, p_qty numeric, p_member uuid, p_link uuid, p_client uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_code text := btrim(coalesce(p_code, ''));
  v_digits boolean;
  v_ids uuid[]; v_suppliers uuid[]; v_vars uuid[];
  ri purch.receipt_items; ev record;
  v_left numeric := p_qty; v_room numeric; v_add numeric; v_extra_add numeric := 0;
  v_alloc jsonb := '[]'::jsonb; v_cands jsonb := '[]'::jsonb;
  v_first uuid; v_first_rc uuid; v_pick uuid; v_room_note boolean;
  v_sum_cnt numeric := 0; v_sum_rev numeric := 0; v_ex_rev numeric; v_ex_qty numeric;
  v_var catalog.variants; v_ni jsonb; v_new jsonb; v_res jsonb; v_ev bigint; v_status text; v_kind text; v_prev jsonb;
begin
  if v_code = '' or length(v_code) > 80 then raise exception 'Código vazio ou longo demais' using errcode = 'P0086'; end if;
  if p_qty is null or p_qty <= 0 or p_qty > 10000 then raise exception 'Quantidade por leitura inválida' using errcode = 'P0086'; end if;
  if p_receipts is null or cardinality(p_receipts) = 0 or cardinality(p_receipts) > 20 then raise exception 'Escolha de 1 a 20 notas' using errcode = 'P0086'; end if;

  perform 1 from purch.receipts where id = any(p_receipts) and org_id = p_org order by id for update;
  select coalesce(array_agg(x.id order by x.ord), '{}'::uuid[]) into v_ids
    from unnest(p_receipts) with ordinality as x(id, ord)
    join purch.receipts rc on rc.id = x.id and rc.org_id = p_org
   where rc.status <> 'POSTED';
  if cardinality(v_ids) = 0 then
    if exists (select 1 from purch.receipts where id = any(p_receipts) and org_id = p_org) then
      raise exception 'Recebimento já lançado no estoque' using errcode = 'P0083';
    end if;
    raise exception 'Recebimento não encontrado';
  end if;
  v_digits := v_code ~ '^\d{8,14}$';

  if p_client is not null then
    select d.result into v_prev from purch.scan_dedup d where d.client_id = p_client and d.org_id = p_org;
    if found then return v_prev || jsonb_build_object('duplicate', true); end if;
  end if;

  select array_agg(distinct supplier_party_id) into v_suppliers from purch.receipts where id = any(v_ids);
  select array_agg(distinct id) into v_vars from (
    select v.id from catalog.variants v
     where v.org_id = p_org and (upper(v.sku) = upper(v_code) or (v_digits and v.gtin = v_code) or upper(v.supplier_sku) = upper(v_code))
    union
    select si.variant_id from catalog.supplier_items si
     where si.org_id = p_org and si.supplier_party_id = any(v_suppliers) and si.variant_id is not null
       and (upper(si.supplier_cprod) = upper(v_code) or (v_digits and si.supplier_ean = v_code))
  ) s;

  -- 1) as linhas da nota com esta peça: primeiro as que ainda têm contagem por revisar
  for ri in
    select i.* from purch.receipt_items i
     where i.receipt_id = any(v_ids)
       and ((v_digits and i.cean = v_code and i.cean !~ '^0+$') or upper(i.supplier_cprod) = upper(v_code) or i.variant_id = any(coalesce(v_vars, '{}')))
     order by (i.qty_reviewed < coalesce(i.qty_counted, 0)) desc, array_position(v_ids, i.receipt_id), i.n_item
     for update
  loop
    v_cands := v_cands || jsonb_build_array(ri.id);
    if v_first is null then v_first := ri.id; v_first_rc := ri.receipt_id; end if;
    v_room := coalesce(ri.qty_counted, 0) - ri.qty_reviewed;
    if v_left > 0 and v_room > 0 then
      v_add := least(v_left, v_room);
      update purch.receipt_items set qty_reviewed = qty_reviewed + v_add where id = ri.id;
      v_left := v_left - v_add;
      if v_pick is null then v_pick := ri.id; end if;
      v_alloc := v_alloc || jsonb_build_array(jsonb_build_object('receipt_id', ri.receipt_id, 'item_id', ri.id, 'added', v_add,
                                                                'qty_reviewed', ri.qty_reviewed + v_add, 'qty_counted', coalesce(ri.qty_counted, 0)));
    end if;
  end loop;

  -- 2) o que passou: confere as sobras desta peça que já estavam registradas (ficam separadas dos itens da nota)
  for ev in
    select e.id, e.reviewed_qty,
           case when e.result ->> 'status' in ('EXCESS', 'PARTIAL_EXCESS') then coalesce((e.result ->> 'excess')::numeric, 0) else e.qty end as xq
      from purch.receipt_scan_events e
     where e.receipt_id = any(v_ids) and e.discarded_at is null and e.resolution_id is null and e.result ->> 'status' in ('EXCESS', 'PARTIAL_EXCESS', 'NOT_IN_NOTE', 'UNKNOWN')
       and (upper(e.code) = upper(v_code)
            or e.result ->> 'variant_id' = any(array(select x::text from unnest(coalesce(v_vars, '{}'::uuid[])) x))
            or e.result ->> 'item_id' in (select x from jsonb_array_elements_text(v_cands) x))
     order by e.id
     for update of e
  loop
    exit when v_left <= 0;
    if ev.xq - ev.reviewed_qty > 0 then
      v_add := least(v_left, ev.xq - ev.reviewed_qty);
      update purch.receipt_scan_events set reviewed_qty = reviewed_qty + v_add where id = ev.id;
      v_left := v_left - v_add;
      v_extra_add := v_extra_add + v_add;
    end if;
  end loop;

  v_room_note := v_first is not null and exists (select 1 from purch.receipt_items
                   where id in (select x::uuid from jsonb_array_elements_text(v_cands) x) and coalesce(qty_counted, 0) < qty_nfe);

  if v_first is null then
    if coalesce(array_length(v_vars, 1), 0) > 0 then
      select * into v_var from catalog.variants where id = v_vars[1];
      v_ni := jsonb_build_object('status', 'NOT_IN_NOTE', 'code', v_code, 'variant_id', v_var.id, 'sku', v_var.sku,
        'label', (select concat_ws(' · ', p.name, c.name, v_var.size) from catalog.products p left join catalog.colors c on c.id = v_var.color_id where p.id = v_var.product_id),
        'photo', (select m.storage_path from catalog.product_media m where m.product_id = v_var.product_id
                   order by (m.color_id is not distinct from v_var.color_id) desc, m.position limit 1));
    else
      v_ni := jsonb_build_object('status', 'UNKNOWN', 'code', v_code);
    end if;
  end if;

  -- 3) ainda sobrou: não cabe em nenhuma linha da nota (ou a nota já está completa para a peça). Chegou fisicamente e não está na NF:
  --    fica registrada como sobra/fora da nota, já conferida, separada dos itens
  if v_left > 0 and not v_room_note then
    if v_first is null then
      v_new := v_ni;
      v_kind := v_ni ->> 'status';
    else
      v_new := purch.receipt_item_view(v_first) || jsonb_build_object('status', 'EXCESS', 'code', v_code, 'added', 0, 'excess', v_left);
      v_kind := 'EXCESS';
    end if;
    insert into purch.receipt_scan_events (org_id, receipt_id, item_id, link_id, member_id, code, qty, result, reviewed_qty)
    values (p_org, coalesce(v_first_rc, v_ids[1]), v_first, p_link, p_member, v_code, v_left, v_new || jsonb_build_object('review', true), v_left)
    returning id into v_ev;
    v_extra_add := v_extra_add + v_left;
    v_left := 0;
  end if;

  if v_first is not null then
    select coalesce(sum(coalesce(qty_counted, 0)), 0), coalesce(sum(qty_reviewed), 0) into v_sum_cnt, v_sum_rev
      from purch.receipt_items where id in (select x::uuid from jsonb_array_elements_text(v_cands) x);
    v_status := case when v_left = 0 then (case when v_extra_add > 0 then 'EXTRA_OK' else 'OK' end)
                     when p_qty - v_left - v_extra_add > 0 then 'PARTIAL_OVER' when v_sum_cnt = 0 then 'NOT_COUNTED' else 'OVER' end;
    v_res := purch.receipt_item_view(coalesce(v_pick, v_first)) || jsonb_build_object(
      -- OK: conferiu · EXTRA_OK: conferiu uma sobra / peça fora da NF (separada dos itens) · PARTIAL_OVER/OVER: mais vezes do que o lançado
      -- (e ainda cabe na nota: dá para ajustar a contagem) · NOT_COUNTED: a peça é da nota, mas não tinha sido bipada
      'status', v_status, 'code', v_code, 'added', p_qty - v_left - v_extra_add, 'excess', v_left,
      'qty_counted', v_sum_cnt, 'qty_reviewed', v_sum_rev, 'allocations', v_alloc, 'candidates', v_cands);
    v_kind := coalesce(v_kind, 'EXCESS');
  else
    v_res := v_ni || jsonb_build_object('status', 'EXTRA_OK', 'code', v_code, 'added', 0, 'excess', 0);
    v_kind := coalesce(v_kind, v_ni ->> 'status');
  end if;

  if v_extra_add > 0 then
    select coalesce(sum(least(t.reviewed_qty, t.xq)), 0), coalesce(sum(t.xq), 0) into v_ex_rev, v_ex_qty from (
      select e.reviewed_qty,
             case when e.result ->> 'status' in ('EXCESS', 'PARTIAL_EXCESS') then coalesce((e.result ->> 'excess')::numeric, 0) else e.qty end as xq
        from purch.receipt_scan_events e
       where e.receipt_id = any(v_ids) and e.discarded_at is null and e.resolution_id is null and e.result ->> 'status' in ('EXCESS', 'PARTIAL_EXCESS', 'NOT_IN_NOTE', 'UNKNOWN')
         and (upper(e.code) = upper(v_code)
              or e.result ->> 'variant_id' = any(array(select x::text from unnest(coalesce(v_vars, '{}'::uuid[])) x))
              or e.result ->> 'item_id' in (select x from jsonb_array_elements_text(v_cands) x))) t;
    v_res := v_res || jsonb_build_object('extra', jsonb_build_object('reviewed', v_ex_rev, 'qty', v_ex_qty, 'kind', v_kind));
  end if;
  if v_ev is not null then v_res := v_res || jsonb_build_object('event_id', v_ev); end if;
  if p_client is not null then
    insert into purch.scan_dedup (client_id, org_id, result) values (p_client, p_org, v_res) on conflict do nothing;
  end if;
  return v_res;
end $$;

-- quem está logado
drop function if exists purch.scan_receipts_code(uuid[], text, numeric);
create or replace function purch.scan_receipts_code(p_receipts uuid[], p_code text, p_qty numeric default 1, p_client uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('purch.write');
  return private.receipt_scan_group(private.org_id(), p_receipts, p_code, p_qty, private.member_id(), null, p_client);
end $$;

drop function if exists purch.review_receipts_code(uuid[], text, numeric);
create or replace function purch.review_receipts_code(p_receipts uuid[], p_code text, p_qty numeric default 1, p_client uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('purch.write');
  return private.receipt_review_group(private.org_id(), p_receipts, p_code, p_qty, private.member_id(), null, p_client);
end $$;

-- celular do link: sempre pelo caminho das notas (uma ou várias)
drop function if exists public.receipt_link_scan(text, text, numeric);
create or replace function public.receipt_link_scan(p_token text, p_code text, p_qty numeric default 1, p_client uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare l purch.receipt_scan_links;
begin
  l := private.scan_link(p_token);
  return private.receipt_scan_group(l.org_id, array[l.receipt_id] || l.extra_receipt_ids, p_code, p_qty, l.created_by, l.id, p_client);
end $$;

drop function if exists public.receipt_link_review(text, text, numeric);
create or replace function public.receipt_link_review(p_token text, p_code text, p_qty numeric default 1, p_client uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare l purch.receipt_scan_links;
begin
  l := private.scan_link(p_token);
  return private.receipt_review_group(l.org_id, array[l.receipt_id] || l.extra_receipt_ids, p_code, p_qty, l.created_by, l.id, p_client);
end $$;

select private.lock_functions();

revoke execute on function public.receipt_link_scan(text, text, numeric, uuid), public.receipt_link_review(text, text, numeric, uuid) from public;
grant execute on function public.receipt_link_scan(text, text, numeric, uuid), public.receipt_link_review(text, text, numeric, uuid) to anon, authenticated, service_role;
