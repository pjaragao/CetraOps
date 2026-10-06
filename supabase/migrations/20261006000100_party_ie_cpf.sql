-- =====================================================================
-- Inscrição estadual no cadastro e CPF na ficha.
-- 1) crm.parties.ie: só dígitos (2 a 14) ou ISENTO. create_party e update_party_identity aceitam "ie"; save_registry preenche a IE
--    a partir das inscrições estaduais da consulta de CNPJ (CNPJ.ws) quando o cadastro ainda não tem (ativa e da UF do endereço primeiro).
-- 2) CPF na ficha: crm.party_cpf_masked mostra só o final (***.***.*89-12) para quem lê o cadastro; crm.reveal_cpf devolve o
--    completo só com a permissão crm.sensitive e registra a consulta em audit.log (CPF_VIEWED).
-- Códigos de erro: P0390 dado inválido · P0462 não encontrado.
-- =====================================================================

alter table crm.parties add column if not exists ie text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'parties_ie_check' and conrelid = 'crm.parties'::regclass) then
    alter table crm.parties add constraint parties_ie_check check (ie is null or ie ~ '^(\d{2,14}|ISENTO)$');
  end if;
end $$;

-- "123.456.789-0", "isento", "" → '1234567890', 'ISENTO', null
create or replace function private.norm_ie(p text) returns text
language plpgsql immutable set search_path = '' as $$
declare t text := upper(regexp_replace(coalesce(p, ''), '[\s./-]', '', 'g'));
begin
  if t = '' then return null; end if;
  if t in ('ISENTO', 'ISENTA') then return 'ISENTO'; end if;
  if t !~ '^\d{2,14}$' then raise exception 'Inscrição estadual: só números (até 14 dígitos) ou ISENTO' using errcode = 'P0390'; end if;
  return t;
end $$;

-- ---------------------------------------------------------------------
-- create_party: + ie
-- ---------------------------------------------------------------------
create or replace function crm.create_party(p jsonb) returns crm.parties
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id(); v_kind crm.party_kind; x crm.parties; v_name text := trim(coalesce(p ->> 'display_name', '')); v_cnpj text := regexp_replace(coalesce(p ->> 'cnpj', ''), '\D', '', 'g');
  v_roles text[]; v_tags text[]; ph text; em text; v_ig text; v_gender text := nullif(upper(trim(coalesce(p ->> 'gender', ''))), ''); v_ie text := private.norm_ie(p ->> 'ie');
