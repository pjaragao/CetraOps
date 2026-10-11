-- =====================================================================
-- Correções de segurança e integridade (revisão de 11/10/2026) nas mudanças de 09–10/10:
-- 1) Stone: a chave secreta nunca sai do servidor; confirmar pagamento é só do servidor (conferido na API da Stone, com o valor pago);
--    maquininhas só pelo sócio; pagamento da maquininha só entra numa venda se a Stone confirmou e uma única vez.
-- 2) Situação do pedido: só o fluxo de entrega muda à mão; pagamento, cancelamento e devolução seguem pelos caminhos que lançam
--    estoque, financeiro e contabilidade (registrar pagamento, cancelar pedido, trocas e devoluções).
-- 3) Desconto nunca maior que o item nem negativo; item avulso exige a permissão própria (sales.custom_item).
-- 4) NFC-e com item avulso: o item entra na nota (antes ficava de fora); vale-troca filtrado pela empresa.
-- 5) Busca de notas recebidas (MDe) só com provedor que faz MDe (Focus NFe ou Brasil NFe).
-- 6) IA: rascunho de campanha passa pelo cartão de confirmação.
-- 7) Link curto: clique repetido da mesma pessoa em 10 min conta uma vez (sem guardar IP); robô de pré-visualização não conta.
-- 8) Nenhuma função dos schemas expostos executável por anon/PUBLIC (faltou private.lock_functions nas migrations de 10/10).
-- Códigos de erro: P0004 situação · P0005 pagamento · P0008 desconto/cupom · 42501 permissão.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Stone
-- ---------------------------------------------------------------------
select private.rpc_only('sales', array['stone_pos_orders']);
create unique index if not exists stone_pos_orders_stone_uq on sales.stone_pos_orders (stone_order_id);

-- Configuração para as telas: SEM a chave secreta
create or replace function sales.get_stone_config() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); c core.integration_connections; v_terminals jsonb; v_default text;
begin
  perform private.require_perm('sales.read');
  select * into c from core.integration_connections where org_id = v_org and provider = 'STONE' and status <> 'DISABLED' order by updated_at desc limit 1;
  v_terminals := coalesce(c.config -> 'terminals', '[]'::jsonb);
  v_default := c.config ->> 'default_serial_number';
  if jsonb_array_length(v_terminals) = 0 and coalesce(v_default, '') <> '' then
    v_terminals := jsonb_build_array(jsonb_build_object('id', 'default', 'name', 'Maquininha Padrão', 'serial', v_default, 'is_default', true));
  end if;
  return jsonb_build_object('has_integration', c.id is not null and c.secret_ref is not null, 'connection_id', c.id, 'stone_code', c.config ->> 'stone_code',
                            'default_serial_number', v_default, 'terminals', v_terminals, 'environment', coalesce(c.config ->> 'environment', 'producao'));
end $$;

-- Servidor (service_role): chave secreta da Stone da empresa
create or replace function sales.stone_secret(p_org uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
declare v_ref text; v_secret text;
begin
  select secret_ref into v_ref from core.integration_connections where org_id = p_org and provider = 'STONE' and status <> 'DISABLED' and secret_ref is not null order by updated_at desc limit 1;
  if v_ref is null then return null; end if;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = v_ref;
  if v_secret is null then return null; end if;
  if left(v_secret, 1) = '{' then return coalesce(nullif(v_secret::jsonb ->> 'secret_key', ''), nullif(v_secret::jsonb ->> 'token', '')); end if;
  return v_secret;
end $$;

-- Maquininhas: só quem administra as integrações
create or replace function sales.save_stone_terminals(p_terminals jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); c core.integration_connections; v_default text; elem jsonb; v_clean jsonb := '[]';
begin
  perform private.require_perm('core.admin');
  if jsonb_typeof(p_terminals) is distinct from 'array' or jsonb_array_length(p_terminals) > 20 then raise exception 'Lista de maquininhas inválida (até 20)' using errcode = '22023'; end if;
  for elem in select * from jsonb_array_elements(p_terminals) loop
    if coalesce(trim(elem ->> 'serial'), '') !~ '^[A-Za-z0-9._-]{4,40}$' then raise exception 'Número de série inválido: %', coalesce(elem ->> 'serial', '') using errcode = '22023'; end if;
    v_clean := v_clean || jsonb_build_object('id', left(coalesce(nullif(elem ->> 'id', ''), gen_random_uuid()::text), 60), 'name', left(coalesce(nullif(trim(elem ->> 'name'), ''), 'Maquininha'), 60),
                                             'serial', trim(elem ->> 'serial'), 'is_default', coalesce((elem ->> 'is_default')::boolean, false));
    if coalesce((elem ->> 'is_default')::boolean, false) and v_default is null then v_default := trim(elem ->> 'serial'); end if;
  end loop;
  if v_default is null and jsonb_array_length(v_clean) > 0 then v_default := v_clean -> 0 ->> 'serial'; end if;
  select * into c from core.integration_connections where org_id = v_org and provider = 'STONE' order by updated_at desc limit 1;
  if c.id is null then
    insert into core.integration_connections (org_id, provider, capability, config, status) values (v_org, 'STONE', 'ACQUIRER', '{}', 'PENDING') returning * into c;
  end if;
  update core.integration_connections set config = coalesce(config, '{}') || jsonb_build_object('terminals', v_clean, 'default_serial_number', v_default), updated_at = now()
  where id = c.id returning * into c;
  return jsonb_build_object('ok', true, 'terminals', c.config -> 'terminals', 'default_serial', v_default);
end $$;

drop function if exists sales.record_stone_pos_order(uuid, text, text, numeric, text, integer, text, jsonb);
create or replace function sales.record_stone_pos_order(p_order_id uuid, p_stone_order_id text, p_terminal_serial text, p_amount numeric, p_method text, p_installments integer,
                                                        p_display_name text default null, p_raw jsonb default '{}'::jsonb, p_terminal_name text default null) returns sales.stone_pos_orders
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); r sales.stone_pos_orders;
begin
  perform private.require_perm('sales.write');
  if p_order_id is not null and not exists (select 1 from sales.orders where id = p_order_id and org_id = v_org) then raise exception 'Pedido não encontrado' using errcode = 'P0002'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Valor inválido' using errcode = '22023'; end if;
  if upper(coalesce(p_method, '')) not in ('CREDIT', 'DEBIT', 'PIX') then raise exception 'Forma de pagamento inválida' using errcode = '22023'; end if;
  if coalesce(p_stone_order_id, '') = '' then raise exception 'Ordem da Stone inválida' using errcode = '22023'; end if;
  insert into sales.stone_pos_orders (org_id, order_id, stone_order_id, terminal_serial, terminal_name, amount, method, installments, display_name, raw_response, created_by)
  values (v_org, p_order_id, p_stone_order_id, p_terminal_serial, p_terminal_name, round(p_amount, 2), upper(p_method), greatest(coalesce(p_installments, 1), 1), p_display_name,
          coalesce(p_raw, '{}'), auth.uid())
  returning * into r;
  return r;
end $$;

