-- Sobras e revisão da bipagem (12/11/2026).
-- REVISÃO (inclui as sobras e o que não está na NF, que ficam separados dos itens da nota): terminada a bipagem, a pessoa pode bipar tudo de novo para conferir o que foi lançado. Cada leitura de revisão soma em
-- purch.receipt_items.qty_revised (nunca passa do que foi contado: o que passar volta como aviso). A contagem só muda se a pessoa mandar
-- ajustar. Funções: purch.review_receipts_code, purch.reset_receipts_review e, para o celular do link, public.receipt_link_review(_reset).
--
-- SOBRAS (12/11/2026): peça lida a mais que a nota, peça que não está na nota e código desconhecido já ficavam gravados
-- em purch.receipt_scan_events, mas só apareciam na lista da tela e sumiam ao recarregar ou sair. Agora a pendência fica visível
-- (na bipagem, no celular e na conferência da nota) até a pessoa marcar como resolvida.
--  • purch.receipt_scan_events.discarded_at/by: leitura resolvida (engano, nota complementar pedida, peça devolvida).
--  • private.receipt_extras: agrupa o que sobrou por peça (sobra, fora da nota, não reconhecida), com quantidade e as leituras de origem.
--  • purch.receipts_extras: o mesmo para quem está logado (conferência).
--  • purch.discard_scan_extras / public.receipt_link_discard: resolver leituras (computador ou celular do link).
--  • O acompanhamento (feed) e a abertura do link passam a trazer "extras".

alter table purch.receipt_items add column if not exists qty_reviewed numeric(12,3) not null default 0 check (qty_reviewed >= 0);

alter table purch.receipt_scan_events
  add column if not exists reviewed_qty numeric(12,3) not null default 0 check (reviewed_qty >= 0),   -- revisão: quanto desta sobra já foi conferido bipando de novo
  add column if not exists discarded_at timestamptz,
  add column if not exists discarded_by uuid references core.members(id);

create or replace function private.receipt_extras(p_receipts uuid[]) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('kind', g.kind, 'code', g.code, 'label', g.label, 'sku', g.sku, 'photo', g.photo,
                                               'qty', g.qty, 'reviewed', g.reviewed, 'events', g.events, 'last_at', g.last_at) order by g.last_at desc), '[]'::jsonb)
  from (
    select x.kind, x.key,
           (array_agg(x.code order by x.id desc))[1] as code,
           (array_agg(x.label order by x.id desc))[1] as label,
           (array_agg(x.sku order by x.id desc))[1] as sku,
           (array_agg(x.photo order by x.id desc))[1] as photo,
           sum(x.qty) as qty, sum(least(x.reviewed, x.qty)) as reviewed, jsonb_agg(x.id order by x.id) as events, max(x.at) as last_at
      from (
        select e.id, e.at, e.code, e.reviewed_qty as reviewed,
               case when e.result ->> 'status' in ('EXCESS', 'PARTIAL_EXCESS') then 'EXCESS' else e.result ->> 'status' end as kind,
               coalesce(e.result ->> 'variant_id', e.result ->> 'item_id', upper(e.code)) as key,
               coalesce(e.result ->> 'label', e.result ->> 'description') as label,
               e.result ->> 'sku' as sku, e.result ->> 'photo' as photo,
               case when e.result ->> 'status' in ('EXCESS', 'PARTIAL_EXCESS') then coalesce((e.result ->> 'excess')::numeric, 0) else e.qty end as qty
          from purch.receipt_scan_events e
         where e.receipt_id = any(p_receipts) and e.discarded_at is null
           and e.result ->> 'status' in ('EXCESS', 'PARTIAL_EXCESS', 'NOT_IN_NOTE', 'UNKNOWN')
      ) x
     where x.qty > 0
     group by x.kind, x.key
  ) g
$$;

create or replace function purch.receipts_extras(p_receipts uuid[]) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_perm('purch.read');
  if p_receipts is null or cardinality(p_receipts) = 0 or cardinality(p_receipts) > 20
     or (select count(*) from purch.receipts where id = any(p_receipts) and org_id = private.org_id()) <> (select count(distinct e) from unnest(p_receipts) e) then
    raise exception 'Recebimento não encontrado';
  end if;
  return private.receipt_extras(p_receipts);
end $$;

