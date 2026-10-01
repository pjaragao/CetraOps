-- =====================================================================
-- Cadastros › Pessoas e Empresas (pilar do sistema) e vínculos entre pessoas.
-- Cadastro único: criar e editar pessoa física ou jurídica (identidade, contatos, endereços, papéis), sem duplicar telefone/e-mail/CNPJ,
-- mesclar duplicados (sócio) e registrar vínculos (mãe/filha, casal, irmãs…) para o marketing de datas (aniversário de parente, Dia das Mães…).
-- Dados de parentes são mínimos e registrados pela equipe a partir do que a cliente contou; nada é inferido.
-- Códigos de erro: P0390 dado inválido · P0391 situação não permite / duplicado · P0392 não encontrado.
-- =====================================================================

create table crm.party_merge_log (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  kept_id uuid not null references crm.parties(id),
  merged_id uuid not null references crm.parties(id),
  merged_name text not null,
  moved jsonb not null default '{}',
  skipped text[] not null default '{}',
  merged_by uuid references core.members(id),
  merged_at timestamptz not null default now()
);
select private.apply_rls('crm', array['party_merge_log'], 'crm.read', 'core.admin');
select private.rpc_only('crm', array['party_merge_log']);

create table crm.party_relations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  from_party uuid not null references crm.parties(id) on delete cascade,     -- "from é <kind> de to"
  to_party uuid not null references crm.parties(id) on delete cascade,
  kind text not null check (kind in ('PARENT', 'SPOUSE', 'PARTNER', 'SIBLING', 'GRANDPARENT', 'AUNT_UNCLE', 'FRIEND')),
  note text,
  created_by uuid references core.members(id),
  created_at timestamptz not null default now(),
  check (from_party <> to_party)
);
-- um par de pessoas tem no máximo uma relação de cada tipo, em qualquer direção
create unique index party_relations_pair_uq on crm.party_relations (kind, least(from_party::text, to_party::text), greatest(from_party::text, to_party::text));
create index party_relations_to_idx on crm.party_relations (to_party);
create index party_relations_from_idx on crm.party_relations (from_party);
select private.apply_rls('crm', array['party_relations'], 'crm.read', 'crm.write');
select private.rpc_only('crm', array['party_relations']);

-- O que cada pessoa é, vista de cada lado (papel genérico; o rótulo em português depende do gênero)
create view crm.v_relatives with (security_invoker = true) as
select r.org_id, r.to_party as party_id, r.from_party as relative_id, r.id as relation_id,
       case r.kind when 'PARENT' then 'PARENT' when 'GRANDPARENT' then 'GRANDPARENT' when 'AUNT_UNCLE' then 'AUNT_UNCLE' else r.kind end as role
from crm.party_relations r
union all
select r.org_id, r.from_party, r.to_party, r.id,
       case r.kind when 'PARENT' then 'CHILD' when 'GRANDPARENT' then 'GRANDCHILD' when 'AUNT_UNCLE' then 'NIECE_NEPHEW' else r.kind end
from crm.party_relations r;

-- ---------------------------------------------------------------------
-- Contatos
-- ---------------------------------------------------------------------
create or replace function private.contact_norm(p_type crm.contact_type, p_value text) returns text
language sql immutable as $$
  select case when p_type in ('PHONE', 'WHATSAPP') then private.normalize_phone(p_value)
              when p_type in ('INSTAGRAM', 'TIKTOK') then lower(ltrim(trim(p_value), '@'))
              else lower(trim(p_value)) end
$$;

