-- =====================================================================
-- Equipe › Escalas: regras configuráveis (liga/desliga), intervalo mínimo e escala semanal padrão por colaborador.
-- • core.settings 'schedule_rules': descanso de 11 h, dias seguidos, jornada máxima, intervalo mínimo (e a partir de quantas horas vale),
--   horas semanais e cobertura dos picos — cada uma pode ser ligada ou desligada; os limites são editáveis.
-- • Turnos e horários livres respeitam o intervalo mínimo (quando a regra está ligada).
-- • Escala semanal padrão: cada colaborador tem um turno (ou folga) por dia da semana; o sistema preenche os meses (rascunho,
--   só nos dias vazios) ao salvar e todo dia de madrugada para os próximos 60 dias.
-- • Picos de cobertura ganham liga/desliga individual.
-- Códigos de erro: P0290 dado inválido · P0291 situação · P0292 não encontrado (mesmos da edição de escala).
-- =====================================================================

create or replace function private.sched_cfg(p_org uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'rest_11h', true, 'consecutive_days', true, 'max_consecutive_days', 6,
    'daily_max', true, 'daily_warn_minutes', 480, 'daily_error_minutes', 600,
    'break_rule', true, 'min_break_minutes', 60, 'break_over_minutes', 360, 'short_break_minutes', 15, 'short_break_over_minutes', 240,
    'weekly_hours', true, 'coverage', true)
    || coalesce((select value from core.settings where org_id = p_org and key = 'schedule_rules'), '{}')
$$;

create or replace function hr.schedule_rules() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_perm('hr.read');
  return private.sched_cfg(private.org_id());
end $$;

create or replace function hr.save_schedule_rules(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); c jsonb; k text; num text[] := array['max_consecutive_days', 'daily_warn_minutes', 'daily_error_minutes', 'min_break_minutes', 'break_over_minutes', 'short_break_minutes', 'short_break_over_minutes'];
begin
  perform private.require_perm('hr.write');
  if jsonb_typeof(p) <> 'object' then raise exception 'Configuração inválida' using errcode = 'P0290'; end if;
  c := private.sched_cfg(v_org);
  for k in select jsonb_object_keys(p) loop
    if not c ? k then raise exception 'Regra desconhecida: %', k using errcode = 'P0290'; end if;
    if k = any (num) then
      if jsonb_typeof(p -> k) <> 'number' or (p ->> k)::numeric < 0 then raise exception 'Valor inválido para %', k using errcode = 'P0290'; end if;
    elsif jsonb_typeof(p -> k) <> 'boolean' then raise exception 'Valor inválido para %', k using errcode = 'P0290'; end if;
  end loop;
  c := c || p;
  if (c ->> 'max_consecutive_days')::int not between 1 and 13 then raise exception 'Dias seguidos: de 1 a 13' using errcode = 'P0290'; end if;
  if (c ->> 'min_break_minutes')::int not between 0 and 240 or (c ->> 'short_break_minutes')::int not between 0 and 240 then raise exception 'Intervalo: de 0 a 240 minutos' using errcode = 'P0290'; end if;
  if (c ->> 'daily_error_minutes')::int < (c ->> 'daily_warn_minutes')::int or (c ->> 'daily_error_minutes')::int > 960 then raise exception 'O limite de erro da jornada precisa ser maior que o de alerta (até 16 h)' using errcode = 'P0290'; end if;
  insert into core.settings (org_id, key, value) values (v_org, 'schedule_rules', c) on conflict (org_id, key) do update set value = excluded.value;
  return c;
end $$;

-- Intervalo mínimo da escala: vale para turnos e horários livres
create or replace function private.check_break_min(p_org uuid, p_start time, p_end time, p_break int) returns void
language plpgsql stable security definer set search_path = '' as $$
declare c jsonb := private.sched_cfg(p_org); v_span int := private.span_minutes(p_start, p_end);
begin
  if not coalesce((c ->> 'break_rule')::boolean, true) then return; end if;
  if v_span > (c ->> 'break_over_minutes')::int and p_break < (c ->> 'min_break_minutes')::int then
    raise exception 'Jornada acima de % h precisa de intervalo de pelo menos % min (regra da escala em Turnos e picos)', round((c ->> 'break_over_minutes')::int / 60.0, 1), c ->> 'min_break_minutes' using errcode = 'P0290';
  end if;
end $$;

