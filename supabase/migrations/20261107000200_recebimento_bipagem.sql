-- Recebimento de NF-e pelo leitor (câmera do celular ou leitor USB/Bluetooth): cada bipe soma no item da nota, no banco.
--  • purch.scan_receipt_code: código lido (EAN da nota, EAN/SKU/SKU do fornecedor da peça, cProd do fornecedor ou par aprendido)
--    → item da nota. Soma de forma atômica (várias pessoas bipando a mesma nota ao mesmo tempo não se atropelam) e nunca passa
--    da quantidade da nota: o que passar volta como sobra (EXCESS) para a tela avisar — sobra pede nota complementar.
--    Mesma peça em mais de uma linha da nota: enche a primeira linha que ainda falta.
--  • purch.bump_receipt_item: +/− na tela e "desfazer a última leitura" (soma relativa, também atômica, entre 0 e a nota).
-- Ambas reabrem a conferência confirmada (CHECKED → PENDING_CHECK), como purch.set_receipt_item, e recusam nota já lançada.

create or replace function purch.receipt_item_view(p_item uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'item_id', ri.id, 'n_item', ri.n_item, 'description', ri.description, 'cprod', ri.supplier_cprod, 'cean', ri.cean,
    'qty_nfe', ri.qty_nfe, 'qty_counted', coalesce(ri.qty_counted, 0), 'variant_id', ri.variant_id, 'sku', v.sku,
    'label', case when v.id is null then null else concat_ws(' · ', p.name, c.name, v.size) end)
  from purch.receipt_items ri
  left join catalog.variants v on v.id = ri.variant_id
  left join catalog.products p on p.id = v.product_id
  left join catalog.colors c on c.id = v.color_id
  where ri.id = p_item
$$;

create or replace function purch.scan_receipt_code(p_receipt uuid, p_code text, p_qty numeric default 1) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id();
  rc purch.receipts;
  v_code text := btrim(coalesce(p_code, ''));
  v_digits boolean;
  v_vars uuid[];
  ri purch.receipt_items;
  v_room numeric; v_add numeric; v_var catalog.variants;
begin
  perform private.require_perm('purch.write');
  if v_code = '' or length(v_code) > 80 then raise exception 'Código vazio ou longo demais' using errcode = 'P0086'; end if;
  if p_qty is null or p_qty <= 0 or p_qty > 10000 then raise exception 'Quantidade por leitura inválida' using errcode = 'P0086'; end if;
  select * into rc from purch.receipts where id = p_receipt and org_id = v_org for update;   -- uma leitura por vez nesta nota
  if rc.id is null then raise exception 'Recebimento não encontrado'; end if;
  if rc.status = 'POSTED' then raise exception 'Recebimento já lançado no estoque' using errcode = 'P0083'; end if;
  v_digits := v_code ~ '^\d{8,14}$';

  -- peças do catálogo com este código (EAN, SKU da etiqueta, SKU do fornecedor ou par cProd → peça aprendido com este fornecedor)
  select array_agg(distinct id) into v_vars from (
    select v.id from catalog.variants v
     where v.org_id = v_org and (upper(v.sku) = upper(v_code) or (v_digits and v.gtin = v_code) or upper(v.supplier_sku) = upper(v_code))
    union
    select si.variant_id from catalog.supplier_items si
     where si.org_id = v_org and si.supplier_party_id = rc.supplier_party_id and si.variant_id is not null
       and (upper(si.supplier_cprod) = upper(v_code) or (v_digits and si.supplier_ean = v_code))
  ) s;

  -- linha da nota: a primeira que ainda falta; se todas já bateram, a primeira (para avisar a sobra)
  select * into ri from purch.receipt_items i
   where i.receipt_id = rc.id
     and ((v_digits and i.cean = v_code and i.cean !~ '^0+$') or upper(i.supplier_cprod) = upper(v_code) or i.variant_id = any(coalesce(v_vars, '{}')))
   order by (coalesce(i.qty_counted, 0) < i.qty_nfe) desc, i.n_item
   limit 1
   for update;

  if ri.id is null then
    if coalesce(array_length(v_vars, 1), 0) > 0 then
      select * into v_var from catalog.variants where id = v_vars[1];
      return jsonb_build_object('status', 'NOT_IN_NOTE', 'code', v_code, 'variant_id', v_var.id, 'sku', v_var.sku,
        'label', (select concat_ws(' · ', p.name, c.name, v_var.size) from catalog.products p left join catalog.colors c on c.id = v_var.color_id where p.id = v_var.product_id));
    end if;
    return jsonb_build_object('status', 'UNKNOWN', 'code', v_code);
  end if;

  v_room := ri.qty_nfe - coalesce(ri.qty_counted, 0);
  v_add := least(p_qty, greatest(v_room, 0));
  if v_add > 0 then
    update purch.receipt_items set qty_counted = coalesce(qty_counted, 0) + v_add where id = ri.id;
    if rc.status = 'CHECKED' then update purch.receipts set status = 'PENDING_CHECK', checked_by = null, checked_at = null where id = rc.id; end if;
  end if;
  return purch.receipt_item_view(ri.id) || jsonb_build_object(
    'status', case when v_add = 0 then 'EXCESS' when v_add < p_qty then 'PARTIAL_EXCESS' else 'OK' end,
    'code', v_code, 'added', v_add, 'excess', p_qty - v_add);
end $$;

create or replace function purch.bump_receipt_item(p_item uuid, p_delta numeric) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id();
  ri purch.receipt_items; rc purch.receipts; v_new numeric;
begin
  perform private.require_perm('purch.write');
  if p_delta is null or p_delta = 0 or abs(p_delta) > 10000 then raise exception 'Quantidade inválida' using errcode = 'P0086'; end if;
  select * into ri from purch.receipt_items where id = p_item and org_id = v_org for update;
  if ri.id is null then raise exception 'Item não encontrado'; end if;
  select * into rc from purch.receipts where id = ri.receipt_id;
  if rc.status = 'POSTED' then raise exception 'Recebimento já lançado no estoque' using errcode = 'P0083'; end if;
  v_new := coalesce(ri.qty_counted, 0) + p_delta;
  if v_new > ri.qty_nfe then
    raise exception 'A nota tem % unidade(s) deste item. Sobras: peça nota complementar ao fornecedor.', ri.qty_nfe using errcode = 'P0085';
  end if;
  update purch.receipt_items set qty_counted = greatest(v_new, 0) where id = ri.id;
  if rc.status = 'CHECKED' then update purch.receipts set status = 'PENDING_CHECK', checked_by = null, checked_at = null where id = rc.id; end if;
  return purch.receipt_item_view(ri.id);
end $$;

insert into private.internal_functions (fqname) values ('purch.receipt_item_view') on conflict do nothing;

select private.lock_functions();
