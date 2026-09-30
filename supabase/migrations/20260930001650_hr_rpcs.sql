-- =====================================================================
-- hr (cadastro): admissão (cadastro único com crm.parties + dados sensíveis separados), reajuste de salário,
-- afastamentos e configuração padrão por empresa. Eventos do eSocial são enfileirados a cada ato.
-- =====================================================================

-- Configuração padrão de encargos ao criar uma empresa
create or replace function private.default_hr_entity_settings() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into hr.entity_settings (legal_entity_id, org_id, charge_profile)
  values (new.id, new.org_id, case when new.tax_regime = 'SIMPLES_NACIONAL' then 'SIMPLES' else 'GENERAL' end)
  on conflict (legal_entity_id) do nothing;
  return new;
end $$;
create trigger trg_hr_entity_settings after insert on core.legal_entities
  for each row execute function private.default_hr_entity_settings();
insert into hr.entity_settings (legal_entity_id, org_id, charge_profile)
select id, org_id, case when tax_regime = 'SIMPLES_NACIONAL' then 'SIMPLES' else 'GENERAL' end from core.legal_entities
on conflict (legal_entity_id) do nothing;

-- ---------------------------------------------------------------------
-- Admissão
-- p = {legal_entity_id, store_id?, cost_center_id?, party_id?, name, cpf, birth_date?, email?, phone?,
--      contract_type, job_title, cbo?, department?, hire_date, salary, salary_unit?, weekly_hours?, daily_minutes?,
--      work_regime?, experience_days?[], commissioned?, track_time?, time_bank?, fgts?, member_id?,
--      pis?, ctps?, rg?, mother_name?, marital_status?, bank_code?, bank_agency?, bank_account?, pix_key?, address?, dependents?[]}
-- ---------------------------------------------------------------------
create or replace function hr.create_employee(p jsonb) returns hr.employees
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
  v_entity core.legal_entities;
  v_party uuid := (p ->> 'party_id')::uuid;
  v_cpf text := regexp_replace(coalesce(p ->> 'cpf', ''), '\D', '', 'g');
  v_regime text := coalesce(p ->> 'work_regime', '6X1');
  v_weekly numeric := coalesce((p ->> 'weekly_hours')::numeric, 44);
  v_daily int;
  e hr.employees;
  d jsonb;
  v_cc uuid := (p ->> 'cost_center_id')::uuid;
