-- =====================================================================
-- Nota inutilizada na Notaas (status `inutilized`): passa a ser gravada como NUMBER_VOIDED.
--  • Antes caía em PROCESSING e a nota ficava "em processamento" para sempre.
--  • fiscal.record_emission aceita NUMBER_VOIDED (o worker avisa como rejeição; a venda pode ser reenviada).
--  • fiscal.process_notaas_webhook reconhece inutilized/inutilizada; nota autorizada ou cancelada não volta atrás.
-- =====================================================================

create or replace function fiscal.record_emission(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare o sales.orders; d fiscal.documents; v_status text := p ->> 'status';
begin
  if v_status not in ('PROCESSING', 'AUTHORIZED', 'REJECTED', 'CANCELLED', 'DENIED', 'NUMBER_VOIDED') then raise exception 'Situação fiscal inválida: %', v_status using errcode = 'P0103'; end if;
  select * into o from sales.orders where id = (p ->> 'order_id')::uuid;
  if o.id is null then raise exception 'Pedido não encontrado' using errcode = 'P0002'; end if;
  insert into fiscal.documents (org_id, legal_entity_id, direction, model, series, number, access_key, status, issue_at, protocol, sefaz_code, sefaz_msg, counterpart_party_id,
                                totals, order_id, provider_ref, xml_path, danfe_path, idempotency_key, events)
  values (o.org_id, o.legal_entity_id, 'OUT', coalesce(p ->> 'model', '65'), (p ->> 'series')::int, (p ->> 'number')::int, nullif(p ->> 'access_key', ''), v_status::text,
          case when v_status = 'AUTHORIZED' then now() end, p ->> 'protocol', p ->> 'sefaz_code', p ->> 'sefaz_msg', o.party_id,
          jsonb_build_object('vNF', o.total), o.id, p ->> 'provider_ref', p ->> 'xml_path', p ->> 'danfe_path', p ->> 'ref', jsonb_build_array(coalesce(p -> 'event', jsonb_build_object('status', v_status, 'at', now()))))
  on conflict (org_id, idempotency_key) where idempotency_key is not null do update set
    status = excluded.status, series = coalesce(excluded.series, fiscal.documents.series), number = coalesce(excluded.number, fiscal.documents.number),
    access_key = coalesce(excluded.access_key, fiscal.documents.access_key), protocol = coalesce(excluded.protocol, fiscal.documents.protocol),
    sefaz_code = excluded.sefaz_code, sefaz_msg = excluded.sefaz_msg, xml_path = coalesce(excluded.xml_path, fiscal.documents.xml_path),
    danfe_path = coalesce(excluded.danfe_path, fiscal.documents.danfe_path), issue_at = coalesce(fiscal.documents.issue_at, excluded.issue_at),
    events = fiscal.documents.events || excluded.events
  returning * into d;
  return d.id;
end $$;

create or replace function fiscal.process_notaas_webhook(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_inv_id text := coalesce(p ->> 'invoiceId', p ->> 'id');
  v_chave text := nullif(trim(replace(coalesce(p ->> 'chaveAcesso', p ->> 'chave_nfe', ''), 'NFe', '')), '');
  v_status text := lower(coalesce(p ->> 'status', ''));
  v_event text := lower(coalesce(p ->> 'event', ''));
  v_mapped_status text;
  d fiscal.documents;
begin
  if v_event in ('nfe.issued', 'nfce.issued', 'invoice.issued') or v_status in ('issued', 'autorizado', 'autorizada') then
    v_mapped_status := 'AUTHORIZED';
  elsif v_event in ('nfe.cancelled', 'nfce.cancelled', 'invoice.cancelled') or v_status in ('cancelled', 'cancelado', 'cancelada') then
    v_mapped_status := 'CANCELLED';
  elsif v_event in ('nfe.error', 'nfce.error', 'invoice.error') or v_status in ('error', 'rejeitado', 'rejeitada') then
    v_mapped_status := 'REJECTED';
  elsif v_status in ('denied', 'denegado') then
    v_mapped_status := 'DENIED';
  elsif v_status in ('inutilized', 'inutilizado', 'inutilizada') then
    v_mapped_status := 'NUMBER_VOIDED';
  else
    v_mapped_status := 'PROCESSING';
  end if;

  select * into d from fiscal.documents
  where (v_inv_id is not null and provider_ref = v_inv_id)
     or (v_chave is not null and access_key = v_chave)
  limit 1;

  if d.id is null then
    return jsonb_build_object('ok', false, 'reason', 'document_not_found', 'invoiceId', v_inv_id);
  end if;

  update fiscal.documents
  set
    status = case
      when d.status = 'CANCELLED' then 'CANCELLED'
      when d.status = 'AUTHORIZED' and v_mapped_status in ('PROCESSING', 'NUMBER_VOIDED') then 'AUTHORIZED'
      else v_mapped_status
    end,
    access_key = coalesce(v_chave, access_key),
    number = coalesce((p ->> 'numero')::int, (p ->> 'nNf')::int, number),
    series = coalesce((p ->> 'serie')::int, series),
    protocol = coalesce(p ->> 'protocolo', p ->> 'nProt', protocol),
    sefaz_code = coalesce(p ->> 'codigoStatus', p ->> 'cStat', sefaz_code),
    sefaz_msg = coalesce(p ->> 'motivo', p ->> 'xMotivo', p ->> 'errorMessage', sefaz_msg),
    danfe_path = coalesce(p ->> 'pdfUrl', danfe_path),
    xml_path = coalesce(p ->> 'xmlUrl', xml_path),
    issue_at = case when v_mapped_status = 'AUTHORIZED' and issue_at is null then now() else issue_at end,
    events = events || jsonb_build_array(jsonb_build_object(
      'type', 'NOTAAS_WEBHOOK',
      'event', coalesce(v_event, v_status),
      'status', v_mapped_status,
      'at', now()
    ))
  where id = d.id;

  return jsonb_build_object('ok', true, 'document_id', d.id, 'status', v_mapped_status);
end $$;

select private.lock_functions();
