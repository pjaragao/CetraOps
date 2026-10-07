-- =====================================================================
-- RH usando o Cadastro como fonte única de pessoas.
--   • hr.create_employee: aceita a pessoa do cadastro (party_id) e confere que é PESSOA do mesmo cliente; sem party_id acha pelo CPF.
--     O CPF da admissão também vai para o cadastro (crm.party_sensitive), então a pessoa passa a ser achada por CPF em qualquer tela.
--     Se a pessoa já tem usuário no sistema, o colaborador nasce ligado a ele (hr.employees.member_id).
--   • Usuário × colaborador: criar usuário ou ligá-lo a uma pessoa que já é colaboradora completa o vínculo do RH.
--   • CPF dos colaboradores já admitidos é copiado para o cadastro (quando ainda não está lá).
-- Códigos de erro: P0064 pessoa inválida · P0065 CPF diferente do que já está no cadastro.
-- =====================================================================

do $x$
declare v_def text;
begin
  select pg_get_functiondef('hr.create_employee(jsonb)'::regprocedure) into v_def;
  if position($y$  if v_party is null then   -- a pessoa já está no cadastro (mesmo CPF)?$y$ in v_def) = 0
     or position($y$insert into crm.party_roles (party_id, org_id, role) values (v_party, v_org, 'EMPLOYEE') on conflict do nothing;$y$ in v_def) = 0
     or position($y$(p ->> 'member_id')::uuid$y$ in v_def) = 0 then
    raise exception 'create_employee mudou: ajuste este patch';
  end if;
  v_def := replace(v_def, $y$  if v_party is null then   -- a pessoa já está no cadastro (mesmo CPF)?$y$,
$y$  if v_party is not null and not exists (select 1 from crm.parties where id = v_party and org_id = v_org and kind = 'PERSON' and merged_into_id is null and anonymized_at is null) then
    raise exception 'Pessoa do cadastro não encontrada' using errcode = 'P0064';
  end if;
  if v_party is null then   -- a pessoa já está no cadastro (mesmo CPF)?$y$);
  v_def := replace(v_def, $y$insert into crm.party_roles (party_id, org_id, role) values (v_party, v_org, 'EMPLOYEE') on conflict do nothing;$y$,
$y$insert into crm.party_roles (party_id, org_id, role) values (v_party, v_org, 'EMPLOYEE') on conflict do nothing;
  declare v_h text;
  begin   -- o CPF fica no cadastro: a pessoa é achada por ele em qualquer tela (sem a chave do CPF no Vault, só o RH guarda)
    begin v_h := private.cpf_hmac(v_cpf); exception when others then v_h := null; end;
    if v_h is not null then
      if exists (select 1 from crm.party_sensitive where party_id = v_party and cpf_hmac is not null and cpf_hmac <> v_h) then
        raise exception 'O CPF informado é diferente do CPF que já está no cadastro desta pessoa' using errcode = 'P0065';
      end if;
      insert into crm.party_sensitive (party_id, org_id, cpf_encrypted, cpf_hmac, cpf_last4, updated_at)
      select v_party, v_org, extensions.pgp_sym_encrypt(v_cpf, private.cpf_key()), v_h, right(v_cpf, 4), now()
      where not exists (select 1 from crm.party_sensitive s where s.org_id = v_org and s.cpf_hmac = v_h and s.party_id <> v_party)
      on conflict (party_id) do update set cpf_encrypted = excluded.cpf_encrypted, cpf_hmac = excluded.cpf_hmac, cpf_last4 = excluded.cpf_last4, updated_at = now();
    end if;
  end;$y$);
  v_def := replace(v_def, $y$(p ->> 'member_id')::uuid$y$, $y$coalesce((p ->> 'member_id')::uuid, (select m.id from core.members m where m.party_id = v_party and m.org_id = v_org))$y$);
  execute v_def;

  -- criar usuário / ligar usuário a uma pessoa que já é colaboradora: completa o vínculo do RH
  select pg_get_functiondef('core.create_user(jsonb)'::regprocedure) into v_def;
  if position($y$  perform private.apply_member_access(v_member, p);$y$ in v_def) = 0 then raise exception 'create_user mudou: ajuste este patch'; end if;
  v_def := replace(v_def, $y$  perform private.apply_member_access(v_member, p);$y$,
$y$  if v_party is not null then update hr.employees set member_id = v_member where party_id = v_party and member_id is null and org_id = v_org; end if;
  perform private.apply_member_access(v_member, p);$y$);
  execute v_def;

  select pg_get_functiondef('core.link_user_party(uuid,uuid)'::regprocedure) into v_def;
  if position($y$  perform private.audit_admin('USER_PARTY_LINKED'$y$ in v_def) = 0 then raise exception 'link_user_party mudou: ajuste este patch'; end if;
  v_def := replace(v_def, $y$  perform private.audit_admin('USER_PARTY_LINKED'$y$,
$y$  update hr.employees set member_id = m.id where party_id = p_party and member_id is null and org_id = v_org;
  perform private.audit_admin('USER_PARTY_LINKED'$y$);
  execute v_def;
end $x$;

-- Colaboradores já admitidos: o CPF vai para o cadastro (só onde ainda não há CPF, e sem repetir CPF de outra pessoa)
do $x$
declare r record; n int := 0;
begin
  for r in
    select e.org_id, e.party_id, ep.cpf from hr.employees e join hr.employee_private ep on ep.employee_id = e.id
    where ep.cpf is not null and private.valid_cpf(ep.cpf) and not exists (select 1 from crm.party_sensitive s where s.party_id = e.party_id and s.cpf_hmac is not null)
  loop
    begin
      insert into crm.party_sensitive (party_id, org_id, cpf_encrypted, cpf_hmac, cpf_last4, updated_at)
      select r.party_id, r.org_id, extensions.pgp_sym_encrypt(r.cpf, private.cpf_key()), private.cpf_hmac(r.cpf), right(r.cpf, 4), now()
      where not exists (select 1 from crm.party_sensitive s where s.org_id = r.org_id and s.cpf_hmac = private.cpf_hmac(r.cpf))
      on conflict (party_id) do update set cpf_encrypted = excluded.cpf_encrypted, cpf_hmac = excluded.cpf_hmac, cpf_last4 = excluded.cpf_last4, updated_at = now();
      n := n + 1;
    exception when others then
      raise notice 'CPF do colaborador % não copiado para o cadastro: %', r.party_id, sqlerrm;
    end;
  end loop;
  raise notice 'CPF de % colaborador(es) copiado(s) para o cadastro', n;
end $x$;

-- Colaboradores com usuário que apontam para a mesma pessoa: completa o vínculo
update hr.employees e set member_id = m.id from core.members m where e.member_id is null and m.party_id = e.party_id and m.org_id = e.org_id;

select private.lock_functions();