-- Servidor (service_role): a Stone confirmou o pagamento (consultado na API da Stone, nunca o que o navegador diz).
-- Idempotente; o valor pago tem de ser o valor da ordem.
drop function if exists sales.complete_stone_pos_payment(text, text, text, text, jsonb);
create or replace function sales.complete_stone_pos_payment(p_org uuid, p_stone_order_id text, p_paid_amount numeric, p_method text, p_installments integer,
                                                            p_nsu text, p_auth_code text default null, p_card_brand text default null, p_raw jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s sales.stone_pos_orders; o sales.orders; v_method text := upper(coalesce(p_method, ''));
begin
  select * into s from sales.stone_pos_orders where stone_order_id = p_stone_order_id and org_id = p_org for update;
  if s.id is null then return jsonb_build_object('ok', false, 'error', 'Ordem Stone não encontrada'); end if;
  if s.status = 'PAID' then return jsonb_build_object('ok', true, 'already', true, 'stone_pos_order_id', s.id, 'order_id', s.order_id, 'status', 'PAID', 'nsu', s.nsu); end if;
  if s.status <> 'PENDING' then return jsonb_build_object('ok', false, 'error', format('Ordem Stone em situação %s', s.status)); end if;
  if round(coalesce(p_paid_amount, 0), 2) <> s.amount then
    update sales.stone_pos_orders set status = 'FAILED', raw_response = coalesce(p_raw, raw_response), updated_at = now() where id = s.id;
    return jsonb_build_object('ok', false, 'error', format('Valor pago (%s) diferente do cobrado (%s): confira na maquininha', p_paid_amount, s.amount));
  end if;
  if v_method not in ('CREDIT', 'DEBIT', 'PIX') then v_method := s.method; end if;
  update sales.stone_pos_orders set status = 'PAID', method = v_method, installments = greatest(coalesce(p_installments, s.installments), 1), nsu = coalesce(nullif(p_nsu, ''), s.nsu),
         auth_code = coalesce(p_auth_code, s.auth_code), card_brand = coalesce(p_card_brand, s.card_brand), raw_response = coalesce(p_raw, s.raw_response), updated_at = now()
  where id = s.id returning * into s;
  if s.order_id is not null then
    select * into o from sales.orders where id = s.order_id;
    if o.id is not null and o.status in ('PENDING_PAYMENT', 'CONFIRMED', 'DRAFT') then
      perform sales.register_payment(jsonb_build_object('order_id', s.order_id, 'method', s.method, 'amount', s.amount, 'installments', s.installments, 'acquirer', 'STONE',
                                                        'nsu', s.nsu, 'auth_code', s.auth_code, 'brand', s.card_brand, 'external_id', s.stone_order_id));
    end if;
  end if;
  return jsonb_build_object('ok', true, 'stone_pos_order_id', s.id, 'order_id', s.order_id, 'status', 'PAID', 'nsu', s.nsu, 'method', s.method, 'installments', s.installments, 'amount', s.amount);
end $$;

-- Servidor (service_role): a Stone avisou que a ordem foi cancelada/expirou
create or replace function sales.fail_stone_pos_order(p_org uuid, p_stone_order_id text, p_status text) returns void
language sql security definer set search_path = '' as $$
  update sales.stone_pos_orders set status = case when upper(p_status) in ('CANCELLED', 'FAILED') then upper(p_status) else 'CANCELLED' end, updated_at = now()
  where org_id = p_org and stone_order_id = p_stone_order_id and status = 'PENDING'
$$;

create or replace function sales.cancel_stone_pos_order(p_stone_order_id text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('sales.write');
  update sales.stone_pos_orders set status = 'CANCELLED', updated_at = now() where stone_order_id = p_stone_order_id and org_id = private.org_id() and status = 'PENDING';
  return found;
end $$;

-- ---------------------------------------------------------------------
-- 2) Situação do pedido
-- ---------------------------------------------------------------------
drop function if exists sales.set_order_status(uuid, text, text);
create or replace function sales.set_order_status(p_order uuid, p_status text, p_notes text default null) returns sales.orders
language plpgsql security definer set search_path = '' as $$
declare o sales.orders; v_note text := nullif(trim(coalesce(p_notes, '')), '');
begin
  perform private.require_perm('sales.write');
  select * into o from sales.orders where id = p_order and org_id = private.org_id() for update;
  if o.id is null then raise exception 'Pedido não encontrado' using errcode = 'P0002'; end if;
  if coalesce(auth.role(), '') = 'authenticated' and not private.can_store(o.store_id) then raise exception 'Sem acesso à loja do pedido' using errcode = '42501'; end if;
  if p_status = o.status::text then
    if v_note is not null then update sales.orders set notes = concat_ws(' · ', nullif(notes, ''), v_note) where id = o.id returning * into o; end if;
    return o;
  end if;
  if p_status = 'CANCELLED' then
    return sales.cancel_order(o.id, coalesce(v_note, 'cancelado pela tela do pedido'));      -- libera estoque, links e estorna o que houver
  elsif p_status in ('PAID', 'COMPLETED') and o.status in ('DRAFT', 'CONFIRMED', 'PENDING_PAYMENT') then
    raise exception 'Para marcar como pago, registre o pagamento recebido (forma, valor e comprovante): é ele que fecha a venda no estoque e no financeiro' using errcode = 'P0004';
  elsif p_status in ('PARTIALLY_RETURNED', 'RETURNED') then
    raise exception 'Devolução é feita em Vender › Trocas & devoluções (estorna estoque, financeiro e nota)' using errcode = 'P0004';
  elsif p_status = 'PENDING_PAYMENT' and o.status = 'DRAFT' and o.paid_total = 0 then
    null;                                                                                     -- rascunho remoto confirmado com a cliente
  elsif p_status = 'DRAFT' and o.status = 'PENDING_PAYMENT' and o.paid_total = 0 then
    null;
  elsif p_status in ('FULFILLING', 'READY_FOR_PICKUP', 'SHIPPED', 'COMPLETED') and o.status in ('PAID', 'FULFILLING', 'READY_FOR_PICKUP', 'SHIPPED') then
    null;                                                                                     -- fluxo de entrega
  else
    raise exception 'Não é possível passar de % para %', o.status, p_status using errcode = 'P0004';
  end if;
  update sales.orders set status = p_status::sales.order_status,
         completed_at = case when p_status = 'COMPLETED' then coalesce(completed_at, now()) else completed_at end,
         notes = case when v_note is null then notes else concat_ws(' · ', nullif(notes, ''), format('[%s → %s] %s', o.status, p_status, v_note)) end
  where id = o.id returning * into o;
  return o;
end $$;

-- Vale-troca: só da empresa de quem pergunta
create or replace function sales.get_customer_store_credit(p_party uuid) returns numeric
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_perm('sales.read');
  return coalesce((select sum(amount) from sales.store_credit_ledger where party_id = p_party and org_id = private.org_id()), 0);
end $$;

-- Rascunho de pedido: só da loja/empresa de quem chama
create or replace function sales.discard_order_draft(p_order_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare o sales.orders;
begin
  perform private.require_perm('sales.write');
  select * into o from sales.orders where id = p_order_id and org_id = private.org_id() for update;
  if o.id is null or o.status <> 'DRAFT' then return; end if;
  if coalesce(auth.role(), '') = 'authenticated' and not private.can_store(o.store_id) then raise exception 'Sem acesso a este pedido' using errcode = '42501'; end if;
  if exists (select 1 from sales.payments where order_id = o.id) then raise exception 'Rascunho com pagamento não pode ser descartado' using errcode = 'P0004'; end if;
  update inv.reservations set status = 'RELEASED' where order_id = o.id and status = 'ACTIVE';
  delete from sales.order_credits where order_id = o.id;
  delete from sales.order_items where order_id = o.id;
  delete from sales.coupon_redemptions where order_id = o.id;
  delete from sales.orders where id = o.id;
end $$;

-- ---------------------------------------------------------------------
-- 3 e 4) Vendas (descontos, item avulso, maquininha) e NFC-e com item avulso
-- ---------------------------------------------------------------------
-- NCM do item avulso (vai para a NFC-e; sem ele vale o NCM padrão da matriz fiscal, e sem nenhum a nota não sai)
create or replace function private.clean_ncm(p text) returns text
language plpgsql immutable as $$
declare d text := regexp_replace(coalesce(p, ''), '\D', '', 'g');
begin
  if d = '' then return null; end if;
  if length(d) <> 8 then raise exception 'NCM do item avulso deve ter 8 dígitos (informado: %)', p using errcode = '22023'; end if;
  return d;
end $$;

create or replace function sales.create_pos_order(p jsonb) returns sales.orders
language plpgsql security definer set search_path = '' as $$
declare
  v_store core.stores;
  v_org uuid;
  v_location uuid;
  v_price_list uuid;
  o sales.orders;
  it jsonb;
  pay jsonb;
  v_list numeric;
  v_unit numeric;
  v_disc numeric;
  v_qty numeric;
  v_subtotal numeric := 0;
  v_discount numeric := 0;
  v_paid numeric := 0;
  v_rate numeric;
  v_method text;
  v_inst int;
  v_mode text;
  v_coupon sales.coupons;
  v_coupon_disc numeric := 0;
  v_can_discount boolean;
  v_can_custom boolean;
  v_desc_text text;
  v_order_id uuid := (p ->> 'order_id')::uuid;
  v_stone uuid;
begin
  perform private.require_perm('sales.write');

  select * into v_store from core.stores where id = (p ->> 'store_id')::uuid;
  if v_store.id is null then raise exception 'Loja inválida' using errcode = '22023'; end if;
  v_org := v_store.org_id;
  if coalesce(auth.role(), '') = 'authenticated' then
    if v_org is distinct from private.org_id() or not private.can_store(v_store.id) then
      raise exception 'Sem acesso a esta loja' using errcode = '42501';
    end if;
  end if;

  select * into o from sales.orders where org_id = v_org and idempotency_key = p ->> 'idempotency_key';
  if o.id is not null then return o; end if;
  if coalesce(p ->> 'idempotency_key', '') = '' then raise exception 'idempotency_key obrigatório'; end if;
  if jsonb_array_length(coalesce(p -> 'items', '[]')) = 0 then raise exception 'Pedido sem itens'; end if;

  v_location := coalesce(
    (p ->> 'location_id')::uuid,
    (select l.id from inv.locations l where l.store_id = v_store.id and l.kind = 'SALES_FLOOR' order by l.created_at limit 1),
    (select l.id from inv.locations l where l.store_id = v_store.id order by l.created_at limit 1),
    (select l.id from inv.locations l where l.org_id = v_org and l.kind = 'SALES_FLOOR' order by l.created_at limit 1),
    (select l.id from inv.locations l where l.org_id = v_org order by l.created_at limit 1)
  );

  if v_location is null then
    insert into inv.locations (org_id, store_id, legal_entity_id, name, kind, is_sellable)
    values (v_org, v_store.id, v_store.legal_entity_id, coalesce(v_store.name, 'Loja') || ' - Balcão', 'SALES_FLOOR', true)
    returning id into v_location;
  end if;

  select id into v_price_list from catalog.price_lists where org_id = v_org and is_default;

  v_can_discount := coalesce(auth.role(), '') <> 'authenticated' or private.has_perm('sales.discount');
  v_can_custom := coalesce(auth.role(), '') <> 'authenticated' or private.has_perm('sales.custom_item');

  if v_order_id is not null then
    select * into o from sales.orders where id = v_order_id and org_id = v_org for update;
    if o.id is null or o.status <> 'DRAFT' then
      v_order_id := null;
    else
      delete from sales.order_items where order_id = o.id;
      delete from sales.coupon_redemptions where order_id = o.id;
      delete from sales.payments where order_id = o.id;

      update sales.orders
      set status = 'CONFIRMED',
          store_id = v_store.id,
          location_id = v_location,
          party_id = (p ->> 'party_id')::uuid,
          seller_member_id = coalesce((p ->> 'seller_member_id')::uuid, private.member_id()),
          cash_session_id = (p ->> 'cash_session_id')::uuid,
          cpf_on_invoice = p ->> 'cpf_on_invoice',
          idempotency_key = p ->> 'idempotency_key',
          price_list_id = v_price_list,
          channel = coalesce((p ->> 'channel')::sales.channel, 'POS'),
          fulfillment_type = 'TAKEAWAY',
          attribution = coalesce(p -> 'attribution', '{}')
      where id = o.id
      returning * into o;
    end if;
  end if;

  if v_order_id is null then
    insert into sales.orders (org_id, legal_entity_id, store_id, location_id, number, channel, status, party_id,
                              seller_member_id, profit_cost_center_id, price_list_id, cash_session_id, cpf_on_invoice,
                              idempotency_key, created_by, attribution)
    values (v_org, v_store.legal_entity_id, v_store.id, v_location, core.next_number(v_org, 'VEN'),
            coalesce((p ->> 'channel')::sales.channel, 'POS'), 'CONFIRMED', (p ->> 'party_id')::uuid,
            coalesce((p ->> 'seller_member_id')::uuid, private.member_id()), v_store.cost_center_id, v_price_list,
            (p ->> 'cash_session_id')::uuid, p ->> 'cpf_on_invoice', p ->> 'idempotency_key', private.member_id(),
            coalesce(p -> 'attribution', '{}'))
    returning * into o;
  end if;

  for it in select * from jsonb_array_elements(p -> 'items') loop
    v_qty := (it ->> 'qty')::numeric;
    if v_qty <= 0 then raise exception 'Quantidade inválida no pedido'; end if;

    if (it ->> 'variant_id') is null then
      -- Item avulso (fora do estoque)
      if not v_can_custom then
        raise exception 'Inclusão de item avulso exige permissão sales.custom_item' using errcode = '42501';
      end if;
      v_desc_text := trim(coalesce(it ->> 'description', ''));
      if v_desc_text = '' then raise exception 'Item avulso precisa de descrição' using errcode = '22023'; end if;
      v_unit := coalesce((it ->> 'unit_price')::numeric, 0);
      if v_unit < 0 then raise exception 'Preço inválido para o item avulso'; end if;
      v_list := coalesce((it ->> 'list_price')::numeric, v_unit);
      v_disc := coalesce((it ->> 'discount_amount')::numeric, 0) + greatest(v_list - v_unit, 0) * v_qty;
      if coalesce((it ->> 'discount_amount')::numeric, 0) < 0 or v_disc > round(v_list * v_qty, 2) then
        raise exception 'Desconto inválido: maior que o valor do item ou negativo' using errcode = 'P0008';
      end if;
      if v_disc > 0 and not v_can_discount then
        raise exception 'Desconto exige permissão sales.discount' using errcode = '42501';
      end if;

      insert into sales.order_items (org_id, order_id, variant_id, description, qty, list_price, unit_price, discount_amount,
                                     discount_reason, total, reservation_id, ncm)
      values (v_org, o.id, null, v_desc_text, v_qty, v_list, v_list, v_disc, it ->> 'discount_reason',
              round(v_list * v_qty - v_disc, 2), null, private.clean_ncm(it ->> 'ncm'));
      v_subtotal := v_subtotal + v_list * v_qty;
      v_discount := v_discount + v_disc;
    else
      -- Item regular do catálogo
      v_list := catalog.current_price((it ->> 'variant_id')::uuid, v_price_list);
      if v_list is null then raise exception 'Variante % sem preço vigente', it ->> 'variant_id' using errcode = 'P0007'; end if;
      v_unit := coalesce((it ->> 'unit_price')::numeric, v_list);
      v_disc := coalesce((it ->> 'discount_amount')::numeric, 0) + greatest(v_list - v_unit, 0) * v_qty;
      if coalesce((it ->> 'discount_amount')::numeric, 0) < 0 or v_disc > round(v_list * v_qty, 2) then
        raise exception 'Desconto inválido: maior que o valor do item ou negativo' using errcode = 'P0008';
      end if;
      if v_disc > 0 and not v_can_discount then
        raise exception 'Desconto exige permissão sales.discount' using errcode = '42501';
      end if;

      insert into sales.order_items (org_id, order_id, variant_id, description, qty, list_price, unit_price, discount_amount,
                                     discount_reason, total, reservation_id)
      values (v_org, o.id, (it ->> 'variant_id')::uuid, null, v_qty, v_list, v_list, v_disc, it ->> 'discount_reason',
              round(v_list * v_qty - v_disc, 2), (it ->> 'reservation_id')::uuid);
      v_subtotal := v_subtotal + v_list * v_qty;
      v_discount := v_discount + v_disc;
    end if;
  end loop;

  -- Cupom (percentual ou valor) sobre o subtotal líquido
  if coalesce(p ->> 'coupon_code', '') <> '' then
    select * into v_coupon from sales.coupons
    where org_id = v_org and upper(code) = upper(p ->> 'coupon_code') and active
      and valid_from <= now() and (valid_to is null or valid_to > now());
    if v_coupon.id is null then raise exception 'Cupom inválido ou expirado' using errcode = 'P0008'; end if;
    if v_coupon.min_order is not null and v_subtotal - v_discount < v_coupon.min_order then
      raise exception 'Pedido abaixo do mínimo do cupom' using errcode = 'P0008';
    end if;
    v_coupon_disc := round(case when v_coupon.kind = 'PERCENT' then (v_subtotal - v_discount) * v_coupon.value / 100
                                else least(v_coupon.value, v_subtotal - v_discount) end, 2);
    v_discount := v_discount + v_coupon_disc;
    insert into sales.coupon_redemptions (org_id, coupon_id, order_id, party_id, amount)
    values (v_org, v_coupon.id, o.id, o.party_id, v_coupon_disc);
    update sales.orders set coupon_id = v_coupon.id,
      attribution = attribution || jsonb_build_object('coupon', v_coupon.code, 'affiliate_party_id', v_coupon.affiliate_party_id)
    where id = o.id;
  end if;

  for pay in select * from jsonb_array_elements(coalesce(p -> 'payments', '[]')) loop
    v_method := pay ->> 'method';
    -- pagamento da maquininha Stone: só vale se a Stone confirmou (valor igual) e se ainda não foi usado em outra venda
    if upper(coalesce(pay ->> 'acquirer', '')) = 'STONE' and coalesce(pay ->> 'external_id', '') <> '' then
      v_stone := null;
      update sales.stone_pos_orders set order_id = o.id, updated_at = now()
      where org_id = v_org and stone_order_id = pay ->> 'external_id' and status = 'PAID' and amount = round((pay ->> 'amount')::numeric, 2)
        and (order_id is null or order_id = o.id)
      returning id into v_stone;                                          -- a trava da linha impede usar o mesmo pagamento em duas vendas ao mesmo tempo
      if v_stone is null then
        raise exception 'Pagamento da maquininha não confirmado pela Stone, com valor diferente ou já usado em outra venda' using errcode = 'P0005';
      end if;
    end if;
    v_inst := coalesce((pay ->> 'installments')::int, 1);
    v_mode := case when v_method in ('DEBIT', 'CREDIT', 'PAYMENT_LINK') then coalesce(pay ->> 'anticipation_mode', 'D1') end;
    v_rate := case when v_method in ('DEBIT', 'CREDIT', 'PAYMENT_LINK', 'PIX') and pay ->> 'acquirer' is not null then
                fin.expected_fee_rate(v_org, pay ->> 'acquirer', case when v_method = 'PAYMENT_LINK' then 'CREDIT' else v_method end,
                                      v_inst, coalesce(v_mode, 'NATURAL'))
              end;
    insert into sales.payments (org_id, order_id, method, amount, installments, acquirer, terminal_id, nsu, auth_code,
                                brand, last4, external_id, anticipation_mode, fee_rate_expected, fee_expected, net_expected)
    values (v_org, o.id, v_method::sales.payment_method, (pay ->> 'amount')::numeric, v_inst, pay ->> 'acquirer',
            pay ->> 'terminal_id', pay ->> 'nsu', pay ->> 'auth_code', pay ->> 'brand', pay ->> 'last4', nullif(pay ->> 'external_id', ''), v_mode, v_rate,
            round((pay ->> 'amount')::numeric * coalesce(v_rate, 0) / 100, 2),
            (pay ->> 'amount')::numeric - round((pay ->> 'amount')::numeric * coalesce(v_rate, 0) / 100, 2));
    v_paid := v_paid + (pay ->> 'amount')::numeric;
  end loop;

  -- Troco em dinheiro: pago acima do total só é aceito quando há dinheiro, e vira movimento CHANGE
  if v_paid > round(v_subtotal - v_discount, 2) then
    if not exists (select 1 from jsonb_array_elements(p -> 'payments') x where x ->> 'method' = 'CASH') then
      raise exception 'Pagamento acima do total sem dinheiro para troco' using errcode = 'P0005';
    end if;
    insert into sales.cash_session_movements (org_id, session_id, type, amount, order_id, created_by)
    values (v_org, (p ->> 'cash_session_id')::uuid, 'CHANGE', -(v_paid - round(v_subtotal - v_discount, 2)), o.id, private.member_id());
    v_paid := round(v_subtotal - v_discount, 2);
  end if;

  update sales.orders set subtotal = round(v_subtotal, 2), discount_total = round(v_discount, 2),
         total = round(v_subtotal - v_discount, 2), paid_total = round(v_paid, 2)
  where id = o.id returning * into o;

  insert into sales.order_credits (order_id, org_id, member_id, role, share_pct)
  values (o.id, v_org, o.seller_member_id, case when o.seller_member_id is null then 'HOUSE' else 'CLOSER' end, 100);

  return sales.finalize_order(o.id);
end $$;

create or replace function sales.create_remote_order(p jsonb) returns sales.orders
language plpgsql security definer set search_path = '' as $$
declare
  v_store core.stores; v_org uuid; v_location uuid; v_price_list uuid; o sales.orders; it jsonb; v_list numeric; v_unit numeric; v_qty numeric; v_disc numeric;
  v_subtotal numeric := 0; v_discount numeric := 0; v_shipping numeric := coalesce((p ->> 'shipping_total')::numeric, 0); v_coupon sales.coupons; v_cdisc numeric;
  v_can_discount boolean; v_can_custom boolean; v_res inv.reservations; v_hours int := coalesce((p ->> 'hold_hours')::int, case when coalesce((p ->> 'draft')::boolean, false) then 2 else 24 end); v_item uuid; v_ai boolean := coalesce((p ->> 'assisted_by_ai')::boolean, false);
  v_desc_text text;
begin
  perform private.require_perm('sales.write');
  select * into v_store from core.stores where id = (p ->> 'store_id')::uuid;
  if v_store.id is null then raise exception 'Loja inválida' using errcode = '22023'; end if;
  v_org := v_store.org_id;
  if coalesce(auth.role(), '') = 'authenticated' and (v_org is distinct from private.org_id() or not private.can_store(v_store.id)) then raise exception 'Sem acesso a esta loja' using errcode = '42501'; end if;
  if coalesce(p ->> 'idempotency_key', '') = '' then raise exception 'idempotency_key obrigatório'; end if;
  select * into o from sales.orders where org_id = v_org and idempotency_key = p ->> 'idempotency_key';
  if o.id is not null then return o; end if;
  if jsonb_array_length(coalesce(p -> 'items', '[]')) = 0 then raise exception 'Pedido sem itens'; end if;
  if (p ->> 'channel') is not null and (p ->> 'channel') = 'POS' then raise exception 'Use o PDV para vendas de balcão'; end if;

  v_location := coalesce((p ->> 'location_id')::uuid, (select l.id from inv.locations l where l.store_id = v_store.id and l.kind = 'SALES_FLOOR' order by l.created_at limit 1));
  if v_location is null then raise exception 'Loja sem local de estoque de venda'; end if;
  select id into v_price_list from catalog.price_lists where org_id = v_org and is_default;
  v_can_discount := coalesce(auth.role(), '') <> 'authenticated' or private.has_perm('sales.discount');
  v_can_custom := coalesce(auth.role(), '') <> 'authenticated' or private.has_perm('sales.custom_item');

  insert into sales.orders (org_id, legal_entity_id, store_id, location_id, number, channel, status, party_id, seller_member_id, profit_cost_center_id,
                            price_list_id, origin_conversation_id, assisted_by_ai, fulfillment_type, idempotency_key, created_by, attribution, notes)
  values (v_org, v_store.legal_entity_id, v_store.id, v_location, core.next_number(v_org, 'VEN'), coalesce((p ->> 'channel')::sales.channel, 'WHATSAPP'),
          case when coalesce((p ->> 'draft')::boolean, false) then 'DRAFT'::sales.order_status else 'PENDING_PAYMENT'::sales.order_status end,
          (p ->> 'party_id')::uuid, coalesce((p ->> 'seller_member_id')::uuid, private.member_id()),
          coalesce((select s.cost_center_id from core.stores s where s.id = v_store.id), null), v_price_list, (p ->> 'conversation_id')::uuid, v_ai,
          coalesce((p ->> 'fulfillment_type')::sales.fulfillment_type, 'MOTOBOY'), p ->> 'idempotency_key', private.member_id(), coalesce(p -> 'attribution', '{}'), p ->> 'notes')
  returning * into o;

  update sales.orders set profit_cost_center_id = coalesce(
    (select cc.id from core.cost_centers cc where cc.store_id = v_store.id and cc.kind = 'CHANNEL' and cc.channel = 'DIGITAL' limit 1),
    (select cc.id from core.cost_centers cc join core.cost_centers par on par.id = cc.parent_id where par.store_id = v_store.id and cc.kind = 'CHANNEL' and cc.code ilike '%DIGITAL%' limit 1),
    profit_cost_center_id) where id = o.id;

  for it in select * from jsonb_array_elements(p -> 'items') loop
    v_qty := (it ->> 'qty')::numeric;
    if v_qty <= 0 then raise exception 'Quantidade inválida'; end if;

    if (it ->> 'variant_id') is null then
      if not v_can_custom then raise exception 'Inclusão de item avulso exige permissão sales.custom_item' using errcode = '42501'; end if;
      v_desc_text := trim(coalesce(it ->> 'description', ''));
      if v_desc_text = '' then raise exception 'Item avulso precisa de descrição' using errcode = '22023'; end if;
      v_unit := coalesce((it ->> 'unit_price')::numeric, 0);
      if v_unit < 0 then raise exception 'Preço inválido'; end if;
      v_list := coalesce((it ->> 'list_price')::numeric, v_unit);
      v_disc := coalesce((it ->> 'discount_amount')::numeric, 0) + greatest(v_list - v_unit, 0) * v_qty;
      if coalesce((it ->> 'discount_amount')::numeric, 0) < 0 or v_disc > round(v_list * v_qty, 2) then
        raise exception 'Desconto inválido: maior que o valor do item ou negativo' using errcode = 'P0008';
      end if;
      if v_disc > 0 and not v_can_discount then raise exception 'Desconto exige permissão sales.discount' using errcode = '42501'; end if;

      insert into sales.order_items (org_id, order_id, variant_id, description, qty, list_price, unit_price, discount_amount, total, ncm)
      values (v_org, o.id, null, v_desc_text, v_qty, v_list, v_list, v_disc, round(v_list * v_qty - v_disc, 2), private.clean_ncm(it ->> 'ncm'));
      v_subtotal := v_subtotal + v_list * v_qty; v_discount := v_discount + v_disc;
    else
      v_list := catalog.current_price((it ->> 'variant_id')::uuid, v_price_list);
      if v_list is null then raise exception 'Variante % sem preço vigente', it ->> 'variant_id' using errcode = 'P0007'; end if;
      v_unit := coalesce((it ->> 'unit_price')::numeric, v_list);
      v_disc := coalesce((it ->> 'discount_amount')::numeric, 0) + greatest(v_list - v_unit, 0) * v_qty;
      if coalesce((it ->> 'discount_amount')::numeric, 0) < 0 or v_disc > round(v_list * v_qty, 2) then
        raise exception 'Desconto inválido: maior que o valor do item ou negativo' using errcode = 'P0008';
      end if;
      if v_disc > 0 and not v_can_discount then raise exception 'Desconto exige permissão sales.discount' using errcode = '42501'; end if;
      insert into sales.order_items (org_id, order_id, variant_id, description, qty, list_price, unit_price, discount_amount, total)
      values (v_org, o.id, (it ->> 'variant_id')::uuid, null, v_qty, v_list, v_list, v_disc, round(v_list * v_qty - v_disc, 2)) returning id into v_item;

      insert into inv.reservations (org_id, variant_id, location_id, qty, reason, order_id, party_id, conversation_id, expires_at, created_by_kind)
      values (v_org, (it ->> 'variant_id')::uuid, v_location, v_qty, 'ORDER', o.id, o.party_id, o.origin_conversation_id, now() + make_interval(hours => v_hours),
              case when v_ai then 'AI' else 'HUMAN' end) returning * into v_res;
      update sales.order_items set reservation_id = v_res.id where id = v_item;
      v_subtotal := v_subtotal + v_list * v_qty; v_discount := v_discount + v_disc;
    end if;
  end loop;

  if coalesce(p ->> 'coupon_code', '') <> '' then
    select * into v_coupon from sales.coupons where org_id = v_org and upper(code) = upper(p ->> 'coupon_code') and active and valid_from <= now() and (valid_to is null or valid_to > now());
    if v_coupon.id is null then raise exception 'Cupom inválido ou expirado' using errcode = 'P0008'; end if;
    if v_coupon.min_order is not null and v_subtotal - v_discount < v_coupon.min_order then raise exception 'Pedido abaixo do mínimo do cupom' using errcode = 'P0008'; end if;
    v_cdisc := round(case when v_coupon.kind = 'PERCENT' then (v_subtotal - v_discount) * v_coupon.value / 100 else least(v_coupon.value, v_subtotal - v_discount) end, 2);
    v_discount := v_discount + v_cdisc;
    insert into sales.coupon_redemptions (org_id, coupon_id, order_id, party_id, amount) values (v_org, v_coupon.id, o.id, o.party_id, v_cdisc);
    update sales.orders set coupon_id = v_coupon.id, attribution = attribution || jsonb_build_object('coupon', v_coupon.code, 'affiliate_party_id', v_coupon.affiliate_party_id) where id = o.id;
  end if;

  update sales.orders set subtotal = round(v_subtotal, 2), discount_total = round(v_discount, 2), shipping_total = round(v_shipping, 2),
         total = round(v_subtotal - v_discount + v_shipping, 2) where id = o.id returning * into o;
  insert into sales.order_credits (order_id, org_id, member_id, role, share_pct)
  values (o.id, v_org, case when v_ai then null else o.seller_member_id end, case when v_ai then 'AI' when o.seller_member_id is null then 'HOUSE' else 'CLOSER' end, 100);
  return o;
end $$;

create or replace function sales.save_order_draft(p jsonb) returns sales.orders
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
  v_store core.stores;
  v_location uuid;
  v_price_list uuid;
  o sales.orders;
  it jsonb;
  v_order_id uuid := (p ->> 'order_id')::uuid;
  v_list numeric;
  v_unit numeric;
  v_disc numeric;
  v_qty numeric;
  v_subtotal numeric := 0;
  v_discount numeric := 0;
  v_shipping numeric := coalesce((p ->> 'shipping_total')::numeric, 0);
  v_desc_text text;
  v_coupon sales.coupons;
  v_coupon_disc numeric := 0;
  v_channel sales.channel := coalesce((p ->> 'channel')::sales.channel, 'POS');
  v_ff sales.fulfillment_type := coalesce((p ->> 'fulfillment_type')::sales.fulfillment_type, 'TAKEAWAY');
begin
  perform private.require_perm('sales.write');

  select * into v_store from core.stores where id = (p ->> 'store_id')::uuid;
  if v_store.id is null then raise exception 'Loja não encontrada' using errcode = '22023'; end if;
  v_org := v_store.org_id;
  if coalesce(auth.role(), '') = 'authenticated' then
    if v_org is distinct from private.org_id() or not private.can_store(v_store.id) then
      raise exception 'Sem acesso a esta loja' using errcode = '42501';
    end if;
  end if;

  v_location := coalesce(
    (p ->> 'location_id')::uuid,
    (select l.id from inv.locations l where l.store_id = v_store.id and l.kind = 'SALES_FLOOR' order by l.created_at limit 1),
    (select l.id from inv.locations l where l.store_id = v_store.id order by l.created_at limit 1),
    (select l.id from inv.locations l where l.org_id = v_org and l.kind = 'SALES_FLOOR' order by l.created_at limit 1),
    (select l.id from inv.locations l where l.org_id = v_org order by l.created_at limit 1)
  );

  if v_location is null then
    insert into inv.locations (org_id, store_id, legal_entity_id, name, kind, is_sellable)
    values (v_org, v_store.id, v_store.legal_entity_id, coalesce(v_store.name, 'Loja') || ' - Balcão', 'SALES_FLOOR', true)
    returning id into v_location;
  end if;

  select id into v_price_list from catalog.price_lists where org_id = v_org and is_default;
  if nullif(p ->> 'party_id', '') is not null and not exists (select 1 from crm.parties where id = (p ->> 'party_id')::uuid and org_id = v_org) then
    raise exception 'Cliente inválida' using errcode = '22023';
  end if;

  -- Se foi passado order_id, verifica se o pedido existe e está em DRAFT
  if v_order_id is not null then
    select * into o from sales.orders where id = v_order_id and org_id = v_org for update;
    if o.id is null then raise exception 'Pedido não encontrado' using errcode = 'P0002'; end if;
    if o.status <> 'DRAFT' then raise exception 'Apenas pedidos em rascunho podem ser alterados' using errcode = 'P0093'; end if;

    update sales.orders
    set party_id = (p ->> 'party_id')::uuid,
        channel = v_channel,
        fulfillment_type = v_ff,
        shipping_total = v_shipping,
        notes = p ->> 'notes',
        location_id = coalesce(o.location_id, v_location)
    where id = o.id
    returning * into o;

    delete from sales.order_items where order_id = o.id;
    delete from sales.coupon_redemptions where order_id = o.id;
  else
    insert into sales.orders (
      org_id, legal_entity_id, store_id, location_id, number, channel, status,
      party_id, seller_member_id, profit_cost_center_id, price_list_id,
      fulfillment_type, created_by, notes, shipping_total, idempotency_key
    )
    values (
      v_org, v_store.legal_entity_id, v_store.id, v_location, core.next_number(v_org, 'VEN'),
      v_channel, 'DRAFT', (p ->> 'party_id')::uuid, private.member_id(),
      v_store.cost_center_id, v_price_list, v_ff, private.member_id(),
      p ->> 'notes', v_shipping, coalesce(p ->> 'idempotency_key', 'draft-' || gen_random_uuid())
    )
    returning * into o;
  end if;

  -- Gravar itens do pedido
  for it in select * from jsonb_array_elements(coalesce(p -> 'items', '[]'::jsonb)) loop
    v_qty := coalesce((it ->> 'qty')::numeric, 1);
    if v_qty <= 0 then v_qty := 1; end if;

    if (it ->> 'variant_id') is null then
      if coalesce(auth.role(), '') = 'authenticated' and not private.has_perm('sales.custom_item') then
        raise exception 'Inclusão de item avulso exige permissão sales.custom_item' using errcode = '42501';
      end if;
      v_desc_text := trim(coalesce(it ->> 'description', 'Item avulso'));
      v_unit := coalesce((it ->> 'unit_price')::numeric, 0);
      v_list := coalesce((it ->> 'list_price')::numeric, v_unit);
      v_list := greatest(v_list, 0);
      v_disc := least(greatest(coalesce((it ->> 'discount_amount')::numeric, 0), 0), round(v_list * v_qty, 2));   -- rascunho: desconto fora da faixa é ajustado; a venda confere de novo

      insert into sales.order_items (
        org_id, order_id, variant_id, description, qty, list_price, unit_price, discount_amount,
        discount_reason, total, ncm
      )
      values (
        v_org, o.id, null, v_desc_text, v_qty, v_list, v_unit, v_disc,
        it ->> 'discount_reason', round(v_list * v_qty - v_disc, 2), private.clean_ncm(it ->> 'ncm')
      );
      v_subtotal := v_subtotal + v_list * v_qty;
      v_discount := v_discount + v_disc;
    else
      v_list := catalog.current_price((it ->> 'variant_id')::uuid, v_price_list);
      if v_list is null then v_list := coalesce((it ->> 'unit_price')::numeric, 0); end if;
      v_unit := coalesce((it ->> 'unit_price')::numeric, v_list);
      v_list := greatest(v_list, 0);
      v_disc := least(greatest(coalesce((it ->> 'discount_amount')::numeric, 0), 0), round(v_list * v_qty, 2));   -- rascunho: desconto fora da faixa é ajustado; a venda confere de novo

      insert into sales.order_items (
        org_id, order_id, variant_id, description, qty, list_price, unit_price, discount_amount,
        discount_reason, total
      )
      values (
        v_org, o.id, (it ->> 'variant_id')::uuid, null, v_qty, v_list, v_unit, v_disc,
        it ->> 'discount_reason', round(v_list * v_qty - v_disc, 2)
      );
      v_subtotal := v_subtotal + v_list * v_qty;
      v_discount := v_discount + v_disc;
    end if;
  end loop;

  -- Cupom no rascunho
  if coalesce(p ->> 'coupon_code', '') <> '' then
    select * into v_coupon from sales.coupons
    where org_id = v_org and upper(code) = upper(p ->> 'coupon_code') and active
      and valid_from <= now() and (valid_to is null or valid_to > now());
    if v_coupon.id is not null then
      v_coupon_disc := round(case when v_coupon.kind = 'PERCENT' then (v_subtotal - v_discount) * v_coupon.value / 100
                                  else least(v_coupon.value, v_subtotal - v_discount) end, 2);
      v_discount := v_discount + v_coupon_disc;
      update sales.orders
      set coupon_id = v_coupon.id,
          attribution = attribution || jsonb_build_object('coupon', v_coupon.code, 'affiliate_party_id', v_coupon.affiliate_party_id)
      where id = o.id;
    end if;
  else
    update sales.orders set coupon_id = null where id = o.id;
  end if;

  update sales.orders
  set subtotal = round(v_subtotal, 2),
      discount_total = round(v_discount, 2),
      total = round(greatest(v_subtotal - v_discount + v_shipping, 0), 2)
  where id = o.id
  returning * into o;

  return o;
end $$;

create or replace function fiscal.emission_payload(p_order uuid, p_purpose text default 'SALE') returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  o sales.orders; le core.legal_entities; matrix jsonb; v_items jsonb; v_pay jsonb; v_model text; v_items_sum numeric; v_coupon numeric; v_ratio numeric;
begin
  select * into o from sales.orders where id = p_order;
  if o.id is null then raise exception 'Pedido não encontrado' using errcode = 'P0002'; end if;
  select * into le from core.legal_entities where id = o.legal_entity_id;
  select value into matrix from core.settings where org_id = o.org_id and key = 'fiscal_matrix';
  matrix := coalesce(matrix, '{}');
  if p_purpose <> 'SALE' then
    return jsonb_build_object('ref', o.id::text || ':' || p_purpose, 'purpose', p_purpose, 'requires_review', true, 'order_number', o.number,
      'note', 'Devolução: o tratamento fiscal (cancelamento da NFC-e ou NF-e de entrada) depende da matriz validada com o contador');
  end if;
  v_model := case when o.channel = 'B2B' then '55'
                  when o.fulfillment_type in ('MOTOBOY', 'CARRIER') then coalesce(matrix ->> 'remote_delivery_model', '65') else '65' end;
  select coalesce(sum(total), 0) into v_items_sum from sales.order_items where order_id = o.id;
  select coalesce(sum(amount), 0) into v_coupon from sales.coupon_redemptions where order_id = o.id;
  v_ratio := case when v_items_sum > 0 then greatest(1 - v_coupon / v_items_sum, 0) else 1 end;

  select jsonb_agg(jsonb_build_object(
      'numero_item', x.n, 'codigo_produto', x.sku, 'descricao', x.name, 'codigo_ncm', coalesce(x.ncm, matrix ->> 'default_ncm'),
      'cfop', coalesce(x.cfop, matrix ->> 'cfop_balcao', '5102'), 'unidade_comercial', 'UN', 'quantidade_comercial', x.qty, 'valor_unitario_comercial', x.list_price,
      'valor_bruto', round(x.list_price * x.qty, 2), 'unidade_tributavel', 'UN', 'quantidade_tributavel', x.qty, 'valor_unitario_tributavel', x.list_price,
      'valor_desconto', round(x.list_price * x.qty - x.total * v_ratio, 2), 'icms_origem', coalesce(x.origin, 0),
      'icms_situacao_tributaria', coalesce(x.csosn, matrix ->> 'csosn', '102'), 'inclui_no_total', 1) order by x.n) into v_items
  -- item avulso (sem variante) entra com a descrição digitada e o NCM/CFOP/CSOSN do próprio item ou da matriz; sem NCM o worker não emite
  from (select row_number() over (order by i.line_no, i.id) as n, coalesce(v.sku, 'AVULSO-' || i.line_no) as sku,
               case when v.id is null then i.description else trim(concat_ws(' ', p.name, c.name, v.size)) end as name,
               coalesce(i.ncm, p.ncm) as ncm, i.cfop, i.csosn, p.origin, i.qty, i.list_price, i.total
        from sales.order_items i left join catalog.variants v on v.id = i.variant_id left join catalog.products p on p.id = v.product_id left join catalog.colors c on c.id = v.color_id
        where i.order_id = o.id) x;

  select jsonb_agg(jsonb_build_object('forma_pagamento', case pm.method when 'CASH' then '01' when 'CREDIT' then '03' when 'DEBIT' then '04' when 'PIX' then '17' when 'PAYMENT_LINK' then '03'
      when 'BOLETO' then '15' when 'STORE_CREDIT' then '05' when 'PERMUTA' then '99' else '99' end, 'valor_pagamento', pm.amount)) into v_pay
  from sales.payments pm where pm.order_id = o.id and pm.status in ('AUTHORIZED', 'CAPTURED');

  return jsonb_build_object('ref', o.id::text || ':SALE', 'purpose', 'SALE', 'model', v_model, 'order_id', o.id, 'order_number', o.number, 'legal_entity_id', o.legal_entity_id,
    'provider_ref', le.fiscal_provider_ref, 'series', case when v_model = '65' then le.nfce_series else le.nfe_series end,
    'document', jsonb_build_object('natureza_operacao', 'VENDA AO CONSUMIDOR', 'data_emissao', to_char(now() at time zone 'America/Sao_Paulo', 'YYYY-MM-DD"T"HH24:MI:SS') || '-03:00',
      'presenca_comprador', case when o.fulfillment_type in ('MOTOBOY', 'CARRIER') then 4 else 1 end, 'modalidade_frete', case when o.fulfillment_type in ('MOTOBOY', 'CARRIER') then 0 else 9 end,
      'local_destino', 1, 'finalidade_emissao', 1, 'consumidor_final', 1, 'cnpj_emitente', le.cnpj, 'cpf_destinatario', nullif(regexp_replace(coalesce(o.cpf_on_invoice, ''), '\D', '', 'g'), ''),
      'valor_frete', case when o.shipping_total > 0 then o.shipping_total end, 'itens', v_items, 'formas_pagamento', v_pay));
end $$;

drop function if exists fiscal.build_emission_payload(uuid, text);          -- versão nunca usada (o worker chama fiscal.emission_payload)

-- ---------------------------------------------------------------------
-- 5) MDe só com provedor que faz MDe
-- ---------------------------------------------------------------------
create or replace function fiscal.request_dfe_sync() returns integer
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('fiscal.write');
  if not exists (select 1 from core.integration_connections where org_id = private.org_id() and provider in ('FOCUS_NFE', 'BRASIL_NFE') and status <> 'DISABLED') then
    raise exception 'A busca de notas recebidas (MDe) usa o Focus NFe ou a Brasil NFe: conecte um deles em Configurações › Integrações' using errcode = 'P0251';
  end if;
  perform private.enqueue('fiscal_emission', jsonb_build_object('action', 'DFE_SYNC', 'org_id', private.org_id()));
  return 1;