begin
  perform private.require_perm('crm.write');
  begin v_kind := (upper(coalesce(p ->> 'kind', 'PERSON')))::crm.party_kind; exception when others then raise exception 'Tipo inválido' using errcode = 'P0390'; end;
  if length(v_name) not between 2 and 120 then raise exception 'Nome: 2 a 120 caracteres' using errcode = 'P0390'; end if;
  if v_kind = 'COMPANY' then
    if not private.valid_cnpj(v_cnpj) then raise exception 'CNPJ inválido' using errcode = 'P0390'; end if;
    if exists (select 1 from crm.parties where org_id = v_org and cnpj = v_cnpj) then raise exception 'Já existe uma empresa com este CNPJ' using errcode = 'P0391'; end if;
  else
    v_cnpj := '';
    if v_gender is not null and v_gender not in ('F', 'M', 'O') then raise exception 'Gênero inválido' using errcode = 'P0390'; end if;
  end if;
  v_roles := array(select distinct upper(trim(r)) from jsonb_array_elements_text(coalesce(p -> 'roles', '[]')) r where trim(r) <> '');
  if not private.valid_party_roles(v_roles) then raise exception 'Papel inválido' using errcode = 'P0390'; end if;
  if cardinality(v_roles) = 0 then v_roles := array['CUSTOMER']; end if;
  v_tags := array(select distinct lower(trim(t)) from jsonb_array_elements_text(coalesce(p -> 'tags', '[]')) t where trim(t) <> '');
  if exists (select 1 from unnest(v_tags) t where t !~ '^[a-z0-9][a-z0-9_-]{1,29}$') then raise exception 'Etiqueta: 2 a 30 letras minúsculas, números, _ ou -' using errcode = 'P0390'; end if;
  v_ig := nullif(lower(ltrim(trim(coalesce(p ->> 'instagram_handle', '')), '@')), '');
  if v_ig is not null and v_ig !~ '^[a-z0-9._]{1,30}$' then raise exception 'Instagram inválido' using errcode = 'P0390'; end if;

  insert into crm.parties (org_id, kind, display_name, legal_name, cnpj, ie, birth_date, gender, instagram_handle, source, tags, preferences)
  values (v_org, v_kind, v_name, nullif(trim(coalesce(p ->> 'legal_name', '')), ''), nullif(v_cnpj, ''), v_ie, nullif(p ->> 'birth_date', '')::date, v_gender, v_ig,
          coalesce(nullif(trim(p ->> 'source'), ''), 'CADASTRO'), v_tags, jsonb_strip_nulls(jsonb_build_object('notes', nullif(left(trim(coalesce(p ->> 'notes', '')), 500), ''))))
  returning * into x;
  insert into crm.party_roles (party_id, org_id, role) select x.id, v_org, r::crm.party_role from unnest(v_roles) r;
  for ph in select jsonb_array_elements_text(coalesce(p -> 'phones', '[]')) loop
    if trim(ph) <> '' then perform private.add_contact(v_org, x.id, 'WHATSAPP', ph, false); end if;
  end loop;
  for em in select jsonb_array_elements_text(coalesce(p -> 'emails', '[]')) loop
    if trim(em) <> '' then perform private.add_contact(v_org, x.id, 'EMAIL', em, false); end if;
  end loop;
  if v_ig is not null then perform private.add_contact(v_org, x.id, 'INSTAGRAM', v_ig, true); end if;
  if jsonb_typeof(p -> 'address') = 'object' and (coalesce(p -> 'address' ->> 'cep', '') <> '' or coalesce(p -> 'address' ->> 'street', '') <> '') then
    perform private.save_address_core(v_org, x.id, p -> 'address', true);
  end if;
  perform private.timeline(v_org, x.id, 'CADASTRO', 'crm.parties', x.id, 'Cadastro criado' || case when v_kind = 'COMPANY' then ' (empresa)' else '' end);
  perform private.refresh_lifecycle(v_org, x.id);
  select * into x from crm.parties where id = x.id;
  return x;
end $$;

-- ---------------------------------------------------------------------
-- update_party_identity: + ie
-- ---------------------------------------------------------------------
create or replace function crm.update_party_identity(p_party uuid, p jsonb) returns crm.parties
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); x crm.parties; v_cnpj text;
begin
  perform private.require_perm('crm.write');
  select * into x from crm.parties where id = p_party and org_id = v_org and merged_into_id is null and anonymized_at is null for update;
  if x.id is null then raise exception 'Cadastro não encontrado' using errcode = 'P0392'; end if;
  if p ? 'display_name' then
    if length(trim(p ->> 'display_name')) not between 2 and 120 then raise exception 'Nome: 2 a 120 caracteres' using errcode = 'P0390'; end if;
    x.display_name := trim(p ->> 'display_name');
  end if;
  if p ? 'legal_name' then x.legal_name := nullif(trim(p ->> 'legal_name'), ''); end if;
  if p ? 'cnpj' then
    if x.kind <> 'COMPANY' then raise exception 'CNPJ é só de empresa' using errcode = 'P0390'; end if;
    v_cnpj := regexp_replace(coalesce(p ->> 'cnpj', ''), '\D', '', 'g');
    if not private.valid_cnpj(v_cnpj) then raise exception 'CNPJ inválido' using errcode = 'P0390'; end if;
    if exists (select 1 from crm.parties where org_id = v_org and cnpj = v_cnpj and id <> x.id) then raise exception 'Já existe outra empresa com este CNPJ' using errcode = 'P0391'; end if;
    x.cnpj := v_cnpj;
  end if;
  if p ? 'ie' then x.ie := private.norm_ie(p ->> 'ie'); end if;
  if p ? 'birth_date' then
    if x.kind = 'COMPANY' then raise exception 'Empresa não tem data de nascimento' using errcode = 'P0390'; end if;
    begin x.birth_date := nullif(p ->> 'birth_date', '')::date; exception when others then raise exception 'Data inválida' using errcode = 'P0390'; end;
    if x.birth_date is not null and (x.birth_date > current_date or x.birth_date < date '1900-01-01') then raise exception 'Data de nascimento fora do esperado' using errcode = 'P0390'; end if;
  end if;
  if p ? 'gender' then
    x.gender := nullif(upper(trim(coalesce(p ->> 'gender', ''))), '');
    if x.gender is not null and x.gender not in ('F', 'M', 'O') then raise exception 'Gênero inválido' using errcode = 'P0390'; end if;
  end if;
  update crm.parties set display_name = x.display_name, legal_name = x.legal_name, cnpj = x.cnpj, ie = x.ie, birth_date = x.birth_date, gender = x.gender where id = x.id returning * into x;
  return x;
