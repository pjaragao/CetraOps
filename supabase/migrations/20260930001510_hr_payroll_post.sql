-- =====================================================================
-- hr (folha → financeiro, contábil e fiscal): aprovar a folha gera
--   · um título a pagar por colaborador (líquido) — a baixa/rateio acontece na tela de pagamento do financeiro
--   · guias agregadas: FGTS, INSS (DAE eSocial), IRRF (DARF 0561), benefícios por fornecedor, pensão/consignado por favorecido
--   · o lançamento contábil (despesa por centro de custo, passivos e retenções)
--   · o calendário de obrigações e a fila de eventos do eSocial
-- Também: estorno da folha, provisões mensais de 13º/férias/FGTS e recibo de férias.
-- =====================================================================

-- Consumo das provisões constituídas quando férias/13º são efetivamente pagos
create or replace function private.provision_balance(p_employee uuid, p_kind text) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(amount), 0) from hr.provisions where employee_id = p_employee and kind = p_kind
$$;

create or replace function private.consume_provisions(p_run uuid, p_entry_date date) returns void
language plpgsql security definer set search_path = '' as $$
declare
  r hr.payroll_runs; ps record; v_lines jsonb := '[]'; v_gross numeric; v_cons numeric; v_fgts_cons numeric; v_kind text; v_role text; v_exp text; v_cc uuid;
