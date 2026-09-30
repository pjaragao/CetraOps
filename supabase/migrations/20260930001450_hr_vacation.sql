-- =====================================================================
-- hr (férias): períodos aquisitivos/concessivos, programação com as regras da CLT (fracionamento em até 3 partes,
-- uma de 14+ dias e as demais de 5+, abono de até 1/3, vedação de início nos 2 dias que antecedem feriado ou repouso,
-- pagamento em dobro fora do período concessivo) e redução do direito por faltas injustificadas (art. 130).
-- O pagamento (recibo de férias) é gerado na folha (hr_payroll).
-- =====================================================================

create table hr.vacation_periods (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  employee_id uuid not null references hr.employees(id) on delete cascade,
  period_start date not null,
  period_end date not null,                                   -- fim do período aquisitivo
  concessive_end date not null,                               -- limite para conceder (12 meses depois)
  days_entitled int not null default 30 check (days_entitled between 0 and 30),
  absences int not null default 0,
  closed_reason text,                                         -- preenchido na rescisão
  unique (employee_id, period_start)
);

create table hr.vacations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  employee_id uuid not null references hr.employees(id) on delete cascade,
  period_id uuid not null references hr.vacation_periods(id),
  start_date date not null,
  days int not null check (days between 5 and 30),
  end_date date not null,
  sell_days int not null default 0 check (sell_days between 0 and 10),   -- abono pecuniário
  thirteenth_advance boolean not null default false,          -- 1ª parcela do 13º junto das férias
  status text not null default 'PLANNED' check (status in ('PLANNED', 'APPROVED', 'PAID', 'TAKEN', 'CANCELLED')),
  pay_date date,                                              -- até 2 dias antes do início (art. 145)
  double_pay boolean not null default false,                  -- concedida após o período concessivo (art. 137)
  payslip_id uuid,                                            -- recibo de férias (hr.payslips)
  notes text,
  created_by uuid references core.members(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on hr.vacations (employee_id, start_date);
create index on hr.vacations (org_id, start_date) where status in ('PLANNED', 'APPROVED', 'PAID');

-- ---------------------------------------------------------------------
-- Consultas de apoio (usadas pela escala, pela folha e pela rescisão)
-- ---------------------------------------------------------------------
create or replace function private.on_vacation(p_employee uuid, p_date date) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from hr.vacations v where v.employee_id = p_employee and v.status in ('APPROVED', 'PAID', 'TAKEN')
                 and p_date between v.start_date and v.end_date)
$$;

create or replace function private.vacation_overlap_days(p_employee uuid, p_from date, p_to date) returns int
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(greatest(0, least(v.end_date, p_to) - greatest(v.start_date, p_from) + 1)), 0)::int
  from hr.vacations v where v.employee_id = p_employee and v.status in ('APPROVED', 'PAID', 'TAKEN')
    and v.start_date <= p_to and v.end_date >= p_from
$$;

-- Faltas injustificadas: registradas como afastamento ou detectadas na escala (quando o ponto é controlado)
create or replace function private.unjustified_absence_dates(p_employee uuid, p_from date, p_to date) returns setof date
language plpgsql stable security definer set search_path = '' as $$
begin
  return query
  select d::date from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') d
  join hr.employees e on e.id = p_employee
  where exists (select 1 from hr.leaves l where l.employee_id = p_employee and l.kind = 'UNJUSTIFIED_ABSENCE' and d::date between l.start_date and l.end_date)
     or (e.track_time
         and exists (select 1 from hr.roster r where r.employee_id = p_employee and r.work_date = d::date and r.kind = 'WORK')
         and not exists (select 1 from hr.time_entries t where t.employee_id = p_employee and t.work_date = d::date)
         and not private.on_vacation(p_employee, d::date)
         and not exists (select 1 from hr.leaves l where l.employee_id = p_employee and d::date between l.start_date and l.end_date)
         and not private.is_holiday(e.org_id, d::date, e.store_id));
end $$;

-- (hr.roster e hr.time_entries são criadas na migration de escala; a função só é executada depois)

-- Direito a férias conforme faltas injustificadas no período aquisitivo (CLT art. 130)
create or replace function private.vacation_days_for_absences(p_absences int) returns int
language sql immutable as $$
  select case when p_absences <= 5 then 30 when p_absences <= 14 then 24 when p_absences <= 23 then 18 when p_absences <= 32 then 12 else 0 end
$$;

