-- =====================================================================
-- hr (escala e ponto): turnos, escala mensal por loja, cobertura dos picos, validações da CLT (descanso de 11h,
-- 6 dias seguidos, intervalo, jornada), ponto (opcional), banco de horas e espelho de ponto mensal que alimenta a folha:
-- horas extras 50%/100%, adicional noturno (hora reduzida de 52'30''), faltas, atrasos e DSR perdido.
-- =====================================================================

-- Parâmetros de RH por organização (core.settings 'hr_policies'), com padrão
create or replace function private.hr_policy(p_org uuid, p_key text, p_default numeric) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce((select (s.value ->> p_key)::numeric from core.settings s where s.org_id = p_org and s.key = 'hr_policies'), p_default)
$$;

create or replace function private.span_minutes(s time, e time) returns int
language sql immutable as $$
  select case when e > s then (extract(epoch from (e - s)) / 60)::int
              when e < s then (extract(epoch from (e - s)) / 60)::int + 1440
              else 0 end
$$;

-- Minutos dentro da faixa noturna (22h–5h), sem a redução da hora
create or replace function private.night_minutes(s time, e time) returns int
language plpgsql immutable as $$
declare a int := extract(hour from s) * 60 + extract(minute from s); b int; n int;
begin
  b := a + private.span_minutes(s, e);
  n := greatest(0, least(b, 300) - greatest(a, 0))
     + greatest(0, least(b, 1740) - greatest(a, 1320))
     + greatest(0, least(b, 3180) - greatest(a, 2760));
  return n;
end $$;

-- Dias úteis (segunda a sábado, sem feriados) e dias de descanso (domingos + feriados) do mês — base do DSR
create or replace function private.month_calendar(p_org uuid, p_month date, p_store uuid default null) returns table (work_days int, rest_days int)
language plpgsql stable security definer set search_path = '' as $$
declare d date; m0 date := date_trunc('month', p_month)::date; m1 date := (date_trunc('month', p_month) + interval '1 month - 1 day')::date; w int := 0; r int := 0;
begin
  for d in select g::date from generate_series(m0::timestamp, m1::timestamp, interval '1 day') g loop
    if extract(dow from d) = 0 or private.is_holiday(p_org, d, p_store) then r := r + 1; else w := w + 1; end if;
  end loop;
  work_days := w; rest_days := r; return next;
end $$;

-- ---------------------------------------------------------------------
-- Turnos, escala e cobertura
-- ---------------------------------------------------------------------
create table hr.shift_templates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  store_id uuid references core.stores(id),
  code text not null,
  name text not null,
  start_time time not null,
  end_time time not null,
  break_minutes int not null default 60 check (break_minutes >= 0),
  color text not null default '#8a7fb0',
  active boolean not null default true,
  unique (org_id, code)
);

create table hr.roster (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  employee_id uuid not null references hr.employees(id) on delete cascade,
  store_id uuid not null references core.stores(id),
  work_date date not null,
  kind text not null default 'WORK' check (kind in ('WORK', 'DAY_OFF', 'COMP_TIME')),
  shift_id uuid references hr.shift_templates(id),
  start_time time,
  end_time time,
  break_minutes int not null default 0,
  status text not null default 'DRAFT' check (status in ('DRAFT', 'PUBLISHED')),
  notes text,
  updated_by uuid references core.members(id),
  updated_at timestamptz not null default now(),
  unique (employee_id, work_date),
  check (kind <> 'WORK' or (start_time is not null and end_time is not null))
);
create index on hr.roster (store_id, work_date);

-- Janelas que precisam de gente na loja (ex.: picos 07:00–09:30 e 17:30–20:00)
create table hr.coverage_rules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  store_id uuid not null references core.stores(id),
  weekday smallint not null check (weekday between 0 and 6),   -- 0 = domingo
  label text not null,
  start_time time not null,
  end_time time not null,
  min_staff smallint not null default 1 check (min_staff >= 1)
);