begin
  select * into r from hr.payroll_runs where id = p_run;
  if r.kind not in ('VACATION', 'THIRTEENTH_1', 'THIRTEENTH_2') then return; end if;
  for ps in
    select p.id, p.employee_id, p.fgts, coalesce(e.cost_center_id, st.cost_center_id) as cc
    from hr.payslips p join hr.employees e on e.id = p.employee_id left join core.stores st on st.id = e.store_id
    where p.run_id = r.id and p.status <> 'CANCELLED'
  loop
    v_kind := case when r.kind = 'VACATION' then 'VACATION' else 'THIRTEENTH' end;
    v_role := case when r.kind = 'VACATION' then 'PROV_VACATION' else 'PROV_13TH' end;
    v_exp := case when r.kind = 'VACATION' then 'PAYROLL_VACATION' else 'PAYROLL_13TH' end;
    select coalesce(sum(l.amount) filter (where l.kind = 'EARNING' and l.event_code in ('FERIAS', 'FERIAS_1_3', 'DEC_TERCEIRO_1', 'DEC_TERCEIRO_2')), 0)
         - coalesce(sum(l.amount) filter (where l.event_code = 'DESC_13_ANT'), 0)
      into v_gross from hr.payslip_lines l where l.payslip_id = ps.id;
    v_cons := least(private.provision_balance(ps.employee_id, v_kind), greatest(v_gross, 0));
    v_fgts_cons := least(private.provision_balance(ps.employee_id, 'FGTS'), ps.fgts);
    v_cc := ps.cc;
    if v_cons > 0 then
      insert into hr.provisions (org_id, employee_id, kind, competence, amount, source_type, source_id)
      values (r.org_id, ps.employee_id, v_kind, r.competence, -v_cons, 'hr.payroll_runs', r.id);
      v_lines := v_lines || jsonb_build_array(
        jsonb_build_object('role', v_role, 'debit', v_cons),
        jsonb_build_object('role', v_exp, 'credit', v_cons, 'cost_center_id', v_cc));
    end if;
    if v_fgts_cons > 0 then
      insert into hr.provisions (org_id, employee_id, kind, competence, amount, source_type, source_id)
      values (r.org_id, ps.employee_id, 'FGTS', r.competence, -v_fgts_cons, 'hr.payroll_runs', r.id);
      v_lines := v_lines || jsonb_build_array(
        jsonb_build_object('role', 'PROV_FGTS', 'debit', v_fgts_cons),
        jsonb_build_object('role', 'PAYROLL_FGTS', 'credit', v_fgts_cons, 'cost_center_id', v_cc));
    end if;
  end loop;
  if jsonb_array_length(v_lines) > 0 then
    perform private.post_entry(r.legal_entity_id, p_entry_date, 'PROVISION_USE', 'hr.payroll_runs', r.id,
      'Uso das provisões — ' || coalesce(r.description, r.kind), v_lines);
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Contabilização + títulos + obrigações (compartilhado pela folha e pela rescisão)
-- ---------------------------------------------------------------------
create or replace function private.post_run(p_run uuid, p_entry_date date, p_due_gov date default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  r hr.payroll_runs; ps record; l record; b record;
  v_lines jsonb := '[]'; v_entry uuid; v_payable_role text; t fin.titles;
  v_fgts numeric; v_inss numeric; v_irrf numeric; v_due_gov date; v_org uuid;
  v_pay_role text;
begin
  select * into r from hr.payroll_runs where id = p_run;
  v_org := r.org_id;
  v_due_gov := coalesce(p_due_gov, private.due_next_month(v_org, r.competence, 20));
  v_payable_role := case r.kind when 'VACATION' then 'VACATION_PAYABLE' when 'THIRTEENTH_1' then 'THIRTEENTH_PAYABLE' when 'THIRTEENTH_2' then 'THIRTEENTH_PAYABLE'
                                when 'TERMINATION' then 'TERMINATION_PAYABLE' when 'PROLABORE' then 'PROLABORE_PAYABLE' else 'SALARIES_PAYABLE' end;

  -- 1) lançamento contábil da competência
  for l in
    select ev.kind, ev.expense_role, ev.liability_role, coalesce(e.cost_center_id, st.cost_center_id) as cc, sum(pl.amount) as amt
    from hr.payslip_lines pl
    join hr.payslips p on p.id = pl.payslip_id
    join hr.employees e on e.id = p.employee_id
    left join core.stores st on st.id = e.store_id
    join hr.payroll_events ev on ev.org_id = pl.org_id and ev.code = pl.event_code
    where p.run_id = r.id and p.status <> 'CANCELLED'
    group by ev.kind, ev.expense_role, ev.liability_role, coalesce(e.cost_center_id, st.cost_center_id)
  loop
    if l.kind = 'EARNING' then
      v_lines := v_lines || jsonb_build_object('role', l.expense_role, 'debit', l.amt, 'cost_center_id', l.cc);
    elsif l.kind = 'DEDUCTION' then
      if l.liability_role is not null then
        v_lines := v_lines || jsonb_build_object('role', l.liability_role, 'credit', l.amt);
      else
        v_lines := v_lines || jsonb_build_object('role', l.expense_role, 'credit', l.amt, 'cost_center_id', l.cc);
      end if;
    else
      v_lines := v_lines || jsonb_build_array(
        jsonb_build_object('role', l.expense_role, 'debit', l.amt, 'cost_center_id', l.cc),
        jsonb_build_object('role', l.liability_role, 'credit', l.amt));
    end if;
  end loop;
  for ps in select p.id, p.net, e.party_id from hr.payslips p join hr.employees e on e.id = p.employee_id where p.run_id = r.id and p.status <> 'CANCELLED' and p.net > 0 loop
    v_lines := v_lines || jsonb_build_object('role', v_payable_role, 'credit', ps.net, 'party_id', ps.party_id);
  end loop;
  v_entry := private.post_entry(r.legal_entity_id, p_entry_date, 'PAYROLL', 'hr.payroll_runs', r.id,
                                coalesce(r.description, 'Folha de pagamento'), v_lines);
  update hr.payroll_runs set journal_entry_id = v_entry where id = r.id;

  -- 2) título a pagar por colaborador (líquido)
  for ps in
    select p.id as psid, p.net, e.id as eid, e.party_id, e.store_id, coalesce(e.cost_center_id, st.cost_center_id) as cc, pa.display_name
    from hr.payslips p join hr.employees e on e.id = p.employee_id join crm.parties pa on pa.id = e.party_id left join core.stores st on st.id = e.store_id
    where p.run_id = r.id and p.status <> 'CANCELLED' and p.net > 0
  loop
    t := private.insert_title(jsonb_build_object(
      'direction', 'PAYABLE', 'legal_entity_id', r.legal_entity_id, 'store_id', ps.store_id, 'party_id', ps.party_id,
      'description', coalesce(r.description, 'Folha') || ' — ' || ps.display_name, 'document_kind', 'FOLHA',
      'competence_date', r.competence, 'cost_center_id', ps.cc, 'origin_type', 'PAYROLL', 'origin_id', ps.psid,
      'approval_status', 'APPROVED', 'accrual_mode', 'EXTERNAL', 'control_account_id', private.acct(v_org, v_payable_role),
      'installments', jsonb_build_array(jsonb_build_object('due_date', coalesce(r.pay_date, v_due_gov), 'amount', ps.net))), private.member_id());
    update hr.payslips set title_id = t.id, status = 'APPROVED' where id = ps.psid;
  end loop;
  update hr.payslips set status = 'APPROVED' where run_id = r.id and status = 'DRAFT';

  -- 3) guias agregadas (FGTS, INSS/DAE, IRRF/DARF)
  select coalesce(sum(pl.amount) filter (where pl.event_code in ('FGTS_EMP', 'MULTA_FGTS')), 0),
         coalesce(sum(pl.amount) filter (where pl.event_code in ('INSS', 'INSS_PATRONAL', 'RAT', 'TERCEIROS')), 0),
         coalesce(sum(pl.amount) filter (where pl.event_code = 'IRRF'), 0)
    into v_fgts, v_inss, v_irrf
  from hr.payslip_lines pl join hr.payslips p on p.id = pl.payslip_id where p.run_id = r.id and p.status <> 'CANCELLED';

  for b in select * from (values
      ('FGTS', 'FGTS', 'FGTS_PAYABLE', v_fgts, coalesce(case when r.kind = 'TERMINATION' then r.pay_date end, v_due_gov), 'FGTS'),
      ('INSS_DAE', 'DAE', 'INSS_PAYABLE', v_inss, v_due_gov, 'INSS (DAE eSocial)'),
      ('IRRF_DARF', 'DARF', 'IRRF_PAYABLE', v_irrf, v_due_gov, 'IRRF (DARF 0561)')
    ) as x(obl, doc, role, amt, due, label)
  loop
    continue when b.amt <= 0;
    t := private.insert_title(jsonb_build_object(
      'direction', 'PAYABLE', 'legal_entity_id', r.legal_entity_id, 'description', b.label || ' — ' || coalesce(r.description, ''),
      'document_kind', b.doc, 'competence_date', r.competence, 'origin_type', 'PAYROLL', 'origin_id', r.id,
      'approval_status', 'APPROVED', 'accrual_mode', 'EXTERNAL', 'control_account_id', private.acct(v_org, b.role),
      'installments', jsonb_build_array(jsonb_build_object('due_date', b.due, 'amount', b.amt))), private.member_id());
    insert into fiscal.obligations (org_id, legal_entity_id, kind, competence, due_date, amount, title_id, source_type, source_id, notes)
    values (v_org, r.legal_entity_id, b.obl, r.competence, b.due, b.amt, t.id, 'hr.payroll_runs', r.id, r.description)
    on conflict (kind, source_type, source_id) where source_id is not null do update set amount = excluded.amount, due_date = excluded.due_date, title_id = excluded.title_id;
  end loop;

  -- 4) benefícios por fornecedor e pensão/consignado por favorecido
  for b in
    select pl.supplier_party_id as party, sum(pl.amount) as amt, 'BENEFICIOS'::text as doc, 'BENEFITS_PAYABLE'::text as role, 'Benefícios' as label
    from hr.payslip_lines pl join hr.payslips p on p.id = pl.payslip_id
    where p.run_id = r.id and p.status <> 'CANCELLED' and pl.event_code in ('BEN_VT', 'BEN_VR', 'BEN_SAUDE', 'BEN_OUTROS')
    group by pl.supplier_party_id
    union all
    select pl.beneficiary_party_id, sum(pl.amount), 'PENSAO', 'GARNISHMENTS_PAYABLE', 'Pensão / consignado'
    from hr.payslip_lines pl join hr.payslips p on p.id = pl.payslip_id
    where p.run_id = r.id and p.status <> 'CANCELLED' and pl.event_code in ('PENSAO', 'EMPREST', 'OUTROS_DESC')
    group by pl.beneficiary_party_id
  loop
    continue when b.amt <= 0;
    perform private.insert_title(jsonb_build_object(
      'direction', 'PAYABLE', 'legal_entity_id', r.legal_entity_id, 'party_id', b.party, 'description', b.label || ' — ' || coalesce(r.description, ''),
      'document_kind', b.doc, 'competence_date', r.competence, 'origin_type', 'PAYROLL', 'origin_id', r.id,
      'approval_status', 'APPROVED', 'accrual_mode', 'EXTERNAL', 'control_account_id', private.acct(v_org, b.role),
      'installments', jsonb_build_array(jsonb_build_object('due_date', coalesce(r.pay_date, v_due_gov), 'amount', b.amt))), private.member_id());
  end loop;
