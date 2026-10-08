-- =====================================================================
-- Régua de aniversário ancorada na data do aniversário.
--   • Entrada por janela: entra quem faz aniversário entre hoje e daqui a "dias antes" (e ainda não entrou neste aniversário).
--     Antes só entrava quem fazia aniversário exatamente daqui a N dias: quem já estava na janela quando a régua foi ligada
--     (ou mudou de configuração) ficava de fora — aparecia no resumo do dia, mas sem tarefa.
--   • O 1º passo conta a espera a partir de (aniversário − dias antes): com espera = dias antes, o contato sai no dia.
--   • Cupom: vale até "dias depois" da data real do aniversário (não da data de entrada).
--   • Tarefa de aniversário vence no próprio dia (20h); não fica presa no limite de contatos pessoais.
-- =====================================================================

-- Aniversário de uma data de nascimento num ano (29/02 vira 28/02 em ano comum) e o próximo a partir de um dia
create or replace function private.birthday_in_year(p_birth date, p_year int) returns date
language sql immutable set search_path = '' as $$
  select make_date(p_year, extract(month from p_birth)::int,
                   least(extract(day from p_birth)::int, extract(day from (make_date(p_year, extract(month from p_birth)::int, 1) + interval '1 month - 1 day'))::int))
$$;

create or replace function private.next_birthday(p_birth date, p_from date) returns date
language sql immutable set search_path = '' as $$
  select case when private.birthday_in_year(p_birth, extract(year from p_from)::int) >= p_from
              then private.birthday_in_year(p_birth, extract(year from p_from)::int)
              else private.birthday_in_year(p_birth, extract(year from p_from)::int + 1) end
$$;

-- Aniversário a que uma inscrição da régua se refere (null se a régua não é de aniversário)
create or replace function private.enrollment_birthday(p_enrollment uuid) returns date
language sql stable security definer set search_path = '' as $$
  select private.next_birthday(p.birth_date, (e.enrolled_at at time zone 'America/Sao_Paulo')::date)
  from mkt.journey_enrollments e join mkt.journeys j on j.id = e.journey_id join crm.parties p on p.id = e.party_id
  where e.id = p_enrollment and j.trigger = 'BIRTHDAY' and p.birth_date is not null
$$;

-- ---------------------------------------------------------------------
-- 1) Entrada por janela
-- ---------------------------------------------------------------------
create or replace function private.journey_enroll_birthday(j mkt.journeys) returns integer
language plpgsql security definer set search_path = '' as $$
declare r record; n int := 0; v_today date := private.today_sp(); v_days int := coalesce((j.trigger_config ->> 'days_before')::int, 3); v_wait numeric; v_grp text;
begin
  if j.trigger <> 'BIRTHDAY' then return 0; end if;
  select coalesce(wait_days, 0) into v_wait from mkt.journey_steps where journey_id = j.id order by position limit 1;
  for r in
    select p.id as party_id, b.bday from crm.parties p
    cross join lateral (select private.next_birthday(p.birth_date, v_today) as bday) b
    where p.org_id = j.org_id and p.birth_date is not null and p.anonymized_at is null and p.merged_into_id is null
      and b.bday between v_today and v_today + v_days
      and not exists (select 1 from crm.party_roles rl where rl.party_id = p.id and rl.role in ('EMPLOYEE', 'SUPPLIER', 'SERVICE_PROVIDER', 'CARRIER', 'ACQUIRER', 'BANK'))
      and not exists (select 1 from mkt.journey_enrollments e where e.journey_id = j.id and e.party_id = p.id
                        and (e.status = 'ACTIVE' or e.source_key = extract(year from b.bday)::int::text))
    limit 500
  loop
    v_grp := case when random() * 100 < j.holdout_pct then 'HOLDOUT' else 'TREATMENT' end;
    insert into mkt.journey_enrollments (org_id, journey_id, party_id, source_key, grp, next_run_at)
    values (j.org_id, j.id, r.party_id, extract(year from r.bday)::int::text, v_grp,
            greatest(now(), ((r.bday - v_days)::timestamp at time zone 'America/Sao_Paulo') + make_interval(secs => (coalesce(v_wait, 0) * 86400)::int)))
    on conflict do nothing;
    if found then n := n + 1; end if;
  end loop;
  return n;
end $$;

-- Prazo da tarefa: aniversário vence no dia (20h de São Paulo); as outras réguas seguem o prazo do passo
create or replace function private.journey_task_due(p_enrollment uuid, p_hours int) returns timestamptz
language plpgsql stable security definer set search_path = '' as $$
declare v_bday date := private.enrollment_birthday(p_enrollment); v_due timestamptz;
begin
  if v_bday is not null then
    v_due := (v_bday + time '20:00') at time zone 'America/Sao_Paulo';
    if v_due > now() then return v_due; end if;
  end if;
  return now() + make_interval(hours => p_hours);
