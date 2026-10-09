-- =====================================================================
-- Entrada direta de produtos a partir de NF-e recebida (inbound_dfe)
-- =====================================================================

create or replace function purch.import_inbound_dfe(
  p_dfe_id uuid,
  p_location uuid,
  p_po uuid default null
) returns purch.receipts
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id();
  d fiscal.inbound_dfe;
  rc purch.receipts;
begin
  perform private.require_perm('purch.write');
  if v_org is null then
    raise exception 'Sem organização no token' using errcode = '42501';
  end if;

  select * into d from fiscal.inbound_dfe where id = p_dfe_id and org_id = v_org for update;
  if d.id is null then
    raise exception 'Nota fiscal recebida não encontrada';
  end if;

  if d.xml is null or length(trim(d.xml)) = 0 then
    raise exception 'O XML desta nota ainda não foi baixado da SEFAZ. Dê ciência da operação primeiro.' using errcode = 'P0082';
  end if;

  rc := purch.import_nfe(d.xml, p_location, p_po);

  update fiscal.inbound_dfe
  set document_id = rc.document_id
  where id = d.id;

  return rc;
end $$;
