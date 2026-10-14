-- =====================================================================
-- Catálogo e pedido da marca em PDF
--  • catalog.products.wholesale_cost: preço de atacado da marca (catálogo de atacado ou último pedido em PDF). É o custo que a
--    encomenda põe no pedido de compra quando a peça ainda não tem custo próprio (antes caía no preço de varejo).
--  • catalog.apply_brand_items: grava o que veio do PDF (pedido ou catálogo) no padrão do site — produto por modelo, cor pelo
--    código da marca, SKU = modelo + código da cor + tamanho — sem renomear produto existente nem trocar preço que já existe.
--    Cada linha é independente: a que falha volta como erro e as demais seguem.
-- Códigos: P0360 dado inválido.
-- =====================================================================

alter table catalog.products
  add column wholesale_cost numeric(14,2) check (wholesale_cost >= 0),
  add column wholesale_cost_at timestamptz;
comment on column catalog.products.wholesale_cost is 'Preço de atacado da marca (catálogo/pedido em PDF): custo da encomenda enquanto a peça não tem custo próprio';

create or replace function catalog.apply_brand_items(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id();
  it jsonb; i int := 0;
  v_pl uuid; v_prod catalog.products; v_color catalog.colors; v_var uuid; v_sku text; v_ref text; v_size text; v_code text; v_name text;
  v_new_prod boolean; v_new_color boolean; v_new_var boolean;
  v_out jsonb := '[]'; v_errors jsonb := '[]';
  n_prod int := 0; n_color int := 0; n_var int := 0;
begin
  perform private.require_perm('catalog.write');
  if jsonb_typeof(p) <> 'array' or jsonb_array_length(p) > 2000 then raise exception 'Lista de itens inválida (máx. 2.000)' using errcode = 'P0360'; end if;
  select id into v_pl from catalog.price_lists where org_id = v_org and is_default;

  for it in select * from jsonb_array_elements(p) loop
    i := i + 1;
    begin
      v_new_prod := false; v_new_color := false; v_new_var := false; v_prod := null; v_color := null;
      v_size := upper(trim(coalesce(it ->> 'size', '')));
      if v_size = '' or length(v_size) > 10 then raise exception 'tamanho inválido'; end if;

      -- produto: escolhido na tela ou pelo modelo (referência)
      if nullif(it ->> 'product_id', '') is not null then
        select * into v_prod from catalog.products where id = (it ->> 'product_id')::uuid and org_id = v_org;
        if v_prod.id is null then raise exception 'produto não encontrado'; end if;
      else
        v_ref := upper(trim(coalesce(it ->> 'reference', '')));
        if v_ref = '' then raise exception 'falta a referência (modelo) do produto'; end if;
        select * into v_prod from catalog.products where org_id = v_org and reference_code = v_ref;
        if v_prod.id is null then
          if length(trim(coalesce(it ->> 'name', ''))) < 2 then raise exception 'produto % não existe: informe o nome', v_ref; end if;
          insert into catalog.products (org_id, size_grid_id, reference_code, name, composition, gender, status)
          values (v_org,
                  (select id from catalog.size_grids where org_id = v_org and name = case upper(coalesce(it ->> 'gender', 'FEM')) when 'MASC' then 'Masculino P-GG' else 'Feminino PP-GG' end),
                  v_ref, trim(it ->> 'name'), nullif(trim(coalesce(it ->> 'composition', '')), ''),
                  (case upper(coalesce(it ->> 'gender', 'FEM')) when 'MASC' then 'MASC' when 'UNISSEX' then 'UNISSEX' else 'FEM' end)::catalog.gender, 'ACTIVE')
          returning * into v_prod;
          v_new_prod := true; n_prod := n_prod + 1;
        end if;
      end if;
      -- texto vazio da loja é preenchido; o que já existe (site ou cadastro) não é trocado
      if v_prod.composition is null and nullif(trim(coalesce(it ->> 'composition', '')), '') is not null then
        update catalog.products set composition = trim(it ->> 'composition') where id = v_prod.id returning * into v_prod;
      end if;
      if nullif(it ->> 'wholesale_cost', '') is not null then
        if (it ->> 'wholesale_cost')::numeric < 0 then raise exception 'preço de atacado inválido'; end if;
        update catalog.products set wholesale_cost = (it ->> 'wholesale_cost')::numeric, wholesale_cost_at = now()
        where id = v_prod.id and wholesale_cost is distinct from (it ->> 'wholesale_cost')::numeric;
      end if;
      if coalesce((it ->> 'backorder')::boolean, false) then
        update catalog.products set backorder = true where id = v_prod.id and not backorder;
      end if;

      -- cor: escolhida na tela, pelo código da marca ou pelo nome
      v_code := upper(trim(coalesce(it ->> 'color_code', '')));
      v_name := trim(coalesce(it ->> 'color_name', ''));
      if nullif(it ->> 'color_id', '') is not null then
        select * into v_color from catalog.colors where id = (it ->> 'color_id')::uuid and org_id = v_org;
        if v_color.id is null then raise exception 'cor não encontrada'; end if;
      elsif v_code <> '' then
        select * into v_color from catalog.colors where org_id = v_org and upper(code) = v_code
        order by (private.norm(name) = private.norm(v_name)) desc, name limit 1;
      elsif v_name <> '' then
        select * into v_color from catalog.colors where org_id = v_org
          and private.norm(regexp_replace(name, '\s*\(\w+\)$', '')) = private.norm(v_name)
        order by (private.norm(name) = private.norm(v_name)) desc, name limit 1;
      else
        raise exception 'falta a cor';
      end if;
      if v_color.id is null then
        if v_name = '' then raise exception 'cor % não cadastrada: informe o nome', v_code; end if;
        if v_code = '' then v_code := upper(left(regexp_replace(private.norm(v_name), '[^a-z0-9]', '', 'g'), 3)); end if;
        if v_code = '' or length(v_code) > 10 then raise exception 'código de cor inválido'; end if;
        -- mesmo nome com outro código (ex.: Preto 004 e Preto 019): o nome leva o código, como no site
        if exists (select 1 from catalog.colors where org_id = v_org and name = v_name) then v_name := v_name || ' (' || v_code || ')'; end if;
        insert into catalog.colors (org_id, name, code) values (v_org, v_name, v_code) returning * into v_color;
        v_new_color := true; n_color := n_color + 1;
      end if;
      if coalesce(v_color.code, '') = '' then raise exception 'a cor % está sem código: corrija no cadastro de cores', v_color.name; end if;

      -- variante no padrão da etiqueta da marca: modelo + código da cor + tamanho
      select id, sku into v_var, v_sku from catalog.variants where product_id = v_prod.id and color_id = v_color.id and size = v_size;
      if v_var is null then
        v_sku := v_prod.reference_code || upper(v_color.code) || v_size;
        if exists (select 1 from catalog.variants where org_id = v_org and sku = v_sku) then
          raise exception 'já existe outra peça com o SKU %', v_sku;
        end if;
        insert into catalog.variants (org_id, product_id, color_id, size, sku, supplier_sku)
        values (v_org, v_prod.id, v_color.id, v_size, v_sku, nullif(trim(coalesce(it ->> 'supplier_sku', '')), ''))
        returning id into v_var;
        v_new_var := true; n_var := n_var + 1;
      else
        update catalog.variants set active = true where id = v_var and not active;
      end if;

      -- preço de venda só entra se o produto ainda não tem (o do site/cadastro manda)
      if nullif(it ->> 'price', '') is not null and (it ->> 'price')::numeric > 0 and v_pl is not null
         and catalog.current_price(v_var, v_pl) is null then
        insert into catalog.prices (org_id, price_list_id, product_id, price) values (v_org, v_pl, v_prod.id, round((it ->> 'price')::numeric, 2));
      end if;

      v_out := v_out || jsonb_build_object('i', i, 'variant_id', v_var, 'sku', v_sku, 'product_id', v_prod.id, 'color_id', v_color.id,
                                           'reference', v_prod.reference_code, 'color_code', v_color.code,
                                           'new_product', v_new_prod, 'new_color', v_new_color, 'new_variant', v_new_var);
    exception when others then
      v_errors := v_errors || jsonb_build_object('i', i, 'erro', sqlerrm);
    end;
  end loop;

  return jsonb_build_object('items', v_out, 'erros', v_errors, 'produtos_novos', n_prod, 'cores_novas', n_color, 'variantes_novas', n_var);
end $$;

-- Custo da encomenda no pedido de compra: último custo → preço de atacado da marca → preço de catálogo → zero
create or replace function sales.backorder_cost(p_variant uuid, p_store uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_le uuid; c numeric; v_price numeric;
begin
  perform private.require_perm('sales.read');
  select legal_entity_id into v_le from core.stores where id = p_store and org_id = private.org_id();
  select coalesce(last_cost, nullif(avg_cost, 0)) into c from inv.item_costs where variant_id = p_variant and legal_entity_id = v_le;
  if c is not null then return jsonb_build_object('source', 'LAST_COST', 'cost', c); end if;
  select pr.wholesale_cost into c from catalog.variants va join catalog.products pr on pr.id = va.product_id
  where va.id = p_variant and va.org_id = private.org_id();
  if c is not null then return jsonb_build_object('source', 'WHOLESALE', 'cost', c); end if;
  v_price := catalog.current_price(p_variant);
  if v_price is not null then return jsonb_build_object('source', 'CATALOG_PRICE', 'cost', v_price); end if;
  return jsonb_build_object('source', 'ZERO', 'cost', 0);
end $$;

-- Encomenda: igual a 20261013000100, só o custo do pedido de compra passa pelo preço de atacado
create or replace function sales.create_backorder(p jsonb) returns sales.orders
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id(); s core.stores; o sales.orders; po purch.purchase_orders; it jsonb; v record; v_loc uuid; v_supplier uuid; v_price_list uuid;
  v_list numeric; v_unit numeric; v_qty numeric; v_disc numeric; v_disc_a numeric; v_av numeric; v_res_qty numeric; v_bo_qty numeric;
  v_item uuid; v_res inv.reservations; v_cost numeric; v_subtotal numeric := 0; v_discount numeric := 0; v_coupon sales.coupons; v_cdisc numeric;
  v_can_discount boolean; v_can_custom boolean; v_desc text; v_party text; v_task uuid; v_lines text := ''; v_ordered boolean := false;
begin
  perform private.require_perm('sales.write');
  select * into s from core.stores where id = (p ->> 'store_id')::uuid and org_id = v_org;
  if s.id is null then raise exception 'Loja não encontrada' using errcode = 'P0350'; end if;
  if coalesce(auth.role(), '') = 'authenticated' and not private.can_store(s.id) then raise exception 'Sem acesso à loja' using errcode = '42501'; end if;
  select display_name into v_party from crm.parties where id = (p ->> 'party_id')::uuid and org_id = v_org;
  if v_party is null then raise exception 'Escolha a cliente da encomenda' using errcode = 'P0350'; end if;
  if jsonb_array_length(coalesce(p -> 'items', '[]')) = 0 then raise exception 'Escolha ao menos uma peça' using errcode = 'P0350'; end if;
  if nullif(p ->> 'idempotency_key', '') is not null then
    select * into o from sales.orders where org_id = v_org and idempotency_key = 'encomenda:' || (p ->> 'idempotency_key');
    if o.id is not null then return o; end if;
  end if;
  v_loc := (select id from inv.locations where store_id = s.id and kind = 'SALES_FLOOR' order by created_at limit 1);
  if v_loc is null then raise exception 'Loja sem local de venda' using errcode = 'P0351'; end if;
  select id into v_price_list from catalog.price_lists where org_id = v_org and is_default;
  v_can_discount := coalesce(auth.role(), '') <> 'authenticated' or private.has_perm('sales.discount');
  v_can_custom := coalesce(auth.role(), '') <> 'authenticated' or private.has_perm('sales.custom_item');

  insert into sales.orders (org_id, legal_entity_id, store_id, location_id, number, channel, status, party_id, seller_member_id, profit_cost_center_id,
                            price_list_id, fulfillment_type, subtotal, total, idempotency_key, notes, created_by)
  values (v_org, s.legal_entity_id, s.id, v_loc, core.next_number(v_org, 'VEN'), coalesce(nullif(p ->> 'channel', ''), 'POS')::sales.channel, 'PENDING_PAYMENT',
          (p ->> 'party_id')::uuid, private.member_id(), s.cost_center_id, v_price_list, 'TAKEAWAY', 0, 0, 'encomenda:' || coalesce(nullif(p ->> 'idempotency_key', ''), gen_random_uuid()::text),
          concat_ws(' · ', 'ENCOMENDA (peças a pedir ao fornecedor)', nullif(trim(coalesce(p ->> 'notes', '')), '')), private.member_id())
  returning * into o;

  for it in select * from jsonb_array_elements(p -> 'items') loop
    v_qty := coalesce(nullif(it ->> 'qty', '')::numeric, 1);
    if v_qty <= 0 or v_qty <> trunc(v_qty) or v_qty > 50 then raise exception 'Quantidade inválida' using errcode = 'P0350'; end if;

    if nullif(it ->> 'variant_id', '') is null then
      -- item avulso (serviço ou peça fora do cadastro): não tem estoque nem vai ao pedido de compra
      if not v_can_custom then raise exception 'Inclusão de item avulso exige permissão sales.custom_item' using errcode = '42501'; end if;
      v_desc := trim(coalesce(it ->> 'description', ''));
      if v_desc = '' then raise exception 'Item avulso precisa de descrição' using errcode = 'P0350'; end if;
      v_unit := coalesce(nullif(it ->> 'unit_price', '')::numeric, 0);
      if v_unit < 0 then raise exception 'Preço inválido' using errcode = 'P0350'; end if;
      v_list := coalesce(nullif(it ->> 'list_price', '')::numeric, v_unit);
      v_disc := coalesce(nullif(it ->> 'discount_amount', '')::numeric, 0) + greatest(v_list - v_unit, 0) * v_qty;
      if coalesce(nullif(it ->> 'discount_amount', '')::numeric, 0) < 0 or v_disc > round(v_list * v_qty, 2) then
        raise exception 'Desconto inválido: maior que o valor do item ou negativo' using errcode = 'P0008';
      end if;
      if v_disc > 0 and not v_can_discount then raise exception 'Desconto exige permissão sales.discount' using errcode = '42501'; end if;
      insert into sales.order_items (org_id, order_id, variant_id, description, qty, list_price, unit_price, discount_amount, discount_reason, total, ncm)
      values (v_org, o.id, null, v_desc, v_qty, v_list, v_list, v_disc, nullif(it ->> 'discount_reason', ''), round(v_list * v_qty - v_disc, 2), private.clean_ncm(it ->> 'ncm'));
      v_subtotal := v_subtotal + v_list * v_qty; v_discount := v_discount + v_disc;
      continue;
    end if;

    select va.id, va.sku, pr.name, pr.backorder, c.name as color, va.size into v from catalog.variants va join catalog.products pr on pr.id = va.product_id
      left join catalog.colors c on c.id = va.color_id where va.id = (it ->> 'variant_id')::uuid and va.org_id = v_org;
    if v.id is null then raise exception 'Peça não encontrada' using errcode = 'P0350'; end if;
    v_list := catalog.current_price(v.id, v_price_list);
    if v_list is null or v_list <= 0 then raise exception '% (%) está sem preço', v.name, v.sku using errcode = 'P0350'; end if;
    v_unit := coalesce(nullif(it ->> 'unit_price', '')::numeric, v_list);
    v_disc := coalesce(nullif(it ->> 'discount_amount', '')::numeric, 0) + greatest(v_list - v_unit, 0) * v_qty;
    if coalesce(nullif(it ->> 'discount_amount', '')::numeric, 0) < 0 or v_disc > round(v_list * v_qty, 2) then
      raise exception 'Desconto inválido: maior que o valor do item ou negativo' using errcode = 'P0008';
    end if;
    if v_disc > 0 and not v_can_discount then raise exception 'Desconto exige permissão sales.discount' using errcode = '42501'; end if;

    -- o que a loja tem fica reservado; o que falta (só de produto liberado) vai ao pedido de compra
    select floor(greatest(sl.available, 0)) into v_av from inv.stock_levels sl where sl.location_id = v_loc and sl.variant_id = v.id for update;
    v_av := coalesce(v_av, 0);
    v_res_qty := least(v_av, v_qty);
    v_bo_qty := v_qty - v_res_qty;
    if v_bo_qty > 0 and not v.backorder then
      raise exception '% (%) não está liberado para encomenda e a loja tem % na quantidade pedida (%)', v.name, v.sku, v_av::int, v_qty::int using errcode = 'P0352';
    end if;
    v_disc_a := case when v_bo_qty = 0 then v_disc else round(v_disc * v_res_qty / v_qty, 2) end;

    if v_res_qty > 0 then
      insert into sales.order_items (org_id, order_id, variant_id, qty, list_price, unit_price, discount_amount, discount_reason, total)
      values (v_org, o.id, v.id, v_res_qty, v_list, v_list, v_disc_a, nullif(it ->> 'discount_reason', ''), round(v_list * v_res_qty - v_disc_a, 2)) returning id into v_item;
      insert into inv.reservations (org_id, variant_id, location_id, qty, reason, order_id, party_id, created_by_kind)
      values (v_org, v.id, v_loc, v_res_qty, 'ORDER', o.id, o.party_id, 'HUMAN') returning * into v_res;
      update sales.order_items set reservation_id = v_res.id where id = v_item;
    end if;

    if v_bo_qty > 0 then
      if po.id is null then
        select (value ->> 'supplier_party_id')::uuid into v_supplier from core.settings where org_id = v_org and key = 'backorders';
        if v_supplier is null then raise exception 'Defina o fornecedor das encomendas (Vender › Encomendas)' using errcode = 'P0351'; end if;
        -- pedido de compra em rascunho do fornecedor nesta loja (complementa) ou um novo
        select * into po from purch.purchase_orders where org_id = v_org and supplier_party_id = v_supplier and store_id = s.id and status = 'DRAFT'
        order by created_at limit 1 for update;
        if po.id is null then
          insert into purch.purchase_orders (org_id, legal_entity_id, location_id, store_id, supplier_party_id, number, notes, total, created_by)
          values (v_org, s.legal_entity_id, v_loc, s.id, v_supplier, core.next_number(v_org, 'PC'), 'Encomendas de clientes (gerado pelo sistema)', 0, private.member_id())
          returning * into po;
        end if;
      end if;
      insert into sales.order_items (org_id, order_id, variant_id, qty, list_price, unit_price, discount_amount, discount_reason, total)
      values (v_org, o.id, v.id, v_bo_qty, v_list, v_list, v_disc - v_disc_a, nullif(it ->> 'discount_reason', ''), round(v_list * v_bo_qty - (v_disc - v_disc_a), 2)) returning id into v_item;
      insert into sales.backorder_items (org_id, order_id, order_item_id, variant_id, qty, po_id) values (v_org, o.id, v_item, v.id, v_bo_qty, po.id);
      v_ordered := true;

      -- custo no pedido de compra: último custo conhecido → preço de atacado da marca → preço de catálogo (sem desconto) → zero
      v_cost := coalesce((select coalesce(ic.last_cost, nullif(ic.avg_cost, 0)) from inv.item_costs ic where ic.variant_id = v.id and ic.legal_entity_id = s.legal_entity_id),
                         (select pr.wholesale_cost from catalog.variants va join catalog.products pr on pr.id = va.product_id where va.id = v.id),
                         v_list, 0);
      if exists (select 1 from purch.po_items where po_id = po.id and variant_id = v.id) then
        update purch.po_items set qty_ordered = qty_ordered + v_bo_qty where po_id = po.id and variant_id = v.id;
      else
        insert into purch.po_items (org_id, po_id, variant_id, qty_ordered, unit_cost) values (v_org, po.id, v.id, v_bo_qty, v_cost);
      end if;
      v_lines := v_lines || format(E'\n%s × %s %s %s (%s)', v_bo_qty::int, v.name, coalesce(v.color, ''), v.size, v.sku);
    end if;
    v_subtotal := v_subtotal + v_list * v_qty; v_discount := v_discount + v_disc;
  end loop;

  -- cupom (percentual ou valor) sobre o subtotal líquido, como na venda de balcão
  if coalesce(p ->> 'coupon_code', '') <> '' then
    select * into v_coupon from sales.coupons where org_id = v_org and upper(code) = upper(p ->> 'coupon_code') and active and valid_from <= now() and (valid_to is null or valid_to > now());
    if v_coupon.id is null then raise exception 'Cupom inválido ou expirado' using errcode = 'P0008'; end if;
    if v_coupon.min_order is not null and v_subtotal - v_discount < v_coupon.min_order then raise exception 'Pedido abaixo do mínimo do cupom' using errcode = 'P0008'; end if;
    v_cdisc := round(case when v_coupon.kind = 'PERCENT' then (v_subtotal - v_discount) * v_coupon.value / 100 else least(v_coupon.value, v_subtotal - v_discount) end, 2);
    v_discount := v_discount + v_cdisc;
    insert into sales.coupon_redemptions (org_id, coupon_id, order_id, party_id, amount) values (v_org, v_coupon.id, o.id, o.party_id, v_cdisc);
    update sales.orders set coupon_id = v_coupon.id, attribution = attribution || jsonb_build_object('coupon', v_coupon.code, 'affiliate_party_id', v_coupon.affiliate_party_id) where id = o.id;
  end if;

  update sales.orders set subtotal = round(v_subtotal, 2), discount_total = round(v_discount, 2), total = round(v_subtotal - v_discount, 2)
  where id = o.id returning * into o;
  insert into sales.order_credits (order_id, org_id, member_id, role, share_pct)
  values (o.id, v_org, o.seller_member_id, case when o.seller_member_id is null then 'HOUSE' else 'CLOSER' end, 100);

  if po.id is not null then
    update purch.purchase_orders set
      total = (select coalesce(sum(qty_ordered * unit_cost), 0) from purch.po_items where po_id = po.id),
      notes = left(concat_ws(E'\n', notes, format('Encomenda %s — %s:%s', o.number, v_party, v_lines)), 4000)
    where id = po.id;
    select id into v_task from crm.tasks where source_rule = 'po_close:' || po.id and status = 'OPEN';
    if v_task is null then
      insert into crm.tasks (org_id, type, title, body, due_at, source_rule)
      values (v_org, 'FOLLOW_UP', 'Fechar o pedido de compra ' || po.number || ' (encomendas de clientes)',
              'Peças encomendadas por clientes entraram no pedido de compra em rascunho. Confira, aprove e envie ao fornecedor (Produtos › Pedidos de compra).',
              ((current_date + 1)::timestamp + time '12:00') at time zone 'America/Sao_Paulo', 'po_close:' || po.id);
    end if;
  end if;
  if not v_ordered then
    update inv.reservations set expires_at = now() + interval '24 hours' where order_id = o.id and status = 'ACTIVE';
  end if;
  return o;
end $$;

select private.lock_functions();