end $$;

create or replace function private.enqueue_dfe_sync() returns integer
language plpgsql security definer set search_path = '' as $$
declare r record; n int := 0;
begin
  for r in select distinct org_id from core.integration_connections where provider in ('FOCUS_NFE', 'BRASIL_NFE') and status <> 'DISABLED' and secret_ref is not null loop
    perform private.enqueue('fiscal_emission', jsonb_build_object('action', 'DFE_SYNC', 'org_id', r.org_id));
    n := n + 1;
  end loop;
  return n;
end $$;

-- Servidor (service_role): documento fiscal pelo id do provedor (webhook da Notaas: o status vem da API, não do corpo do aviso)
create or replace function fiscal.document_by_provider_ref(p_ref text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', d.id, 'org_id', d.org_id, 'status', d.status, 'model', d.model) from fiscal.documents d
  where d.provider_ref = p_ref and d.direction = 'OUT' order by d.created_at desc limit 1
$$;

-- ---------------------------------------------------------------------
-- 6) IA: rascunho de campanha com confirmação
-- ---------------------------------------------------------------------
create or replace function private.assistant_tool_perm(p_tool text) returns text
language sql immutable as $$
  select case p_tool
    when 'venda_pdv' then 'sales.write' when 'cadastrar_pessoa' then 'crm.write' when 'reserva' then 'sales.write' when 'avise_me' then 'crm.write'
    when 'tarefa' then 'crm.write' when 'preferencias' then 'crm.write' when 'conta_pagar' then 'fin.write' when 'baixa' then 'fin.write'
    when 'abrir_caixa' then 'sales.write' when 'fechar_caixa' then 'sales.write' when 'campanha_rascunho' then 'crm.write' end
