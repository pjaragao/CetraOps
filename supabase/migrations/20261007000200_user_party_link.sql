-- =====================================================================
-- Cadastro como fonte única de pessoas: usuário e colaborador apontam para a pessoa que já existe.
--   • core.link_user_party: troca a pessoa de um usuário (ex.: a Luisa já era sócia no cadastro e o usuário nasceu com uma pessoa nova).
--     Se a pessoa antiga foi criada automaticamente pelo usuário (origem USUARIO), ela é mesclada na escolhida: some a duplicidade.
--   • hr.create_employee: sem party_id, reaproveita a pessoa que já tem o mesmo CPF no cadastro em vez de criar outra.
-- =====================================================================

create or replace function core.link_user_party(p_member uuid, p_party uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); m core.members; v_old uuid; v_old_src text; v_email text; v_merged boolean := false;
begin
  perform private.require_perm('core.admin');
  select * into m from core.members where id = p_member and org_id = v_org;
  if m.id is null then raise exception 'Usuário não encontrado' using errcode = 'P0422'; end if;
  if not exists (select 1 from crm.parties where id = p_party and org_id = v_org and kind = 'PERSON' and merged_into_id is null and anonymized_at is null) then
    raise exception 'Pessoa do cadastro não encontrada' using errcode = 'P0422';
  end if;
  if exists (select 1 from core.members where party_id = p_party and id <> m.id) then raise exception 'Esta pessoa já tem outro usuário no sistema' using errcode = 'P0421'; end if;
  v_old := m.party_id;
  if v_old is not distinct from p_party then return jsonb_build_object('party_id', p_party, 'merged', false); end if;
  select source into v_old_src from crm.parties where id = v_old;

  update core.members set party_id = p_party where id = m.id;
  select lower(email) into v_email from auth.users where id = m.user_id;
  if v_email is not null then
    begin perform private.add_contact(v_org, p_party, 'EMAIL', v_email, false); exception when others then null; end;   -- o e-mail de acesso fica no cadastro
  end if;

  -- a pessoa criada sozinha junto com o usuário vira duplicidade: mescla na escolhida (se der, fica como está)
  if v_old is not null and v_old_src = 'USUARIO' and not exists (select 1 from crm.party_roles where party_id = v_old and role = 'EMPLOYEE') then
    begin
      perform crm.merge_parties(p_party, v_old);
      v_merged := true;
    exception when others then v_merged := false;
    end;
  end if;
  perform private.audit_admin('USER_PARTY_LINKED', 'core.members', m.id, jsonb_build_object('old_party_id', v_old, 'party_id', p_party, 'merged_old', v_merged));
  return jsonb_build_object('party_id', p_party, 'merged', v_merged);
end $$;

do $x$
declare v_def text;
begin
  select pg_get_functiondef('hr.create_employee(jsonb)'::regprocedure) into v_def;
  if position($y$  if v_party is null then
    insert into crm.parties (org_id, kind, display_name, birth_date, source, tags)$y$ in v_def) = 0 then raise exception 'create_employee mudou: ajuste este patch'; end if;
  v_def := replace(v_def, $y$  if v_party is null then
    insert into crm.parties (org_id, kind, display_name, birth_date, source, tags)$y$,
$y$  if v_party is null then   -- a pessoa já está no cadastro (mesmo CPF)? usa a mesma, sem duplicar
    select s.party_id into v_party from crm.party_sensitive s join crm.parties x on x.id = s.party_id
    where s.org_id = v_org and s.cpf_hmac = private.cpf_hmac(v_cpf) and x.kind = 'PERSON' and x.merged_into_id is null limit 1;
  end if;
  if v_party is null then
    insert into crm.parties (org_id, kind, display_name, birth_date, source, tags)$y$);
  execute v_def;
end $x$;

select private.lock_functions();