end $$;

-- ---------------------------------------------------------------------
-- 2) Cupom: até "dias depois" do aniversário de verdade
-- ---------------------------------------------------------------------
create or replace function private.ensure_journey_coupon(p_enrollment uuid) returns sales.coupons
language plpgsql security definer set search_path = '' as $$
declare e mkt.journey_enrollments; j mkt.journeys; c sales.coupons; cfg jsonb; v_last date; v_try int := 0;
begin
  select * into e from mkt.journey_enrollments where id = p_enrollment;
  select * into j from mkt.journeys where id = e.journey_id;
  cfg := j.trigger_config -> 'coupon';
  if cfg is null or jsonb_typeof(cfg) <> 'object' or coalesce((cfg ->> 'enabled')::boolean, true) is not true then return null; end if;
  if e.coupon_id is not null then
    select * into c from sales.coupons where id = e.coupon_id;
    return c;
  end if;
  v_last := coalesce(private.enrollment_birthday(e.id),
                     (e.enrolled_at at time zone 'America/Sao_Paulo')::date + coalesce((j.trigger_config ->> 'days_before')::int, 0))
            + coalesce((cfg ->> 'days_after')::int, 20);
  while c.id is null and v_try < 5 loop
    v_try := v_try + 1;
    insert into sales.coupons (org_id, code, kind, value, party_id, max_uses, per_customer_limit, min_order, valid_to)
    values (e.org_id, 'ANIV-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6)), 'PERCENT', coalesce((cfg ->> 'percent')::numeric, 5), e.party_id, 1, 1,
            nullif(cfg ->> 'min_order', '')::numeric, (v_last + 1)::timestamp at time zone 'America/Sao_Paulo')
    on conflict (org_id, code) do nothing returning * into c;
  end loop;
  if c.id is null then return null; end if;
  update mkt.journey_enrollments set coupon_id = c.id where id = e.id;
  return c;
end $$;

-- ---------------------------------------------------------------------
-- 3) Motor: entrada por janela, prazo no dia, aniversário fora do limite de contatos pessoais
-- ---------------------------------------------------------------------
do $x$
declare v_def text;
begin
  select pg_get_functiondef('private.journey_enroll(mkt.journeys)'::regprocedure) into v_def;
  if position($y$where j.trigger = 'BIRTHDAY' and p.org_id = j.org_id$y$ in v_def) = 0 then raise exception 'journey_enroll mudou: ajuste este patch'; end if;
  v_def := replace(v_def, $y$where j.trigger = 'BIRTHDAY' and p.org_id = j.org_id$y$, $y$where false and j.trigger = 'BIRTHDAY' and p.org_id = j.org_id$y$);   -- agora em journey_enroll_birthday
  execute v_def;

  select pg_get_functiondef('private.run_journeys()'::regprocedure) into v_def;
  if position($y$private.journey_enroll(j) + private.journey_enroll_relations(j);$y$ in v_def) = 0
     or position($y$now() + make_interval(hours => s.due_hours), 'journey:'$y$ in v_def) = 0
     or position($y$if private.contact_block(e.party_id, 'RELATIONSHIP') is null then$y$ in v_def) = 0 then
    raise exception 'run_journeys mudou: ajuste este patch';
  end if;
  v_def := replace(v_def, $y$private.journey_enroll(j) + private.journey_enroll_relations(j);$y$,
                          $y$private.journey_enroll(j) + private.journey_enroll_relations(j) + private.journey_enroll_birthday(j);$y$);
  v_def := replace(v_def, $y$now() + make_interval(hours => s.due_hours), 'journey:'$y$, $y$private.journey_task_due(e.id, s.due_hours), 'journey:'$y$);
  v_def := replace(v_def, $y$if private.contact_block(e.party_id, 'RELATIONSHIP') is null then$y$,
    $y$if coalesce(private.contact_block(e.party_id, 'RELATIONSHIP'), 'OK') in ('OK', case when private.enrollment_birthday(e.id) is not null then 'FREQUENCY_CAP' end) then$y$);
  execute v_def;
end $x$;

-- tarefas de aniversário em aberto passam a vencer no dia do aniversário
with b as (
  select t.id, case when t.source_rule ~ '^journey:[0-9a-f-]{36}:' then private.enrollment_birthday(split_part(t.source_rule, ':', 2)::uuid) end as bday
  from crm.tasks t where t.type = 'BIRTHDAY' and t.status = 'OPEN'
)
update crm.tasks t set due_at = (b.bday + time '20:00') at time zone 'America/Sao_Paulo'
from b where b.id = t.id and b.bday >= private.today_sp();

insert into private.internal_functions (fqname) values
  ('private.enrollment_birthday'), ('private.journey_enroll_birthday'), ('private.journey_task_due')
on conflict do nothing;
select private.lock_functions();