$$;

do $x$
declare v_def text; v_old text := $y$  when 'cadastrar_pessoa' then
    v_party := private.assistant_new_party(g);$y$;
begin
  select pg_get_functiondef('private.assistant_dispatch(ai.assistant_actions)'::regprocedure) into v_def;
  if position(v_old in v_def) = 0 then raise exception 'assistant_dispatch mudou: ajuste este patch'; end if;
  v_def := replace(v_def, v_old, $y$  when 'campanha_rascunho' then
    declare c mkt.campaigns;
    begin
      c := mkt.save_campaign(jsonb_build_object('name', g ->> 'name', 'objective', coalesce(g ->> 'objective', 'CUSTOM'), 'audience', coalesce(g -> 'audience', '{}')));
      return jsonb_build_object('target_type', 'mkt.campaigns', 'target_id', c.id, 'href', '/marketing/campanhas/' || c.id || '/montar?passo=2');
    end;
$y$ || v_old);
  execute v_def;
end $x$;

-- ---------------------------------------------------------------------
-- 7) Link curto: o mesmo clique (mesma pessoa, mesmo link) em 10 min conta uma vez
-- ---------------------------------------------------------------------
alter table mkt.link_clicks add column if not exists fingerprint text;      -- hash curto de IP+navegador+dia, calculado na aplicação (o IP não é guardado)
create index if not exists link_clicks_fp_idx on mkt.link_clicks (tracking_link_id, fingerprint, clicked_at) where fingerprint is not null;

