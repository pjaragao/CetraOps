-- =====================================================================
-- Suporte ao Notaas como provedor fiscal (NFC-e, NF-e, webhooks e sincronização)
-- =====================================================================

create or replace function fiscal.request_dfe_sync() returns integer
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('fiscal.write');
  if not exists (select 1 from core.integration_connections where org_id = private.org_id() and provider in ('FOCUS_NFE', 'BRASIL_NFE', 'NOTAAS') and status <> 'DISABLED') then
    raise exception 'Conecte o Focus NFe, Brasil NFe ou Notaas em Configurações › Integrações para emitir e consultar notas fiscais' using errcode = 'P0251';
  end if;
  perform private.enqueue('fiscal_emission', jsonb_build_object('action', 'DFE_SYNC', 'org_id', private.org_id()));
  return 1;
end $$;

create or replace function private.enqueue_dfe_sync() returns integer
language plpgsql security definer set search_path = '' as $$
declare r record; n int := 0;
begin
  for r in select distinct org_id from core.integration_connections where provider in ('FOCUS_NFE', 'BRASIL_NFE', 'NOTAAS') and status <> 'DISABLED' and secret_ref is not null loop
    perform private.enqueue('fiscal_emission', jsonb_build_object('action', 'DFE_SYNC', 'org_id', r.org_id));
    n := n + 1;
  end loop;
  return n;
end $$;

-- Processa notificações de webhooks recebidos da Notaas
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
      when d.status = 'AUTHORIZED' and v_mapped_status = 'PROCESSING' then 'AUTHORIZED'
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

insert into private.internal_functions (fqname) values ('fiscal.process_notaas_webhook')
on conflict do nothing;

select private.lock_functions();
