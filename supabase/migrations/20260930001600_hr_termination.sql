-- =====================================================================
-- hr (rescisão): cálculo da rescisão contratual com memória de cálculo e integração completa —
--   · folha do tipo TERMINATION (recibo com verbas rescisórias), prazo de 10 dias para pagamento (CLT art. 477 §6º)
--   · guias: FGTS + multa (GRRF), INSS/IRRF sobre saldo de salário e 13º; títulos no financeiro; lançamento contábil
--   · baixa das provisões de férias/13º/FGTS e reversão do excedente
--   · evento S-2299 do eSocial; encerra escala, benefícios, férias programadas e descontos do colaborador
-- PRÉVIA para conferência com o contador: a rescisão oficial (TRCT) é homologada por ele.
-- =====================================================================

create table hr.terminations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  employee_id uuid not null references hr.employees(id),
  kind text not null check (kind in ('WITHOUT_CAUSE', 'RESIGNATION', 'JUST_CAUSE', 'MUTUAL_AGREEMENT', 'FIXED_TERM_END', 'EXPERIENCE_END', 'DEATH', 'RETIREMENT')),
  notice_kind text not null default 'INDEMNIFIED' check (notice_kind in ('WORKED', 'INDEMNIFIED', 'WAIVED', 'NOT_SERVED', 'NONE')),
  termination_date date not null,
  notice_days int check (notice_days between 0 and 90),      -- vazio = 30 dias + 3 por ano completo (máx. 90)
  fgts_balance numeric(14,2),                                -- saldo do extrato do FGTS (base da multa); vazio = estimativa do sistema
  reason text,
  notes text,
  status text not null default 'DRAFT' check (status in ('DRAFT', 'CALCULATED', 'APPROVED', 'PAID', 'CANCELLED')),
  run_id uuid references hr.payroll_runs(id),
  computed jsonb not null default '{}',                      -- memória de cálculo
  approved_by uuid references core.members(id),
  approved_at timestamptz,
  created_by uuid references core.members(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index terminations_employee_uq on hr.terminations (employee_id) where status <> 'CANCELLED';

-- ---------------------------------------------------------------------
-- Cálculo do recibo de rescisão
-- ---------------------------------------------------------------------
create or replace function private.calc_termination_payslip(p_ps uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  ps hr.payslips; r hr.payroll_runs; e hr.employees; t hr.terminations; es hr.entity_settings;
  td date; m0 date; s numeric; v_var numeric; base numeric; tenure int; notice_total int; proj_days int := 0; proj_end date;
  days_bal int; v_saldo numeric; v_aviso numeric := 0; v_aviso_desc numeric := 0;
  y int; avos13 int := 0; total13 numeric := 0; first_paid numeric := 0;
  per record; v_venc_days int := 0; v_venc numeric := 0; v_expired boolean := false; v_prop numeric := 0; avos_vac int := 0;
  cur_start date; m int; ms date; me date;
  v_rate numeric; v_fgts_base numeric; v_fgts numeric := 0; v_fine_pct numeric; v_balance numeric; v_fine numeric; v_estimated boolean := false;
  base_s numeric; prior_base numeric; prior_inss numeric; v_inss_s numeric := 0; v_inss_13 numeric := 0; v_irrf_s numeric := 0; v_irrf_13 numeric := 0; v_deps int;
  v_adv numeric; v_inss_total_base numeric;
begin
  select * into ps from hr.payslips where id = p_ps;
  select * into r from hr.payroll_runs where id = ps.run_id;
  select * into e from hr.employees where id = ps.employee_id;
  select * into t from hr.terminations where id = r.reference_id;
  select * into es from hr.entity_settings where legal_entity_id = r.legal_entity_id;
  td := t.termination_date;
  m0 := date_trunc('month', td)::date;
  s := private.monthly_salary(e.id, td);
  if s is null then raise exception 'Colaborador sem salário cadastrado' using errcode = 'P0051'; end if;
  v_var := private.variable_avg(e.id, (td - interval '12 months')::date, (td - interval '1 month')::date);
  base := s + v_var;
  tenure := extract(year from age(td + 1, e.hire_date))::int;

  -- saldo de salário (base comercial de 30 dias)
  days_bal := least(30, extract(day from td)::int);
  if e.hire_date >= m0 then days_bal := least(30, extract(day from td)::int - extract(day from e.hire_date)::int + 1); end if;
  days_bal := greatest(0, days_bal - private.leave_overlap_days(e.id, m0, td, 'UNPAID') - private.leave_overlap_days(e.id, m0, td, 'INSS')
                          - private.vacation_overlap_days(e.id, m0, td));
  v_saldo := round(s / 30 * days_bal, 2);
  perform private.add_line(ps.id, 'SALDO_SALARIO', v_saldo, days_bal, 'Saldo de salário (' || days_bal::text || ' dias)');

  -- aviso prévio
  notice_total := coalesce(t.notice_days, least(90, 30 + 3 * tenure));
  if t.kind = 'WITHOUT_CAUSE' and t.notice_kind = 'INDEMNIFIED' then
    v_aviso := round(base / 30 * notice_total, 2); proj_days := notice_total;
  elsif t.kind = 'MUTUAL_AGREEMENT' and t.notice_kind = 'INDEMNIFIED' then
    v_aviso := round(base / 30 * notice_total * 0.5, 2); proj_days := notice_total / 2;
  elsif t.kind = 'RESIGNATION' and t.notice_kind = 'NOT_SERVED' then
    v_aviso_desc := round(s, 2);
  end if;
  proj_end := td + proj_days;
  perform private.add_line(ps.id, 'AVISO_INDENIZADO', v_aviso, proj_days, 'Aviso prévio indenizado (' || proj_days::text || ' dias)');
  perform private.add_line(ps.id, 'AVISO_DESC', v_aviso_desc, null, 'Aviso prévio não cumprido (desconto)');

  -- 13º proporcional (não devido na justa causa), projetando o aviso indenizado
  y := extract(year from td)::int;
  if t.kind <> 'JUST_CAUSE' then
    avos13 := private.avos(e.id, y, least(proj_end, make_date(y, 12, 31)));
    total13 := round((s + v_var) / 12 * avos13, 2);
    if extract(year from proj_end)::int > y then
      total13 := total13 + round((s + v_var) / 12 * private.avos(e.id, y + 1, proj_end), 2);
      avos13 := avos13 + private.avos(e.id, y + 1, proj_end);
    end if;
    select coalesce(sum(p2.gross), 0) into first_paid from hr.payslips p2 join hr.payroll_runs r2 on r2.id = p2.run_id
    where p2.employee_id = e.id and r2.kind = 'THIRTEENTH_1' and extract(year from r2.competence) = y and r2.status in ('APPROVED', 'PAID') and p2.status <> 'CANCELLED';
    first_paid := first_paid + coalesce((select sum(l.amount) from hr.payslip_lines l join hr.payslips p3 on p3.id = l.payslip_id join hr.payroll_runs r3 on r3.id = p3.run_id
                                         where p3.employee_id = e.id and l.event_code = 'ADIANT_13_FER' and extract(year from r3.competence) = y
                                           and r3.status in ('APPROVED', 'PAID') and p3.status <> 'CANCELLED'), 0);
    perform private.add_line(ps.id, 'DEC_TERCEIRO_PROP', total13, avos13, '13º salário proporcional (' || avos13::text || '/12)');
    perform private.add_line(ps.id, 'DESC_13_ANT', least(first_paid, total13), null, '(−) 13º já adiantado');
  end if;

  -- férias vencidas (períodos aquisitivos completos com saldo) + 1/3; dobra se passou do prazo concessivo
  perform private.ensure_vacation_periods(e.id);
  for per in select vp.id, vp.period_end, vp.concessive_end from hr.vacation_periods vp where vp.employee_id = e.id and vp.period_end < td order by vp.period_start loop
    perform private.refresh_vacation_period(per.id);
    declare v_left int;
    begin
      select vp.days_entitled - coalesce(sum(v.days + v.sell_days) filter (where v.status <> 'CANCELLED'), 0) into v_left
      from hr.vacation_periods vp left join hr.vacations v on v.period_id = vp.id where vp.id = per.id group by vp.days_entitled;
      if v_left > 0 then
        v_venc_days := v_venc_days + v_left;
        if per.concessive_end < td then v_expired := true; end if;
      end if;
    end;
  end loop;
  if v_venc_days > 0 then
    v_venc := round(base / 30 * v_venc_days, 2);
    perform private.add_line(ps.id, 'FERIAS_VENC', v_venc, v_venc_days, 'Férias vencidas (' || v_venc_days::text || ' dias)');
    perform private.add_line(ps.id, 'FERIAS_VENC_1_3', round(v_venc / 3, 2), null, '1/3 sobre férias vencidas');
    if v_expired then perform private.add_line(ps.id, 'FERIAS_DOBRA', v_venc + round(v_venc / 3, 2), null, 'Dobra legal das férias vencidas (art. 137 CLT)'); end if;
  end if;

  -- férias proporcionais + 1/3 (avos do período aquisitivo em curso, projetando o aviso indenizado)
  if t.kind <> 'JUST_CAUSE' then
    cur_start := (e.hire_date + make_interval(years => tenure))::date;
    for m in 0 .. 11 loop
      ms := (cur_start + make_interval(months => m))::date;
      exit when ms > proj_end;
      me := (ms + interval '1 month' - interval '1 day')::date;
      if (least(me, proj_end) - ms + 1) >= 15 then avos_vac := avos_vac + 1; end if;
    end loop;
    v_prop := round(base / 12 * avos_vac, 2);
    perform private.add_line(ps.id, 'FERIAS_PROP', v_prop, avos_vac, 'Férias proporcionais (' || avos_vac::text || '/12)');
    perform private.add_line(ps.id, 'FERIAS_PROP_1_3', round(v_prop / 3, 2), null, '1/3 sobre férias proporcionais');
  end if;

  -- adiantamento salarial do mês já pago
  select coalesce(sum(p2.gross), 0) into v_adv from hr.payslips p2 join hr.payroll_runs r2 on r2.id = p2.run_id
  where p2.employee_id = e.id and r2.kind = 'ADVANCE' and r2.competence = m0 and r2.status in ('APPROVED', 'PAID') and p2.status <> 'CANCELLED';
  perform private.add_line(ps.id, 'ADIANT', v_adv, null, 'Adiantamento salarial');

  -- INSS e IRRF: incidem só sobre saldo de salário (tabela mensal) e 13º (tabela exclusiva); aviso e férias indenizados não
  select coalesce(sum(l.amount), 0) into base_s from hr.payslip_lines l join hr.payroll_events ev on ev.org_id = l.org_id and ev.code = l.event_code
  where l.payslip_id = ps.id and l.kind = 'EARNING' and ev.inss and l.event_code <> 'DEC_TERCEIRO_PROP';
  select coalesce(sum(p2.inss_base), 0), coalesce(sum(p2.inss), 0) into prior_base, prior_inss
  from hr.payslips p2 join hr.payroll_runs r2 on r2.id = p2.run_id
  where p2.employee_id = e.id and p2.id <> ps.id and p2.base_group = 'MONTH' and r2.competence = r.competence and r2.status in ('CALCULATED', 'APPROVED', 'PAID') and p2.status <> 'CANCELLED';
  v_inss_s := greatest(hr.calc_inss(prior_base + base_s, td) - prior_inss, 0);
  v_inss_13 := hr.calc_inss(total13, td);
  select count(*)::int into v_deps from hr.dependents where employee_id = e.id and irrf;
  v_irrf_s := hr.calc_irrf(base_s, v_inss_s, v_deps, td, 0, true);
  v_irrf_13 := hr.calc_irrf(total13, v_inss_13, v_deps, td, 0, private.hr_policy(e.org_id, 'irrf_reducer_13th', 1) = 1);
  perform private.add_line(ps.id, 'INSS', v_inss_s, null, 'INSS sobre saldo de salário');
  perform private.add_line(ps.id, 'INSS', v_inss_13, null, 'INSS sobre 13º salário');
  perform private.add_line(ps.id, 'IRRF', v_irrf_s, null, 'IRRF sobre saldo de salário');
  perform private.add_line(ps.id, 'IRRF', v_irrf_13, null, 'IRRF sobre 13º salário (tributação exclusiva)');

  -- FGTS do mês da rescisão (saldo, aviso indenizado e 13º ainda não depositado) e multa rescisória
  v_rate := (hr.tax_data('FGTS', td) ->> 'rate')::numeric;
  v_fgts_base := v_saldo + v_aviso + greatest(total13 - first_paid, 0);
  if e.fgts and e.contract_type in ('CLT', 'APRENDIZ', 'INTERMITENTE', 'TEMPORARIO') then
    v_fgts := round(v_fgts_base * v_rate / 100, 2);
    perform private.add_line(ps.id, 'FGTS_EMP', v_fgts, v_rate, 'FGTS rescisório ' || v_rate::text || '%');
  end if;
  v_fine_pct := case t.kind when 'WITHOUT_CAUSE' then (hr.tax_data('FGTS', td) ->> 'fine_without_cause')::numeric
                            when 'MUTUAL_AGREEMENT' then (hr.tax_data('FGTS', td) ->> 'fine_mutual_agreement')::numeric
                            when 'DEATH' then 0 else 0 end;
  if v_fine_pct > 0 then
    if t.fgts_balance is not null then
      v_balance := t.fgts_balance;
    else
      select coalesce(sum(p2.fgts), 0) into v_balance from hr.payslips p2 where p2.employee_id = e.id and p2.id <> ps.id and p2.status in ('APPROVED', 'PAID');
      v_estimated := true;
    end if;
    v_fine := round((v_balance + v_fgts) * v_fine_pct / 100, 2);
    perform private.add_line(ps.id, 'MULTA_FGTS', v_fine, v_fine_pct, 'Multa rescisória do FGTS (' || v_fine_pct::text || '%)');
  end if;

  if coalesce(es.charge_profile, 'SIMPLES') <> 'SIMPLES' and (base_s + total13) > 0 then
    perform private.add_line(ps.id, 'INSS_PATRONAL', round((base_s + total13) * es.inss_employer_pct / 100, 2), es.inss_employer_pct);
    perform private.add_line(ps.id, 'RAT', round((base_s + total13) * es.rat_pct / 100, 2), es.rat_pct);
    if es.charge_profile = 'GENERAL' then
      perform private.add_line(ps.id, 'TERCEIROS', round((base_s + total13) * es.third_parties_pct / 100, 2), es.third_parties_pct);
    end if;
  end if;

  v_inss_total_base := base_s + total13;
  update hr.payslips set inss_base = v_inss_total_base, inss = v_inss_s + v_inss_13, irrf_base = base_s + total13, irrf = v_irrf_s + v_irrf_13,
                         fgts_base = v_fgts_base, fgts = v_fgts, dependents = v_deps where id = ps.id;
  update hr.terminations set computed = jsonb_build_object(
    'salary', s, 'variable_avg', v_var, 'tenure_years', tenure, 'saldo_days', days_bal, 'notice_days_total', notice_total, 'notice_projection_days', proj_days,
    'avos_13', avos13, 'avos_vacation', avos_vac, 'vacation_due_days', v_venc_days, 'vacation_expired', v_expired,
    'fgts_fine_pct', v_fine_pct, 'fgts_balance_used', v_balance, 'fgts_balance_estimated', v_estimated,
    'payment_deadline', r.pay_date), updated_at = now()
  where id = t.id;
end $$;

-- ---------------------------------------------------------------------
-- Fluxo da rescisão
-- p = {employee_id, kind, notice_kind?, termination_date, notice_days?, fgts_balance?, reason?, notes?}
-- ---------------------------------------------------------------------
create or replace function hr.create_termination(p jsonb) returns hr.terminations
language plpgsql security definer set search_path = '' as $$
declare e hr.employees; t hr.terminations; r hr.payroll_runs; ps hr.payslips; v_name text; td date := (p ->> 'termination_date')::date;
begin
  perform private.require_perm('hr.payroll.write');
  select * into e from hr.employees where id = (p ->> 'employee_id')::uuid and org_id = coalesce(private.org_id(), org_id);
  if e.id is null or e.status <> 'ACTIVE' then raise exception 'Colaborador não encontrado ou já desligado'; end if;
  if e.contract_type not in ('CLT', 'INTERMITENTE', 'TEMPORARIO', 'APRENDIZ') then raise exception 'Rescisão CLT só se aplica a vínculos CLT' using errcode = 'P0058'; end if;
  if td < e.hire_date then raise exception 'Data de desligamento anterior à admissão'; end if;
  if td > private.today_sp() + 60 then raise exception 'Data de desligamento muito distante'; end if;
  if exists (select 1 from hr.payslips ps2 join hr.payroll_runs r2 on r2.id = ps2.run_id
             where ps2.employee_id = e.id and r2.kind in ('MONTHLY', 'PROLABORE') and r2.competence = date_trunc('month', td)::date
               and r2.status in ('APPROVED', 'PAID') and ps2.status <> 'CANCELLED') then
    raise exception 'A folha mensal de % já foi aprovada com este colaborador: cancele-a e refaça sem ele', to_char(td, 'MM/YYYY') using errcode = 'P0059';
  end if;
  -- recibos ainda não aprovados da folha mensal saem: o saldo de salário passa a ser pago na rescisão
  update hr.payslips ps2 set status = 'CANCELLED' from hr.payroll_runs r2
  where ps2.run_id = r2.id and ps2.employee_id = e.id and r2.kind = 'MONTHLY' and r2.competence = date_trunc('month', td)::date and r2.status in ('DRAFT', 'CALCULATED');
  update hr.payroll_runs set status = 'DRAFT' where kind = 'MONTHLY' and legal_entity_id = e.legal_entity_id and competence = date_trunc('month', td)::date and status = 'CALCULATED';
  select display_name into v_name from crm.parties where id = e.party_id;
  insert into hr.terminations (org_id, employee_id, kind, notice_kind, termination_date, notice_days, fgts_balance, reason, notes, created_by)
  values (e.org_id, e.id, p ->> 'kind', coalesce(p ->> 'notice_kind', 'INDEMNIFIED'), td, (p ->> 'notice_days')::int, (p ->> 'fgts_balance')::numeric,
          p ->> 'reason', p ->> 'notes', private.member_id())
  returning * into t;
  insert into hr.payroll_runs (org_id, legal_entity_id, kind, competence, description, pay_date, reference_type, reference_id, created_by)
  values (e.org_id, e.legal_entity_id, 'TERMINATION', date_trunc('month', td)::date, 'Rescisão de ' || v_name, td + 10, 'hr.terminations', t.id, private.member_id())
  returning * into r;
  insert into hr.payslips (org_id, run_id, employee_id) values (e.org_id, r.id, e.id) returning * into ps;
  update hr.terminations set run_id = r.id where id = t.id;
  perform hr.calc_run(r.id);
  update hr.terminations set status = 'CALCULATED' where id = t.id returning * into t;
  return t;
end $$;

create or replace function hr.recalc_termination(p_termination uuid, p jsonb default '{}') returns hr.terminations
language plpgsql security definer set search_path = '' as $$
declare t hr.terminations;
begin
  perform private.require_perm('hr.payroll.write');
  select * into t from hr.terminations where id = p_termination and org_id = coalesce(private.org_id(), org_id) for update;
  if t.id is null then raise exception 'Rescisão não encontrada'; end if;
  if t.status not in ('DRAFT', 'CALCULATED') then raise exception 'Rescisão já aprovada' using errcode = 'P0053'; end if;
  update hr.terminations set
    kind = coalesce(p ->> 'kind', kind), notice_kind = coalesce(p ->> 'notice_kind', notice_kind),
    termination_date = coalesce((p ->> 'termination_date')::date, termination_date),
    notice_days = case when p ? 'notice_days' then (p ->> 'notice_days')::int else notice_days end,
    fgts_balance = case when p ? 'fgts_balance' then (p ->> 'fgts_balance')::numeric else fgts_balance end,
    reason = coalesce(p ->> 'reason', reason), notes = coalesce(p ->> 'notes', notes)
  where id = t.id;
  update hr.payroll_runs set status = 'DRAFT', competence = date_trunc('month', (select termination_date from hr.terminations where id = t.id))::date,
                             pay_date = (select termination_date from hr.terminations where id = t.id) + 10 where id = t.run_id;
  perform hr.calc_run(t.run_id);
  update hr.terminations set status = 'CALCULATED' where id = t.id returning * into t;
  return t;
end $$;

-- Baixa das provisões do colaborador na rescisão: consome o que foi pago e reverte o excedente para o resultado
create or replace function private.settle_provisions_termination(p_run uuid, p_employee uuid, p_date date) returns void
language plpgsql security definer set search_path = '' as $$
declare
  r hr.payroll_runs; e hr.employees; ps hr.payslips; v_cc uuid; v_lines jsonb := '[]';
  v_vac_paid numeric; v_13_paid numeric; v_fgts_paid numeric; b numeric; used numeric;
  kinds text[] := array['VACATION', 'THIRTEENTH', 'FGTS']; k text; v_role text; v_exp text; paid numeric;
begin
  select * into r from hr.payroll_runs where id = p_run;
  select * into e from hr.employees where id = p_employee;
  select * into ps from hr.payslips where run_id = r.id and employee_id = p_employee and status <> 'CANCELLED';
  select coalesce(e2.cost_center_id, st.cost_center_id) into v_cc from hr.employees e2 left join core.stores st on st.id = e2.store_id where e2.id = p_employee;
  select coalesce(sum(l.amount) filter (where l.event_code in ('FERIAS_VENC', 'FERIAS_VENC_1_3', 'FERIAS_PROP', 'FERIAS_PROP_1_3')), 0),
         coalesce(sum(l.amount) filter (where l.event_code = 'DEC_TERCEIRO_PROP'), 0) - coalesce(sum(l.amount) filter (where l.event_code = 'DESC_13_ANT'), 0),
         coalesce(sum(l.amount) filter (where l.event_code = 'FGTS_EMP'), 0)
    into v_vac_paid, v_13_paid, v_fgts_paid from hr.payslip_lines l where l.payslip_id = ps.id;
  foreach k in array kinds loop
    b := private.provision_balance(p_employee, k);
    continue when b = 0;
    paid := case k when 'VACATION' then v_vac_paid when 'THIRTEENTH' then v_13_paid else v_fgts_paid end;
    v_role := case k when 'VACATION' then 'PROV_VACATION' when 'THIRTEENTH' then 'PROV_13TH' else 'PROV_FGTS' end;
    v_exp := case k when 'VACATION' then 'PAYROLL_VACATION' when 'THIRTEENTH' then 'PAYROLL_13TH' else 'PAYROLL_FGTS' end;
    used := least(b, greatest(paid, 0));
    -- o que foi pago consome a provisão (reduz a despesa do mês); o restante é revertido (a provisão excedeu o devido)
    insert into hr.provisions (org_id, employee_id, kind, competence, amount, source_type, source_id)
    values (r.org_id, p_employee, k, r.competence, -b, 'hr.payroll_runs', r.id);
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('role', v_role, 'debit', b),
      jsonb_build_object('role', v_exp, 'credit', b, 'cost_center_id', v_cc));
  end loop;
  if jsonb_array_length(v_lines) > 0 then
    perform private.post_entry(r.legal_entity_id, p_date, 'PROVISION_USE', 'hr.payroll_runs', r.id, 'Baixa das provisões na rescisão', v_lines);
  end if;
end $$;

create or replace function hr.approve_termination(p_termination uuid) returns hr.terminations
language plpgsql security definer set search_path = '' as $$
declare t hr.terminations; r hr.payroll_runs; e hr.employees; ps hr.payslips;
begin
  perform private.require_perm('hr.payroll.approve');
  select * into t from hr.terminations where id = p_termination and org_id = coalesce(private.org_id(), org_id) for update;
  if t.id is null then raise exception 'Rescisão não encontrada'; end if;
  if t.status <> 'CALCULATED' then raise exception 'Calcule a rescisão antes de aprovar (situação: %)', t.status using errcode = 'P0053'; end if;
  select * into r from hr.payroll_runs where id = t.run_id for update;
  select * into e from hr.employees where id = t.employee_id;
  select * into ps from hr.payslips where run_id = r.id;
  if ps.net < 0 then raise exception 'Líquido negativo na rescisão: registre o saldo devedor como desconto/ajuste' using errcode = 'P0054'; end if;
  perform private.assert_period_open(r.legal_entity_id, t.termination_date);

  perform private.post_run(r.id, t.termination_date, null);
  perform private.settle_provisions_termination(r.id, e.id, t.termination_date);

  perform private.enqueue_esocial(r.legal_entity_id, 'S-2299', 'hr.terminations', t.id, r.competence,
    jsonb_build_object('employee_id', e.id, 'kind', t.kind, 'notice_kind', t.notice_kind, 'termination_date', t.termination_date, 'gross', ps.gross, 'net', ps.net, 'fgts_fine', (t.computed ->> 'fgts_fine_pct')));
  perform private.enqueue_esocial(r.legal_entity_id, 'S-1200', 'hr.payslips', ps.id, r.competence,
    jsonb_build_object('employee_id', e.id, 'run_kind', 'TERMINATION', 'gross', ps.gross, 'net', ps.net));

  -- efeitos no cadastro
  update hr.employees set status = 'TERMINATED', termination_date = t.termination_date where id = e.id;
  delete from hr.roster where employee_id = e.id and work_date > t.termination_date;
  update hr.employee_benefits set end_date = t.termination_date where employee_id = e.id and (end_date is null or end_date > t.termination_date);
  update hr.employee_deductions set end_date = t.termination_date where employee_id = e.id and (end_date is null or end_date > t.termination_date);
  update hr.vacations set status = 'CANCELLED', notes = concat_ws(' · ', notes, 'Cancelada pela rescisão') where employee_id = e.id and status in ('PLANNED', 'APPROVED') and start_date > t.termination_date;
  update hr.vacation_periods set closed_reason = 'Rescisão em ' || to_char(t.termination_date, 'DD/MM/YYYY') where employee_id = e.id;

  update hr.payroll_runs set status = 'APPROVED', approved_by = private.member_id(), approved_at = now() where id = r.id;
  update hr.terminations set status = 'APPROVED', approved_by = private.member_id(), approved_at = now() where id = t.id returning * into t;
  return t;
end $$;

-- Cancelamento de folha aprovada (compartilhado com a rescisão)
create or replace function private.cancel_run_approved(p_run uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare r hr.payroll_runs; ent record;
begin
  select * into r from hr.payroll_runs where id = p_run for update;
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
  select org_id, employee_id, kind, competence, -amount, 'hr.payroll_runs', r.id from hr.provisions where source_type = 'hr.payroll_runs' and source_id = r.id and amount < 0;
  update fiscal.esocial_events set status = 'CANCELLED' where status = 'PENDING'
    and ((reference_type = 'hr.payslips' and reference_id in (select id from hr.payslips where run_id = r.id))
      or (reference_type = 'hr.terminations' and reference_id = r.reference_id));
  update comm.statements set status = 'APPROVED', payslip_id = null where payslip_id in (select id from hr.payslips where run_id = r.id);
  update hr.vacations set status = 'APPROVED', payslip_id = null where payslip_id in (select id from hr.payslips where run_id = r.id);
  update hr.payslips set status = 'CANCELLED' where run_id = r.id;
  update hr.payroll_runs set status = 'CANCELLED', notes = concat_ws(' · ', notes, 'Cancelada: ' || coalesce(p_reason, '—')) where id = r.id;
end $$;

create or replace function hr.cancel_run(p_run uuid, p_reason text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare r hr.payroll_runs;
begin
  perform private.require_perm('hr.payroll.approve');
  select * into r from hr.payroll_runs where id = p_run and org_id = coalesce(private.org_id(), org_id) for update;
  if r.id is null then raise exception 'Folha não encontrada'; end if;
  if r.status = 'CANCELLED' then return; end if;
  if r.kind = 'TERMINATION' then raise exception 'Cancele a rescisão pelo fluxo de rescisão' using errcode = 'P0053'; end if;
  if r.status in ('DRAFT', 'CALCULATED') then
    update hr.payslips set status = 'CANCELLED' where run_id = r.id;
    update hr.payroll_runs set status = 'CANCELLED', notes = concat_ws(' · ', notes, 'Cancelada: ' || coalesce(p_reason, '—')) where id = r.id;
    return;
  end if;
  perform private.cancel_run_approved(r.id, p_reason);
end $$;

create or replace function hr.cancel_termination(p_termination uuid, p_reason text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare t hr.terminations; r hr.payroll_runs;
begin
  perform private.require_perm('hr.payroll.approve');
  select * into t from hr.terminations where id = p_termination and org_id = coalesce(private.org_id(), org_id) for update;
  if t.id is null then raise exception 'Rescisão não encontrada'; end if;
  if t.status = 'CANCELLED' then return; end if;
  select * into r from hr.payroll_runs where id = t.run_id for update;
  if t.status in ('APPROVED', 'PAID') then
    perform private.cancel_run_approved(r.id, p_reason);
    update hr.employees set status = 'ACTIVE', termination_date = null where id = t.employee_id;
    update hr.vacation_periods set closed_reason = null where employee_id = t.employee_id;
  else
    update hr.payslips set status = 'CANCELLED' where run_id = r.id;
    update hr.payroll_runs set status = 'CANCELLED' where id = r.id;
  end if;
  update hr.terminations set status = 'CANCELLED', notes = concat_ws(' · ', notes, 'Cancelada: ' || coalesce(p_reason, '—')) where id = t.id;
end $$;

-- Rescisão paga quando todos os títulos do recibo forem quitados (o trigger da folha marca o recibo)
create or replace function private.sync_termination_paid() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'PAID' and old.status is distinct from 'PAID' and new.kind = 'TERMINATION' then
    update hr.terminations set status = 'PAID' where run_id = new.id and status = 'APPROVED';
  end if;
  return null;
end $$;
create trigger trg_termination_paid after update of status on hr.payroll_runs
  for each row execute function private.sync_termination_paid();

select private.attach_updated_at('hr');
select private.apply_rls('hr', array['terminations'], 'hr.payroll.read', 'hr.payroll.write');
select private.rpc_only('hr', array['terminations']);
create trigger trg_audit after insert or update or delete on hr.terminations for each row execute function private.audit_capture();