-- Gera os períodos aquisitivos do colaborador até hoje (idempotente)
create or replace function private.ensure_vacation_periods(p_employee uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare e hr.employees; n int := 0; v_start date; v_end date; v_today date := private.today_sp();
begin
  select * into e from hr.employees where id = p_employee;
  if e.id is null or e.contract_type not in ('CLT', 'INTERMITENTE', 'TEMPORARIO') then return; end if;
  loop
    v_start := (e.hire_date + make_interval(years => n))::date;
    exit when v_start > v_today or (e.termination_date is not null and v_start > e.termination_date);
    v_end := (v_start + interval '1 year' - interval '1 day')::date;
    insert into hr.vacation_periods (org_id, employee_id, period_start, period_end, concessive_end)
    values (e.org_id, e.id, v_start, v_end, (v_end + interval '1 year')::date)
    on conflict (employee_id, period_start) do nothing;
    n := n + 1;
    exit when n > 60;
  end loop;
end $$;

create or replace function private.refresh_vacation_period(p_period uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare p hr.vacation_periods; v_abs int;
begin
  select * into p from hr.vacation_periods where id = p_period;
  select count(*)::int into v_abs from private.unjustified_absence_dates(p.employee_id, p.period_start, least(p.period_end, private.today_sp())) d;
  update hr.vacation_periods set absences = v_abs, days_entitled = private.vacation_days_for_absences(v_abs) where id = p_period;
end $$;

-- Uso do período: dias gozados/vendidos/programados
create or replace function private.vacation_usage(p_period uuid) returns table (used_days int, sold_days int, parts int)
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(days), 0)::int, coalesce(sum(sell_days), 0)::int, count(*)::int
  from hr.vacations where period_id = p_period and status <> 'CANCELLED'
$$;

-- Quadro por colaborador: períodos, saldo e prazo (para a tela e alertas de férias vencendo)
create or replace view hr.v_vacation_balance with (security_invoker = true) as
select p.id as period_id, p.org_id, p.employee_id, p.period_start, p.period_end, p.concessive_end, p.days_entitled, p.absences,
       coalesce(u.used_days, 0) as used_days, coalesce(u.sold_days, 0) as sold_days,
       p.days_entitled - coalesce(u.used_days, 0) - coalesce(u.sold_days, 0) as days_left,
       (p.period_end < private.today_sp()) as acquired,
       (p.concessive_end - private.today_sp()) as days_to_expire
from hr.vacation_periods p
left join lateral (select coalesce(sum(days), 0) as used_days, coalesce(sum(sell_days), 0) as sold_days
                   from hr.vacations v where v.period_id = p.id and v.status <> 'CANCELLED') u on true;

-- ---------------------------------------------------------------------
-- Programar férias. p = {employee_id, period_id?, start_date, days, sell_days?, thirteenth_advance?, notes?}
-- ---------------------------------------------------------------------
create or replace function hr.schedule_vacation(p jsonb) returns hr.vacations
language plpgsql security definer set search_path = '' as $$
declare
  e hr.employees;
  per hr.vacation_periods;
  v hr.vacations;
  v_start date := (p ->> 'start_date')::date;
  v_days int := (p ->> 'days')::int;
  v_sell int := coalesce((p ->> 'sell_days')::int, 0);
  v_end date;
  u record;
  v_left int;
  v_maxpart int;
  v_pay date;
begin
  perform private.require_perm('hr.write');
  select * into e from hr.employees where id = (p ->> 'employee_id')::uuid and org_id = coalesce(private.org_id(), org_id);
  if e.id is null or e.status <> 'ACTIVE' then raise exception 'Colaborador não encontrado ou desligado'; end if;
  if e.contract_type not in ('CLT', 'INTERMITENTE', 'TEMPORARIO') then raise exception 'Férias só se aplicam a vínculos CLT'; end if;
  perform private.ensure_vacation_periods(e.id);

  if (p ->> 'period_id') is not null then
    select * into per from hr.vacation_periods where id = (p ->> 'period_id')::uuid and employee_id = e.id;
  else
    select * into per from hr.vacation_periods vp where vp.employee_id = e.id and vp.period_end < v_start
      and vp.days_entitled - (select coalesce(sum(days + sell_days), 0) from hr.vacations x where x.period_id = vp.id and x.status <> 'CANCELLED') > 0
    order by vp.period_start limit 1;
  end if;
  if per.id is null then raise exception 'Nenhum período aquisitivo completo com saldo para esta data' using errcode = 'P0040'; end if;
  perform private.refresh_vacation_period(per.id);
  select * into per from hr.vacation_periods where id = per.id;

  if v_start <= per.period_end then raise exception 'As férias só podem começar depois de completado o período aquisitivo (%)', per.period_end using errcode = 'P0040'; end if;
  if v_days < 5 then raise exception 'Cada período de férias precisa ter no mínimo 5 dias corridos' using errcode = 'P0041'; end if;
  if v_sell > 10 or v_sell > per.days_entitled / 3 then raise exception 'O abono pecuniário é de no máximo 1/3 do período (% dias)', per.days_entitled / 3 using errcode = 'P0041'; end if;

  select * into u from private.vacation_usage(per.id);
  v_left := per.days_entitled - u.used_days - u.sold_days;
  if v_days + v_sell > v_left then raise exception 'Saldo insuficiente no período: restam % dias', v_left using errcode = 'P0042'; end if;
  if u.parts >= 3 then raise exception 'As férias podem ser fracionadas em no máximo 3 períodos' using errcode = 'P0043'; end if;
  if v_sell > 0 and u.sold_days > 0 then raise exception 'O abono pecuniário só pode ser vendido uma vez por período' using errcode = 'P0041'; end if;

  -- quando os dias se completam, uma das partes precisa ter 14+ dias
  if v_days + v_sell = v_left and u.parts >= 1 then
    select greatest(coalesce(max(days), 0), v_days) into v_maxpart from hr.vacations where period_id = per.id and status <> 'CANCELLED';
    if v_maxpart < 14 then raise exception 'No fracionamento, uma das partes precisa ter pelo menos 14 dias corridos' using errcode = 'P0043'; end if;
  end if;

  -- vedado iniciar nos 2 dias que antecedem feriado ou repouso semanal (domingo)
  if extract(dow from v_start + 1) = 0 or extract(dow from v_start + 2) = 0
     or private.is_holiday(e.org_id, v_start + 1, e.store_id) or private.is_holiday(e.org_id, v_start + 2, e.store_id) then
    raise exception 'Não é permitido iniciar férias nos 2 dias que antecedem feriado ou dia de repouso semanal' using errcode = 'P0044';
  end if;

  v_end := v_start + v_days - 1;
  if exists (select 1 from hr.vacations x where x.employee_id = e.id and x.status <> 'CANCELLED' and x.start_date <= v_end and x.end_date >= v_start)
     or private.leave_overlap_days(e.id, v_start, v_end, 'ANY') > 0 then
    raise exception 'O colaborador já tem férias ou afastamento nesse intervalo' using errcode = 'P0045';
  end if;

  -- pagamento até 2 dias antes do início, em dia útil
  v_pay := v_start - 2;
  while extract(dow from v_pay) = 0 or private.is_holiday(e.org_id, v_pay, e.store_id) loop v_pay := v_pay - 1; end loop;

  insert into hr.vacations (org_id, employee_id, period_id, start_date, days, end_date, sell_days, thirteenth_advance, pay_date, double_pay, notes, created_by)
  values (e.org_id, e.id, per.id, v_start, v_days, v_end, v_sell, coalesce((p ->> 'thirteenth_advance')::boolean, false), v_pay,
          v_end > per.concessive_end, p ->> 'notes', private.member_id())
  returning * into v;
  return v;
end $$;

create or replace function hr.approve_vacation(p_vacation uuid) returns hr.vacations
language plpgsql security definer set search_path = '' as $$
declare v hr.vacations; e hr.employees;
begin
  perform private.require_perm('hr.write');
  select * into v from hr.vacations where id = p_vacation and org_id = coalesce(private.org_id(), org_id) for update;
  if v.id is null then raise exception 'Férias não encontradas'; end if;
  if v.status <> 'PLANNED' then raise exception 'Só férias programadas podem ser aprovadas (situação: %)', v.status; end if;
  select * into e from hr.employees where id = v.employee_id;
  update hr.vacations set status = 'APPROVED' where id = v.id returning * into v;
  -- a escala do período vira "férias": remove turnos que conflitam
  delete from hr.roster where employee_id = v.employee_id and work_date between v.start_date and v.end_date;
  perform private.enqueue_esocial(e.legal_entity_id, 'S-2230', 'hr.vacations', v.id, date_trunc('month', v.start_date)::date,
    jsonb_build_object('employee_id', e.id, 'kind', 'VACATION', 'start_date', v.start_date, 'end_date', v.end_date, 'days', v.days));
  return v;
end $$;

create or replace function hr.cancel_vacation(p_vacation uuid, p_reason text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v hr.vacations;
begin
  perform private.require_perm('hr.write');
  select * into v from hr.vacations where id = p_vacation and org_id = coalesce(private.org_id(), org_id) for update;
  if v.id is null then raise exception 'Férias não encontradas'; end if;
  if v.status in ('PAID', 'TAKEN') then raise exception 'Férias já pagas: estorne o recibo na folha antes de cancelar' using errcode = 'P0046'; end if;
  update hr.vacations set status = 'CANCELLED', notes = concat_ws(' · ', notes, 'Cancelada: ' || coalesce(p_reason, '—')) where id = v.id;
end $$;

-- Marca como gozadas as férias que já terminaram (chamada diária)
create or replace function hr.roll_vacation_status() returns int
language sql security definer set search_path = '' as $$
  with u as (update hr.vacations set status = 'TAKEN' where status = 'PAID' and end_date < private.today_sp() returning 1)
  select count(*)::int from u
$$;
revoke execute on function hr.roll_vacation_status() from authenticated;

select private.attach_updated_at('hr');
select private.apply_rls('hr', array['vacation_periods', 'vacations'], 'hr.read', 'hr.write');
select private.rpc_only('hr', array['vacation_periods', 'vacations']);
create trigger trg_audit after insert or update or delete on hr.vacations for each row execute function private.audit_capture();
