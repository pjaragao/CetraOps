-- =====================================================================
-- Nota recebida pela chave de acesso (SEFAZ direta, consChNFe da NT 2014.002).
-- A varredura por NSU só traz notas a partir do primeiro uso do serviço (sem NSU retroativo): uma nota anterior — como a
-- primeira remessa do fornecedor — só entra consultando a chave. Limite da SEFAZ: 20 consultas por chave por hora.
-- =====================================================================
create or replace function fiscal.request_dfe_by_key(p_key text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_key text := regexp_replace(coalesce(p_key, ''), '\D', '', 'g');
begin
  perform private.require_perm('fiscal.write');
  if length(v_key) <> 44 then raise exception 'A chave de acesso tem 44 dígitos' using errcode = 'P0250'; end if;
  if substr(v_key, 21, 2) <> '55' then raise exception 'Essa chave não é de NF-e (modelo 55)' using errcode = 'P0250'; end if;
  if not exists (select 1 from core.integration_connections where org_id = private.org_id() and provider = 'SEFAZ' and status <> 'DISABLED' and secret_ref is not null) then
    raise exception 'A consulta pela chave usa o certificado: conecte a SEFAZ direta em Configurações › Integrações' using errcode = 'P0251';
  end if;
  perform private.enqueue('fiscal_emission', jsonb_build_object('action', 'DFE_KEY', 'org_id', private.org_id(), 'key', v_key, 'by', private.member_id()));
end $$;

select private.lock_functions();