-- Ponto (opcional): um registro por dia com a jornada realizada
create table hr.time_entries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  employee_id uuid not null references hr.employees(id) on delete cascade,
  work_date date not null,
  start_time time not null,
  end_time time not null,
  break_minutes int not null default 0,
  source text not null default 'MANUAL' check (source in ('MANUAL', 'IMPORT', 'APP')),
  approved boolean not null default false,
  notes text,
  unique (employee_id, work_date)
);

-- Banco de horas: livro só-inserção
create table hr.time_bank (
  id bigint generated always as identity primary key,
  org_id uuid not null references core.orgs(id),
  employee_id uuid not null references hr.employees(id) on delete cascade,
  occurred_on date not null,
  minutes int not null check (minutes <> 0),
  kind text not null check (kind in ('OVERTIME', 'COMPENSATION', 'PAYOUT', 'EXPIRY', 'ADJUSTMENT')),
  source_type text,
  source_id uuid,
  note text,
  created_by uuid references core.members(id),
  created_at timestamptz not null default now()
);
create index on hr.time_bank (employee_id, occurred_on);
create trigger trg_time_bank_immutable before update or delete on hr.time_bank
  for each row execute function private.forbid_mutation();

create table hr.timesheets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  employee_id uuid not null references hr.employees(id) on delete cascade,
  competence date not null check (competence = date_trunc('month', competence)::date),
  regular_min int not null default 0,
  ot50_min int not null default 0,
  ot100_min int not null default 0,
  night_min int not null default 0,                           -- já com a hora reduzida (52'30'')
  absence_days int not null default 0,
  late_min int not null default 0,
  dsr_lost_days int not null default 0,
  bank_delta_min int not null default 0,
  status text not null default 'OPEN' check (status in ('OPEN', 'CLOSED')),
  closed_by uuid references core.members(id),
  closed_at timestamptz,
  detail jsonb not null default '{}',
  unique (employee_id, competence)
);

-- ---------------------------------------------------------------------
-- Edição da escala
-- ---------------------------------------------------------------------
create or replace function hr.set_roster_cell(p_employee uuid, p_date date, p_kind text, p_shift uuid default null) returns hr.roster
language plpgsql security definer set search_path = '' as $$
declare e hr.employees; sh hr.shift_templates; r hr.roster;
begin
  perform private.require_perm('hr.write');
  select * into e from hr.employees where id = p_employee and org_id = coalesce(private.org_id(), org_id) and status = 'ACTIVE';
  if e.id is null then raise exception 'Colaborador não encontrado ou desligado'; end if;
  if e.store_id is null or (coalesce(auth.role(), '') = 'authenticated' and not private.can_store(e.store_id)) then
    raise exception 'Sem acesso à loja do colaborador' using errcode = '42501';
  end if;
  if p_date < e.hire_date then raise exception 'Data anterior à admissão'; end if;
  if p_kind = 'CLEAR' then
    delete from hr.roster where employee_id = e.id and work_date = p_date;
    return null;
  end if;
  if p_kind = 'WORK' then
    select * into sh from hr.shift_templates where id = p_shift and org_id = e.org_id and active;
    if sh.id is null then raise exception 'Turno inválido'; end if;
    if private.on_vacation(e.id, p_date) or private.leave_overlap_days(e.id, p_date, p_date, 'ANY') > 0 then
      raise exception 'O colaborador está de férias ou afastado nesse dia' using errcode = 'P0045';
    end if;
  end if;
  insert into hr.roster (org_id, employee_id, store_id, work_date, kind, shift_id, start_time, end_time, break_minutes, status, updated_by)
  values (e.org_id, e.id, e.store_id, p_date, p_kind, sh.id, sh.start_time, sh.end_time, coalesce(sh.break_minutes, 0), 'DRAFT', private.member_id())
  on conflict (employee_id, work_date) do update set kind = excluded.kind, shift_id = excluded.shift_id, start_time = excluded.start_time,
    end_time = excluded.end_time, break_minutes = excluded.break_minutes, status = 'DRAFT', updated_by = excluded.updated_by, updated_at = now()
  returning * into r;
  return r;