end $$;

create or replace function hr.approve_run(p_run uuid) returns hr.payroll_runs
language plpgsql security definer set search_path = '' as $$
declare r hr.payroll_runs; comp_end date; ps record;
begin
  perform private.require_perm('hr.payroll.approve');
  select * into r from hr.payroll_runs where id = p_run and org_id = coalesce(private.org_id(), org_id) for update;
  if r.id is null then raise exception 'Folha não encontrada'; end if;
  if r.status <> 'CALCULATED' then raise exception 'Calcule a folha antes de aprovar (situação: %)', r.status using errcode = 'P0053'; end if;
  if r.kind = 'TERMINATION' then raise exception 'Rescisões são aprovadas pelo fluxo de rescisão'; end if;
  if exists (select 1 from hr.payslips where run_id = r.id and net < 0) then
    raise exception 'Há recibo com líquido negativo: ajuste descontos antes de aprovar' using errcode = 'P0054';
  end if;
  if not exists (select 1 from hr.payslips where run_id = r.id and status <> 'CANCELLED') then raise exception 'Folha sem recibos'; end if;
  comp_end := (r.competence + interval '1 month - 1 day')::date;
  perform private.assert_period_open(r.legal_entity_id, comp_end);

  perform private.post_run(r.id, comp_end);
  perform private.consume_provisions(r.id, comp_end);

  -- eSocial: remuneração (S-1200) por colaborador
  if r.kind in ('MONTHLY', 'THIRTEENTH_2', 'PROLABORE', 'VACATION') then
    for ps in select p.id, p.employee_id, p.gross, p.net, p.inss, p.irrf, p.fgts from hr.payslips p where p.run_id = r.id and p.status <> 'CANCELLED' loop
      perform private.enqueue_esocial(r.legal_entity_id, 'S-1200', 'hr.payslips', ps.id, r.competence,
        jsonb_build_object('employee_id', ps.employee_id, 'run_kind', r.kind, 'gross', ps.gross, 'net', ps.net, 'inss', ps.inss, 'irrf', ps.irrf, 'fgts', ps.fgts,
          'lines', (select coalesce(jsonb_agg(jsonb_build_object('code', l.event_code, 'amount', l.amount, 'kind', l.kind)), '[]') from hr.payslip_lines l where l.payslip_id = ps.id)));
    end loop;
  end if;

  -- comissões e férias ficam vinculadas ao recibo
  update comm.statements s set status = 'PAID', payslip_id = p.id
  from hr.payslips p join hr.employees e on e.id = p.employee_id
  where r.kind = 'MONTHLY' and p.run_id = r.id and s.member_id = e.member_id and s.competence = r.competence and s.status = 'APPROVED';
  update hr.vacations v set status = 'PAID' where r.kind = 'VACATION' and v.id = r.reference_id;

  update hr.payroll_runs set status = 'APPROVED', approved_by = private.member_id(), approved_at = now() where id = r.id returning * into r;
  return r;
