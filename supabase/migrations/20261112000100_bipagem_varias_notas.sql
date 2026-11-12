-- Bipagem de várias NF-e de uma vez (12/11/2026): três caixas do mesmo pedido chegam com três notas, mas as peças não vêm
-- separadas por nota. A pessoa bipa tudo junto e o banco distribui cada peça na nota que ainda precisa dela.
--  • purch.scan_receipts_code: um código lido → itens das notas escolhidas (EAN da nota, SKU/EAN/SKU do fornecedor da peça,
--    cProd, par aprendido). Enche primeiro as notas que ainda faltam, na ordem em que foram escolhidas; a peça que passa do
--    total das notas vira sobra (aviso), nunca entra a mais. Devolve a distribuição (allocations) e as linhas da peça (candidates).
--  • purch.receipts_scan_feed: quantidades, leituras novas e celulares ligados de todas as notas juntas.
--  • Cada nota continua sendo um recebimento próprio (conferência, vencimentos, estoque e financeiro de cada uma): só a bipagem é junta.
--  • Modo assistido: o link do celular pode cobrir várias notas (receipt_scan_links.extra_receipt_ids).
-- As funções de uma nota só (purch.scan_receipt_code, private.receipt_scan…) ficam como estão.

alter table purch.receipt_scan_links add column if not exists extra_receipt_ids uuid[] not null default '{}';

-- ---------- resumo de uma nota (cabeçalho da tela do celular) ----------
create or replace function private.receipt_summary_json(p_receipt uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', rc.id, 'receiptNumber', rc.number, 'status', rc.status,
    'nfNumber', case when d.id is null then '—' else coalesce(d.number::text, '') || coalesce('/' || d.series::text, '') end,
    'issueAt', to_char(d.issue_at at time zone 'America/Sao_Paulo', 'DD/MM/YYYY'),
    'supplier', coalesce((select display_name from crm.parties where id = rc.supplier_party_id), 'Fornecedor'),
    'supplierCnpj', d.counterpart_cnpj,
    'location', coalesce((select name from inv.locations where id = rc.location_id), '—'),
    'nfTotal', rc.nf_total, 'vProd', coalesce((d.totals ->> 'vProd')::numeric, 0),
    'vFrete', coalesce((d.totals ->> 'vFrete')::numeric, 0), 'vDesc', coalesce((d.totals ->> 'vDesc')::numeric, 0))
  from purch.receipts rc left join fiscal.documents d on d.id = rc.document_id
  where rc.id = p_receipt
$$;

-- ---------- núcleo da leitura em várias notas ----------
create or replace function private.receipt_scan_group(p_org uuid, p_receipts uuid[], p_code text, p_qty numeric, p_member uuid, p_link uuid)
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
  v_var catalog.variants; v_res jsonb; v_ev bigint;
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
  return v_res || jsonb_build_object('event_id', v_ev);
end $$;

-- ---------- acompanhamento das notas juntas ----------
create or replace function private.receipt_feed_group(p_receipts uuid[], p_after bigint) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'status', case when exists (select 1 from purch.receipts where id = any(p_receipts) and status <> 'POSTED') then 'PENDING_CHECK' else 'POSTED' end,
    'receipts', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'status', r.status)) from purch.receipts r where r.id = any(p_receipts)), '[]'),
    'items', coalesce((select jsonb_agg(jsonb_build_object('item_id', i.id, 'receipt_id', i.receipt_id, 'qty_counted', coalesce(i.qty_counted, 0), 'qty_nfe', i.qty_nfe))
                        from purch.receipt_items i where i.receipt_id = any(p_receipts)), '[]'),
    'events', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'at', e.at, 'code', e.code, 'qty', e.qty, 'by_link', e.link_id is not null, 'result', e.result) order by e.id)
                         from (select * from purch.receipt_scan_events where receipt_id = any(p_receipts) and id > coalesce(p_after, 0) order by id desc limit 50) e), '[]'),
    'last_event', coalesce((select max(id) from purch.receipt_scan_events where receipt_id = any(p_receipts)), 0),
    'links', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'label', l.label, 'expires_at', l.expires_at, 'last_seen_at', l.last_seen_at,
                                            'online', coalesce(l.last_seen_at > now() - interval '60 seconds', false)) order by l.created_at)
                        from purch.receipt_scan_links l
                       where (l.receipt_id = any(p_receipts) or l.extra_receipt_ids && p_receipts) and l.revoked_at is null and l.expires_at > now()), '[]'))
$$;

-- ---------- quem está logado ----------
create or replace function purch.scan_receipts_code(p_receipts uuid[], p_code text, p_qty numeric default 1) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('purch.write');
  return private.receipt_scan_group(private.org_id(), p_receipts, p_code, p_qty, private.member_id(), null);
end $$;

create or replace function purch.receipts_scan_feed(p_receipts uuid[], p_after bigint default 0) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_perm('purch.read');
  if p_receipts is null or cardinality(p_receipts) = 0 or cardinality(p_receipts) > 20
     or (select count(*) from purch.receipts where id = any(p_receipts) and org_id = private.org_id()) <> (select count(distinct e) from unnest(p_receipts) e) then
    raise exception 'Recebimento não encontrado';
  end if;
  return private.receipt_feed_group(p_receipts, p_after);
end $$;