create or replace function purch.discard_scan_extras(p_events bigint[]) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  perform private.require_perm('purch.write');
  if p_events is null or cardinality(p_events) > 500 then raise exception 'Leituras demais de uma vez' using errcode = 'P0086'; end if;
  update purch.receipt_scan_events set discarded_at = now(), discarded_by = private.member_id()
   where id = any(p_events) and org_id = private.org_id() and discarded_at is null;
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------- acompanhamento de uma nota (igual ao da 20261108, com extras) ----------
create or replace function private.receipt_feed(p_receipt uuid, p_after bigint) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'status', (select status from purch.receipts where id = p_receipt),
    'items', coalesce((select jsonb_agg(jsonb_build_object('item_id', i.id, 'qty_counted', coalesce(i.qty_counted, 0), 'qty_reviewed', i.qty_reviewed, 'qty_nfe', i.qty_nfe))
                        from purch.receipt_items i where i.receipt_id = p_receipt), '[]'),
    'events', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'at', e.at, 'code', e.code, 'qty', e.qty, 'by_link', e.link_id is not null, 'result', e.result) order by e.id)
                         from (select * from purch.receipt_scan_events where receipt_id = p_receipt and id > coalesce(p_after, 0) order by id desc limit 50) e), '[]'),
    'last_event', coalesce((select max(id) from purch.receipt_scan_events where receipt_id = p_receipt), 0),
    'links', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'label', l.label, 'expires_at', l.expires_at, 'last_seen_at', l.last_seen_at,
                                            'online', coalesce(l.last_seen_at > now() - interval '60 seconds', false)) order by l.created_at)
                        from purch.receipt_scan_links l where l.receipt_id = p_receipt and l.revoked_at is null and l.expires_at > now()), '[]'),
    'extras', private.receipt_extras(array[p_receipt]))
$$;

-- ---------- acompanhamento de várias notas (igual ao da 20261112000100, com extras) ----------
create or replace function private.receipt_feed_group(p_receipts uuid[], p_after bigint) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'status', case when exists (select 1 from purch.receipts where id = any(p_receipts) and status <> 'POSTED') then 'PENDING_CHECK' else 'POSTED' end,
    'receipts', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'status', r.status)) from purch.receipts r where r.id = any(p_receipts)), '[]'),
    'items', coalesce((select jsonb_agg(jsonb_build_object('item_id', i.id, 'receipt_id', i.receipt_id, 'qty_counted', coalesce(i.qty_counted, 0), 'qty_reviewed', i.qty_reviewed, 'qty_nfe', i.qty_nfe))
                        from purch.receipt_items i where i.receipt_id = any(p_receipts)), '[]'),
    'events', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'at', e.at, 'code', e.code, 'qty', e.qty, 'by_link', e.link_id is not null, 'result', e.result) order by e.id)
                         from (select * from purch.receipt_scan_events where receipt_id = any(p_receipts) and id > coalesce(p_after, 0) order by id desc limit 50) e), '[]'),
    'last_event', coalesce((select max(id) from purch.receipt_scan_events where receipt_id = any(p_receipts)), 0),
    'links', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'label', l.label, 'expires_at', l.expires_at, 'last_seen_at', l.last_seen_at,
                                            'online', coalesce(l.last_seen_at > now() - interval '60 seconds', false)) order by l.created_at)
                        from purch.receipt_scan_links l
                       where (l.receipt_id = any(p_receipts) or l.extra_receipt_ids && p_receipts) and l.revoked_at is null and l.expires_at > now()), '[]'),
    'extras', private.receipt_extras(p_receipts))
$$;