end $$;

-- Recibo marcado como PAGO quando o título do líquido é quitado; a folha vira PAGA quando todos estão pagos
create or replace function private.sync_payroll_paid() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_run uuid;
begin
  if new.status = 'SETTLED' and old.status is distinct from 'SETTLED' and new.origin_type = 'PAYROLL' then
    update hr.payslips set status = 'PAID' where id = new.origin_id and title_id = new.id returning run_id into v_run;
    if v_run is not null and not exists (select 1 from hr.payslips where run_id = v_run and status = 'APPROVED') then
      update hr.payroll_runs set status = 'PAID' where id = v_run and status = 'APPROVED';
    end if;
  end if;
  return null;
end $$;
create trigger trg_payroll_paid after update of status on fin.titles
  for each row execute function private.sync_payroll_paid();

-- ---------------------------------------------------------------------
-- Estorno / cancelamento da folha
-- ---------------------------------------------------------------------
create or replace function hr.cancel_run(p_run uuid, p_reason text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare r hr.payroll_runs; ent record;
begin
  perform private.require_perm('hr.payroll.approve');
  select * into r from hr.payroll_runs where id = p_run and org_id = coalesce(private.org_id(), org_id) for update;
  if r.id is null then raise exception 'Folha não encontrada'; end if;
  if r.status = 'CANCELLED' then return; end if;
  if r.kind = 'TERMINATION' and r.status in ('APPROVED', 'PAID') then
    raise exception 'Cancele a rescisão pelo fluxo de rescisão' using errcode = 'P0053';
  end if;
  if r.status in ('DRAFT', 'CALCULATED') then
    update hr.payslips set status = 'CANCELLED' where run_id = r.id;
    update hr.payroll_runs set status = 'CANCELLED', notes = concat_ws(' · ', notes, 'Cancelada: ' || coalesce(p_reason, '—')) where id = r.id;
    return;
  end if;
  if exists (
    select 1 from fin.title_installments i join fin.titles t on t.id = i.title_id
    where t.origin_type = 'PAYROLL' and (t.origin_id = r.id or t.origin_id in (select id from hr.payslips where run_id = r.id)) and i.amount_settled > 0
  ) then
    raise exception 'A folha tem pagamentos: estorne as baixas no financeiro antes de cancelar' using errcode = 'P0055';
  end if;
  perform private.assert_period_open(r.legal_entity_id, private.today_sp());

  update fin.title_installments set status = 'CANCELLED'
  where title_id in (select id from fin.titles where origin_type = 'PAYROLL' and (origin_id = r.id or origin_id in (select id from hr.payslips where run_id = r.id)));
  update fin.titles set status = 'CANCELLED', tags = array_append(tags, 'folha-cancelada')
  where origin_type = 'PAYROLL' and (origin_id = r.id or origin_id in (select id from hr.payslips where run_id = r.id));

  for ent in select id from fin.journal_entries where source_type = 'hr.payroll_runs' and source_id = r.id and reversal_of_id is null loop
    perform private.reverse_entry(ent.id, 'Cancelamento da folha: ' || coalesce(p_reason, ''));
  end loop;
  insert into hr.provisions (org_id, employee_id, kind, competence, amount, source_type, source_id)
  select org_id, employee_id, kind, competence, -amount, 'hr.payroll_runs', r.id
  from hr.provisions where source_type = 'hr.payroll_runs' and source_id = r.id and amount < 0;

  update fiscal.esocial_events set status = 'CANCELLED' where reference_type = 'hr.payslips' and reference_id in (select id from hr.payslips where run_id = r.id) and status = 'PENDING';
  update comm.statements set status = 'APPROVED', payslip_id = null where payslip_id in (select id from hr.payslips where run_id = r.id);
  update hr.vacations set status = 'APPROVED', payslip_id = null where payslip_id in (select id from hr.payslips where run_id = r.id);
  update hr.payslips set status = 'CANCELLED' where run_id = r.id;
  update hr.payroll_runs set status = 'CANCELLED', notes = concat_ws(' · ', notes, 'Cancelada: ' || coalesce(p_reason, '—')) where id = r.id;
end $$;

-- ---------------------------------------------------------------------
-- Provisões mensais de 13º, férias + 1/3 e FGTS sobre elas (competência)
-- ---------------------------------------------------------------------
create or replace function hr.accrue_provisions(p_entity uuid, p_competence date) returns hr.provision_runs
language plpgsql security definer set search_path = '' as $$
declare
  pr hr.provision_runs; emp record; comp date := date_trunc('month', p_competence)::date; comp_end date; v_org uuid;
  s numeric; v_var numeric; base numeric; frac numeric; p13 numeric; pvac numeric; pfgts numeric; v_rate numeric;
  v_lines jsonb := '[]'; c record; t13 numeric := 0; tvac numeric := 0; tfgts numeric := 0;
begin
  perform private.require_perm('hr.payroll.approve');
  select org_id into v_org from core.legal_entities where id = p_entity and org_id = coalesce(private.org_id(), org_id);
  if v_org is null then raise exception 'Empresa inválida'; end if;
  comp_end := (comp + interval '1 month - 1 day')::date;
  perform private.assert_period_open(p_entity, comp_end);
  if exists (select 1 from hr.provision_runs where legal_entity_id = p_entity and competence = comp) then
    raise exception 'Provisões de % já foram lançadas', to_char(comp, 'MM/YYYY') using errcode = 'P0056';
  end if;
  v_rate := (hr.tax_data('FGTS', comp_end) ->> 'rate')::numeric;
  insert into hr.provision_runs (org_id, legal_entity_id, competence, created_by) values (v_org, p_entity, comp, private.member_id()) returning * into pr;

  for emp in select * from hr.employees x where x.legal_entity_id = p_entity and x.status = 'ACTIVE' and x.contract_type in ('CLT', 'INTERMITENTE', 'TEMPORARIO', 'APRENDIZ')
             and x.hire_date <= comp_end and (x.termination_date is null or x.termination_date > comp_end) loop
    s := private.monthly_salary(emp.id, comp_end);
    continue when s is null;
    frac := 1;
    if emp.hire_date > comp then frac := (30 - least(extract(day from emp.hire_date)::int, 30) + 1) / 30.0; end if;
    v_var := private.variable_avg(emp.id, (comp - interval '11 months')::date, comp);
    base := (s + v_var) * frac;
    p13 := round(base / 12, 2);
    pvac := round(base / 12 * 4 / 3, 2);
    pfgts := case when emp.fgts then round((p13 + pvac) * v_rate / 100, 2) else 0 end;
    insert into hr.provisions (org_id, employee_id, kind, competence, amount, source_type, source_id) values
      (v_org, emp.id, 'THIRTEENTH', comp, p13, 'hr.provision_runs', pr.id),
      (v_org, emp.id, 'VACATION', comp, pvac, 'hr.provision_runs', pr.id);
    if pfgts > 0 then
      insert into hr.provisions (org_id, employee_id, kind, competence, amount, source_type, source_id) values (v_org, emp.id, 'FGTS', comp, pfgts, 'hr.provision_runs', pr.id);
    end if;
  end loop;

  for c in
    select coalesce(e.cost_center_id, st.cost_center_id) as cc,
           sum(p.amount) filter (where p.kind = 'THIRTEENTH') as s13, sum(p.amount) filter (where p.kind = 'VACATION') as svac, sum(p.amount) filter (where p.kind = 'FGTS') as sfgts
    from hr.provisions p join hr.employees e on e.id = p.employee_id left join core.stores st on st.id = e.store_id
    where p.source_type = 'hr.provision_runs' and p.source_id = pr.id
    group by coalesce(e.cost_center_id, st.cost_center_id)
  loop
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('role', 'PAYROLL_13TH', 'debit', coalesce(c.s13, 0), 'cost_center_id', c.cc),
      jsonb_build_object('role', 'PROV_13TH', 'credit', coalesce(c.s13, 0)),
      jsonb_build_object('role', 'PAYROLL_VACATION', 'debit', coalesce(c.svac, 0), 'cost_center_id', c.cc),
      jsonb_build_object('role', 'PROV_VACATION', 'credit', coalesce(c.svac, 0)),
      jsonb_build_object('role', 'PAYROLL_FGTS', 'debit', coalesce(c.sfgts, 0), 'cost_center_id', c.cc),
      jsonb_build_object('role', 'PROV_FGTS', 'credit', coalesce(c.sfgts, 0)));
    t13 := t13 + coalesce(c.s13, 0); tvac := tvac + coalesce(c.svac, 0); tfgts := tfgts + coalesce(c.sfgts, 0);
  end loop;
  if jsonb_array_length(v_lines) > 0 then
    update hr.provision_runs set totals = jsonb_build_object('thirteenth', t13, 'vacation', tvac, 'fgts', tfgts),
      journal_entry_id = private.post_entry(p_entity, comp_end, 'PROVISION', 'hr.provision_runs', pr.id, 'Provisões de 13º, férias e FGTS — ' || to_char(comp, 'MM/YYYY'), v_lines)
    where id = pr.id returning * into pr;
  end if;
  return pr;