-- ---------- link do celular: uma nota ou várias ----------
drop function if exists purch.create_scan_link(uuid, text, integer);
create or replace function purch.create_scan_link(p_receipt uuid, p_label text default null, p_hours integer default 6, p_extra uuid[] default '{}')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare rc purch.receipts; v_token text; v_id uuid; v_exp timestamptz; v_extra uuid[];
begin
  perform private.require_perm('purch.write');
  select * into rc from purch.receipts where id = p_receipt and org_id = private.org_id();
  if rc.id is null then raise exception 'Recebimento não encontrado'; end if;
  if rc.status = 'POSTED' then raise exception 'Recebimento já lançado no estoque' using errcode = 'P0083'; end if;
  if p_hours is null or p_hours < 1 or p_hours > 24 then raise exception 'Validade do link: de 1 a 24 horas' using errcode = 'P0086'; end if;
  select coalesce(array_agg(s.id order by s.ord), '{}'::uuid[]) into v_extra from (
    select distinct on (x.id) x.id, x.ord
      from unnest(coalesce(p_extra, '{}'::uuid[])) with ordinality as x(id, ord)
      join purch.receipts r on r.id = x.id and r.org_id = rc.org_id and r.status <> 'POSTED' and r.id <> rc.id
     order by x.id, x.ord) s;
  if cardinality(v_extra) <> (select count(distinct e) from unnest(coalesce(p_extra, '{}'::uuid[])) e where e <> rc.id) or cardinality(v_extra) > 19 then
    raise exception 'Alguma das notas juntadas não existe ou já foi lançada' using errcode = 'P0083';
  end if;
  v_token := translate(encode(extensions.gen_random_bytes(18), 'base64'), '+/', '-_');
  v_exp := now() + make_interval(hours => p_hours);
  insert into purch.receipt_scan_links (org_id, receipt_id, extra_receipt_ids, token_hash, created_by, label, expires_at)
  values (rc.org_id, rc.id, v_extra, encode(extensions.digest(v_token, 'sha256'), 'hex'), private.member_id(), nullif(left(btrim(coalesce(p_label, '')), 80), ''), v_exp)
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'token', v_token, 'expires_at', v_exp);
end $$;

create or replace function purch.revoke_scan_link(p_receipt uuid, p_link uuid default null) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  perform private.require_perm('purch.write');
  update purch.receipt_scan_links set revoked_at = now()
   where (receipt_id = p_receipt or p_receipt = any(extra_receipt_ids)) and org_id = private.org_id() and revoked_at is null and (p_link is null or id = p_link);
  get diagnostics n = row_count;
  return n;
end $$;

-- Celular: abre as notas do link (resumo de cada uma + itens com foto). "summary" continua sendo o da primeira nota.
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
    'items', coalesce((select jsonb_agg(jsonb_build_object(
        'id', i.id, 'receipt_id', i.receipt_id, 'n_item', i.n_item, 'description', coalesce(i.description, ''), 'cprod', i.supplier_cprod, 'cean', i.cean,
        'qty_nfe', i.qty_nfe, 'qty_counted', coalesce(i.qty_counted, 0), 'item_total', i.item_total, 'variant_id', i.variant_id,
        'sku', v.sku, 'label', case when v.id is null then null else concat_ws(' · ', p.name, c.name, v.size) end,
        'photo', (select m.storage_path from catalog.product_media m where m.product_id = v.product_id
                   order by (m.color_id is not distinct from v.color_id) desc, m.position limit 1)) order by array_position(v_ids, i.receipt_id), i.n_item)
      from purch.receipt_items i
      left join catalog.variants v on v.id = i.variant_id
      left join catalog.products p on p.id = v.product_id
      left join catalog.colors c on c.id = v.color_id
      where i.receipt_id = any(v_ids)), '[]'));
end $$;

create or replace function public.receipt_link_scan(p_token text, p_code text, p_qty numeric default 1) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare l purch.receipt_scan_links;
begin
  l := private.scan_link(p_token);
  if cardinality(l.extra_receipt_ids) > 0 then
    return private.receipt_scan_group(l.org_id, array[l.receipt_id] || l.extra_receipt_ids, p_code, p_qty, l.created_by, l.id);
  end if;
  return private.receipt_scan(l.org_id, l.receipt_id, p_code, p_qty, l.created_by, l.id);
end $$;

create or replace function public.receipt_link_bump(p_token text, p_item uuid, p_delta numeric) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare l purch.receipt_scan_links;
begin
  l := private.scan_link(p_token);
  if not exists (select 1 from purch.receipt_items where id = p_item and (receipt_id = l.receipt_id or receipt_id = any(l.extra_receipt_ids))) then raise exception 'Item não encontrado'; end if;
  return private.receipt_bump(l.org_id, p_item, p_delta, l.created_by, l.id);
end $$;

create or replace function public.receipt_link_feed(p_token text, p_after bigint default 0) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare l purch.receipt_scan_links;
begin
  l := private.scan_link(p_token);
  if cardinality(l.extra_receipt_ids) > 0 then
    return private.receipt_feed_group(array[l.receipt_id] || l.extra_receipt_ids, p_after) - 'links' || jsonb_build_object('expires_at', l.expires_at);
  end if;
  return private.receipt_feed(l.receipt_id, p_after) - 'links' || jsonb_build_object('expires_at', l.expires_at);
end $$;

insert into private.internal_functions (fqname) values
  ('private.receipt_scan_group'), ('private.receipt_feed_group'), ('private.receipt_summary_json')
on conflict do nothing;
select private.lock_functions();