end $$;

-- ---------------------------------------------------------------------
-- save_registry: + preenche a IE pela consulta de CNPJ (só se estiver vazia)
-- ---------------------------------------------------------------------
create or replace function crm.save_registry(p_party uuid, p_data jsonb) returns crm.parties
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); x crm.parties; v_cnpj text := regexp_replace(coalesce(p_data ->> 'cnpj', ''), '\D', '', 'g'); ph text; v_addr jsonb; v_sit text; v_ie text;
begin
  perform private.require_perm('crm.write');
  select * into x from crm.parties where id = p_party and org_id = v_org and merged_into_id is null;
  if x.id is null then raise exception 'Cadastro não encontrado' using errcode = 'P0432'; end if;
  if x.kind <> 'COMPANY' then raise exception 'Dados da Receita são só para empresas' using errcode = 'P0430'; end if;
  if jsonb_typeof(p_data) <> 'object' or length(coalesce(p_data ->> 'legal_name', '')) < 2 then raise exception 'Consulta de CNPJ vazia' using errcode = 'P0430'; end if;
  if x.cnpj is not null and v_cnpj <> x.cnpj then raise exception 'A consulta é de outro CNPJ (%), não deste cadastro', v_cnpj using errcode = 'P0430'; end if;

  -- inscrição estadual: a ativa da UF do endereço primeiro
  select d into v_ie from (
    select regexp_replace(coalesce(r ->> 'ie', ''), '\D', '', 'g') as d, r from jsonb_array_elements(case when jsonb_typeof(p_data -> 'state_registrations') = 'array' then p_data -> 'state_registrations' else '[]' end) r
  ) s where d ~ '^\d{2,14}$'
  order by (s.r ->> 'active') = 'true' desc, (s.r ->> 'uf') = (p_data -> 'address' ->> 'uf') desc limit 1;

  update crm.parties set registry = p_data, registry_at = now(),
         legal_name = coalesce(nullif(legal_name, ''), nullif(p_data ->> 'legal_name', '')),
         cnpj = coalesce(cnpj, nullif(v_cnpj, '')),
         ie = coalesce(ie, v_ie)
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

-- ---------------------------------------------------------------------
-- CPF na ficha
-- ---------------------------------------------------------------------
-- Só o final, para quem lê o cadastro (a tabela party_sensitive só abre com crm.sensitive).
create or replace function crm.party_cpf_masked(p_party uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
declare v text;
begin
  perform private.require_perm('crm.read');
  select s.cpf_last4 into v from crm.party_sensitive s where s.party_id = p_party and s.org_id = private.org_id() and s.cpf_hmac is not null;
  return case when v is null then null else '***.***.*' || left(v, 2) || '-' || right(v, 2) end;
end $$;

-- CPF completo: exige crm.sensitive e fica registrado em audit.log.
create or replace function crm.reveal_cpf(p_party uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); v text;
begin
  perform private.require_perm('crm.sensitive');
  if not exists (select 1 from crm.parties where id = p_party and org_id = v_org) then raise exception 'Cadastro não encontrado' using errcode = 'P0462'; end if;
  v := private.party_cpf(p_party);
  if v is null then return null; end if;
  insert into audit.log (org_id, actor_type, actor_id, action, table_name, record_id, after)
  values (v_org, 'USER', private.member_id(), 'CPF_VIEWED', 'crm.party_sensitive', p_party::text, jsonb_build_object('cpf_last4', right(v, 4)));
  return v;
end $$;

select private.lock_functions();