-- ---------- celular do link ----------
create or replace function public.receipt_link_open(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare l purch.receipt_scan_links; v_ids uuid[];
begin
  l := private.scan_link(p_token);
  v_ids := array[l.receipt_id] || l.extra_receipt_ids;
  return jsonb_build_object(
    'expires_at', l.expires_at, 'label', l.label,
    'summary', private.receipt_summary_json(l.receipt_id),
    'notes', coalesce((select jsonb_agg(private.receipt_summary_json(x.id) order by x.ord) from unnest(v_ids) with ordinality as x(id, ord)), '[]'),
    'extras', private.receipt_extras(v_ids),
    'items', coalesce((select jsonb_agg(jsonb_build_object(
        'id', i.id, 'receipt_id', i.receipt_id, 'n_item', i.n_item, 'description', coalesce(i.description, ''), 'cprod', i.supplier_cprod, 'cean', i.cean,
        'qty_nfe', i.qty_nfe, 'qty_counted', coalesce(i.qty_counted, 0), 'qty_reviewed', i.qty_reviewed, 'item_total', i.item_total, 'variant_id', i.variant_id,
        'sku', v.sku, 'label', case when v.id is null then null else concat_ws(' · ', p.name, c.name, v.size) end,
        'photo', (select m.storage_path from catalog.product_media m where m.product_id = v.product_id
                   order by (m.color_id is not distinct from v.color_id) desc, m.position limit 1)) order by array_position(v_ids, i.receipt_id), i.n_item)
      from purch.receipt_items i
      left join catalog.variants v on v.id = i.variant_id
      left join catalog.products p on p.id = v.product_id
      left join catalog.colors c on c.id = v.color_id
      where i.receipt_id = any(v_ids)), '[]'));
end $$;

create or replace function public.receipt_link_discard(p_token text, p_events bigint[]) returns integer
language plpgsql security definer set search_path = '' as $$
declare l purch.receipt_scan_links; n integer;
begin
  l := private.scan_link(p_token);
  if p_events is null or cardinality(p_events) > 500 then raise exception 'Leituras demais de uma vez' using errcode = 'P0086'; end if;
  update purch.receipt_scan_events set discarded_at = now(), discarded_by = l.created_by
   where id = any(p_events) and org_id = l.org_id and (receipt_id = l.receipt_id or receipt_id = any(l.extra_receipt_ids)) and discarded_at is null;
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------- revisão: bipar de novo para conferir o que foi lançado ----------
create or replace function private.receipt_review_group(p_org uuid, p_receipts uuid[], p_code text, p_qty numeric, p_member uuid, p_link uuid)
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
  v_var catalog.variants; v_ni jsonb; v_new jsonb; v_res jsonb; v_ev bigint; v_status text; v_kind text;
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
     where e.receipt_id = any(v_ids) and e.discarded_at is null and e.result ->> 'status' in ('EXCESS', 'PARTIAL_EXCESS', 'NOT_IN_NOTE', 'UNKNOWN')
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
       where e.receipt_id = any(v_ids) and e.discarded_at is null and e.result ->> 'status' in ('EXCESS', 'PARTIAL_EXCESS', 'NOT_IN_NOTE', 'UNKNOWN')
         and (upper(e.code) = upper(v_code)
              or e.result ->> 'variant_id' = any(array(select x::text from unnest(coalesce(v_vars, '{}'::uuid[])) x))
              or e.result ->> 'item_id' in (select x from jsonb_array_elements_text(v_cands) x))) t;
    v_res := v_res || jsonb_build_object('extra', jsonb_build_object('reviewed', v_ex_rev, 'qty', v_ex_qty, 'kind', v_kind));
  end if;
  if v_ev is not null then v_res := v_res || jsonb_build_object('event_id', v_ev); end if;
  return v_res;
end $$;

create or replace function purch.review_receipts_code(p_receipts uuid[], p_code text, p_qty numeric default 1) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('purch.write');
  return private.receipt_review_group(private.org_id(), p_receipts, p_code, p_qty, private.member_id(), null);
end $$;

create or replace function purch.reset_receipts_review(p_receipts uuid[]) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  perform private.require_perm('purch.write');
  if p_receipts is null or cardinality(p_receipts) = 0 or cardinality(p_receipts) > 20 then raise exception 'Escolha de 1 a 20 notas' using errcode = 'P0086'; end if;
  update purch.receipt_items set qty_reviewed = 0 where receipt_id = any(p_receipts) and org_id = private.org_id() and qty_reviewed <> 0;
  get diagnostics n = row_count;
  update purch.receipt_scan_events set reviewed_qty = 0 where receipt_id = any(p_receipts) and org_id = private.org_id() and reviewed_qty <> 0;
  return n;
end $$;

create or replace function public.receipt_link_review(p_token text, p_code text, p_qty numeric default 1) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare l purch.receipt_scan_links;
begin
  l := private.scan_link(p_token);
  return private.receipt_review_group(l.org_id, array[l.receipt_id] || l.extra_receipt_ids, p_code, p_qty, l.created_by, l.id);
end $$;

create or replace function public.receipt_link_review_reset(p_token text) returns integer
language plpgsql security definer set search_path = '' as $$
declare l purch.receipt_scan_links; n integer;
begin
  l := private.scan_link(p_token);
  update purch.receipt_items set qty_reviewed = 0
   where (receipt_id = l.receipt_id or receipt_id = any(l.extra_receipt_ids)) and org_id = l.org_id and qty_reviewed <> 0;
  get diagnostics n = row_count;
  update purch.receipt_scan_events set reviewed_qty = 0
   where (receipt_id = l.receipt_id or receipt_id = any(l.extra_receipt_ids)) and org_id = l.org_id and reviewed_qty <> 0;
  return n;
end $$;

insert into private.internal_functions (fqname) values ('private.receipt_extras'), ('private.receipt_review_group') on conflict do nothing;
select private.lock_functions();

revoke execute on function public.receipt_link_discard(text, bigint[]) from public;
grant execute on function public.receipt_link_discard(text, bigint[]) to anon, authenticated, service_role;
revoke execute on function public.receipt_link_review(text, text, numeric), public.receipt_link_review_reset(text) from public;
grant execute on function public.receipt_link_review(text, text, numeric), public.receipt_link_review_reset(text) to anon, authenticated, service_role;
