-- =====================================================================
-- Horário de funcionamento das lojas, ligado à escala e ao atendimento
--  1) core.stores.business_hours (mesmo formato do horário dos canais: {"days": {"1": [["09:00","20:00"]], …}}) + exceções por data
--     (feriado fechado, horário especial de evento/Black Friday). Sem dias cadastrados = horário não definido (nada é cobrado).
--  2) A escala passa a conferir: loja aberta sem ninguém escalado e turno fora do horário (com tolerância de preparação).
--  3) Canal de atendimento sem horário próprio usa o horário da loja dele (SLA, aviso de fora do horário).
--  4) Ajuste da campanha de aniversário: inscrições antigas com a tarefa marcada fora da meia-noite do aniversário.
-- Códigos: P0330 dado inválido · P0331 não encontrado.
-- =====================================================================

alter table core.stores add constraint stores_business_hours_valid check (private.valid_business_hours(business_hours)) not valid;
alter table core.stores validate constraint stores_business_hours_valid;

create table core.store_hours_exceptions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  store_id uuid not null references core.stores(id) on delete cascade,
  day date not null,
  closed boolean not null default false,
  hours jsonb not null default '[]',             -- [["10:00","22:00"]] quando não fecha
  note text,
  created_at timestamptz not null default now(),
  unique (store_id, day),
  check (closed or (jsonb_typeof(hours) = 'array' and jsonb_array_length(hours) between 1 and 3))
);
select private.apply_rls('core', array['store_hours_exceptions'], 'core.read', 'core.admin');
select private.rpc_only('core', array['store_hours_exceptions']);
-- quem vende e quem cuida da escala também precisa ler o horário
drop policy if exists p_read on core.store_hours_exceptions;
create policy p_read on core.store_hours_exceptions for select to authenticated using (org_id = (select private.org_id()));