create or replace function private.add_contact(p_org uuid, p_party uuid, p_type crm.contact_type, p_value text, p_primary boolean) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_norm text := private.contact_norm(p_type, p_value); v_other record; v_id uuid;
begin
  if coalesce(trim(p_value), '') = '' or v_norm is null or v_norm = '' then raise exception 'Contato vazio ou inválido' using errcode = 'P0390'; end if;
  if p_type = 'EMAIL' and v_norm !~ '^[^@\s]+@[^@\s]+\.[a-z]{2,}$' then raise exception 'E-mail inválido' using errcode = 'P0390'; end if;
  if p_type in ('PHONE', 'WHATSAPP') and length(regexp_replace(v_norm, '\D', '', 'g')) < 10 then raise exception 'Telefone inválido (use DDD)' using errcode = 'P0390'; end if;
  select c.party_id, p.display_name into v_other from crm.party_contact_points c join crm.parties p on p.id = c.party_id where c.org_id = p_org and c.type = p_type and c.value_normalized = v_norm;
  if v_other.party_id is not null then
    if v_other.party_id = p_party then return null; end if;
    raise exception 'Este contato já está no cadastro de %', v_other.display_name using errcode = 'P0391';
  end if;
  insert into crm.party_contact_points (org_id, party_id, type, value_display, is_primary) values (p_org, p_party, p_type, trim(p_value),
    coalesce(p_primary, false) or not exists (select 1 from crm.party_contact_points where party_id = p_party and type = p_type)) returning id into v_id;
  return v_id;
end $$;

