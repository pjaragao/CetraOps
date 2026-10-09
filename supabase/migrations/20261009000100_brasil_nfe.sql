-- =====================================================================
-- Suporte ao Brasil NFe para MDe (busca periódica e manual de DF-e recebidos)
-- =====================================================================

create or replace function fiscal.request_dfe_sync() returns integer
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('fiscal.write');
  if not exists (select 1 from core.integration_connections where org_id = private.org_id() and provider in ('FOCUS_NFE', 'BRASIL_NFE') and status <> 'DISABLED') then
    raise exception 'Conecte o Focus NFe ou Brasil NFe em Configurações › Integrações para buscar as notas na SEFAZ' using errcode = 'P0251';
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