-- save_shift_template / set_roster_hours passam a conferir o intervalo mínimo
create or replace function private.check_shift_hours(p_start time, p_end time, p_break int) returns void
language plpgsql immutable as $$
begin
  if p_start is null or p_end is null then raise exception 'Informe o início e o fim' using errcode = 'P0290'; end if;
  if p_start = p_end then raise exception 'O início e o fim não podem ser iguais' using errcode = 'P0290'; end if;
  if coalesce(p_break, -1) < 0 or p_break > 240 then raise exception 'O intervalo vai de 0 a 240 minutos' using errcode = 'P0290'; end if;
  if p_break >= private.span_minutes(p_start, p_end) then raise exception 'O intervalo precisa ser menor que a jornada' using errcode = 'P0290'; end if;
  if private.span_minutes(p_start, p_end) > 14 * 60 then raise exception 'Jornada acima de 14 horas' using errcode = 'P0290'; end if;
end $$;

do $$
declare v_def text;
begin
  -- injeta a checagem do intervalo mínimo nas duas funções, logo depois da checagem de horário
  select pg_get_functiondef('hr.save_shift_template(jsonb)'::regprocedure) into v_def;
  v_def := replace(v_def, 'perform private.check_shift_hours(v_s, v_e, v_b);', 'perform private.check_shift_hours(v_s, v_e, v_b);' || chr(10) || '  perform private.check_break_min(v_org, v_s, v_e, v_b);');
  execute v_def;
  select pg_get_functiondef('hr.set_roster_hours(uuid,date,time without time zone,time without time zone,integer,text)'::regprocedure) into v_def;
  v_def := replace(v_def, 'perform private.check_shift_hours(p_start, p_end, p_break);', 'perform private.check_shift_hours(p_start, p_end, p_break);' || chr(10) || '  perform private.check_break_min(e.org_id, p_start, p_end, p_break);');
  execute v_def;
end $$;

-- ---------------------------------------------------------------------
-- Picos com liga/desliga
-- ---------------------------------------------------------------------
alter table hr.coverage_rules add column if not exists active boolean not null default true;