end $$;

-- Copia um trecho da escala para outra data (repetir a semana modelo)
create or replace function hr.copy_roster(p_store uuid, p_source_from date, p_days int, p_target_from date) returns int
language plpgsql security definer set search_path = '' as $$
declare n int; v_off int := p_target_from - p_source_from;
begin
  perform private.require_perm('hr.write');
  if not exists (select 1 from core.stores where id = p_store and org_id = private.org_id()) or not private.can_store(p_store) then
    raise exception 'Loja inválida' using errcode = '42501';
  end if;
  with src as (
    select r.* from hr.roster r join hr.employees e on e.id = r.employee_id
    where r.store_id = p_store and e.status = 'ACTIVE' and r.work_date between p_source_from and p_source_from + p_days - 1
  ), ins as (
    insert into hr.roster (org_id, employee_id, store_id, work_date, kind, shift_id, start_time, end_time, break_minutes, status, updated_by)
    select s.org_id, s.employee_id, s.store_id, s.work_date + v_off, s.kind, s.shift_id, s.start_time, s.end_time, s.break_minutes, 'DRAFT', private.member_id()
    from src s
    where not private.on_vacation(s.employee_id, s.work_date + v_off) and private.leave_overlap_days(s.employee_id, s.work_date + v_off, s.work_date + v_off, 'ANY') = 0
    on conflict (employee_id, work_date) do update set kind = excluded.kind, shift_id = excluded.shift_id, start_time = excluded.start_time,
      end_time = excluded.end_time, break_minutes = excluded.break_minutes, status = 'DRAFT', updated_at = now()
    returning 1
  )
  select count(*)::int into n from ins;
  return n;
end $$;

create or replace function hr.publish_roster(p_store uuid, p_from date, p_to date) returns int
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  perform private.require_perm('hr.write');
  if not exists (select 1 from core.stores where id = p_store and org_id = private.org_id()) or not private.can_store(p_store) then
    raise exception 'Loja inválida' using errcode = '42501';
  end if;
  if exists (select 1 from hr.validate_roster(p_store, p_from, p_to) v where v.severity = 'ERROR') then
    raise exception 'A escala tem erros de conformidade: corrija antes de publicar' using errcode = 'P0047';
  end if;
  update hr.roster set status = 'PUBLISHED' where store_id = p_store and work_date between p_from and p_to and status = 'DRAFT';
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------------------------------------------------------------------
-- Validação da escala (CLT): descanso de 11h, 6 dias seguidos, intervalo, jornada, semana, afastamento e cobertura
-- ---------------------------------------------------------------------
create or replace function hr.validate_roster(p_store uuid, p_from date, p_to date)
returns table (employee_id uuid, work_date date, severity text, code text, message text)
language plpgsql stable security invoker as $$
#variable_conflict use_column
declare
  c record; d date; t timestamp; t_end timestamp; n int; v_fail timestamp;