begin
  perform private.require_perm('hr.write');
  perform private.require_perm('hr.payroll.write');
  perform private.require_perm('hr.sensitive');
  select * into v_entity from core.legal_entities where id = (p ->> 'legal_entity_id')::uuid and org_id = coalesce(private.org_id(), org_id);
  if v_entity.id is null then raise exception 'Empresa inválida'; end if;
  v_org := v_entity.org_id;
  if coalesce(p ->> 'name', '') = '' and v_party is null then raise exception 'Informe o nome do colaborador'; end if;
  if not private.valid_cpf(v_cpf) then raise exception 'CPF inválido' using errcode = 'P0060'; end if;
  if exists (select 1 from hr.employee_private where org_id = v_org and cpf = v_cpf) then raise exception 'Já existe colaborador com este CPF' using errcode = 'P0061'; end if;
  if coalesce((p ->> 'salary')::numeric, 0) <= 0 then raise exception 'Informe o salário'; end if;
  if (p ->> 'store_id') is not null and not exists (select 1 from core.stores where id = (p ->> 'store_id')::uuid and org_id = v_org) then raise exception 'Loja inválida'; end if;

  v_daily := coalesce((p ->> 'daily_minutes')::int, case v_regime when '5X2' then round(v_weekly * 60 / 5)::int when '12X36' then 720 when '6X1' then round(v_weekly * 60 / 6)::int else 480 end);
  if v_cc is null and (p ->> 'store_id') is not null then select cost_center_id into v_cc from core.stores where id = (p ->> 'store_id')::uuid; end if;

  if v_party is null then
    insert into crm.parties (org_id, kind, display_name, birth_date, source, tags)
    values (v_org, 'PERSON', p ->> 'name', (p ->> 'birth_date')::date, 'RH', array['colaborador']) returning id into v_party;
  end if;
  insert into crm.party_roles (party_id, org_id, role) values (v_party, v_org, 'EMPLOYEE') on conflict do nothing;
  if coalesce(p ->> 'phone', '') <> '' then
    insert into crm.party_contact_points (org_id, party_id, type, value_normalized, value_display, is_primary)
    values (v_org, v_party, 'WHATSAPP', 'x', p ->> 'phone', true) on conflict do nothing;
  end if;
  if coalesce(p ->> 'email', '') <> '' then
    insert into crm.party_contact_points (org_id, party_id, type, value_normalized, value_display, is_primary)
    values (v_org, v_party, 'EMAIL', 'x', p ->> 'email', false) on conflict do nothing;
  end if;

  insert into hr.employees (org_id, party_id, member_id, legal_entity_id, store_id, cost_center_id, registration, contract_type, job_title, cbo, department,
                            hire_date, experience_days, weekly_hours, daily_minutes, work_regime, track_time, time_bank, commissioned, fgts)
  values (v_org, v_party, (p ->> 'member_id')::uuid, v_entity.id, (p ->> 'store_id')::uuid, v_cc, core.next_number(v_org, 'MAT'),
          p ->> 'contract_type', p ->> 'job_title', p ->> 'cbo', p ->> 'department', (p ->> 'hire_date')::date,
          coalesce(array(select jsonb_array_elements_text(p -> 'experience_days')::int), '{}'), v_weekly, v_daily, v_regime,
          coalesce((p ->> 'track_time')::boolean, false), coalesce((p ->> 'time_bank')::boolean, false),
          coalesce((p ->> 'commissioned')::boolean, false), coalesce((p ->> 'fgts')::boolean, true))
  returning * into e;

  insert into hr.employee_private (employee_id, org_id, cpf, pis, ctps, rg, mother_name, marital_status, bank_code, bank_agency, bank_account, pix_key, address)
  values (e.id, v_org, v_cpf, p ->> 'pis', p ->> 'ctps', p ->> 'rg', p ->> 'mother_name', p ->> 'marital_status', p ->> 'bank_code', p ->> 'bank_agency',
          p ->> 'bank_account', p ->> 'pix_key', coalesce(p -> 'address', '{}'));

  insert into hr.salary_history (org_id, employee_id, effective_from, amount, unit, reason, created_by)
  values (v_org, e.id, e.hire_date, (p ->> 'salary')::numeric, coalesce(p ->> 'salary_unit', 'MONTH'), 'Admissão', private.member_id());

  for d in select * from jsonb_array_elements(coalesce(p -> 'dependents', '[]')) loop
    insert into hr.dependents (org_id, employee_id, name, cpf, birth_date, relationship, irrf, family_allowance)
    values (v_org, e.id, d ->> 'name', regexp_replace(coalesce(d ->> 'cpf', ''), '\D', '', 'g'), (d ->> 'birth_date')::date,
            coalesce(d ->> 'relationship', 'FILHO'), coalesce((d ->> 'irrf')::boolean, true), coalesce((d ->> 'family_allowance')::boolean, false));
  end loop;

  perform private.ensure_vacation_periods(e.id);
  perform private.enqueue_esocial(e.legal_entity_id, 'S-2200', 'hr.employees', e.id, date_trunc('month', e.hire_date)::date,
    jsonb_build_object('employee_id', e.id, 'registration', e.registration, 'hire_date', e.hire_date, 'contract_type', e.contract_type, 'job_title', e.job_title, 'cbo', e.cbo));
  return e;
end $$;

