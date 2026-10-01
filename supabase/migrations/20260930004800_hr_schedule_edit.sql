-- =====================================================================
-- Equipe › Escalas editáveis: cadastro de turnos (antes só vinham do seed), horário livre por dia (sem depender de turno pronto)
-- e regras de cobertura dos picos editáveis por loja.
-- Mudar o horário de um turno atualiza as células AINDA NÃO PUBLICADAS daqui para frente; o que já foi publicado não muda.
-- Códigos de erro: P0290 dado inválido · P0291 situação não permite · P0292 não encontrado.
-- =====================================================================

alter table hr.shift_templates add column if not exists updated_at timestamptz not null default now();

-- Confere um horário de jornada: início ≠ fim, intervalo menor que a jornada (pode virar a meia-noite)
create or replace function private.check_shift_hours(p_start time, p_end time, p_break int) returns void
language plpgsql immutable as $$
begin
  if p_start is null or p_end is null then raise exception 'Informe o início e o fim' using errcode = 'P0290'; end if;
  if p_start = p_end then raise exception 'O início e o fim não podem ser iguais' using errcode = 'P0290'; end if;
  if coalesce(p_break, -1) < 0 or p_break > 240 then raise exception 'O intervalo vai de 0 a 240 minutos' using errcode = 'P0290'; end if;
  if p_break >= private.span_minutes(p_start, p_end) then raise exception 'O intervalo precisa ser menor que a jornada' using errcode = 'P0290'; end if;
  if private.span_minutes(p_start, p_end) > 14 * 60 then raise exception 'Jornada acima de 14 horas' using errcode = 'P0290'; end if;
end $$;

-- ---------------------------------------------------------------------
-- 1) Turnos
-- p = {id?, code, name?, start_time, end_time, break_minutes, color?, store_id?}
-- ---------------------------------------------------------------------
create or replace function hr.save_shift_template(p jsonb) returns hr.shift_templates
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id(); v_id uuid := nullif(p ->> 'id', '')::uuid; v_code text := upper(trim(coalesce(p ->> 'code', '')));
  v_s time; v_e time; v_b int := coalesce(nullif(p ->> 'break_minutes', '')::int, 0); v_color text := coalesce(nullif(trim(p ->> 'color'), ''), '#8a7fb0');
  v_store uuid := nullif(p ->> 'store_id', '')::uuid; v_name text; sh hr.shift_templates; old hr.shift_templates;
begin
  perform private.require_perm('hr.write');
  if v_code !~ '^[A-Z0-9]{1,4}$' then raise exception 'Sigla do turno: 1 a 4 letras ou números (aparece na grade)' using errcode = 'P0290'; end if;
  begin v_s := (p ->> 'start_time')::time; v_e := (p ->> 'end_time')::time;
  exception when others then raise exception 'Horário inválido' using errcode = 'P0290'; end;
  perform private.check_shift_hours(v_s, v_e, v_b);
  if v_color !~ '^#[0-9a-fA-F]{6}$' then raise exception 'Cor inválida' using errcode = 'P0290'; end if;
  if v_store is not null and not exists (select 1 from core.stores where id = v_store and org_id = v_org) then raise exception 'Loja inválida' using errcode = 'P0290'; end if;
  v_name := coalesce(nullif(trim(p ->> 'name'), ''), v_code);
  if length(v_name) > 60 then raise exception 'Nome do turno: até 60 caracteres' using errcode = 'P0290'; end if;

  if v_id is null then
    insert into hr.shift_templates (org_id, store_id, code, name, start_time, end_time, break_minutes, color)
    values (v_org, v_store, v_code, v_name, v_s, v_e, v_b, v_color) returning * into sh;
  else
    select * into old from hr.shift_templates where id = v_id and org_id = v_org for update;
    if old.id is null then raise exception 'Turno não encontrado' using errcode = 'P0292'; end if;
    update hr.shift_templates set code = v_code, name = v_name, start_time = v_s, end_time = v_e, break_minutes = v_b, color = v_color, store_id = v_store, updated_at = now()
    where id = v_id returning * into sh;
    -- escala ainda em rascunho, de hoje em diante, acompanha o novo horário
    update hr.roster set start_time = v_s, end_time = v_e, break_minutes = v_b, updated_by = private.member_id(), updated_at = now()
    where shift_id = v_id and status = 'DRAFT' and work_date >= private.today_sp()
      and (start_time, end_time, break_minutes) is distinct from (v_s, v_e, v_b);
  end if;
  return sh;
exception when unique_violation then
  raise exception 'Já existe um turno com a sigla %', v_code using errcode = 'P0290';
end $$;

create or replace function hr.set_shift_active(p_id uuid, p_active boolean) returns hr.shift_templates
language plpgsql security definer set search_path = '' as $$
declare sh hr.shift_templates;
begin
  perform private.require_perm('hr.write');
  update hr.shift_templates set active = p_active, updated_at = now() where id = p_id and org_id = private.org_id() returning * into sh;
  if sh.id is null then raise exception 'Turno não encontrado' using errcode = 'P0292'; end if;
  return sh;
end $$;