begin
  -- 1) descanso mínimo de 11h entre jornadas
  return query
  with r as (
    select x.employee_id as eid, x.work_date as wd,
           (x.work_date + x.start_time) as s_ts,
           (x.work_date + x.end_time + (case when x.end_time <= x.start_time then interval '1 day' else interval '0' end)) as e_ts
    from hr.roster x where x.store_id = p_store and x.kind = 'WORK' and x.work_date between p_from - 1 and p_to
  ), l as (select r.*, lag(r.e_ts) over (partition by r.eid order by r.wd) as prev_e from r)
  select l.eid, l.wd, 'ERROR'::text, 'REST_11H'::text,
         format('Só %s h de descanso desde a jornada anterior (mínimo 11h)', round(extract(epoch from (l.s_ts - l.prev_e)) / 3600, 1))
  from l where l.prev_e is not null and l.s_ts - l.prev_e < interval '11 hours' and l.wd between p_from and p_to;

  -- 2) mais de 6 dias seguidos sem folga
  return query
  with w as (select x.employee_id as eid, x.work_date as wd from hr.roster x where x.store_id = p_store and x.kind = 'WORK' and x.work_date between p_from - 7 and p_to),
  g as (select w.eid, w.wd, w.wd - (row_number() over (partition by w.eid order by w.wd))::int as grp from w),
  runs as (select g.eid, g.wd, row_number() over (partition by g.eid, g.grp order by g.wd) as n from g)
  select runs.eid, runs.wd, 'ERROR'::text, 'DSR'::text, 'Mais de 6 dias seguidos sem folga (repouso semanal de 24h)'::text
  from runs where runs.n > 6 and runs.wd between p_from and p_to;

  -- 3) jornada diária acima de 10h e intervalo
  return query
  select x.employee_id, x.work_date,
         (case when x.span - x.break_minutes > 600 then 'ERROR' else 'WARN' end)::text,
         'DAILY_MAX'::text, format('Jornada de %s h (limite de 8h + 2h extras)', round((x.span - x.break_minutes) / 60.0, 1))
  from (select r.*, private.span_minutes(r.start_time, r.end_time) as span from hr.roster r where r.store_id = p_store and r.kind = 'WORK' and r.work_date between p_from and p_to) x
  where x.span - x.break_minutes > 480;

  return query
  select x.employee_id, x.work_date, (case when x.break_minutes < 30 then 'ERROR' else 'WARN' end)::text, 'BREAK'::text,
         format('Intervalo de %s min para jornada de %s h (esperado 60 min; 30 min só com acordo/convenção)', x.break_minutes, round(x.span / 60.0, 1))
  from (select r.*, private.span_minutes(r.start_time, r.end_time) as span from hr.roster r where r.store_id = p_store and r.kind = 'WORK' and r.work_date between p_from and p_to) x
  where (x.span > 360 and x.break_minutes < 60) or (x.span > 240 and x.span <= 360 and x.break_minutes < 15);

  -- 4) horas na semana acima do contratado
  return query
  with wk as (
    select r.employee_id as eid, date_trunc('week', r.work_date)::date as ws, min(r.work_date) as first_d,
           sum(private.span_minutes(r.start_time, r.end_time) - r.break_minutes) as mins, max(e.weekly_hours) as wh
    from hr.roster r join hr.employees e on e.id = r.employee_id
    where r.store_id = p_store and r.kind = 'WORK' and r.work_date between p_from - 6 and p_to + 6
    group by r.employee_id, date_trunc('week', r.work_date)
  )
  select wk.eid, greatest(wk.ws, p_from), 'WARN'::text, 'WEEKLY_HOURS'::text,
         format('Semana com %s h programadas (contratado: %s h) — gera horas extras ou banco de horas', round(wk.mins / 60.0, 1), wk.wh)
  from wk where wk.mins > wk.wh * 60 and wk.ws + 6 >= p_from and wk.ws <= p_to;

  -- 5) escalado durante férias/afastamento
  return query
  select r.employee_id, r.work_date, 'ERROR'::text, 'ON_LEAVE'::text, 'Colaborador escalado em dia de férias ou afastamento'::text
  from hr.roster r
  where r.store_id = p_store and r.kind = 'WORK' and r.work_date between p_from and p_to
    and (private.on_vacation(r.employee_id, r.work_date) or private.leave_overlap_days(r.employee_id, r.work_date, r.work_date, 'ANY') > 0);

  -- 6) cobertura dos picos (fatias de 30 min)
  for c in select * from hr.coverage_rules cr where cr.store_id = p_store loop
    for d in select g::date from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') g where extract(dow from g) = c.weekday loop
      t := d + c.start_time;
      t_end := d + c.end_time;
      v_fail := null;
      while t < t_end loop
        select count(distinct r.employee_id)::int into n from hr.roster r
        where r.store_id = p_store and r.kind = 'WORK' and r.work_date between d - 1 and d
          and (r.work_date + r.start_time) <= t
          and t < (r.work_date + r.end_time + (case when r.end_time <= r.start_time then interval '1 day' else interval '0' end));
        if n < c.min_staff then v_fail := t; exit; end if;
        t := t + interval '30 minutes';
      end loop;
      if v_fail is not null then
        employee_id := null; work_date := d; severity := 'WARN'; code := 'COVERAGE';
        message := format('%s: faltam pessoas às %s (mínimo %s na janela %s–%s)', c.label, to_char(v_fail, 'HH24:MI'), c.min_staff,
                          to_char(c.start_time, 'HH24:MI'), to_char(c.end_time, 'HH24:MI'));
        return next;
      end if;
    end loop;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Espelho de ponto mensal (alimenta a folha)