-- Faixas da loja num dia (exceção da data > semana). Devolve vazio se fechada ou sem horário.
create or replace function private.store_intervals(p_store uuid, p_day date) returns table (s timestamptz, e timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare x core.store_hours_exceptions; h jsonb;
begin
  select * into x from core.store_hours_exceptions where store_id = p_store and day = p_day;
  if x.id is not null then
    if x.closed then return; end if;
    return query select ((p_day + (iv ->> 0)::time)::timestamp at time zone 'America/Sao_Paulo'), ((p_day + (iv ->> 1)::time)::timestamp at time zone 'America/Sao_Paulo')
                 from jsonb_array_elements(x.hours) iv;
    return;
  end if;
  select business_hours into h from core.stores where id = p_store;
  return query select * from private.bh_intervals(h, p_day);
end $$;

create or replace function private.store_hours_configured(p_store uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.bh_configured(business_hours) from core.stores where id = p_store
$$;

-- p = {"days": {...}} (dia ausente = fechado)
create or replace function core.set_store_hours(p_store uuid, p jsonb) returns core.stores
language plpgsql security definer set search_path = '' as $$
declare s core.stores; v jsonb := jsonb_build_object('days', coalesce(p -> 'days', '{}'));
begin
  perform private.require_perm('core.admin');
  if not private.valid_business_hours(v) then
    raise exception 'Horário inválido: cada faixa precisa terminar depois de começar, no mesmo dia, sem sobrepor' using errcode = 'P0330';
  end if;
  update core.stores set business_hours = v where id = p_store and org_id = private.org_id() returning * into s;
  if s.id is null then raise exception 'Loja não encontrada' using errcode = 'P0331'; end if;
  return s;
end $$;

-- p = {store_id, day, closed, hours?: [["10:00","22:00"]], note?}
create or replace function core.save_store_hours_exception(p jsonb) returns core.store_hours_exceptions
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); x core.store_hours_exceptions; v_closed boolean := coalesce((p ->> 'closed')::boolean, false); v_hours jsonb := coalesce(p -> 'hours', '[]');
begin
  perform private.require_perm('core.admin');
  if not exists (select 1 from core.stores where id = (p ->> 'store_id')::uuid and org_id = v_org) then raise exception 'Loja não encontrada' using errcode = 'P0331'; end if;
  if (p ->> 'day') is null then raise exception 'Informe a data' using errcode = 'P0330'; end if;
  if not v_closed and (jsonb_typeof(v_hours) <> 'array' or jsonb_array_length(v_hours) = 0
                       or not private.valid_business_hours(jsonb_build_object('days', jsonb_build_object('0', v_hours)))) then
    raise exception 'Horário especial inválido' using errcode = 'P0330';
  end if;
  insert into core.store_hours_exceptions (org_id, store_id, day, closed, hours, note)
  values (v_org, (p ->> 'store_id')::uuid, (p ->> 'day')::date, v_closed, case when v_closed then '[]' else v_hours end, nullif(trim(coalesce(p ->> 'note', '')), ''))
  on conflict (store_id, day) do update set closed = excluded.closed, hours = excluded.hours, note = excluded.note
  returning * into x;
  return x;
end $$;

create or replace function core.delete_store_hours_exception(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('core.admin');
  delete from core.store_hours_exceptions where id = p_id and org_id = private.org_id();
end $$;

-- Calendário da loja: dia a dia, horário, pessoas escaladas e buracos (para a tela de horários e para a rotina)
create or replace function core.store_calendar(p_store uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare d date; v jsonb := '[]'; iv jsonb; staff jsonb; x core.store_hours_exceptions;
begin
  perform private.require_any_perm(array['core.read', 'core.admin', 'hr.read', 'sales.read']);
  if not exists (select 1 from core.stores where id = p_store and org_id = private.org_id()) then raise exception 'Loja não encontrada' using errcode = 'P0331'; end if;
  if p_to < p_from or p_to - p_from > 62 then raise exception 'Período inválido' using errcode = 'P0330'; end if;
  for d in select g::date from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') g loop
    select coalesce(jsonb_agg(jsonb_build_array(to_char(i.s at time zone 'America/Sao_Paulo', 'HH24:MI'), to_char(i.e at time zone 'America/Sao_Paulo', 'HH24:MI')) order by i.s), '[]')
      into iv from private.store_intervals(p_store, d) i;
    select coalesce(jsonb_agg(jsonb_build_object('start', to_char(r.start_time, 'HH24:MI'), 'end', to_char(r.end_time, 'HH24:MI')) order by r.start_time), '[]')
      into staff from hr.roster r where r.store_id = p_store and r.work_date = d and r.kind = 'WORK';
    select * into x from core.store_hours_exceptions where store_id = p_store and day = d;
    v := v || jsonb_build_object('day', d, 'hours', iv, 'staff', staff, 'exception', x.note, 'closed_exception', coalesce(x.closed, false));
  end loop;
  return v;
end $$;

-- ---------------------------------------------------------------------
-- 2) Escala × horário da loja (acrescenta as conferências 8 e 9 ao validate_roster)
-- ---------------------------------------------------------------------
create or replace function hr.validate_roster(p_store uuid, p_from date, p_to date)
returns table (employee_id uuid, work_date date, severity text, code text, message text)
language plpgsql stable security invoker as $$
#variable_conflict use_column
declare
  c record; d date; t timestamp; t_end timestamp; n int; v_fail timestamp; cfg jsonb; iv record; v_prep int; v_close timestamptz; v_open timestamptz; r record;
begin
  select private.sched_cfg(org_id) into cfg from core.stores where id = p_store;
  cfg := coalesce(cfg, private.sched_cfg(null));

  -- 1) descanso mínimo de 11h entre jornadas
  if coalesce((cfg ->> 'rest_11h')::boolean, true) then
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
  end if;

  -- 2) dias seguidos sem folga
  if coalesce((cfg ->> 'consecutive_days')::boolean, true) then
    return query
    with w as (select x.employee_id as eid, x.work_date as wd from hr.roster x where x.store_id = p_store and x.kind = 'WORK' and x.work_date between p_from - 13 and p_to),
    g as (select w.eid, w.wd, w.wd - (row_number() over (partition by w.eid order by w.wd))::int as grp from w),
    runs as (select g.eid, g.wd, row_number() over (partition by g.eid, g.grp order by g.wd) as n from g)
    select runs.eid, runs.wd, 'ERROR'::text, 'DSR'::text, format('Mais de %s dias seguidos sem folga (repouso semanal de 24h)', cfg ->> 'max_consecutive_days')
    from runs where runs.n > (cfg ->> 'max_consecutive_days')::int and runs.wd between p_from and p_to;
  end if;

  -- 3) jornada diária
  if coalesce((cfg ->> 'daily_max')::boolean, true) then
    return query
    select x.employee_id, x.work_date,
           (case when x.span - x.break_minutes > (cfg ->> 'daily_error_minutes')::int then 'ERROR' else 'WARN' end)::text,
           'DAILY_MAX'::text, format('Jornada de %s h (alerta acima de %s h, erro acima de %s h)', round((x.span - x.break_minutes) / 60.0, 1),
                                     round((cfg ->> 'daily_warn_minutes')::int / 60.0, 1), round((cfg ->> 'daily_error_minutes')::int / 60.0, 1))
    from (select r.*, private.span_minutes(r.start_time, r.end_time) as span from hr.roster r where r.store_id = p_store and r.kind = 'WORK' and r.work_date between p_from and p_to) x
    where x.span - x.break_minutes > (cfg ->> 'daily_warn_minutes')::int;
  end if;

  -- 4) intervalo
  if coalesce((cfg ->> 'break_rule')::boolean, true) then
    return query
    select x.employee_id, x.work_date, (case when x.break_minutes < 30 then 'ERROR' else 'WARN' end)::text, 'BREAK'::text,
           format('Intervalo de %s min para jornada de %s h (mínimo configurado: %s min acima de %s h)', x.break_minutes, round(x.span / 60.0, 1), cfg ->> 'min_break_minutes', round((cfg ->> 'break_over_minutes')::int / 60.0, 1))
    from (select r.*, private.span_minutes(r.start_time, r.end_time) as span from hr.roster r where r.store_id = p_store and r.kind = 'WORK' and r.work_date between p_from and p_to) x
    where (x.span > (cfg ->> 'break_over_minutes')::int and x.break_minutes < (cfg ->> 'min_break_minutes')::int)
       or (x.span > (cfg ->> 'short_break_over_minutes')::int and x.span <= (cfg ->> 'break_over_minutes')::int and x.break_minutes < (cfg ->> 'short_break_minutes')::int);
  end if;

  -- 5) horas na semana acima do contratado
  if coalesce((cfg ->> 'weekly_hours')::boolean, true) then
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
  end if;

  -- 6) escalado durante férias/afastamento (sempre confere)
  return query
  select r.employee_id, r.work_date, 'ERROR'::text, 'ON_LEAVE'::text, 'Colaborador escalado em dia de férias ou afastamento'::text
  from hr.roster r
  where r.store_id = p_store and r.kind = 'WORK' and r.work_date between p_from and p_to
    and (private.on_vacation(r.employee_id, r.work_date) or private.leave_overlap_days(r.employee_id, r.work_date, r.work_date, 'ANY') > 0);

  -- 7) cobertura dos picos ativos (fatias de 30 min)
  if coalesce((cfg ->> 'coverage')::boolean, true) then
    for c in select * from hr.coverage_rules cr where cr.store_id = p_store and cr.active loop
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
  end if;

  -- 8) loja aberta sem ninguém escalado (só com horário de funcionamento cadastrado)
  if coalesce((cfg ->> 'store_hours')::boolean, true) and private.store_hours_configured(p_store) then
    for d in select g::date from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') g loop
      v_fail := null;
      for iv in select * from private.store_intervals(p_store, d) order by 1 loop
        t := iv.s at time zone 'America/Sao_Paulo';
        t_end := iv.e at time zone 'America/Sao_Paulo';
        while t < t_end loop
          select count(*)::int into n from hr.roster r
          where r.store_id = p_store and r.kind = 'WORK' and r.work_date between d - 1 and d
            and (r.work_date + r.start_time) <= t
            and t < (r.work_date + r.end_time + (case when r.end_time <= r.start_time then interval '1 day' else interval '0' end));
          if n = 0 then v_fail := t; exit; end if;
          t := t + interval '30 minutes';
        end loop;
        exit when v_fail is not null;
      end loop;
      if v_fail is not null then
        employee_id := null; work_date := d; severity := 'WARN'; code := 'STORE_UNCOVERED';
        message := format('Loja aberta sem ninguém escalado a partir das %s', to_char(v_fail, 'HH24:MI'));
        return next;
      end if;
    end loop;

    -- 9) turno fora do horário da loja (tolerância de preparação antes de abrir e depois de fechar)
    v_prep := coalesce((cfg ->> 'store_prep_minutes')::int, 30);
    for r in select x.* from hr.roster x where x.store_id = p_store and x.kind = 'WORK' and x.work_date between p_from and p_to loop
      select min(i.s), max(i.e) into v_open, v_close from private.store_intervals(p_store, r.work_date) i;
      employee_id := r.employee_id; work_date := r.work_date; severity := 'WARN'; code := 'OUTSIDE_STORE_HOURS';
      if v_open is null then
        message := 'Escalado num dia em que a loja está fechada';
        return next;
      elsif ((r.work_date + r.start_time)::timestamp at time zone 'America/Sao_Paulo') < v_open - make_interval(mins => v_prep)
         or ((r.work_date + r.end_time + (case when r.end_time <= r.start_time then interval '1 day' else interval '0' end))::timestamp at time zone 'America/Sao_Paulo') > v_close + make_interval(mins => v_prep) then
        message := format('Turno %s–%s fora do horário da loja (%s–%s, tolerância de %s min)', to_char(r.start_time, 'HH24:MI'), to_char(r.end_time, 'HH24:MI'),
                          to_char(v_open at time zone 'America/Sao_Paulo', 'HH24:MI'), to_char(v_close at time zone 'America/Sao_Paulo', 'HH24:MI'), v_prep);
        return next;
      end if;
    end loop;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 3) Canal sem horário próprio usa o da loja