create or replace function public.resolve_link(p_code text, p_meta jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare l mkt.tracking_links; ca omni.channel_accounts; cp mkt.campaigns; v_dev text := upper(coalesce(p_meta ->> 'device', 'OTHER')); v_fp text := left(nullif(p_meta ->> 'fingerprint', ''), 32);
begin
  if p_code is null or lower(p_code) !~ '^[a-z0-9][a-z0-9-]{2,22}$' then return null; end if;
  select * into l from mkt.tracking_links where code = lower(p_code) and active order by created_at limit 1;
  if l.id is null then return null; end if;
  if l.campaign_id is not null then
    select * into cp from mkt.campaigns where id = l.campaign_id;
    if cp.id is not null and cp.status in ('ENDED', 'CANCELLED') then return null; end if;
  end if;
  if v_dev not in ('MOBILE', 'DESKTOP', 'OTHER') then v_dev := 'OTHER'; end if;
  if not coalesce((p_meta ->> 'bot')::boolean, false)                                   -- pré-visualização de link (WhatsApp, Facebook…) não é clique
     and (v_fp is null or not exists (select 1 from mkt.link_clicks k where k.tracking_link_id = l.id and k.fingerprint = v_fp and k.clicked_at > now() - interval '10 minutes')) then
    insert into mkt.link_clicks (org_id, tracking_link_id, device, referrer_host, from_ad, utm, fingerprint)
    values (l.org_id, l.id, v_dev, left(p_meta ->> 'referrer_host', 120), coalesce((p_meta ->> 'from_ad')::boolean, false),
            case when jsonb_typeof(p_meta -> 'utm') = 'object' then p_meta -> 'utm' else '{}' end, v_fp);
  end if;
  if l.channel_account_id is not null then select * into ca from omni.channel_accounts where id = l.channel_account_id; end if;
  return jsonb_build_object('target', l.target, 'code', l.code, 'kind', l.kind, 'channel', ca.channel, 'address', ca.public_address, 'prefill_text', l.prefill_text,
                            'target_url', l.target_url, 'utm', l.utm, 'campaign_code', cp.code);
end $$;

-- ---------------------------------------------------------------------
-- 8) Privilégios
-- ---------------------------------------------------------------------
insert into private.internal_functions (fqname) values
  ('private.clean_ncm'), ('sales.stone_secret'), ('sales.complete_stone_pos_payment'), ('sales.fail_stone_pos_order'), ('fiscal.document_by_provider_ref')
on conflict do nothing;
select private.lock_functions();
revoke execute on function sales.finalize_order(uuid) from authenticated;
grant execute on function public.resolve_link(text, jsonb) to anon, authenticated, service_role;