-- ---------------------------------------------------------------------
create or replace function hr.close_timesheet(p_employee uuid, p_competence date, p_force boolean default false) returns hr.timesheets
language plpgsql security definer set search_path = '' as $$
declare
  e hr.employees;
  comp date := date_trunc('month', p_competence)::date;
  comp_end date := (date_trunc('month', p_competence) + interval '1 month - 1 day')::date;
  first_d date; last_d date; d date;
  ro hr.roster; te hr.time_entries;
  s time; en time; brk int; worked int;
  reg int := 0; ot50 int := 0; ot100 int := 0; night int := 0; late int := 0; holmin int := 0; bank int := 0;
  abs_dates date[]; weeks date[]; wk date;
  tol int; sunday_double boolean; holiday_double boolean; night_mult numeric;
  is_sun boolean; is_hol boolean; ts hr.timesheets; old_bank int; diff int;
begin
  perform private.require_perm('hr.write');
  select * into e from hr.employees where id = p_employee and org_id = coalesce(private.org_id(), org_id);
  if e.id is null then raise exception 'Colaborador não encontrado'; end if;
  select * into ts from hr.timesheets where employee_id = e.id and competence = comp;
  if ts.id is not null and ts.status = 'CLOSED' and not p_force then return ts; end if;

  tol := private.hr_policy(e.org_id, 'tolerance_min', 10)::int;
  sunday_double := private.hr_policy(e.org_id, 'sunday_double', 1) = 1 and e.work_regime <> '12X36';
  holiday_double := private.hr_policy(e.org_id, 'holiday_double', 1) = 1;
  night_mult := 60.0 / 52.5;

  first_d := greatest(comp, e.hire_date);
  last_d := least(comp_end, coalesce(e.termination_date, comp_end));
  select coalesce(array_agg(x), '{}') into abs_dates from private.unjustified_absence_dates(e.id, first_d, last_d) x;

  for d in select g::date from generate_series(first_d::timestamp, last_d::timestamp, interval '1 day') g loop
    select * into ro from hr.roster where employee_id = e.id and work_date = d and kind = 'WORK';
    select * into te from hr.time_entries where employee_id = e.id and work_date = d;
    s := null; en := null; brk := 0;
    if te.id is not null then
      s := te.start_time; en := te.end_time; brk := te.break_minutes;
    elsif ro.id is not null and not e.track_time and not private.on_vacation(e.id, d) then
      s := ro.start_time; en := ro.end_time; brk := ro.break_minutes;
    end if;
    continue when s is null;
    worked := greatest(0, private.span_minutes(s, en) - brk);
    continue when worked = 0;

    is_sun := extract(dow from d) = 0;
    is_hol := private.is_holiday(e.org_id, d, e.store_id);
    if (is_sun and sunday_double) or (is_hol and holiday_double) then
      ot100 := ot100 + worked; holmin := holmin + worked;
    else
      reg := reg + least(worked, e.daily_minutes);
      if worked - e.daily_minutes > tol then ot50 := ot50 + (worked - e.daily_minutes); end if;
    end if;
    night := night + round(private.night_minutes(s, en) * night_mult)::int;

    if e.track_time and ro.id is not null and te.id is not null and te.start_time > ro.start_time
       and private.span_minutes(ro.start_time, te.start_time) > tol then
      late := late + private.span_minutes(ro.start_time, te.start_time);
    end if;
  end loop;

  weeks := '{}';
  foreach d in array abs_dates loop
    wk := date_trunc('week', d)::date;
    if not (wk = any (weeks)) then weeks := array_append(weeks, wk); end if;
  end loop;

  if e.time_bank then
    bank := round(ot50 * private.hr_policy(e.org_id, 'bank_multiplier', 1))::int;
    ot50 := 0;
  end if;

  insert into hr.timesheets (org_id, employee_id, competence, regular_min, ot50_min, ot100_min, night_min, absence_days, late_min,
                             dsr_lost_days, bank_delta_min, status, closed_by, closed_at, detail)
  values (e.org_id, e.id, comp, reg, ot50, ot100, night, coalesce(array_length(abs_dates, 1), 0), late,
          coalesce(array_length(weeks, 1), 0), bank, 'CLOSED', private.member_id(), now(),
          jsonb_build_object('holiday_sunday_min', holmin, 'absence_dates', to_jsonb(abs_dates)))
  on conflict (employee_id, competence) do update set regular_min = excluded.regular_min, ot50_min = excluded.ot50_min,
    ot100_min = excluded.ot100_min, night_min = excluded.night_min, absence_days = excluded.absence_days, late_min = excluded.late_min,
    dsr_lost_days = excluded.dsr_lost_days, bank_delta_min = excluded.bank_delta_min, status = 'CLOSED',
    closed_by = excluded.closed_by, closed_at = excluded.closed_at, detail = excluded.detail
  returning * into ts;

  -- banco de horas: lança só a diferença em relação ao que já foi lançado para este espelho
  select coalesce(sum(minutes), 0) into old_bank from hr.time_bank where source_type = 'hr.timesheets' and source_id = ts.id;
  diff := bank - old_bank;
  if diff <> 0 then
    insert into hr.time_bank (org_id, employee_id, occurred_on, minutes, kind, source_type, source_id, note, created_by)
    values (e.org_id, e.id, comp_end, diff, 'OVERTIME', 'hr.timesheets', ts.id, 'Horas extras do mês ' || to_char(comp, 'MM/YYYY'), private.member_id());
  end if;
  return ts;