create or replace function hr.set_coverage_active(p_id uuid, p_active boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('hr.write');
  update hr.coverage_rules set active = p_active where id = p_id and org_id = private.org_id() and private.can_store(store_id);
  if not found then raise exception 'Regra não encontrada' using errcode = 'P0292'; end if;
end $$;

-- ---------------------------------------------------------------------
-- Validação da escala com as regras configuráveis
-- ---------------------------------------------------------------------
create or replace function hr.validate_roster(p_store uuid, p_from date, p_to date)
returns table (employee_id uuid, work_date date, severity text, code text, message text)
language plpgsql stable security invoker as $$
#variable_conflict use_column
declare
  c record; d date; t timestamp; t_end timestamp; n int; v_fail timestamp; cfg jsonb;
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
end $$;

-- ---------------------------------------------------------------------
-- Escala semanal padrão
-- ---------------------------------------------------------------------
create table hr.weekly_patterns (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  employee_id uuid not null references hr.employees(id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6),          -- 0 = domingo
  kind text not null check (kind in ('WORK', 'DAY_OFF')),
  shift_id uuid references hr.shift_templates(id),
  updated_at timestamptz not null default now(),
  unique (employee_id, weekday),
  check (kind <> 'WORK' or shift_id is not null)
);
select private.apply_rls('hr', array['weekly_patterns'], 'hr.read', 'hr.write');
select private.rpc_only('hr', array['weekly_patterns']);

-- Preenche rascunhos nos dias VAZIOS (ou troca rascunhos, se p_overwrite). Nunca mexe no que já foi publicado.
create or replace function private.apply_pattern_core(p_employee uuid, p_from date, p_to date, p_overwrite boolean, p_actor uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare e hr.employees; d date; w hr.weekly_patterns; sh hr.shift_templates; n int := 0; cur hr.roster;
begin
  select * into e from hr.employees where id = p_employee and status = 'ACTIVE';
  if e.id is null or e.store_id is null then return 0; end if;
  for d in select g::date from generate_series(greatest(p_from, e.hire_date)::timestamp, least(p_to, coalesce(e.termination_date, p_to))::timestamp, interval '1 day') g loop
    select * into w from hr.weekly_patterns where employee_id = e.id and weekday = extract(dow from d)::int;
    continue when w.id is null;
    select * into cur from hr.roster where employee_id = e.id and work_date = d;
    continue when cur.id is not null and (cur.status = 'PUBLISHED' or not p_overwrite);
    if w.kind = 'WORK' then
      select * into sh from hr.shift_templates where id = w.shift_id and active;
      continue when sh.id is null or private.on_vacation(e.id, d) or private.leave_overlap_days(e.id, d, d, 'ANY') > 0;
      insert into hr.roster (org_id, employee_id, store_id, work_date, kind, shift_id, start_time, end_time, break_minutes, status, updated_by)
      values (e.org_id, e.id, e.store_id, d, 'WORK', sh.id, sh.start_time, sh.end_time, sh.break_minutes, 'DRAFT', p_actor)
      on conflict (employee_id, work_date) do update set kind = 'WORK', shift_id = excluded.shift_id, start_time = excluded.start_time, end_time = excluded.end_time,
        break_minutes = excluded.break_minutes, status = 'DRAFT', updated_by = excluded.updated_by, updated_at = now() where hr.roster.status = 'DRAFT';
    else
      insert into hr.roster (org_id, employee_id, store_id, work_date, kind, status, updated_by) values (e.org_id, e.id, e.store_id, d, 'DAY_OFF', 'DRAFT', p_actor)
      on conflict (employee_id, work_date) do update set kind = 'DAY_OFF', shift_id = null, start_time = null, end_time = null, break_minutes = 0, status = 'DRAFT', updated_by = excluded.updated_by, updated_at = now()
        where hr.roster.status = 'DRAFT';
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;

-- p_days: {"0": "OFF", "1": "<uuid do turno>", "2": "<uuid>", ...}; dia ausente ou vazio = sem padrão para o dia
create or replace function hr.save_weekly_pattern(p_employee uuid, p_days jsonb, p_apply boolean default true) returns integer
language plpgsql security definer set search_path = '' as $$
declare e hr.employees; k text; v text; v_shift uuid; n int := 0;
begin
  perform private.require_perm('hr.write');
  select * into e from hr.employees where id = p_employee and org_id = private.org_id() and status = 'ACTIVE';
  if e.id is null then raise exception 'Colaborador não encontrado ou desligado' using errcode = 'P0292'; end if;
  if e.store_id is null or not private.can_store(e.store_id) then raise exception 'Sem acesso à loja do colaborador' using errcode = '42501'; end if;
  if jsonb_typeof(p_days) <> 'object' then raise exception 'Padrão inválido' using errcode = 'P0290'; end if;
  for k in select generate_series(0, 6)::text loop
    v := nullif(trim(coalesce(p_days ->> k, '')), '');
    if v is null then
      delete from hr.weekly_patterns where employee_id = e.id and weekday = k::int;
    elsif upper(v) = 'OFF' then
      insert into hr.weekly_patterns (org_id, employee_id, weekday, kind) values (e.org_id, e.id, k::int, 'DAY_OFF')
      on conflict (employee_id, weekday) do update set kind = 'DAY_OFF', shift_id = null, updated_at = now();
    else
      begin v_shift := v::uuid; exception when others then raise exception 'Turno inválido' using errcode = 'P0290'; end;
      if not exists (select 1 from hr.shift_templates where id = v_shift and org_id = e.org_id and active) then raise exception 'Turno inválido ou inativo' using errcode = 'P0290'; end if;
      insert into hr.weekly_patterns (org_id, employee_id, weekday, kind, shift_id) values (e.org_id, e.id, k::int, 'WORK', v_shift)
      on conflict (employee_id, weekday) do update set kind = 'WORK', shift_id = v_shift, updated_at = now();
    end if;
  end loop;
  if p_apply then n := private.apply_pattern_core(e.id, private.today_sp(), (date_trunc('month', private.today_sp()) + interval '3 months - 1 day')::date, false, private.member_id()); end if;
  return n;
end $$;

-- Botão "aplicar o padrão neste mês": p_overwrite troca os RASCUNHOS (o publicado nunca muda)
create or replace function hr.apply_weekly_patterns(p_store uuid, p_from date, p_to date, p_overwrite boolean default false) returns integer
language plpgsql security definer set search_path = '' as $$
declare r record; n int := 0;
begin
  perform private.require_perm('hr.write');
  if not exists (select 1 from core.stores where id = p_store and org_id = private.org_id()) or not private.can_store(p_store) then raise exception 'Loja inválida' using errcode = '42501'; end if;
  if p_to < p_from or p_to - p_from > 125 then raise exception 'Período inválido (até 4 meses)' using errcode = 'P0290'; end if;
  for r in select distinct e.id from hr.employees e join hr.weekly_patterns w on w.employee_id = e.id where e.store_id = p_store and e.status = 'ACTIVE' loop
    n := n + private.apply_pattern_core(r.id, p_from, p_to, p_overwrite, private.member_id());
  end loop;
  return n;
end $$;

-- Todo dia de madrugada: garante os próximos 60 dias (só dias vazios)
create or replace function private.apply_patterns_rolling() returns integer
language plpgsql security definer set search_path = '' as $$
declare r record; n int := 0;
begin
  for r in select distinct w.employee_id from hr.weekly_patterns w loop
    n := n + private.apply_pattern_core(r.employee_id, private.today_sp(), private.today_sp() + 60, false, null);
  end loop;
  return n;
end $$;
select cron.schedule('sie-schedule-patterns', '0 6 * * *', $$ select private.apply_patterns_rolling() $$);   -- 03:00 BRT

insert into private.internal_functions (fqname) values ('private.apply_pattern_core'), ('private.apply_patterns_rolling'), ('private.check_break_min') on conflict do nothing;
select private.lock_functions();