-- ---------------------------------------------------------------------
create or replace function private.channel_hours(p_ca uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when private.bh_configured(ca.business_hours) then ca.business_hours
              when s.id is not null and private.bh_configured(s.business_hours) then s.business_hours || jsonb_build_object('after_hours_ai', coalesce(ca.business_hours ->> 'after_hours_ai', 'DRAFT_ONLY'))
              else ca.business_hours end
  from omni.channel_accounts ca left join core.stores s on s.id = ca.store_id
  where ca.id = p_ca
$$;

create or replace function private.channel_is_open(p_ca uuid, p_at timestamptz default now()) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare h jsonb; d date;
begin
  h := private.channel_hours(p_ca);
  if not private.bh_configured(h) then return true; end if;
  d := (p_at at time zone 'America/Sao_Paulo')::date;
  return exists (select 1 from private.bh_intervals(h, d) i where p_at >= i.s and p_at < i.e);
end $$;

create or replace function private.channel_next_open(p_ca uuid, p_at timestamptz default now()) returns timestamptz
language plpgsql stable security definer set search_path = '' as $$
declare h jsonb; d date; k int; r record;
begin
  h := private.channel_hours(p_ca);
  if not private.bh_configured(h) then return p_at; end if;
  d := (p_at at time zone 'America/Sao_Paulo')::date;
  for k in 0..13 loop
    for r in select * from private.bh_intervals(h, d + k) order by 1 loop
      if p_at < r.e then return greatest(p_at, r.s); end if;
    end loop;
  end loop;
  return null;
end $$;

create or replace function private.business_add(p_ca uuid, p_from timestamptz, p_minutes int) returns timestamptz
language plpgsql stable security definer set search_path = '' as $$
declare h jsonb; d date; k int; r record; v_left numeric := greatest(p_minutes, 0); v_start timestamptz; v_avail numeric;
begin
  h := private.channel_hours(p_ca);
  if not private.bh_configured(h) then return p_from + make_interval(mins => p_minutes); end if;
  d := (p_from at time zone 'America/Sao_Paulo')::date;
  for k in 0..20 loop
    for r in select * from private.bh_intervals(h, d + k) order by 1 loop
      continue when r.e <= p_from;
      v_start := greatest(p_from, r.s);
      v_avail := extract(epoch from (r.e - v_start)) / 60;
      if v_avail >= v_left then return v_start + make_interval(secs => v_left * 60); end if;
      v_left := v_left - v_avail;
    end loop;
  end loop;
  return p_from + make_interval(mins => p_minutes);
end $$;

-- ---------------------------------------------------------------------
-- 4) Aniversário: tarefa sai à meia-noite (São Paulo) do dia do aniversário, inclusive nas inscrições antigas
-- ---------------------------------------------------------------------
update mkt.journey_enrollments e
set next_run_at = ((private.next_birthday(p.birth_date, (e.enrolled_at at time zone 'America/Sao_Paulo')::date))::timestamp at time zone 'America/Sao_Paulo')
from mkt.journeys j, crm.parties p
where j.id = e.journey_id and p.id = e.party_id and j.trigger = 'BIRTHDAY' and e.status = 'ACTIVE' and e.next_step = 1
  and e.next_run_at is not null and p.birth_date is not null
  and (e.next_run_at at time zone 'America/Sao_Paulo')::time <> '00:00'
  and (select s.wait_days from mkt.journey_steps s where s.journey_id = j.id and s.position = 1) = coalesce((j.trigger_config ->> 'days_before')::numeric, 0);

-- (store_intervals e store_hours_configured ficam executáveis: o validate_roster roda com o papel de quem chama)
insert into private.internal_functions (fqname) values ('private.channel_hours')
on conflict do nothing;

select private.lock_functions();