create or replace function private.save_address_core(p_org uuid, p_party uuid, a jsonb, p_default boolean, p_id uuid default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_cep text := regexp_replace(coalesce(a ->> 'cep', ''), '\D', '', 'g'); v_uf text := upper(nullif(trim(coalesce(a ->> 'uf', '')), ''));
begin
  if v_cep <> '' and length(v_cep) <> 8 then raise exception 'CEP inválido' using errcode = 'P0390'; end if;
  if v_uf is not null and v_uf !~ '^[A-Z]{2}$' then raise exception 'UF inválida' using errcode = 'P0390'; end if;
  if coalesce(trim(a ->> 'street'), '') = '' and v_cep = '' then raise exception 'Informe o CEP ou o logradouro' using errcode = 'P0390'; end if;
  if p_id is null then
    insert into crm.party_addresses (org_id, party_id, label, cep, street, number, complement, district, city, uf, is_default)
    values (p_org, p_party, nullif(trim(coalesce(a ->> 'label', '')), ''), nullif(v_cep, ''), nullif(trim(coalesce(a ->> 'street', '')), ''), nullif(trim(coalesce(a ->> 'number', '')), ''),
            nullif(trim(coalesce(a ->> 'complement', '')), ''), nullif(trim(coalesce(a ->> 'district', '')), ''), nullif(trim(coalesce(a ->> 'city', '')), ''), v_uf,
            coalesce(p_default, false) or not exists (select 1 from crm.party_addresses where party_id = p_party)) returning id into v_id;
  else
    update crm.party_addresses set label = nullif(trim(coalesce(a ->> 'label', '')), ''), cep = nullif(v_cep, ''), street = nullif(trim(coalesce(a ->> 'street', '')), ''),
           number = nullif(trim(coalesce(a ->> 'number', '')), ''), complement = nullif(trim(coalesce(a ->> 'complement', '')), ''), district = nullif(trim(coalesce(a ->> 'district', '')), ''),
           city = nullif(trim(coalesce(a ->> 'city', '')), ''), uf = v_uf where id = p_id and party_id = p_party returning id into v_id;
    if v_id is null then raise exception 'Endereço não encontrado' using errcode = 'P0392'; end if;
  end if;
  if coalesce(p_default, false) then update crm.party_addresses set is_default = (id = v_id) where party_id = p_party; end if;
  -- cidade e UF principais da pessoa seguem o endereço padrão
  update crm.parties set city = coalesce(nullif(trim(coalesce(a ->> 'city', '')), ''), city), uf = coalesce(v_uf, uf)::char(2)
  where id = p_party and exists (select 1 from crm.party_addresses where id = v_id and is_default);
  return v_id;
end $$;

create or replace function private.valid_party_roles(p_roles text[]) returns boolean
language sql immutable as $$ select p_roles <@ array['CUSTOMER', 'SUPPLIER', 'AFFILIATE_TRAINER', 'PARTNER_GYM', 'INFLUENCER', 'CARRIER', 'SERVICE_PROVIDER', 'SHAREHOLDER'] $$;

-- ---------------------------------------------------------------------
-- Criar pessoa ou empresa
-- p = {kind PERSON|COMPANY, display_name, legal_name?, cnpj?, birth_date?, gender?, instagram_handle?, phones[], emails[], address{}, roles[], tags[], notes?, source?}
-- ---------------------------------------------------------------------
create or replace function crm.create_party(p jsonb) returns crm.parties
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id(); v_kind crm.party_kind; x crm.parties; v_name text := trim(coalesce(p ->> 'display_name', '')); v_cnpj text := regexp_replace(coalesce(p ->> 'cnpj', ''), '\D', '', 'g');
  v_roles text[]; v_tags text[]; ph text; em text; v_ig text; v_gender text := nullif(upper(trim(coalesce(p ->> 'gender', ''))), '');
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

  insert into crm.parties (org_id, kind, display_name, legal_name, cnpj, birth_date, gender, instagram_handle, source, tags, preferences)
  values (v_org, v_kind, v_name, nullif(trim(coalesce(p ->> 'legal_name', '')), ''), nullif(v_cnpj, ''), nullif(p ->> 'birth_date', '')::date, v_gender, v_ig,
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

-- Identidade: nome, razão social, CNPJ (só empresa), nascimento e gênero (só pessoa)
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
  if p ? 'birth_date' then
    if x.kind = 'COMPANY' then raise exception 'Empresa não tem data de nascimento' using errcode = 'P0390'; end if;
    begin x.birth_date := nullif(p ->> 'birth_date', '')::date; exception when others then raise exception 'Data inválida' using errcode = 'P0390'; end;
    if x.birth_date is not null and (x.birth_date > current_date or x.birth_date < date '1900-01-01') then raise exception 'Data de nascimento fora do esperado' using errcode = 'P0390'; end if;
  end if;
  if p ? 'gender' then
    x.gender := nullif(upper(trim(coalesce(p ->> 'gender', ''))), '');
    if x.gender is not null and x.gender not in ('F', 'M', 'O') then raise exception 'Gênero inválido' using errcode = 'P0390'; end if;
  end if;
  update crm.parties set display_name = x.display_name, legal_name = x.legal_name, cnpj = x.cnpj, birth_date = x.birth_date, gender = x.gender where id = x.id returning * into x;
  return x;
end $$;

create or replace function crm.add_contact(p_party uuid, p_type crm.contact_type, p_value text, p_primary boolean default false) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); v_id uuid;
begin
  perform private.require_perm('crm.write');
  if not exists (select 1 from crm.parties where id = p_party and org_id = v_org and merged_into_id is null) then raise exception 'Cadastro não encontrado' using errcode = 'P0392'; end if;
  v_id := private.add_contact(v_org, p_party, p_type, p_value, p_primary);
  if coalesce(p_primary, false) and v_id is not null then update crm.party_contact_points set is_primary = (id = v_id) where party_id = p_party and type = p_type; end if;
  return v_id;
end $$;

create or replace function crm.remove_contact(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare c crm.party_contact_points;
begin
  perform private.require_perm('crm.write');
  select * into c from crm.party_contact_points where id = p_id and org_id = private.org_id();
  if c.id is null then raise exception 'Contato não encontrado' using errcode = 'P0392'; end if;
  if exists (select 1 from omni.channel_identities i where i.party_id = c.party_id and i.external_id = regexp_replace(c.value_normalized, '\D', '', 'g')) then
    raise exception 'Este contato tem conversa vinculada: não pode ser removido' using errcode = 'P0391';
  end if;
  delete from crm.party_contact_points where id = c.id;
  update crm.party_contact_points set is_primary = true where id = (select id from crm.party_contact_points where party_id = c.party_id and type = c.type order by created_at limit 1)
    and not exists (select 1 from crm.party_contact_points where party_id = c.party_id and type = c.type and is_primary);
end $$;

-- p = {party_id, id?, label?, cep?, street?, number?, complement?, district?, city?, uf?, is_default?}
create or replace function crm.save_address(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); v_party uuid := nullif(p ->> 'party_id', '')::uuid;
begin
  perform private.require_perm('crm.write');
  if not exists (select 1 from crm.parties where id = v_party and org_id = v_org and merged_into_id is null) then raise exception 'Cadastro não encontrado' using errcode = 'P0392'; end if;
  return private.save_address_core(v_org, v_party, p, coalesce((p ->> 'is_default')::boolean, false), nullif(p ->> 'id', '')::uuid);
end $$;

create or replace function crm.delete_address(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare a crm.party_addresses;
begin
  perform private.require_perm('crm.write');
  delete from crm.party_addresses where id = p_id and org_id = private.org_id() returning * into a;
  if a.id is null then raise exception 'Endereço não encontrado' using errcode = 'P0392'; end if;
  update crm.party_addresses set is_default = true where id = (select id from crm.party_addresses where party_id = a.party_id order by created_at limit 1)
    and not exists (select 1 from crm.party_addresses where party_id = a.party_id and is_default);
end $$;

-- Papéis (colaboradora vem do RH e não se mexe aqui)
create or replace function crm.set_party_roles(p_party uuid, p_roles text[]) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); v_roles text[] := array(select distinct upper(trim(r)) from unnest(coalesce(p_roles, '{}')) r where trim(r) <> '');
begin
  perform private.require_perm('crm.write');
  if not exists (select 1 from crm.parties where id = p_party and org_id = v_org and merged_into_id is null) then raise exception 'Cadastro não encontrado' using errcode = 'P0392'; end if;
  if not private.valid_party_roles(v_roles) then raise exception 'Papel inválido' using errcode = 'P0390'; end if;
  if cardinality(v_roles) = 0 then raise exception 'Escolha ao menos um papel' using errcode = 'P0390'; end if;
  delete from crm.party_roles where party_id = p_party and role::text <> all (v_roles) and role::text in ('CUSTOMER', 'SUPPLIER', 'AFFILIATE_TRAINER', 'PARTNER_GYM', 'INFLUENCER', 'CARRIER', 'SERVICE_PROVIDER', 'SHAREHOLDER');
  insert into crm.party_roles (party_id, org_id, role) select p_party, v_org, r::crm.party_role from unnest(v_roles) r on conflict do nothing;
end $$;

-- ---------------------------------------------------------------------
-- Mesclar duplicados (sócio): tudo da duplicada passa para a principal; a duplicada fica marcada e some das listas
-- ---------------------------------------------------------------------
create or replace function crm.merge_parties(p_keep uuid, p_dup uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id(); k crm.parties; d crm.parties; r record; v_moved jsonb := '{}'; v_n bigint; v_skipped text[] := '{}';
begin
  perform private.require_perm('core.admin');
  if p_keep = p_dup then raise exception 'Escolha duas pessoas diferentes' using errcode = 'P0390'; end if;
  select * into k from crm.parties where id = p_keep and org_id = v_org and merged_into_id is null and anonymized_at is null for update;
  select * into d from crm.parties where id = p_dup and org_id = v_org and merged_into_id is null and anonymized_at is null for update;
  if k.id is null or d.id is null then raise exception 'Cadastro não encontrado (ou já mesclado)' using errcode = 'P0392'; end if;
  if k.kind <> d.kind then raise exception 'Pessoa e empresa não se mesclam' using errcode = 'P0391'; end if;
  if exists (select 1 from crm.party_roles where party_id = p_dup and role = 'EMPLOYEE') then raise exception 'Colaborador não se mescla: o vínculo trabalhista é do RH' using errcode = 'P0391'; end if;

  update crm.party_contact_points set party_id = p_keep, is_primary = false where party_id = p_dup;
  insert into crm.party_roles (party_id, org_id, role) select p_keep, org_id, role from crm.party_roles where party_id = p_dup on conflict do nothing;
  delete from crm.party_roles where party_id = p_dup;
  -- aceites: a principal herda o que ela não tinha; uma recusa da duplicada vale também para a principal
  insert into crm.consents (org_id, party_id, purpose, granted, legal_basis, evidence, recorded_by)
  select c.org_id, p_keep, c.purpose, c.granted, c.legal_basis, c.evidence || jsonb_build_object('merged_from', p_dup), private.member_id()
  from crm.v_current_consents c
  where c.party_id = p_dup and (not exists (select 1 from crm.v_current_consents x where x.party_id = p_keep and x.purpose = c.purpose)
        or (c.granted = false and exists (select 1 from crm.v_current_consents x where x.party_id = p_keep and x.purpose = c.purpose and x.granted)));
  update crm.party_sensitive set party_id = p_keep where party_id = p_dup and not exists (select 1 from crm.party_sensitive where party_id = p_keep);

  for r in
    select c.conrelid::regclass::text as tbl, a.attname as col
    from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.confrelid = 'crm.parties'::regclass and c.contype = 'f' and array_length(c.conkey, 1) = 1
      and c.conrelid not in ('crm.parties'::regclass, 'crm.party_contact_points'::regclass, 'crm.party_roles'::regclass, 'crm.consents'::regclass, 'crm.party_sensitive'::regclass, 'crm.party_merge_log'::regclass)
  loop
    begin
      execute format('update %s set %I = $1 where %I = $2', r.tbl, r.col, r.col) using p_keep, p_dup;
      get diagnostics v_n = row_count;
      if v_n > 0 then v_moved := v_moved || jsonb_build_object(r.tbl || '.' || r.col, v_n); end if;
    exception
      when unique_violation then
        execute format('delete from %s where %I = $1', r.tbl, r.col) using p_dup;                       -- já existia o mesmo registro na principal
        v_skipped := array_append(v_skipped, r.tbl || ' (duplicados descartados)');
      when others then
        v_skipped := array_append(v_skipped, r.tbl || ': ' || left(sqlerrm, 80));
    end;
  end loop;
  delete from crm.party_relations where from_party = to_party;

  update crm.parties set birth_date = coalesce(k.birth_date, d.birth_date), city = coalesce(k.city, d.city), uf = coalesce(k.uf, d.uf), profession = coalesce(k.profession, d.profession),
         instagram_handle = coalesce(k.instagram_handle, d.instagram_handle), gender = coalesce(k.gender, d.gender), relationship_owner_member_id = coalesce(k.relationship_owner_member_id, d.relationship_owner_member_id),
         sizes = d.sizes || k.sizes, tags = array(select distinct unnest(k.tags || d.tags)), preferences = d.preferences || k.preferences,
         joy_member_status = case when k.joy_member_status = 'UNKNOWN' then d.joy_member_status else k.joy_member_status end,
         first_touch_at = least(k.first_touch_at, d.first_touch_at)
  where id = p_keep;
  update crm.parties set merged_into_id = p_keep, tags = array(select distinct unnest(tags || array['mesclada'])) where id = p_dup;
  insert into crm.party_merge_log (org_id, kept_id, merged_id, merged_name, moved, skipped, merged_by) values (v_org, p_keep, p_dup, d.display_name, v_moved, v_skipped, private.member_id());
  perform private.timeline(v_org, p_keep, 'CADASTRO', 'crm.parties', p_keep, 'Cadastro mesclado com o duplicado "' || d.display_name || '"', jsonb_build_object('moved', v_moved));
  perform private.refresh_lifecycle(v_org, p_keep);
  return jsonb_build_object('kept', p_keep, 'merged', p_dup, 'moved', v_moved, 'skipped', to_jsonb(v_skipped));
end $$;

-- Possíveis duplicadas da pessoa (mesmo nome parecido, mesmo Instagram ou telefones com o mesmo final)
create or replace function crm.duplicate_candidates(p_party uuid) returns table (party_id uuid, display_name text, reason text)
language plpgsql stable security definer set search_path = '' as $$
declare p crm.parties;
begin
  perform private.require_perm('crm.read');
  select * into p from crm.parties where id = p_party and org_id = private.org_id();
  if p.id is null then return; end if;
  return query
    select x.id, x.display_name, 'mesmo nome'::text from crm.parties x
    where x.org_id = p.org_id and x.id <> p.id and x.merged_into_id is null and x.kind = p.kind and private.norm(x.display_name) = private.norm(p.display_name)
    union
    select x.id, x.display_name, 'mesmo Instagram'::text from crm.parties x
    where x.org_id = p.org_id and x.id <> p.id and x.merged_into_id is null and p.instagram_handle is not null and x.instagram_handle = p.instagram_handle
    union
    select x.id, x.display_name, 'telefone com o mesmo final'::text from crm.parties x
    where x.org_id = p.org_id and x.id <> p.id and x.merged_into_id is null and exists (
      select 1 from crm.party_contact_points a join crm.party_contact_points b on right(regexp_replace(a.value_normalized, '\D', '', 'g'), 8) = right(regexp_replace(b.value_normalized, '\D', '', 'g'), 8)
      where a.party_id = p.id and b.party_id = x.id and a.type in ('PHONE', 'WHATSAPP') and b.type in ('PHONE', 'WHATSAPP'));
end $$;

-- ---------------------------------------------------------------------
-- Vínculos entre pessoas
-- p_role = o que a OUTRA pessoa é para p_party: PARENT (mãe/pai), CHILD (filha/filho), SPOUSE, PARTNER, SIBLING, GRANDPARENT, GRANDCHILD, AUNT_UNCLE, NIECE_NEPHEW, FRIEND
-- ---------------------------------------------------------------------
create or replace function crm.add_relation(p_party uuid, p_other uuid, p_role text, p_note text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); v_role text := upper(coalesce(p_role, '')); v_from uuid; v_to uuid; v_kind text; v_id uuid;
begin
  perform private.require_perm('crm.write');
  if p_party = p_other then raise exception 'Escolha outra pessoa' using errcode = 'P0390'; end if;
  if (select count(*) from crm.parties where id in (p_party, p_other) and org_id = v_org and merged_into_id is null and anonymized_at is null and kind = 'PERSON') <> 2 then
    raise exception 'Vínculos são entre pessoas (não empresas)' using errcode = 'P0392';
  end if;
  case v_role
    when 'PARENT' then v_kind := 'PARENT'; v_from := p_other; v_to := p_party;
    when 'CHILD' then v_kind := 'PARENT'; v_from := p_party; v_to := p_other;
    when 'GRANDPARENT' then v_kind := 'GRANDPARENT'; v_from := p_other; v_to := p_party;
    when 'GRANDCHILD' then v_kind := 'GRANDPARENT'; v_from := p_party; v_to := p_other;
    when 'AUNT_UNCLE' then v_kind := 'AUNT_UNCLE'; v_from := p_other; v_to := p_party;
    when 'NIECE_NEPHEW' then v_kind := 'AUNT_UNCLE'; v_from := p_party; v_to := p_other;
    when 'SPOUSE', 'PARTNER', 'SIBLING', 'FRIEND' then v_kind := v_role; v_from := p_party; v_to := p_other;
    else raise exception 'Tipo de vínculo inválido' using errcode = 'P0390';
  end case;
  begin
    insert into crm.party_relations (org_id, from_party, to_party, kind, note, created_by) values (v_org, v_from, v_to, v_kind, nullif(left(trim(coalesce(p_note, '')), 200), ''), private.member_id()) returning id into v_id;
  exception when unique_violation then raise exception 'Este vínculo já está cadastrado' using errcode = 'P0391';
  end;
  perform private.timeline(v_org, p_party, 'RELATION', 'crm.party_relations', v_id, 'Vínculo registrado com ' || (select display_name from crm.parties where id = p_other));
  return v_id;
end $$;

create or replace function crm.remove_relation(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('crm.write');
  delete from crm.party_relations where id = p_id and org_id = private.org_id();
  if not found then raise exception 'Vínculo não encontrado' using errcode = 'P0392'; end if;
end $$;

-- Parentes da pessoa, com o que cada um é para ela, o aniversário e quantos dias faltam
create or replace function crm.relatives_of(p_party uuid) returns table (relation_id uuid, relative_id uuid, relative_name text, role text, gender text, birth_date date, birthday_in_days integer, note text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_perm('crm.read');
  return query
    select v.relation_id, v.relative_id, p.display_name, v.role, p.gender, p.birth_date,
           case when p.birth_date is null then null
                else (make_date(extract(year from private.today_sp())::int + case when to_char(p.birth_date, 'MM-DD') < to_char(private.today_sp(), 'MM-DD') then 1 else 0 end,
                                extract(month from p.birth_date)::int, least(extract(day from p.birth_date)::int, 28)) - private.today_sp())::int end,
           r.note
    from crm.v_relatives v join crm.parties p on p.id = v.relative_id join crm.party_relations r on r.id = v.relation_id
    where v.party_id = p_party and v.org_id = private.org_id() and p.merged_into_id is null and p.anonymized_at is null
    order by p.display_name;
end $$;

insert into private.internal_functions (fqname) values ('private.add_contact'), ('private.save_address_core'), ('private.contact_norm'), ('private.valid_party_roles') on conflict do nothing;
select private.lock_functions();
