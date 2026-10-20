-- Central: venda com item avulso (fora do catálogo/estoque), como o "+ Item avulso" do PDV.
-- sales.quote_order passa a aceitar linha sem variant_id: {description, unit_price, qty, ncm?}. Exige a mesma permissão
-- sales.custom_item que sales.create_pos_order cobra na hora de gravar (e quem confirma o cartão é a mesma pessoa).
-- A linha avulsa sai com custom = true e available = null (não há estoque a conferir). O resto da função não muda.

create or replace function sales.quote_order(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_store core.stores; v_org uuid := private.org_id(); v_price_list uuid; it jsonb; v_qty numeric; v_list numeric; v_avail numeric; v_subtotal numeric := 0;
  v_coupon sales.coupons; v_coupon_disc numeric := 0; v_lines jsonb := '[]'; v_warnings text[] := '{}'; r record; v_desc text;
begin
  perform private.require_perm('sales.read');
  select * into v_store from core.stores where id = nullif(p ->> 'store_id', '')::uuid and org_id = v_org;
  if v_store.id is null then raise exception 'Loja inválida' using errcode = 'P0460'; end if;
  if jsonb_array_length(coalesce(p -> 'items', '[]')) = 0 then raise exception 'Pedido sem itens' using errcode = 'P0460'; end if;
  select id into v_price_list from catalog.price_lists where org_id = v_org and is_default;
  for it in select * from jsonb_array_elements(p -> 'items') loop
    v_qty := coalesce((it ->> 'qty')::numeric, 1);
    if v_qty <= 0 or v_qty <> trunc(v_qty) then raise exception 'Quantidade inválida' using errcode = 'P0460'; end if;
    if nullif(it ->> 'variant_id', '') is null then
      -- item avulso
      if coalesce(auth.role(), '') = 'authenticated' and not private.has_perm('sales.custom_item') then
        raise exception 'Inclusão de item avulso exige permissão sales.custom_item' using errcode = '42501';
      end if;
      v_desc := trim(coalesce(it ->> 'description', ''));
      if v_desc = '' then raise exception 'Item avulso precisa de descrição' using errcode = '22023'; end if;
      v_list := (it ->> 'unit_price')::numeric;
      if v_list is null or v_list < 0 then raise exception 'Preço inválido para o item avulso' using errcode = 'P0460'; end if;
      v_lines := v_lines || jsonb_build_object('variant_id', null, 'custom', true, 'description', v_desc, 'name', v_desc, 'color', null, 'size', null,
                                              'ncm', private.clean_ncm(it ->> 'ncm'), 'qty', v_qty, 'unit_price', v_list, 'total', round(v_list * v_qty, 2), 'available', null);
      v_subtotal := v_subtotal + v_list * v_qty;
      continue;
    end if;
    select v.id, v.sku, v.size, pr.name, pr.reference_code, col.name as color into r
    from catalog.variants v join catalog.products pr on pr.id = v.product_id left join catalog.colors col on col.id = v.color_id
    where v.id = nullif(it ->> 'variant_id', '')::uuid and v.org_id = v_org;
    if r.id is null then raise exception 'Produto não encontrado' using errcode = 'P0462'; end if;
    v_list := catalog.current_price(r.id, v_price_list);
    if v_list is null then raise exception 'Variante % sem preço vigente', r.sku using errcode = 'P0007'; end if;
    select coalesce(sum(sl.available), 0) into v_avail from inv.stock_levels sl join inv.locations l on l.id = sl.location_id and l.is_sellable and l.store_id = v_store.id
    where sl.variant_id = r.id;
    if v_avail < v_qty then v_warnings := v_warnings || format('%s %s %s: só %s disponível na loja', r.name, coalesce(r.color, ''), r.size, trim_scale(v_avail)); end if;
    v_lines := v_lines || jsonb_build_object('variant_id', r.id, 'sku', r.sku, 'name', r.name, 'reference', r.reference_code, 'color', r.color, 'size', r.size,
                                            'qty', v_qty, 'unit_price', v_list, 'total', round(v_list * v_qty, 2), 'available', trim_scale(v_avail));
    v_subtotal := v_subtotal + v_list * v_qty;
  end loop;
  if coalesce(p ->> 'coupon_code', '') <> '' then
    select * into v_coupon from sales.coupons
    where org_id = v_org and upper(code) = upper(p ->> 'coupon_code') and active and valid_from <= now() and (valid_to is null or valid_to > now());
    if v_coupon.id is null then
      v_warnings := v_warnings || 'Cupom inválido ou expirado'::text;
    elsif v_coupon.min_order is not null and v_subtotal < v_coupon.min_order then
      v_warnings := v_warnings || 'Pedido abaixo do mínimo do cupom'::text;
      v_coupon.id := null;
    else
      v_coupon_disc := round(case when v_coupon.kind = 'PERCENT' then v_subtotal * v_coupon.value / 100 else least(v_coupon.value, v_subtotal) end, 2);
    end if;
  end if;
  return jsonb_build_object('store_id', v_store.id, 'store_name', v_store.name, 'items', v_lines, 'subtotal', round(v_subtotal, 2),
                            'coupon', case when v_coupon.id is not null then jsonb_build_object('code', v_coupon.code, 'discount', v_coupon_disc) end,
                            'discount_total', v_coupon_disc, 'total', round(v_subtotal - v_coupon_disc, 2), 'warnings', to_jsonb(v_warnings));
end $$;

select private.lock_functions();