-- Excluir só turno que nunca entrou na escala (o que já foi usado se desativa, para não perder o histórico)
create or replace function hr.delete_shift_template(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('hr.write');
  if exists (select 1 from hr.roster where shift_id = p_id) then
    raise exception 'Este turno já foi usado na escala: desative-o em vez de excluir' using errcode = 'P0291';
  end if;
  delete from hr.shift_templates where id = p_id and org_id = private.org_id();
  if not found then raise exception 'Turno não encontrado' using errcode = 'P0292'; end if;
end $$;

-- ---------------------------------------------------------------------
-- 2) Horário livre num dia (sem turno pronto): ex. 10:00–16:00 com 30 min, só para aquela pessoa naquele dia
-- ---------------------------------------------------------------------
create or replace function hr.set_roster_hours(p_employee uuid, p_date date, p_start time, p_end time, p_break int default 60, p_notes text default null) returns hr.roster
language plpgsql security definer set search_path = '' as $$
declare e hr.employees; r hr.roster;
begin
  perform private.require_perm('hr.write');
  select * into e from hr.employees where id = p_employee and org_id = coalesce(private.org_id(), org_id) and status = 'ACTIVE';
  if e.id is null then raise exception 'Colaborador não encontrado ou desligado' using errcode = 'P0292'; end if;
  if e.store_id is null or (coalesce(auth.role(), '') = 'authenticated' and not private.can_store(e.store_id)) then
    raise exception 'Sem acesso à loja do colaborador' using errcode = '42501';
  end if;
  if p_date < e.hire_date then raise exception 'Data anterior à admissão' using errcode = 'P0291'; end if;
  perform private.check_shift_hours(p_start, p_end, p_break);
  if private.on_vacation(e.id, p_date) or private.leave_overlap_days(e.id, p_date, p_date, 'ANY') > 0 then
    raise exception 'O colaborador está de férias ou afastado nesse dia' using errcode = 'P0045';
  end if;
  insert into hr.roster (org_id, employee_id, store_id, work_date, kind, shift_id, start_time, end_time, break_minutes, status, notes, updated_by)
  values (e.org_id, e.id, e.store_id, p_date, 'WORK', null, p_start, p_end, p_break, 'DRAFT', nullif(left(trim(coalesce(p_notes, '')), 200), ''), private.member_id())
  on conflict (employee_id, work_date) do update set kind = 'WORK', shift_id = null, start_time = excluded.start_time, end_time = excluded.end_time,
    break_minutes = excluded.break_minutes, notes = excluded.notes, status = 'DRAFT', updated_by = excluded.updated_by, updated_at = now()
  returning * into r;
  return r;
end $$;

-- ---------------------------------------------------------------------
-- 3) Cobertura dos picos (por loja e dia da semana)
-- p = {id?, store_id, weekdays: [1..5] (criar) | weekday (editar), label, start_time, end_time, min_staff}
-- ---------------------------------------------------------------------
create or replace function hr.save_coverage_rule(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id(); v_id uuid := nullif(p ->> 'id', '')::uuid; v_store uuid := nullif(p ->> 'store_id', '')::uuid;
  v_label text := trim(coalesce(p ->> 'label', '')); v_s time; v_e time; v_min int := coalesce(nullif(p ->> 'min_staff', '')::int, 1);
  v_days int[]; w int; n int := 0;
begin
  perform private.require_perm('hr.write');
  if v_store is null or not exists (select 1 from core.stores where id = v_store and org_id = v_org) or not private.can_store(v_store) then
    raise exception 'Loja inválida' using errcode = 'P0290';
  end if;
  if length(v_label) not between 2 and 60 then raise exception 'Nome da janela: 2 a 60 caracteres' using errcode = 'P0290'; end if;
  begin v_s := (p ->> 'start_time')::time; v_e := (p ->> 'end_time')::time;
  exception when others then raise exception 'Horário inválido' using errcode = 'P0290'; end;
  if v_s is null or v_e is null or v_e <= v_s then raise exception 'O fim da janela precisa ser depois do início (no mesmo dia)' using errcode = 'P0290'; end if;
  if v_min not between 1 and 20 then raise exception 'Mínimo de 1 a 20 pessoas' using errcode = 'P0290'; end if;

  if v_id is not null then
    w := coalesce(nullif(p ->> 'weekday', '')::int, -1);
    if w not between 0 and 6 then raise exception 'Dia da semana inválido' using errcode = 'P0290'; end if;
    update hr.coverage_rules set weekday = w, label = v_label, start_time = v_s, end_time = v_e, min_staff = v_min
    where id = v_id and org_id = v_org and store_id = v_store;
    if not found then raise exception 'Regra não encontrada' using errcode = 'P0292'; end if;
    return 1;
  end if;

  v_days := array(select distinct x::int from jsonb_array_elements_text(coalesce(p -> 'weekdays', '[]')) x);
  if cardinality(v_days) = 0 then raise exception 'Escolha ao menos um dia da semana' using errcode = 'P0290'; end if;
  foreach w in array v_days loop
    if w not between 0 and 6 then raise exception 'Dia da semana inválido' using errcode = 'P0290'; end if;
    insert into hr.coverage_rules (org_id, store_id, weekday, label, start_time, end_time, min_staff) values (v_org, v_store, w, v_label, v_s, v_e, v_min);
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function hr.delete_coverage_rule(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('hr.write');
  delete from hr.coverage_rules where id = p_id and org_id = private.org_id() and private.can_store(store_id);
  if not found then raise exception 'Regra não encontrada' using errcode = 'P0292'; end if;
end $$;

-- Observação de um dia da escala (ex.: "cobre a Ana", "inventário")
create or replace function hr.set_roster_notes(p_employee uuid, p_date date, p_notes text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('hr.write');
  update hr.roster set notes = nullif(left(trim(coalesce(p_notes, '')), 200), ''), updated_by = private.member_id(), updated_at = now()
  where employee_id = p_employee and work_date = p_date and org_id = private.org_id() and private.can_store(store_id);
  if not found then raise exception 'Dia sem escala' using errcode = 'P0292'; end if;
end $$;

select private.lock_functions();
