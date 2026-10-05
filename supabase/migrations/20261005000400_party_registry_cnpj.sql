-- =====================================================================
-- Dados da Receita no cadastro de empresa (consulta de CNPJ em fontes gratuitas: BrasilAPI, OpenCNPJ, CNPJ.ws, ReceitaWS).
-- crm.parties.registry guarda o retrato normalizado (situação, abertura, porte, natureza, capital, Simples/MEI, regime, CNAEs,
-- inscrições estaduais, sócios, fontes) e registry_at a data da consulta.
-- crm.save_registry grava o retrato e só PREENCHE o que estiver vazio (razão social, endereço, telefones, e-mail): nunca apaga
-- o que alguém digitou. Situação diferente de "Ativa" (baixada, inapta, suspensa) fica marcada para alertar quem paga.
-- Códigos de erro: P0430 dado inválido · P0432 não encontrado.
-- =====================================================================

alter table crm.parties add column if not exists registry jsonb;
alter table crm.parties add column if not exists registry_at timestamptz;

create or replace function crm.save_registry(p_party uuid, p_data jsonb) returns crm.parties
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); x crm.parties; v_cnpj text := regexp_replace(coalesce(p_data ->> 'cnpj', ''), '\D', '', 'g'); ph text; v_addr jsonb; v_sit text;
begin
  perform private.require_perm('crm.write');
  select * into x from crm.parties where id = p_party and org_id = v_org and merged_into_id is null;
  if x.id is null then raise exception 'Cadastro não encontrado' using errcode = 'P0432'; end if;
  if x.kind <> 'COMPANY' then raise exception 'Dados da Receita são só para empresas' using errcode = 'P0430'; end if;
  if jsonb_typeof(p_data) <> 'object' or length(coalesce(p_data ->> 'legal_name', '')) < 2 then raise exception 'Consulta de CNPJ vazia' using errcode = 'P0430'; end if;
  if x.cnpj is not null and v_cnpj <> x.cnpj then raise exception 'A consulta é de outro CNPJ (%), não deste cadastro', v_cnpj using errcode = 'P0430'; end if;

  update crm.parties set registry = p_data, registry_at = now(),
         legal_name = coalesce(nullif(legal_name, ''), nullif(p_data ->> 'legal_name', '')),
         cnpj = coalesce(cnpj, nullif(v_cnpj, ''))
  where id = x.id;

  -- contatos que faltam (se o número/e-mail já for de outro cadastro, só não entra)
  for ph in select jsonb_array_elements_text(coalesce(p_data -> 'phones', '[]')) loop
    begin perform private.add_contact(v_org, x.id, 'PHONE', ph, false); exception when others then null; end;
  end loop;
  if coalesce(p_data ->> 'email', '') <> '' then
    begin perform private.add_contact(v_org, x.id, 'EMAIL', p_data ->> 'email', false); exception when others then null; end;
  end if;
  -- endereço só se ainda não houver nenhum
  v_addr := p_data -> 'address';
  if jsonb_typeof(v_addr) = 'object' and coalesce(v_addr ->> 'cep', '') <> '' and not exists (select 1 from crm.party_addresses where party_id = x.id) then
    begin perform private.save_address_core(v_org, x.id, v_addr - 'ibge', true); exception when others then null; end;
  end if;

  v_sit := coalesce(p_data ->> 'situation', '');
  perform private.timeline(v_org, x.id, 'CADASTRO', 'crm.parties', x.id,
    'Dados da Receita atualizados' || case when v_sit <> '' then ' (situação: ' || v_sit || ')' else '' end);
  select * into x from crm.parties where id = x.id;
  return x;
end $$;

select private.lock_functions();
