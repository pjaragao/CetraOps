-- =====================================================================
-- hr (folha): catálogo de verbas, folhas por tipo (mensal, adiantamento, 13º, pró-labore, férias, rescisão),
-- recibos com linhas e motor de cálculo. A folha calculada aqui é PRÉVIA para conferência com o contador; o contador
-- também pode lançar/importar valores oficiais como linhas manuais. Contabilização, títulos e obrigações: hr_payroll_post.
-- =====================================================================

create table hr.payroll_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  code text not null,
  name text not null,
  kind text not null check (kind in ('EARNING', 'DEDUCTION', 'EMPLOYER')),
  inss boolean not null default false,                       -- integra a base do INSS
  irrf boolean not null default false,                       -- integra a base do IRRF
  fgts boolean not null default false,                       -- integra a base do FGTS
  vacation_avg boolean not null default false,               -- entra na média das variáveis (férias, 13º, rescisão)
  variable boolean not null default false,                   -- verba variável (base do DSR)
  expense_role text,                                         -- conta de despesa (papel contábil)
  liability_role text,                                       -- conta do passivo a recolher/pagar
  esocial_code text,
  active boolean not null default true,
  unique (org_id, code)
);

create table hr.payroll_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  legal_entity_id uuid not null references core.legal_entities(id),
  kind text not null check (kind in ('MONTHLY', 'ADVANCE', 'VACATION', 'THIRTEENTH_1', 'THIRTEENTH_2', 'TERMINATION', 'PROLABORE')),
  competence date not null check (competence = date_trunc('month', competence)::date),
  description text,
  pay_date date,
  status text not null default 'DRAFT' check (status in ('DRAFT', 'CALCULATED', 'APPROVED', 'PAID', 'CANCELLED')),
  source text not null default 'SYSTEM' check (source in ('SYSTEM', 'ACCOUNTANT_IMPORT')),
  reference_type text,
  reference_id uuid,
  totals jsonb not null default '{}',
  journal_entry_id uuid references fin.journal_entries(id),
  notes text,
  approved_by uuid references core.members(id),
  approved_at timestamptz,
  created_by uuid references core.members(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index payroll_runs_period_uq on hr.payroll_runs (legal_entity_id, kind, competence)
  where kind in ('MONTHLY', 'ADVANCE', 'THIRTEENTH_1', 'THIRTEENTH_2', 'PROLABORE') and status <> 'CANCELLED';
create unique index payroll_runs_ref_uq on hr.payroll_runs (kind, reference_id) where reference_id is not null and status <> 'CANCELLED';
create index on hr.payroll_runs (org_id, competence desc);

create table hr.payslips (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  run_id uuid not null references hr.payroll_runs(id) on delete cascade,
  employee_id uuid not null references hr.employees(id),
  base_group text not null default 'MONTH' check (base_group in ('MONTH', 'THIRTEENTH')),   -- teto do INSS separado para o 13º
  gross numeric(14,2) not null default 0,
  deductions numeric(14,2) not null default 0,
  net numeric(14,2) not null default 0,
  inss_base numeric(14,2) not null default 0,
  inss numeric(14,2) not null default 0,
  irrf_base numeric(14,2) not null default 0,
  irrf numeric(14,2) not null default 0,
  fgts_base numeric(14,2) not null default 0,
  fgts numeric(14,2) not null default 0,
  employer_cost numeric(14,2) not null default 0,
  dependents smallint not null default 0,
  title_id uuid references fin.titles(id),
  status text not null default 'DRAFT' check (status in ('DRAFT', 'APPROVED', 'PAID', 'CANCELLED')),
  notes text,
  unique (run_id, employee_id)
);
create index on hr.payslips (employee_id);

create table hr.payslip_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  payslip_id uuid not null references hr.payslips(id) on delete cascade,
  event_code text not null,
  description text not null,
  kind text not null check (kind in ('EARNING', 'DEDUCTION', 'EMPLOYER')),
  reference numeric(14,4),                                   -- dias, horas ou percentual
  amount numeric(14,2) not null check (amount > 0),
  source text not null default 'AUTO' check (source in ('AUTO', 'MANUAL', 'IMPORT')),
  supplier_party_id uuid references crm.parties(id),         -- fornecedor do benefício
  beneficiary_party_id uuid references crm.parties(id),      -- favorecido (pensão, consignado)
  memo text,
  created_at timestamptz not null default now()
);
create index on hr.payslip_lines (payslip_id);

-- Provisões (13º, férias + 1/3 e FGTS sobre elas) por colaborador: livro só-inserção
create table hr.provision_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  legal_entity_id uuid not null references core.legal_entities(id),
  competence date not null,
  totals jsonb not null default '{}',
  journal_entry_id uuid references fin.journal_entries(id),
  created_by uuid references core.members(id),
  created_at timestamptz not null default now(),
  unique (legal_entity_id, competence)
);
create table hr.provisions (
  id bigint generated always as identity primary key,
  org_id uuid not null references core.orgs(id),
  employee_id uuid not null references hr.employees(id),
  kind text not null check (kind in ('VACATION', 'THIRTEENTH', 'FGTS')),
  competence date not null,
  amount numeric(14,2) not null check (amount <> 0),         -- + provisiona · − consome
  source_type text,
  source_id uuid,
  created_at timestamptz not null default now()
);
create index on hr.provisions (employee_id, kind);
create trigger trg_provisions_immutable before update or delete on hr.provisions
  for each row execute function private.forbid_mutation();

