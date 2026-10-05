-- =====================================================================
-- Fiscal › Notas emitidas: reenviar nota rejeitada, emitir venda que ficou sem nota, cancelar NFC-e/NF-e autorizada e vigiar vendas sem nota.
-- A emissão em si é do worker (fila fiscal_emission → Focus NFe); aqui ficam os pedidos das telas e as regras.
-- Códigos de erro: P0120 pedido/nota em situação que não permite · P0121 já existe nota · P0122 justificativa inválida · P0123 não encontrado.
-- =====================================================================

-- Histórico de eventos da nota (pedido de cancelamento, falha, reenvio) — só o servidor acrescenta
create or replace function fiscal.record_document_event(p_document uuid, p_event jsonb) returns void
language sql security definer set search_path = '' as $$
  update fiscal.documents set events = events || jsonb_build_array(p_event || jsonb_build_object('at', now())) where id = p_document;
$$;

-- Cancelamento confirmado pelo provedor: a nota passa a CANCELADA (o protocolo do evento fica no histórico)
create or replace function fiscal.record_cancellation(p_document uuid, p jsonb) returns void
language sql security definer set search_path = '' as $$
  update fiscal.documents
  set status = 'CANCELLED', sefaz_code = p ->> 'sefaz_code', sefaz_msg = p ->> 'sefaz_msg',
      events = events || jsonb_build_array(jsonb_build_object('type', 'CANCELLED', 'protocol', p ->> 'protocol', 'sefaz_code', p ->> 'sefaz_code', 'sefaz_msg', p ->> 'sefaz_msg', 'at', now()))
  where id = p_document and status = 'AUTHORIZED';
$$;

-- ---------------------------------------------------------------------
-- 1) Emitir / reenviar a nota de uma venda (mesma referência: o Focus aceita reenviar nota rejeitada depois de corrigir o cadastro)
-- ---------------------------------------------------------------------
create or replace function fiscal.request_emission(p_order uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare o sales.orders;
begin
  perform private.require_perm('fiscal.write');
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

-- ---------------------------------------------------------------------
-- 2) Cancelar nota autorizada (justificativa de 15 a 255 caracteres, exigência da SEFAZ). Cancelar a nota NÃO desfaz a venda:
--    estoque, comissão e razão se corrigem por devolução/cancelamento do pedido.
-- ---------------------------------------------------------------------
create or replace function fiscal.request_cancellation(p_document uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare d fiscal.documents; v_reason text := trim(coalesce(p_reason, ''));
begin
  perform private.require_perm('fiscal.write');
  select * into d from fiscal.documents where id = p_document and org_id = private.org_id() and direction = 'OUT';
  if d.id is null then raise exception 'Nota não encontrada' using errcode = 'P0123'; end if;
  if d.status <> 'AUTHORIZED' then raise exception 'Só nota autorizada pode ser cancelada (situação atual: %)', d.status using errcode = 'P0120'; end if;
  if length(v_reason) not between 15 and 255 then raise exception 'A justificativa precisa ter de 15 a 255 caracteres' using errcode = 'P0122'; end if;
  perform private.enqueue('fiscal_emission', jsonb_build_object('org_id', d.org_id, 'document_id', d.id, 'order_id', d.order_id, 'action', 'CANCEL', 'reason', v_reason, 'model', d.model));
  update fiscal.documents set events = events || jsonb_build_array(jsonb_build_object('type', 'CANCEL_REQUESTED', 'by', private.member_id(), 'at', now(), 'reason', v_reason)) where id = d.id;
end $$;

-- ---------------------------------------------------------------------
-- 3) Vendas pagas sem nota (o RLS do chamador vale: security_invoker)
-- ---------------------------------------------------------------------
create or replace view fiscal.v_uninvoiced_orders with (security_invoker = true) as
  select o.id as order_id, o.org_id, o.number, o.channel, o.status, o.total, o.created_at, o.store_id, o.party_id
  from sales.orders o
  where o.status in ('PAID', 'FULFILLING', 'READY_FOR_PICKUP', 'SHIPPED', 'COMPLETED', 'PARTIALLY_RETURNED')
    and not exists (select 1 from fiscal.documents d where d.order_id = o.id and d.direction = 'OUT' and d.status in ('AUTHORIZED', 'PROCESSING'));   -- nota cancelada com a venda de pé volta a ser pendência (venda cancelada/devolvida sai pela situação do pedido)
grant select on fiscal.v_uninvoiced_orders to authenticated;

-- Alerta (pg_cron, de hora em hora): venda paga há mais de 30 minutos sem nota; no máximo um aviso por dia
create or replace function private.check_uninvoiced_orders() returns int
language plpgsql security definer set search_path = '' as $$
declare r record; n int := 0;
begin
  for r in select org_id, count(*) as qty, coalesce(sum(total), 0) as total from fiscal.v_uninvoiced_orders where created_at < now() - interval '30 minutes' group by org_id loop
    if not exists (select 1 from core.notifications where org_id = r.org_id and kind = 'FISCAL_PENDING' and created_at > now() - interval '1 day') then
      perform core.notify(r.org_id, 'FISCAL_PENDING', r.qty || ' venda(s) paga(s) sem nota fiscal — R$ ' || replace(to_char(r.total, 'FM999999990.00'), '.', ','),
                          jsonb_build_object('orders', r.qty, 'total', r.total), 'fiscal.write');
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

insert into private.internal_functions (fqname) values ('fiscal.record_document_event'), ('fiscal.record_cancellation'), ('private.check_uninvoiced_orders') on conflict do nothing;
select private.lock_functions();

select cron.schedule('centralops-uninvoiced-orders', '10 * * * *', $$ select private.check_uninvoiced_orders() $$);