create or replace function hr.change_salary(p_employee uuid, p_effective_from date, p_amount numeric, p_reason text default null, p_unit text default 'MONTH') returns void
language plpgsql security definer set search_path = '' as $$
declare e hr.employees;
begin
  perform private.require_perm('hr.payroll.write');
  select * into e from hr.employees where id = p_employee and org_id = coalesce(private.org_id(), org_id);
  if e.id is null then raise exception 'Colaborador não encontrado'; end if;
  if p_amount <= 0 then raise exception 'Salário inválido'; end if;
  if p_effective_from < e.hire_date then raise exception 'Vigência anterior à admissão'; end if;
  if exists (select 1 from hr.payroll_runs r join hr.payslips ps on ps.run_id = r.id
             where ps.employee_id = e.id and r.kind = 'MONTHLY' and r.status in ('APPROVED', 'PAID') and r.competence >= date_trunc('month', p_effective_from)::date) then
    raise exception 'Já existe folha aprovada nessa competência ou depois: use vigência do próximo mês' using errcode = 'P0062';
  end if;
  insert into hr.salary_history (org_id, employee_id, effective_from, amount, unit, reason, created_by)
  values (e.org_id, e.id, p_effective_from, p_amount, p_unit, p_reason, private.member_id());
  perform private.enqueue_esocial(e.legal_entity_id, 'S-2206', 'hr.employees', e.id, date_trunc('month', p_effective_from)::date,
    jsonb_build_object('employee_id', e.id, 'new_salary', p_amount, 'effective_from', p_effective_from, 'reason', p_reason));
end $$;

-- Afastamentos e faltas. p = {employee_id, kind, start_date, end_date, paid?, inss_leave?, cid?, doc_ref?, notes?}
create or replace function hr.add_leave(p jsonb) returns hr.leaves
language plpgsql security definer set search_path = '' as $$
declare e hr.employees; l hr.leaves; v_kind text := p ->> 'kind'; v_paid boolean; v_inss boolean;
begin
  perform private.require_perm('hr.write');
  select * into e from hr.employees where id = (p ->> 'employee_id')::uuid and org_id = coalesce(private.org_id(), org_id);
  if e.id is null then raise exception 'Colaborador não encontrado'; end if;
  if (p ->> 'end_date')::date < (p ->> 'start_date')::date then raise exception 'Data final anterior à inicial'; end if;
  if exists (select 1 from hr.vacations v where v.employee_id = e.id and v.status in ('APPROVED', 'PAID', 'TAKEN')
             and v.start_date <= (p ->> 'end_date')::date and v.end_date >= (p ->> 'start_date')::date) then
    raise exception 'O colaborador está de férias nesse intervalo' using errcode = 'P0045';
  end if;
  v_paid := coalesce((p ->> 'paid')::boolean, v_kind not in ('UNPAID', 'SUSPENSION', 'UNJUSTIFIED_ABSENCE', 'MILITARY'));
  v_inss := coalesce((p ->> 'inss_leave')::boolean, false);
  insert into hr.leaves (org_id, employee_id, kind, start_date, end_date, paid, inss_leave, cid, doc_ref, notes, created_by)
  values (e.org_id, e.id, v_kind, (p ->> 'start_date')::date, (p ->> 'end_date')::date, v_paid and not v_inss, v_inss, p ->> 'cid', p ->> 'doc_ref', p ->> 'notes', private.member_id())
  returning * into l;
  delete from hr.roster where employee_id = e.id and work_date between l.start_date and l.end_date;
  if v_kind in ('SICK', 'ACCIDENT', 'MATERNITY', 'PATERNITY', 'MILITARY', 'MARRIAGE', 'BEREAVEMENT', 'BLOOD_DONATION') then
    perform private.enqueue_esocial(e.legal_entity_id, 'S-2230', 'hr.leaves', l.id, date_trunc('month', l.start_date)::date,
      jsonb_build_object('employee_id', e.id, 'kind', v_kind, 'start_date', l.start_date, 'end_date', l.end_date, 'inss_leave', l.inss_leave, 'cid', l.cid));
  end if;
  return l;
end $$;

-- Vincula o colaborador a um usuário do sistema (acesso da vendedora, gerente...)
create or replace function hr.link_member(p_employee uuid, p_member uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('hr.write');
  if not exists (select 1 from core.members where id = p_member and org_id = coalesce(private.org_id(), org_id)) then raise exception 'Membro inválido'; end if;
  update hr.employees set member_id = p_member where id = p_employee and org_id = coalesce(private.org_id(), org_id);
end $$;

-- Nova permissão: aprovar folha, provisões e rescisões (fica com os sócios)
-- (hr.read / hr.write / hr.payroll.read / hr.payroll.write / hr.sensitive / hr.payroll.approve)