alter table hr.vacations add constraint vacations_payslip_fk foreign key (payslip_id) references hr.payslips(id);
alter table comm.statements add constraint statements_payslip_fk foreign key (payslip_id) references hr.payslips(id);

-- ---------------------------------------------------------------------
-- Datas úteis (segunda a sábado, sem feriados) e vencimentos
-- ---------------------------------------------------------------------
create or replace function private.nth_business_day(p_org uuid, p_month date, p_n int) returns date
language plpgsql stable security definer set search_path = '' as $$
declare d date := date_trunc('month', p_month)::date; c int := 0;
begin
  loop
    if extract(dow from d) <> 0 and not private.is_holiday(p_org, d) then c := c + 1; end if;
    exit when c >= p_n;
    d := d + 1;
  end loop;
  return d;
end $$;

-- Vencimento no dia X do mês seguinte à competência, antecipado para o dia útil anterior se cair em fim de semana/feriado
create or replace function private.due_next_month(p_org uuid, p_competence date, p_day int default 20) returns date
language plpgsql stable security definer set search_path = '' as $$
declare d date := (date_trunc('month', p_competence) + interval '1 month')::date + (p_day - 1);
begin
  while extract(dow from d) in (0, 6) or private.is_holiday(p_org, d) loop d := d - 1; end loop;
  return d;
end $$;

