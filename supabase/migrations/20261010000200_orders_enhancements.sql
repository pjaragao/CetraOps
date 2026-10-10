-- =====================================================================
-- Melhorias no ciclo de vida dos pedidos:
-- 1) Suporte a todos os status em sales.set_order_status com liberação de reservas no cancelamento.
-- 2) sales.request_order_invoice para emissão de NF por operadores com permissão de venda ou fiscal.
-- 3) sales.get_orders_fiscal_docs e sales.get_order_fiscal_doc para consulta segura de status fiscal.
-- =====================================================================

drop function if exists sales.set_order_status(uuid, text);

create or replace function sales.set_order_status(p_order uuid, p_status text, p_notes text default null) returns sales.orders
language plpgsql security definer set search_path = '' as $$
declare
  o sales.orders;
  v_new_status sales.order_status;
begin
  perform private.require_perm('sales.write');

  select * into o from sales.orders where id = p_order and org_id = private.org_id() for update;
  if o.id is null then
    raise exception 'Pedido não encontrado' using errcode = 'P0002';
  end if;

  begin
    v_new_status := p_status::sales.order_status;
  exception when others then
    raise exception 'Situação inválida: %', p_status using errcode = 'P0004';
  end;

  -- Se for cancelamento, liberar reservas ativas e cancelar links de pagamento
  if v_new_status = 'CANCELLED' then
    update inv.reservations set status = 'RELEASED' where order_id = o.id and status = 'ACTIVE';
    update sales.payment_links set status = 'CANCELLED' where order_id = o.id and status in ('CREATED', 'SENT');
  end if;

  update sales.orders
  set
    status = v_new_status,
    completed_at = case
      when v_new_status = 'COMPLETED' and completed_at is null then now()
      when v_new_status <> 'COMPLETED' then null
      else completed_at
    end,
    notes = case
      when p_notes is not null and trim(p_notes) <> '' then
        case when notes is null or trim(notes) = '' then trim(p_notes) else concat_ws(' · ', notes, trim(p_notes)) end
      else notes
    end
  where id = o.id
  returning * into o;

  return o;
end $$;

-- Emissão fiscal direta para operadores de venda
create or replace function sales.request_order_invoice(p_order uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare o sales.orders;
begin
  if not (private.has_perm('sales.write') or private.has_perm('fiscal.write')) then
    raise exception 'Sem permissão para emitir nota fiscal' using errcode = '42501';
  end if;
  select * into o from sales.orders where id = p_order and org_id = private.org_id();
  if o.id is null then raise exception 'Pedido não encontrado' using errcode = 'P0123'; end if;
  if o.status not in ('PAID', 'FULFILLING', 'READY_FOR_PICKUP', 'SHIPPED', 'COMPLETED', 'PARTIALLY_RETURNED') then
    raise exception 'O pedido ainda não foi pago: não há o que faturar' using errcode = 'P0120';
  end if;
  if exists (select 1 from fiscal.documents where order_id = o.id and direction = 'OUT' and status in ('AUTHORIZED', 'PROCESSING')) then
    raise exception 'Este pedido já tem nota autorizada ou em processamento' using errcode = 'P0121';
  end if;
  perform private.enqueue('fiscal_emission', jsonb_build_object('org_id', o.org_id, 'order_id', o.id, 'purpose', 'SALE',
    'model', case when o.channel = 'B2B' then '55' else '65' end, 'ref', o.id::text || ':SALE', 'manual', true));
  update fiscal.documents set events = events || jsonb_build_array(jsonb_build_object('type', 'RESEND_REQUESTED', 'by', private.member_id(), 'at', now()))
  where order_id = o.id and direction = 'OUT' and status in ('REJECTED', 'DRAFT', 'CONTINGENCY_PENDING');
end $$;

-- Consulta em lote de documentos fiscais por pedido (para listas)
create or replace function sales.get_orders_fiscal_docs(p_orders uuid[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  res jsonb;
begin
  perform private.require_perm('sales.read');
  select coalesce(jsonb_object_agg(d.order_id::text, jsonb_build_object(
    'id', d.id,
    'model', d.model,
    'series', d.series,
    'number', d.number,
    'access_key', d.access_key,
    'status', d.status,
    'danfe_path', d.danfe_path,
    'xml_path', d.xml_path,
    'issue_at', d.issue_at
  )), '{}'::jsonb)
  into res
  from (
    select distinct on (d.order_id) d.*
    from fiscal.documents d
    where d.order_id = any(p_orders) and d.org_id = private.org_id() and d.direction = 'OUT'
    order by d.order_id, d.created_at desc
  ) d;
  return res;
end $$;

-- Consulta individual de documento fiscal por pedido
create or replace function sales.get_order_fiscal_doc(p_order uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r record;
begin
  perform private.require_perm('sales.read');
  select d.id, d.model, d.series, d.number, d.access_key, d.status, d.danfe_path, d.xml_path, d.issue_at, d.sefaz_code, d.sefaz_msg
  into r
  from fiscal.documents d
  where d.order_id = p_order and d.org_id = private.org_id() and d.direction = 'OUT'
  order by d.created_at desc limit 1;

  if r.id is null then return null; end if;
  return to_jsonb(r);
end $$;