end $$;

-- ---------------------------------------------------------------------
-- Recibo de férias: gera e calcula a folha do tipo VACATION para as férias aprovadas
-- ---------------------------------------------------------------------
create or replace function hr.pay_vacation(p_vacation uuid) returns hr.payroll_runs
language plpgsql security definer set search_path = '' as $$
declare v hr.vacations; e hr.employees; r hr.payroll_runs; ps hr.payslips; v_name text;
begin
  perform private.require_perm('hr.payroll.write');
  select * into v from hr.vacations where id = p_vacation and org_id = coalesce(private.org_id(), org_id) for update;
  if v.id is null then raise exception 'Férias não encontradas'; end if;
  if v.status <> 'APPROVED' then raise exception 'Só férias aprovadas geram recibo (situação: %)', v.status using errcode = 'P0057'; end if;
  if exists (select 1 from hr.payroll_runs where kind = 'VACATION' and reference_id = v.id and status <> 'CANCELLED') then
    raise exception 'Este recibo de férias já foi gerado' using errcode = 'P0057';
  end if;
  select * into e from hr.employees where id = v.employee_id;
  select display_name into v_name from crm.parties where id = e.party_id;
  insert into hr.payroll_runs (org_id, legal_entity_id, kind, competence, description, pay_date, reference_type, reference_id, created_by)
  values (e.org_id, e.legal_entity_id, 'VACATION', date_trunc('month', v.start_date)::date,
          'Férias de ' || v_name || ' (' || to_char(v.start_date, 'DD/MM') || ' a ' || to_char(v.end_date, 'DD/MM/YYYY') || ')', v.pay_date, 'hr.vacations', v.id, private.member_id())
  returning * into r;
  insert into hr.payslips (org_id, run_id, employee_id) values (e.org_id, r.id, e.id) returning * into ps;
  update hr.vacations set payslip_id = ps.id where id = v.id;
  return hr.calc_run(r.id);
end $$;

select private.rpc_only('hr', array['payroll_runs']);