end $$;

create or replace function hr.reopen_timesheet(p_timesheet uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare ts hr.timesheets;
begin
  perform private.require_perm('hr.write');
  select * into ts from hr.timesheets where id = p_timesheet and org_id = coalesce(private.org_id(), org_id);
  if ts.id is null then raise exception 'Espelho não encontrado'; end if;
  if exists (select 1 from hr.payslips p join hr.payroll_runs r on r.id = p.run_id
             where p.employee_id = ts.employee_id and r.competence = ts.competence and r.status in ('APPROVED', 'PAID') and r.kind = 'MONTHLY') then
    raise exception 'A folha do mês já foi aprovada: estorne-a antes de reabrir o ponto' using errcode = 'P0048';
  end if;
  update hr.timesheets set status = 'OPEN', closed_at = null, closed_by = null where id = ts.id;
end $$;

-- Saldo do banco de horas (minutos)
create or replace view hr.v_time_bank_balance with (security_invoker = true) as
select org_id, employee_id, sum(minutes)::int as balance_min from hr.time_bank group by org_id, employee_id;

select private.attach_updated_at('hr');
select private.apply_rls('hr', array['shift_templates', 'roster', 'coverage_rules', 'time_entries', 'time_bank', 'timesheets'], 'hr.read', 'hr.write');
select private.rpc_only('hr', array['time_bank', 'timesheets']);