-- ---------------------------------------------------------------------
-- Linhas do recibo
-- ---------------------------------------------------------------------
create or replace function private.add_line(
  p_ps uuid, p_code text, p_amount numeric, p_ref numeric default null, p_desc text default null,
  p_source text default 'AUTO', p_supplier uuid default null, p_beneficiary uuid default null, p_memo text default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare ps hr.payslips; ev hr.payroll_events;
begin
  if p_amount is null or round(p_amount, 2) <= 0 then return; end if;
  select * into ps from hr.payslips where id = p_ps;
  select * into ev from hr.payroll_events where org_id = ps.org_id and code = p_code;
  if ev.id is null then raise exception 'Verba % não cadastrada no catálogo da folha', p_code using errcode = 'P0050'; end if;
  insert into hr.payslip_lines (org_id, payslip_id, event_code, description, kind, reference, amount, source, supplier_party_id, beneficiary_party_id, memo)
  values (ps.org_id, ps.id, ev.code, coalesce(p_desc, ev.name), ev.kind, p_ref, round(p_amount, 2), p_source, p_supplier, p_beneficiary, p_memo);
end $$;

create or replace function private.recompute_payslip(p_ps uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare g numeric; d numeric; c numeric;
begin
  select coalesce(sum(amount) filter (where kind = 'EARNING'), 0), coalesce(sum(amount) filter (where kind = 'DEDUCTION'), 0),
         coalesce(sum(amount) filter (where kind = 'EMPLOYER'), 0)
    into g, d, c from hr.payslip_lines where payslip_id = p_ps;
  update hr.payslips set gross = g, deductions = d, net = g - d, employer_cost = c where id = p_ps;
end $$;

-- Média mensal das verbas variáveis (comissões, horas extras, adicional noturno...) para férias, 13º e rescisão
create or replace function private.variable_avg(p_employee uuid, p_from date, p_to date) returns numeric
language sql stable security definer set search_path = '' as $$
  with base as (
    select r.competence, l.amount
    from hr.payslip_lines l
    join hr.payslips p on p.id = l.payslip_id
    join hr.payroll_runs r on r.id = p.run_id
    join hr.payroll_events ev on ev.org_id = l.org_id and ev.code = l.event_code
    where p.employee_id = p_employee and r.kind = 'MONTHLY' and r.status in ('APPROVED', 'PAID') and l.kind = 'EARNING' and ev.vacation_avg
      and r.competence between date_trunc('month', p_from)::date and date_trunc('month', p_to)::date
  ), months as (
    select count(distinct r.competence) as n from hr.payslips p join hr.payroll_runs r on r.id = p.run_id
    where p.employee_id = p_employee and r.kind = 'MONTHLY' and r.status in ('APPROVED', 'PAID')
      and r.competence between date_trunc('month', p_from)::date and date_trunc('month', p_to)::date
  )
  select round(coalesce((select sum(amount) from base), 0) / greatest((select n from months), 1), 2)
$$;

-- Dias trabalháveis no mês para benefícios por dia (escala publicada ou regime contratual)
create or replace function private.benefit_days(p_employee uuid, p_from date, p_to date) returns int
language plpgsql stable security definer set search_path = '' as $$
declare e hr.employees; d date; n int := 0; has_roster boolean;
begin
  select * into e from hr.employees where id = p_employee;
  select exists (select 1 from hr.roster where employee_id = p_employee and work_date between p_from and p_to) into has_roster;
  for d in select g::date from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') g loop
    continue when d < e.hire_date or (e.termination_date is not null and d > e.termination_date);
    continue when private.on_vacation(e.id, d) or private.leave_overlap_days(e.id, d, d, 'ANY') > 0;
    if has_roster then
      if exists (select 1 from hr.roster where employee_id = p_employee and work_date = d and kind = 'WORK') then n := n + 1; end if;
    elsif e.work_regime = '6X1' then
      if extract(dow from d) <> 0 and not private.is_holiday(e.org_id, d, e.store_id) then n := n + 1; end if;
    elsif e.work_regime = '5X2' then
      if extract(dow from d) not in (0, 6) and not private.is_holiday(e.org_id, d, e.store_id) then n := n + 1; end if;
    elsif e.work_regime = '12X36' then
      if (d - p_from) % 2 = 0 then n := n + 1; end if;
    end if;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------------
-- Encargos do colaborador no recibo: INSS (acumulado no mês), pensão, IRRF, FGTS e encargos patronais por perfil
-- ---------------------------------------------------------------------
create or replace function private.apply_statutory(
  p_ps uuid, p_mode text default 'EMPLOYEE', p_fgts_base numeric default null, p_reducer boolean default true, p_recurring boolean default false
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  ps hr.payslips; r hr.payroll_runs; e hr.employees; es hr.entity_settings;
  comp_end date;
  v_base numeric; prior_base numeric; prior_inss numeric; v_inss numeric;
  v_gross numeric; v_taxable numeric; v_pension numeric := 0; v_irrf numeric; v_deps int;
  v_fgts_base numeric; v_fgts_rate numeric; v_fgts numeric := 0;
  ded record; v_amt numeric;
begin
  select * into ps from hr.payslips where id = p_ps;
  select * into r from hr.payroll_runs where id = ps.run_id;
  select * into e from hr.employees where id = ps.employee_id;
  select * into es from hr.entity_settings where legal_entity_id = r.legal_entity_id;
  comp_end := (r.competence + interval '1 month - 1 day')::date;

  -- estagiário: bolsa-auxílio sem INSS, IRRF (abaixo do limite) e FGTS
  if e.contract_type = 'ESTAGIO' then return; end if;

  -- INSS do colaborador (progressivo, acumulando com outros recibos do mesmo mês e mesmo grupo de base)
  select coalesce(sum(l.amount), 0) into v_base from hr.payslip_lines l
  join hr.payroll_events ev on ev.org_id = l.org_id and ev.code = l.event_code
  where l.payslip_id = ps.id and l.kind = 'EARNING' and ev.inss;
  select coalesce(sum(p2.inss_base), 0), coalesce(sum(p2.inss), 0) into prior_base, prior_inss
  from hr.payslips p2 join hr.payroll_runs r2 on r2.id = p2.run_id
  where p2.employee_id = ps.employee_id and p2.id <> ps.id and p2.base_group = ps.base_group and r2.competence = r.competence
    and r2.status in ('CALCULATED', 'APPROVED', 'PAID') and p2.status <> 'CANCELLED';
  if p_mode = 'PROLABORE' then
    v_inss := greatest(hr.calc_inss_prolabore(prior_base + v_base, comp_end) - prior_inss, 0);
  else
    v_inss := greatest(hr.calc_inss(prior_base + v_base, comp_end) - prior_inss, 0);
  end if;
  perform private.add_line(ps.id, 'INSS', v_inss, null, 'INSS');

  -- descontos recorrentes (pensão alimentícia, consignado): pensão reduz a base do IRRF
  select coalesce(sum(l.amount), 0) into v_gross from hr.payslip_lines l where l.payslip_id = ps.id and l.kind = 'EARNING';
  if p_recurring then
    for ded in select * from hr.employee_deductions d where d.employee_id = e.id and d.start_date <= comp_end
                 and (d.end_date is null or d.end_date >= r.competence) and (d.installments_left is null or d.installments_left > 0) loop
      v_amt := round(case ded.calc when 'PCT_NET' then (v_gross - v_inss) * ded.value / 100 else ded.value end, 2);
      perform private.add_line(ps.id, ded.event_code, v_amt, null, null, 'AUTO', null, ded.beneficiary_party_id);
      if ded.event_code = 'PENSAO' then v_pension := v_pension + v_amt; end if;
    end loop;
  end if;

  -- IRRF
  select coalesce(sum(l.amount), 0) into v_taxable from hr.payslip_lines l
  join hr.payroll_events ev on ev.org_id = l.org_id and ev.code = l.event_code
  where l.payslip_id = ps.id and l.kind = 'EARNING' and ev.irrf;
  select count(*)::int into v_deps from hr.dependents where employee_id = e.id and irrf;
  v_irrf := hr.calc_irrf(v_taxable, v_inss, v_deps, comp_end, v_pension, p_reducer);
  perform private.add_line(ps.id, 'IRRF', v_irrf, null, 'IRRF');

  -- FGTS (encargo do empregador)
  if e.fgts and e.contract_type in ('CLT', 'APRENDIZ', 'INTERMITENTE', 'TEMPORARIO') then
    select coalesce(sum(l.amount), 0) into v_fgts_base from hr.payslip_lines l
    join hr.payroll_events ev on ev.org_id = l.org_id and ev.code = l.event_code
    where l.payslip_id = ps.id and l.kind = 'EARNING' and ev.fgts;
    v_fgts_base := coalesce(p_fgts_base, v_fgts_base);
    v_fgts_rate := case e.contract_type when 'APRENDIZ' then (hr.tax_data('FGTS', comp_end) ->> 'apprentice_rate')::numeric else (hr.tax_data('FGTS', comp_end) ->> 'rate')::numeric end;
    v_fgts := round(v_fgts_base * v_fgts_rate / 100, 2);
    perform private.add_line(ps.id, 'FGTS_EMP', v_fgts, v_fgts_rate, 'FGTS ' || v_fgts_rate::text || '%');
  else
    v_fgts_base := 0;
  end if;

  -- contribuição patronal fora do Simples (regime geral / Anexo IV)
  if coalesce(es.charge_profile, 'SIMPLES') <> 'SIMPLES' and v_base > 0 then
    perform private.add_line(ps.id, 'INSS_PATRONAL', round(v_base * es.inss_employer_pct / 100, 2), es.inss_employer_pct);
    perform private.add_line(ps.id, 'RAT', round(v_base * es.rat_pct / 100, 2), es.rat_pct);
    if es.charge_profile = 'GENERAL' then
      perform private.add_line(ps.id, 'TERCEIROS', round(v_base * es.third_parties_pct / 100, 2), es.third_parties_pct);
    end if;
  end if;

  update hr.payslips set inss_base = v_base, inss = v_inss, irrf_base = v_taxable, irrf = v_irrf, fgts_base = coalesce(v_fgts_base, 0),
                         fgts = v_fgts, dependents = v_deps where id = ps.id;
end $$;

-- ---------------------------------------------------------------------
-- Folha MENSAL do colaborador
-- ---------------------------------------------------------------------
create or replace function private.calc_monthly(p_ps uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  ps hr.payslips; r hr.payroll_runs; e hr.employees;
  comp date; comp_end date;
  s numeric; hourly numeric;
  base_days numeric; vac_days int; unpaid int; inss_leave int; paid_days numeric;
  ts hr.timesheets; cal record;
  v_salary numeric; v_he50 numeric := 0; v_he100 numeric := 0; v_night numeric := 0; v_dsr numeric := 0;
  stm comm.statements; v_comm numeric := 0; v_comm_dsr numeric := 0;
  v_absence numeric := 0; v_dsr_lost numeric := 0; v_late numeric := 0;
  v_ot_pct numeric; v_hol_pct numeric; v_night_pct numeric;
  b record; v_cost numeric; v_share numeric; v_days int; v_code text; v_ded_code text; v_sal_full numeric;
  v_adv numeric; v_family numeric := 0; v_fam_data jsonb; v_kids int;
begin
  select * into ps from hr.payslips where id = p_ps;
  select * into r from hr.payroll_runs where id = ps.run_id;
  select * into e from hr.employees where id = ps.employee_id;
  comp := r.competence;
  comp_end := (comp + interval '1 month - 1 day')::date;
  s := private.monthly_salary(e.id, comp_end);
  if s is null then raise exception 'Colaborador % sem salário cadastrado', e.registration using errcode = 'P0051'; end if;
  hourly := round(s / (e.weekly_hours * 5), 4);

  -- dias remunerados (base comercial de 30 dias)
  base_days := 30;
  if e.hire_date > comp then base_days := greatest(1, 30 - (least(extract(day from e.hire_date)::int, 30) - 1)); end if;
  vac_days := private.vacation_overlap_days(e.id, comp, comp_end);
  unpaid := private.leave_overlap_days(e.id, comp, comp_end, 'UNPAID');
  inss_leave := private.leave_overlap_days(e.id, comp, comp_end, 'INSS');
  paid_days := greatest(0, base_days - vac_days - unpaid - inss_leave);
  v_salary := round(s / 30 * paid_days, 2);
  perform private.add_line(ps.id, 'SALARIO', v_salary, paid_days, 'Salário (' || paid_days::int::text || ' dias)');

  -- ponto do mês (se fechado)
  select * into ts from hr.timesheets where employee_id = e.id and competence = comp and status = 'CLOSED';
  select * into cal from private.month_calendar(e.org_id, comp, e.store_id);
  v_ot_pct := private.hr_policy(e.org_id, 'ot_weekday_pct', 50);
  v_hol_pct := private.hr_policy(e.org_id, 'ot_holiday_pct', 100);
  v_night_pct := private.hr_policy(e.org_id, 'night_pct', 20);
  if ts.id is not null then
    v_he50 := round(ts.ot50_min / 60.0 * hourly * (1 + v_ot_pct / 100), 2);
    v_he100 := round(ts.ot100_min / 60.0 * hourly * (1 + v_hol_pct / 100), 2);
    v_night := round(ts.night_min / 60.0 * hourly * v_night_pct / 100, 2);
    perform private.add_line(ps.id, 'HE50', v_he50, round(ts.ot50_min / 60.0, 2), 'Horas extras ' || v_ot_pct::int::text || '%');
    perform private.add_line(ps.id, 'HE100', v_he100, round(ts.ot100_min / 60.0, 2), 'Horas em domingo/feriado ' || v_hol_pct::int::text || '%');
    perform private.add_line(ps.id, 'ADIC_NOT', v_night, round(ts.night_min / 60.0, 2), 'Adicional noturno');
    if private.hr_policy(e.org_id, 'dsr_on_variable', 1) = 1 and cal.work_days > 0 then
      v_dsr := round((v_he50 + v_he100 + v_night) / cal.work_days * cal.rest_days, 2);
      perform private.add_line(ps.id, 'DSR_VAR', v_dsr, null, 'DSR sobre horas extras e adicionais');
    end if;
    v_absence := round(s / 30 * ts.absence_days, 2);
    v_dsr_lost := round(s / 30 * ts.dsr_lost_days, 2);
    v_late := round(ts.late_min / 60.0 * hourly, 2);
    perform private.add_line(ps.id, 'FALTAS', v_absence, ts.absence_days, 'Faltas injustificadas');
    perform private.add_line(ps.id, 'DSR_FALTAS', v_dsr_lost, ts.dsr_lost_days, 'DSR perdido por faltas');
    perform private.add_line(ps.id, 'ATRASOS', v_late, round(ts.late_min / 60.0, 2), 'Atrasos');
  end if;

  -- comissão aprovada do mês (+ DSR)
  if e.commissioned and e.member_id is not null then
    select * into stm from comm.statements where member_id = e.member_id and competence = comp and status = 'APPROVED';
    if stm.id is not null then
      v_comm := stm.total;
      perform private.add_line(ps.id, 'COMISSAO', v_comm, null, 'Comissões e bônus de vendas');
      if cal.work_days > 0 then
        v_comm_dsr := round(v_comm / cal.work_days * cal.rest_days, 2);
        perform private.add_line(ps.id, 'DSR_COM', v_comm_dsr, null, 'DSR sobre comissões');
      end if;
    end if;
  end if;

  -- salário-família
  v_fam_data := hr.tax_data('FAMILY_ALLOWANCE', comp_end);
  if v_fam_data is not null and (v_salary + v_he50 + v_he100 + v_night + v_dsr + v_comm + v_comm_dsr) <= (v_fam_data ->> 'limit')::numeric then
    select count(*)::int into v_kids from hr.dependents where employee_id = e.id and family_allowance;
    v_family := round(v_kids * (v_fam_data ->> 'quota')::numeric, 2);
    perform private.add_line(ps.id, 'SAL_FAMILIA', v_family, v_kids, 'Salário-família');
  end if;

  -- benefícios: custo da empresa e desconto do colaborador
  for b in
    select eb.value, eb.share_pct_override, bt.name, bt.kind as bkind, bt.calc, bt.employee_share_pct, bt.share_base, bt.employee_share_fixed, bt.supplier_party_id
    from hr.employee_benefits eb join hr.benefit_types bt on bt.id = eb.benefit_type_id
    where eb.employee_id = e.id and bt.active and eb.start_date <= comp_end and (eb.end_date is null or eb.end_date >= comp)
  loop
    v_days := 0;
    if b.calc = 'DAILY' then
      v_days := private.benefit_days(e.id, comp, comp_end);
      v_cost := round(b.value * v_days, 2);
    elsif b.calc = 'PCT_SALARY' then
      v_cost := round(s * b.value / 100, 2);
    else
      v_cost := round(b.value * least(paid_days + vac_days, 30) / 30, 2);
    end if;
    v_sal_full := round(s / 30 * paid_days, 2);
    if b.share_base = 'SALARY' then
      v_share := least(v_cost, round(v_sal_full * coalesce(b.share_pct_override, b.employee_share_pct) / 100, 2));
    else
      v_share := round(v_cost * coalesce(b.share_pct_override, b.employee_share_pct) / 100 + b.employee_share_fixed, 2);
    end if;
    v_code := case when b.bkind = 'TRANSPORT' then 'BEN_VT' when b.bkind in ('MEAL', 'FOOD') then 'BEN_VR'
                   when b.bkind in ('HEALTH', 'DENTAL', 'LIFE') then 'BEN_SAUDE' else 'BEN_OUTROS' end;
    v_ded_code := case when b.bkind = 'TRANSPORT' then 'DESC_VT' when b.bkind in ('MEAL', 'FOOD') then 'DESC_VR'
                       when b.bkind in ('HEALTH', 'DENTAL', 'LIFE') then 'DESC_SAUDE' else 'DESC_BEN' end;
    perform private.add_line(ps.id, v_code, v_cost, v_days, b.name, 'AUTO', b.supplier_party_id);
    perform private.add_line(ps.id, v_ded_code, least(v_share, v_cost), null, 'Desconto ' || b.name);
  end loop;

  -- adiantamento salarial já pago no mês
  select coalesce(sum(p2.gross), 0) into v_adv from hr.payslips p2 join hr.payroll_runs r2 on r2.id = p2.run_id
  where p2.employee_id = e.id and r2.kind = 'ADVANCE' and r2.competence = comp and r2.status in ('APPROVED', 'PAID') and p2.status <> 'CANCELLED';
  perform private.add_line(ps.id, 'ADIANT', v_adv, null, 'Adiantamento salarial');

  perform private.apply_statutory(ps.id, 'EMPLOYEE', null, true, true);
end $$;

-- ---------------------------------------------------------------------
-- Adiantamento (vale) · Pró-labore · 13º · Recibo de férias
-- ---------------------------------------------------------------------
create or replace function private.calc_advance(p_ps uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare ps hr.payslips; r hr.payroll_runs; e hr.employees; s numeric; pct numeric;
begin
  select * into ps from hr.payslips where id = p_ps;
  select * into r from hr.payroll_runs where id = ps.run_id;
  select * into e from hr.employees where id = ps.employee_id;
  s := private.monthly_salary(e.id, (r.competence + interval '1 month - 1 day')::date);
  pct := private.hr_policy(e.org_id, 'advance_pct', 40);
  perform private.add_line(ps.id, 'ADIANTAMENTO', round(s * pct / 100, 2), pct, 'Adiantamento salarial ' || pct::int::text || '%');
end $$;

create or replace function private.calc_prolabore(p_ps uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare ps hr.payslips; r hr.payroll_runs; e hr.employees; s numeric;
begin
  select * into ps from hr.payslips where id = p_ps;
  select * into r from hr.payroll_runs where id = ps.run_id;
  select * into e from hr.employees where id = ps.employee_id;
  s := private.monthly_salary(e.id, (r.competence + interval '1 month - 1 day')::date);
  perform private.add_line(ps.id, 'PROLABORE', s, null, 'Pró-labore');
  perform private.apply_statutory(ps.id, 'PROLABORE', null, true, false);
end $$;

-- Meses avos do ano com 15 ou mais dias trabalhados até a data de corte
create or replace function private.avos(p_employee uuid, p_year int, p_until date) returns int
language plpgsql stable security definer set search_path = '' as $$
declare e hr.employees; m int; n int := 0; a date; b date; d_from date; d_to date;
begin
  select * into e from hr.employees where id = p_employee;
  for m in 1 .. 12 loop
    a := make_date(p_year, m, 1);
    b := (a + interval '1 month - 1 day')::date;
    exit when a > p_until;
    d_from := greatest(a, e.hire_date);
    d_to := least(b, p_until, coalesce(e.termination_date, b));
    if d_to >= d_from and (d_to - d_from + 1) >= 15 then n := n + 1; end if;
  end loop;
  return n;
end $$;

create or replace function private.calc_thirteenth(p_ps uuid, p_second boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare
  ps hr.payslips; r hr.payroll_runs; e hr.employees;
  y int; cutoff date; s numeric; v_avos int; v_var numeric; total numeric; first_paid numeric; first_amt numeric; comp_end date;
begin
  select * into ps from hr.payslips where id = p_ps;
  select * into r from hr.payroll_runs where id = ps.run_id;
  select * into e from hr.employees where id = ps.employee_id;
  y := extract(year from r.competence)::int;
  comp_end := (r.competence + interval '1 month - 1 day')::date;
  cutoff := case when p_second then make_date(y, 12, 31) else comp_end end;
  s := private.monthly_salary(e.id, cutoff);
  v_avos := private.avos(e.id, y, cutoff);
  v_var := private.variable_avg(e.id, make_date(y, 1, 1), cutoff);
  total := round((s + v_var) / 12 * v_avos, 2);
  if not p_second then
    first_amt := round(total * 0.5, 2);
    perform private.add_line(ps.id, 'DEC_TERCEIRO_1', first_amt, v_avos, '13º salário — 1ª parcela (' || v_avos::text || '/12)');
    perform private.apply_statutory(ps.id, 'EMPLOYEE', first_amt, false, false);
    -- a 1ª parcela não sofre INSS/IRRF: zera as linhas de imposto geradas sobre base vazia
    delete from hr.payslip_lines where payslip_id = ps.id and event_code in ('INSS', 'IRRF');
  else
    select coalesce(sum(p2.gross), 0) into first_paid from hr.payslips p2 join hr.payroll_runs r2 on r2.id = p2.run_id
    where p2.employee_id = e.id and r2.kind = 'THIRTEENTH_1' and extract(year from r2.competence) = y and r2.status in ('APPROVED', 'PAID') and p2.status <> 'CANCELLED';
    -- adiantamentos de 13º concedidos nas férias
    first_paid := first_paid + coalesce((select sum(l.amount) from hr.payslip_lines l join hr.payslips p3 on p3.id = l.payslip_id join hr.payroll_runs r3 on r3.id = p3.run_id
                                         where p3.employee_id = e.id and l.event_code = 'ADIANT_13_FER' and extract(year from r3.competence) = y
                                           and r3.status in ('APPROVED', 'PAID') and p3.status <> 'CANCELLED'), 0);
    perform private.add_line(ps.id, 'DEC_TERCEIRO_2', total, v_avos, '13º salário integral (' || v_avos::text || '/12)');
    perform private.add_line(ps.id, 'DESC_13_ANT', least(first_paid, total), null, '(−) 1ª parcela / adiantamento já pago');
    perform private.apply_statutory(ps.id, 'EMPLOYEE', greatest(total - first_paid, 0), private.hr_policy(e.org_id, 'irrf_reducer_13th', 1) = 1, false);
  end if;
end $$;

-- Recibo de férias: gozo + 1/3 (tributáveis), abono + 1/3 (indenizatório), adiantamento do 13º e dobra legal
create or replace function private.calc_vacation_payslip(p_ps uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  ps hr.payslips; r hr.payroll_runs; e hr.employees; v hr.vacations;
  s numeric; v_var numeric; base numeric; gozo numeric; terco numeric; abono numeric; abono_terco numeric; adv13 numeric;
begin
  select * into ps from hr.payslips where id = p_ps;
  select * into r from hr.payroll_runs where id = ps.run_id;
  select * into e from hr.employees where id = ps.employee_id;
  select * into v from hr.vacations where id = r.reference_id;
  s := private.monthly_salary(e.id, v.start_date);
  v_var := private.variable_avg(e.id, (v.start_date - interval '12 months')::date, (v.start_date - interval '1 month')::date);
  base := s + v_var;
  gozo := round(base / 30 * v.days, 2);
  terco := round(gozo / 3, 2);
  perform private.add_line(ps.id, 'FERIAS', gozo, v.days, 'Férias gozadas (' || v.days::text || ' dias)');
  perform private.add_line(ps.id, 'FERIAS_1_3', terco, null, '1/3 constitucional de férias');
  if v.sell_days > 0 then
    abono := round(base / 30 * v.sell_days, 2);
    abono_terco := round(abono / 3, 2);
    perform private.add_line(ps.id, 'ABONO_FERIAS', abono, v.sell_days, 'Abono pecuniário (' || v.sell_days::text || ' dias)');
    perform private.add_line(ps.id, 'ABONO_1_3', abono_terco, null, '1/3 sobre o abono pecuniário');
  end if;
  if v.thirteenth_advance then
    adv13 := round(base / 2, 2);
    perform private.add_line(ps.id, 'ADIANT_13_FER', adv13, null, 'Adiantamento da 1ª parcela do 13º');
  end if;
  if v.double_pay then
    perform private.add_line(ps.id, 'FERIAS_DOBRA', gozo + terco, null, 'Dobra legal das férias (art. 137 CLT)');
  end if;
  perform private.apply_statutory(ps.id, 'EMPLOYEE', null, true, false);
end $$;

-- Despachante por tipo de folha
create or replace function private.calc_payslip(p_ps uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare ps hr.payslips; r hr.payroll_runs;
begin
  select * into ps from hr.payslips where id = p_ps;
  select * into r from hr.payroll_runs where id = ps.run_id;
  delete from hr.payslip_lines where payslip_id = ps.id and source = 'AUTO';
  if r.kind = 'MONTHLY' then perform private.calc_monthly(ps.id);
  elsif r.kind = 'ADVANCE' then perform private.calc_advance(ps.id);
  elsif r.kind = 'PROLABORE' then perform private.calc_prolabore(ps.id);
  elsif r.kind = 'THIRTEENTH_1' then perform private.calc_thirteenth(ps.id, false);
  elsif r.kind = 'THIRTEENTH_2' then perform private.calc_thirteenth(ps.id, true);
  elsif r.kind = 'VACATION' then perform private.calc_vacation_payslip(ps.id);
  elsif r.kind = 'TERMINATION' then perform private.calc_termination_payslip(ps.id);
  end if;
  perform private.recompute_payslip(ps.id);
end $$;

-- ---------------------------------------------------------------------
-- Criar e calcular a folha
-- p = {legal_entity_id, kind, competence, pay_date?, description?, employee_ids?}
-- ---------------------------------------------------------------------
create or replace function hr.create_run(p jsonb) returns hr.payroll_runs
language plpgsql security definer set search_path = '' as $$
declare
  r hr.payroll_runs;
  v_org uuid;
  v_kind text := p ->> 'kind';
  comp date := date_trunc('month', (p ->> 'competence')::date)::date;
  comp_end date := (date_trunc('month', (p ->> 'competence')::date) + interval '1 month - 1 day')::date;
  v_pay date;
  v_types text[];
  v_ids uuid[] := case when p ? 'employee_ids' then array(select jsonb_array_elements_text(p -> 'employee_ids')::uuid) else null end;
begin
  perform private.require_perm('hr.payroll.write');
  select org_id into v_org from core.legal_entities where id = (p ->> 'legal_entity_id')::uuid and org_id = coalesce(private.org_id(), org_id);
  if v_org is null then raise exception 'Empresa inválida'; end if;
  if v_kind not in ('MONTHLY', 'ADVANCE', 'THIRTEENTH_1', 'THIRTEENTH_2', 'PROLABORE') then
    raise exception 'Tipo de folha inválido (férias e rescisão são geradas pelos seus fluxos)';
  end if;
  if exists (select 1 from hr.payroll_runs where legal_entity_id = (p ->> 'legal_entity_id')::uuid and kind = v_kind and competence = comp and status <> 'CANCELLED') then
    raise exception 'Já existe folha % para %', v_kind, to_char(comp, 'MM/YYYY') using errcode = 'P0052';
  end if;
  perform private.assert_period_open((p ->> 'legal_entity_id')::uuid, comp_end);

  v_pay := coalesce((p ->> 'pay_date')::date, case v_kind
    when 'ADVANCE' then private.due_next_month(v_org, (comp - interval '1 month')::date, 20)
    when 'THIRTEENTH_1' then (make_date(extract(year from comp)::int, 11, 30))
    when 'THIRTEENTH_2' then private.due_next_month(v_org, make_date(extract(year from comp)::int, 11, 1), 20)
    else private.nth_business_day(v_org, (comp + interval '1 month')::date, coalesce((select pay_business_day from hr.entity_settings where legal_entity_id = (p ->> 'legal_entity_id')::uuid), 5)) end);

  insert into hr.payroll_runs (org_id, legal_entity_id, kind, competence, description, pay_date, created_by)
  values (v_org, (p ->> 'legal_entity_id')::uuid, v_kind, comp,
          coalesce(p ->> 'description', case v_kind when 'MONTHLY' then 'Folha de ' when 'ADVANCE' then 'Adiantamento de ' when 'PROLABORE' then 'Pró-labore de '
            when 'THIRTEENTH_1' then '13º salário (1ª parcela) de ' else '13º salário (2ª parcela) de ' end || to_char(comp, 'MM/YYYY')),
          v_pay, private.member_id())
  returning * into r;

  v_types := case v_kind when 'PROLABORE' then array['PRO_LABORE']
                         when 'MONTHLY' then array['CLT', 'ESTAGIO', 'APRENDIZ', 'INTERMITENTE', 'TEMPORARIO']
                         when 'ADVANCE' then array['CLT', 'APRENDIZ', 'INTERMITENTE', 'TEMPORARIO']
                         else array['CLT', 'APRENDIZ', 'INTERMITENTE', 'TEMPORARIO'] end;
  insert into hr.payslips (org_id, run_id, employee_id, base_group, status)
  select e.org_id, r.id, e.id, case when v_kind like 'THIRTEENTH%' then 'THIRTEENTH' else 'MONTH' end, 'DRAFT'
  from hr.employees e
  where e.legal_entity_id = r.legal_entity_id and e.status = 'ACTIVE' and e.contract_type = any (v_types)
    and e.hire_date <= comp_end and (e.termination_date is null or e.termination_date > comp_end)
    and (v_ids is null or e.id = any (v_ids));
  return r;
end $$;

create or replace function hr.calc_run(p_run uuid) returns hr.payroll_runs
language plpgsql security definer set search_path = '' as $$
declare r hr.payroll_runs; ps record; v_missing text[] := '{}'; v_tot record;
begin
  perform private.require_perm('hr.payroll.write');
  select * into r from hr.payroll_runs where id = p_run and org_id = coalesce(private.org_id(), org_id) for update;
  if r.id is null then raise exception 'Folha não encontrada'; end if;
  if r.status not in ('DRAFT', 'CALCULATED') then raise exception 'Folha % não pode ser recalculada', r.status using errcode = 'P0053'; end if;
  for ps in select p.id, e.registration, e.id as eid from hr.payslips p join hr.employees e on e.id = p.employee_id where p.run_id = r.id and p.status <> 'CANCELLED' order by e.registration loop
    perform private.calc_payslip(ps.id);
    if r.kind = 'MONTHLY' and not exists (select 1 from hr.timesheets t where t.employee_id = ps.eid and t.competence = r.competence and t.status = 'CLOSED') then
      v_missing := array_append(v_missing, ps.registration);
    end if;
  end loop;
  select count(*) as n, coalesce(sum(gross), 0) as gross, coalesce(sum(deductions), 0) as ded, coalesce(sum(net), 0) as net,
         coalesce(sum(inss), 0) as inss, coalesce(sum(irrf), 0) as irrf, coalesce(sum(fgts), 0) as fgts, coalesce(sum(employer_cost), 0) as employer
    into v_tot from hr.payslips where run_id = r.id and status <> 'CANCELLED';
  update hr.payroll_runs set status = 'CALCULATED', updated_at = now(),
    totals = jsonb_build_object('payslips', v_tot.n, 'gross', v_tot.gross, 'deductions', v_tot.ded, 'net', v_tot.net, 'inss', v_tot.inss,
                                'irrf', v_tot.irrf, 'fgts', v_tot.fgts, 'employer_cost', v_tot.employer, 'without_timesheet', to_jsonb(v_missing))
  where id = r.id returning * into r;
  return r;
end $$;

-- Verba manual (bônus, ajuda de custo, desconto avulso, valores do contador). Vale até o recálculo; recálculo mantém as manuais.
create or replace function hr.add_manual_line(p_payslip uuid, p_code text, p_amount numeric, p_desc text default null, p_source text default 'MANUAL') returns void
language plpgsql security definer set search_path = '' as $$
declare ps hr.payslips; r hr.payroll_runs;
begin
  perform private.require_perm('hr.payroll.write');
  select * into ps from hr.payslips where id = p_payslip and org_id = coalesce(private.org_id(), org_id);
  if ps.id is null then raise exception 'Recibo não encontrado'; end if;
  select * into r from hr.payroll_runs where id = ps.run_id;
  if r.status not in ('DRAFT', 'CALCULATED') then raise exception 'Folha já aprovada: estorne para alterar' using errcode = 'P0053'; end if;
  if p_source not in ('MANUAL', 'IMPORT') then raise exception 'Origem inválida'; end if;
  perform private.add_line(ps.id, p_code, p_amount, null, p_desc, p_source);
  perform private.recompute_payslip(ps.id);
  update hr.payroll_runs set status = 'DRAFT' where id = r.id and status = 'CALCULATED';   -- força novo cálculo dos impostos
end $$;

create or replace function hr.remove_line(p_line uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare l hr.payslip_lines; ps hr.payslips; r hr.payroll_runs;
begin
  perform private.require_perm('hr.payroll.write');
  select * into l from hr.payslip_lines where id = p_line and org_id = coalesce(private.org_id(), org_id);
  if l.id is null then raise exception 'Linha não encontrada'; end if;
  select * into ps from hr.payslips where id = l.payslip_id;
  select * into r from hr.payroll_runs where id = ps.run_id;
  if r.status not in ('DRAFT', 'CALCULATED') then raise exception 'Folha já aprovada: estorne para alterar' using errcode = 'P0053'; end if;
  delete from hr.payslip_lines where id = l.id;
  perform private.recompute_payslip(ps.id);
  update hr.payroll_runs set status = 'DRAFT' where id = r.id and status = 'CALCULATED';
end $$;

-- ---------------------------------------------------------------------
-- Segurança
-- ---------------------------------------------------------------------
select private.attach_updated_at('hr');
select private.apply_rls('hr', array['payroll_events', 'payroll_runs', 'payslips', 'payslip_lines', 'provision_runs', 'provisions'], 'hr.payroll.read', 'hr.payroll.write');
select private.rpc_only('hr', array['payroll_runs', 'payslips', 'payslip_lines', 'provision_runs', 'provisions']);
create trigger trg_audit after insert or update or delete on hr.payroll_runs for each row execute function private.audit_capture();
