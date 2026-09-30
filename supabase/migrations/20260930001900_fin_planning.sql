-- =====================================================================
-- fin: planejamento e fechamento
--   · fluxo de caixa diário (realizado + projetado pelas parcelas em aberto)
--   · recorrências (aluguel, assinaturas...) que geram os títulos do mês
--   · orçamento (versões/cenários) e orçado × realizado
--   · regras de rateio por direcionadores (receita, margem, pedidos, headcount, m²) aplicadas no fechamento
--     como lançamentos GERENCIAIS (ledger MGMT): o DRE "sem rateio" continua sendo a margem da unidade
--   · fechamento mensal com checklist
-- =====================================================================

-- ---------------------------------------------------------------------
-- Fluxo de caixa
-- Realizado: movimentos de caixa/banco (transferências entre contas próprias ficam de fora no consolidado).
-- Projetado: parcelas em aberto na data esperada; o vencido cai em "hoje".
-- ---------------------------------------------------------------------
create or replace function fin.cash_flow(p_from date, p_to date, p_entity uuid default null, p_bank uuid default null)
returns table (day date, realized_in numeric, realized_out numeric, projected_in numeric, projected_out numeric, balance numeric)
language plpgsql stable security invoker as $$
#variable_conflict use_column
declare v_today date := private.today_sp(); v_open numeric; v_pre numeric := 0;
begin
  if p_to < p_from then raise exception 'Período inválido'; end if;
  if p_to - p_from > 400 then raise exception 'Período máximo de 400 dias'; end if;

  select coalesce(sum(b.opening_balance), 0) + coalesce(sum(m.mv), 0) into v_open
  from fin.bank_accounts b
  left join lateral (
    select sum(t.amount) as mv from fin.cash_transactions t
    where t.bank_account_id = b.id and not t.voided and t.occurred_on < p_from and (b.opening_date is null or t.occurred_on >= b.opening_date)) m on true
  where b.active and (p_entity is null or b.legal_entity_id = p_entity) and (p_bank is null or b.id = p_bank);

  if p_from > v_today and p_bank is null then
    select coalesce(sum(case i.direction when 'RECEIVABLE' then i.balance else -i.balance end), 0) into v_pre
    from fin.v_open_installments i
    where (p_entity is null or i.legal_entity_id = p_entity) and greatest(coalesce(i.expected_date, i.due_date), v_today) < p_from;
  end if;

  return query
  with days as (select generate_series(p_from, p_to, interval '1 day')::date as d),
  realized as (
    select t.occurred_on as d,
           coalesce(sum(t.amount) filter (where t.amount > 0), 0) as inn, coalesce(-sum(t.amount) filter (where t.amount < 0), 0) as outt
    from fin.cash_transactions t join fin.bank_accounts b on b.id = t.bank_account_id
    where t.occurred_on between p_from and p_to and not t.voided and b.active
      and (p_entity is null or b.legal_entity_id = p_entity) and (p_bank is null or b.id = p_bank)
      and (p_bank is not null or t.kind <> 'TRANSFER')
    group by t.occurred_on
  ), projected as (
    select greatest(coalesce(i.expected_date, i.due_date), v_today) as d,
           coalesce(sum(i.balance) filter (where i.direction = 'RECEIVABLE'), 0) as inn,
           coalesce(sum(i.balance) filter (where i.direction = 'PAYABLE'), 0) as outt
    from fin.v_open_installments i
    where p_bank is null and (p_entity is null or i.legal_entity_id = p_entity)
    group by 1
  ), m as (
    select days.d, coalesce(r.inn, 0) as ri, coalesce(r.outt, 0) as ro,
           case when days.d >= v_today then coalesce(p.inn, 0) else 0 end as pi,
           case when days.d >= v_today then coalesce(p.outt, 0) else 0 end as po
    from days left join realized r on r.d = days.d left join projected p on p.d = days.d
  )
  select m.d, m.ri, m.ro, m.pi, m.po, v_open + v_pre + sum(m.ri - m.ro + m.pi - m.po) over (order by m.d)
  from m order by m.d;
end $$;

-- ---------------------------------------------------------------------
-- Recorrências
-- ---------------------------------------------------------------------
create table fin.recurring_templates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  legal_entity_id uuid not null references core.legal_entities(id),
  store_id uuid references core.stores(id),
  direction fin.title_direction not null default 'PAYABLE',
  party_id uuid references crm.parties(id),
  description text not null,
  amount numeric(14,2) not null check (amount > 0),
  day_of_month smallint not null check (day_of_month between 1 and 28),
  chart_account_id uuid references fin.chart_accounts(id),
  cost_center_id uuid references core.cost_centers(id),
  allocation_template_id uuid references fin.allocation_templates(id),
  document_kind text not null default 'RECURRING',
  auto_approve boolean not null default false,
  start_date date not null,
  end_date date,
  next_run date not null,                                    -- próxima competência (1º dia do mês) a gerar
  active boolean not null default true,
  notes text,
  created_by uuid references core.members(id),
  created_at timestamptz not null default now(),
  check (next_run = date_trunc('month', next_run)::date)
);
create index on fin.recurring_templates (org_id, active, next_run);

create or replace function fin.save_recurring(p jsonb) returns fin.recurring_templates
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id(); t fin.recurring_templates;
  v_start date := (p ->> 'start_date')::date; v_day int := (p ->> 'day_of_month')::int; v_next date;
begin
  perform private.require_perm('fin.write');
  if not exists (select 1 from core.legal_entities where id = (p ->> 'legal_entity_id')::uuid and org_id = v_org) then raise exception 'Empresa inválida'; end if;
  if v_day not between 1 and 28 then raise exception 'Dia de vencimento deve ficar entre 1 e 28'; end if;
  -- primeira competência: o mês do início, ou o seguinte se o dia já passou
  v_next := case when extract(day from v_start)::int > v_day then (date_trunc('month', v_start) + interval '1 month')::date else date_trunc('month', v_start)::date end;
  if (p ->> 'id') is not null then
    update fin.recurring_templates set description = p ->> 'description', amount = (p ->> 'amount')::numeric, day_of_month = v_day,
      party_id = (p ->> 'party_id')::uuid, chart_account_id = (p ->> 'chart_account_id')::uuid, cost_center_id = (p ->> 'cost_center_id')::uuid,
      allocation_template_id = (p ->> 'allocation_template_id')::uuid, auto_approve = coalesce((p ->> 'auto_approve')::boolean, false),
      end_date = (p ->> 'end_date')::date, active = coalesce((p ->> 'active')::boolean, true), notes = p ->> 'notes'
    where id = (p ->> 'id')::uuid and org_id = v_org returning * into t;
    if t.id is null then raise exception 'Recorrência não encontrada'; end if;
  else
    insert into fin.recurring_templates (org_id, legal_entity_id, store_id, direction, party_id, description, amount, day_of_month, chart_account_id,
                                         cost_center_id, allocation_template_id, auto_approve, start_date, end_date, next_run, notes, created_by)
    values (v_org, (p ->> 'legal_entity_id')::uuid, (p ->> 'store_id')::uuid, coalesce((p ->> 'direction')::fin.title_direction, 'PAYABLE'),
            (p ->> 'party_id')::uuid, p ->> 'description', (p ->> 'amount')::numeric, v_day, (p ->> 'chart_account_id')::uuid,
            (p ->> 'cost_center_id')::uuid, (p ->> 'allocation_template_id')::uuid, coalesce((p ->> 'auto_approve')::boolean, false),
            v_start, (p ->> 'end_date')::date, v_next, p ->> 'notes', private.member_id())
    returning * into t;
  end if;
  return t;
end $$;

-- Gera os títulos das recorrências até a data (padrão: 45 dias à frente). Idempotente por competência.
create or replace function fin.run_recurring(p_until date default null) returns int
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id(); v_actor uuid := private.member_id();
  v_until date := coalesce(p_until, private.today_sp() + 45);
  t fin.recurring_templates; v_next date; v_due date; v_n int := 0;
begin
  perform private.require_perm('fin.write');
  for t in select * from fin.recurring_templates where org_id = v_org and active order by next_run loop
    v_next := t.next_run;
    while v_next + (t.day_of_month - 1) <= v_until and (t.end_date is null or v_next <= t.end_date) loop
      v_due := v_next + (t.day_of_month - 1);
      if not exists (select 1 from fin.titles where origin_type = 'RECURRING' and origin_id = t.id and competence_date = v_next and status <> 'CANCELLED') then
        begin
          perform private.insert_title(jsonb_build_object(
            'direction', t.direction, 'legal_entity_id', t.legal_entity_id, 'store_id', t.store_id, 'party_id', t.party_id,
            'description', t.description || ' — ' || to_char(v_next, 'MM/YYYY'), 'document_kind', t.document_kind,
            'issue_date', v_next, 'competence_date', v_next, 'chart_account_id', t.chart_account_id, 'cost_center_id', t.cost_center_id,
            'allocation_template_id', t.allocation_template_id,
            'installments', jsonb_build_array(jsonb_build_object('due_date', v_due, 'amount', t.amount)),
            'origin_type', 'RECURRING', 'origin_id', t.id, 'tags', jsonb_build_array('recorrente'),
            'approval_status', case when t.auto_approve or t.direction = 'RECEIVABLE' then 'APPROVED' else 'DRAFT' end), v_actor);
          v_n := v_n + 1;
        exception when sqlstate 'P0022' then
          null;   -- mês já fechado para a empresa: não gera retroativo
        end;
      end if;
      v_next := (v_next + interval '1 month')::date;
    end loop;
    update fin.recurring_templates set next_run = v_next where id = t.id;
  end loop;
  return v_n;
end $$;

-- ---------------------------------------------------------------------
-- Orçamento
-- ---------------------------------------------------------------------
create table fin.budgets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  legal_entity_id uuid not null references core.legal_entities(id),
  year int not null check (year between 2020 and 2100),
  name text not null default 'Orçamento',
  version int not null default 1,
  scenario text not null default 'BASE' check (scenario in ('BASE', 'OPTIMISTIC', 'PESSIMISTIC')),
  status text not null default 'DRAFT' check (status in ('DRAFT', 'APPROVED', 'ARCHIVED')),
  notes text,
  created_by uuid references core.members(id),
  created_at timestamptz not null default now(),
  unique (legal_entity_id, year, version, scenario)
);

create table fin.budget_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  budget_id uuid not null references fin.budgets(id) on delete cascade,
  chart_account_id uuid not null references fin.chart_accounts(id),
  cost_center_id uuid references core.cost_centers(id),
  month date not null check (month = date_trunc('month', month)::date),
  amount numeric(14,2) not null
);
create unique index budget_lines_uq on fin.budget_lines (budget_id, chart_account_id, coalesce(cost_center_id, '00000000-0000-0000-0000-000000000000'::uuid), month);

-- p = {id?, legal_entity_id, year, name?, scenario?, notes?, replace?: bool,
--      lines:[{code | chart_account_id, month: 1..12 | 'YYYY-MM-01', amount, cost_center_id?}]}
create or replace function fin.save_budget(p jsonb) returns fin.budgets
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id(); b fin.budgets; ln jsonb; v_acc uuid; v_month date; v_year int := (p ->> 'year')::int; v_n int := 0;
begin
  perform private.require_perm('fin.approve');
  if not exists (select 1 from core.legal_entities where id = (p ->> 'legal_entity_id')::uuid and org_id = v_org) then raise exception 'Empresa inválida'; end if;
  if (p ->> 'id') is not null then
    select * into b from fin.budgets where id = (p ->> 'id')::uuid and org_id = v_org for update;
    if b.id is null then raise exception 'Orçamento não encontrado'; end if;
    if b.status = 'ARCHIVED' then raise exception 'Orçamento arquivado não pode ser alterado' using errcode = 'P0090'; end if;
    update fin.budgets set name = coalesce(p ->> 'name', name), notes = coalesce(p ->> 'notes', notes) where id = b.id returning * into b;
  else
    insert into fin.budgets (org_id, legal_entity_id, year, name, version, scenario, notes, created_by)
    values (v_org, (p ->> 'legal_entity_id')::uuid, v_year, coalesce(p ->> 'name', 'Orçamento ' || v_year),
            coalesce((select max(version) + 1 from fin.budgets where legal_entity_id = (p ->> 'legal_entity_id')::uuid and year = v_year and scenario = coalesce(p ->> 'scenario', 'BASE')), 1),
            coalesce(p ->> 'scenario', 'BASE'), p ->> 'notes', private.member_id())
    returning * into b;
  end if;
  if coalesce((p ->> 'replace')::boolean, false) then delete from fin.budget_lines where budget_id = b.id; end if;

  for ln in select * from jsonb_array_elements(coalesce(p -> 'lines', '[]')) loop
    v_acc := coalesce((ln ->> 'chart_account_id')::uuid, (select id from fin.chart_accounts where org_id = v_org and code = ln ->> 'code'));
    if v_acc is null or not exists (select 1 from fin.chart_accounts a where a.id = v_acc and a.org_id = v_org and a.kind = 'ANALYTIC'
                                    and a."group" in ('REVENUE', 'DEDUCTION', 'COGS', 'EXPENSE', 'FINANCIAL')) then
      raise exception 'Conta inválida no orçamento (%): use contas analíticas de resultado', coalesce(ln ->> 'code', ln ->> 'chart_account_id') using errcode = 'P0090';
    end if;
    v_month := case when (ln ->> 'month') ~ '^\d{1,2}$' then make_date(b.year, (ln ->> 'month')::int, 1) else date_trunc('month', (ln ->> 'month')::date)::date end;
    if extract(year from v_month) <> b.year then raise exception 'Mês fora do ano do orçamento (%)', ln ->> 'month' using errcode = 'P0090'; end if;
    insert into fin.budget_lines (org_id, budget_id, chart_account_id, cost_center_id, month, amount)
    values (v_org, b.id, v_acc, (ln ->> 'cost_center_id')::uuid, v_month, round((ln ->> 'amount')::numeric, 2))
    on conflict (budget_id, chart_account_id, coalesce(cost_center_id, '00000000-0000-0000-0000-000000000000'::uuid), month)
      do update set amount = excluded.amount;
    v_n := v_n + 1;
  end loop;
  return b;
end $$;

create or replace function fin.set_budget_status(p_budget uuid, p_status text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('fin.approve');
  if p_status not in ('DRAFT', 'APPROVED', 'ARCHIVED') then raise exception 'Situação inválida'; end if;
  update fin.budgets set status = p_status where id = p_budget and org_id = private.org_id();
end $$;

-- Orçado × realizado por conta no intervalo. Valores sempre positivos (receita = crédito − débito; despesa = débito − crédito).
create or replace function fin.budget_vs_actual(p_budget uuid, p_from date, p_to date)
returns table (account_id uuid, code text, name text, grp fin.account_group, budget numeric, actual numeric)
language plpgsql stable security invoker as $$
#variable_conflict use_column
declare b fin.budgets;
begin
  select * into b from fin.budgets where id = p_budget;
  if b.id is null then raise exception 'Orçamento não encontrado'; end if;
  return query
  with bl as (
    select l.chart_account_id as acc, sum(l.amount) as amt from fin.budget_lines l
    where l.budget_id = p_budget and l.month between date_trunc('month', p_from)::date and p_to group by 1
  ), ac as (
    select l.account_id as acc, sum(case when a.nature = 'DEBIT' then l.debit - l.credit else l.credit - l.debit end) as amt
    from fin.journal_lines l join fin.journal_entries e on e.id = l.entry_id join fin.chart_accounts a on a.id = l.account_id
    where e.legal_entity_id = b.legal_entity_id and e.entry_date between p_from and p_to
      and a."group" in ('REVENUE', 'DEDUCTION', 'COGS', 'EXPENSE', 'FINANCIAL')
    group by 1
  )
  select a.id, a.code, a.name, a."group", coalesce(bl.amt, 0), coalesce(ac.amt, 0)
  from fin.chart_accounts a
  left join bl on bl.acc = a.id left join ac on ac.acc = a.id
  where a.org_id = b.org_id and a.kind = 'ANALYTIC' and (bl.amt is not null or ac.amt is not null)
  order by a.code;
end $$;

-- ---------------------------------------------------------------------
-- Rateio por direcionadores (no fechamento) — lançamentos GERENCIAIS entre centros de custo
-- ---------------------------------------------------------------------
create table fin.allocation_rules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  legal_entity_id uuid references core.legal_entities(id),        -- vazio = todas as empresas
  name text not null,
  method text not null check (method in ('FIXED_PCT', 'REVENUE_SHARE', 'GROSS_MARGIN_SHARE', 'ORDERS_COUNT', 'HEADCOUNT', 'AREA_M2')),
  source_cost_center_id uuid not null references core.cost_centers(id),   -- pool de origem (ex.: CORP)
  account_ids uuid[],                                             -- contas de despesa do pool; vazio = todas as de despesa
  targets jsonb not null,                                         -- [{cost_center_id, pct?}]: pct só no FIXED_PCT (soma 100)
  rounding_cost_center_id uuid references core.cost_centers(id),
  active boolean not null default true,
  valid_from date not null default date '2000-01-01',
  valid_to date,
  notes text,
  created_at timestamptz not null default now()
);

create table fin.allocation_batches (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  legal_entity_id uuid not null references core.legal_entities(id),
  competence date not null check (competence = date_trunc('month', competence)::date),
  status text not null default 'APPLIED' check (status in ('APPLIED', 'REVERSED')),
  total numeric(14,2) not null default 0,
  detail jsonb not null default '[]',
  entry_ids uuid[] not null default '{}',
  created_by uuid references core.members(id),
  created_at timestamptz not null default now(),
  reversed_by uuid references core.members(id),
  reversed_at timestamptz,
  reversal_reason text
);
create unique index allocation_batches_applied_uq on fin.allocation_batches (legal_entity_id, competence) where status = 'APPLIED';

-- Valor do direcionador de um centro de custo (com filhos) no período
create or replace function private.alloc_driver(p_entity uuid, p_method text, p_cc uuid, p_from date, p_to date) returns numeric
language plpgsql stable security definer set search_path = '' as $$
declare v numeric := 0; ccs uuid[] := core.cc_subtree(p_cc);
begin
  if p_method = 'REVENUE_SHARE' then
    select coalesce(sum(l.credit - l.debit), 0) into v
    from fin.journal_lines l join fin.journal_entries e on e.id = l.entry_id join fin.chart_accounts a on a.id = l.account_id
    where e.legal_entity_id = p_entity and e.ledger = 'LEGAL' and e.entry_date between p_from and p_to and l.cost_center_id = any (ccs)
      and a."group" in ('REVENUE', 'DEDUCTION');
  elsif p_method = 'GROSS_MARGIN_SHARE' then
    select coalesce(sum(l.credit - l.debit), 0) into v
    from fin.journal_lines l join fin.journal_entries e on e.id = l.entry_id join fin.chart_accounts a on a.id = l.account_id
    where e.legal_entity_id = p_entity and e.ledger = 'LEGAL' and e.entry_date between p_from and p_to and l.cost_center_id = any (ccs)
      and a."group" in ('REVENUE', 'DEDUCTION', 'COGS');
  elsif p_method = 'ORDERS_COUNT' then
    select count(*) into v from sales.orders o
    where o.legal_entity_id = p_entity and o.profit_cost_center_id = any (ccs) and o.status not in ('DRAFT', 'CANCELLED')
      and (o.created_at at time zone 'America/Sao_Paulo')::date between p_from and p_to;
  elsif p_method = 'HEADCOUNT' then
    select count(*) into v from hr.employees e join core.stores s on s.id = e.store_id
    where e.legal_entity_id = p_entity and s.cost_center_id = any (ccs) and e.hire_date <= p_to and (e.termination_date is null or e.termination_date >= p_from);
  elsif p_method = 'AREA_M2' then
    select coalesce(sum(s.area_m2), 0) into v from core.stores s
    where s.legal_entity_id = p_entity and s.cost_center_id = any (ccs) and s.status = 'ACTIVE';
  end if;
  return greatest(v, 0);
end $$;

-- Aplica todas as regras vigentes do mês. Um lançamento gerencial por regra: cada conta do pool sai do centro de origem
-- e entra nos destinos (mantém a linha do DRE de cada despesa).
create or replace function fin.run_allocation_batch(p_entity uuid, p_competence date) returns fin.allocation_batches
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id();
  v_from date := date_trunc('month', p_competence)::date;
  v_to date := (date_trunc('month', p_competence) + interval '1 month - 1 day')::date;
  rl fin.allocation_rules; pool record; b fin.allocation_batches; tg jsonb;
  v_ccs uuid[]; v_ws numeric[]; v_amts numeric[]; v_sum numeric; v_tot numeric; v_w numeric; i int; v_lines jsonb; v_src uuid; v_entry uuid; v_ref uuid;
  v_detail jsonb := '[]'; v_entries uuid[] := '{}'; v_total numeric := 0; v_rule_total numeric; v_round uuid; v_big int;
begin
  perform private.require_perm('fin.approve');
  if not exists (select 1 from core.legal_entities where id = p_entity and org_id = v_org) then raise exception 'Empresa inválida'; end if;
  if exists (select 1 from fin.allocation_batches where legal_entity_id = p_entity and competence = v_from and status = 'APPLIED') then
    raise exception 'O rateio de %/% já foi aplicado: estorne-o antes de refazer', to_char(v_from, 'MM'), to_char(v_from, 'YYYY') using errcode = 'P0091';
  end if;
  perform private.assert_period_open(p_entity, v_to);

  insert into fin.allocation_batches (org_id, legal_entity_id, competence, created_by) values (v_org, p_entity, v_from, private.member_id()) returning * into b;

  for rl in select * from fin.allocation_rules where org_id = v_org and active and (legal_entity_id is null or legal_entity_id = p_entity)
                  and valid_from <= v_to and (valid_to is null or valid_to >= v_from) order by created_at, name loop
    v_ccs := array(select (x ->> 'cost_center_id')::uuid from jsonb_array_elements(rl.targets) x);
    if coalesce(array_length(v_ccs, 1), 0) = 0 then continue; end if;
    v_src := rl.source_cost_center_id; v_round := coalesce(rl.rounding_cost_center_id, v_ccs[1]);

    -- pesos
    if rl.method = 'FIXED_PCT' then
      v_ws := array(select coalesce((x ->> 'pct')::numeric, 0) from jsonb_array_elements(rl.targets) x);
    else
      v_ws := array(select private.alloc_driver(p_entity, rl.method, c, v_from, v_to) from unnest(v_ccs) c);
    end if;
    select coalesce(sum(w), 0) into v_tot from unnest(v_ws) w;
    if v_tot <= 0 then
      v_detail := v_detail || jsonb_build_object('rule', rl.name, 'skipped', 'sem direcionador no período');
      continue;
    end if;

    v_lines := '[]'; v_rule_total := 0;
    for pool in
      select l.account_id, sum(l.debit - l.credit) as bal
      from fin.journal_lines l join fin.journal_entries e on e.id = l.entry_id join fin.chart_accounts a on a.id = l.account_id
      where e.legal_entity_id = p_entity and e.ledger = 'LEGAL' and e.entry_date between v_from and v_to
        and l.cost_center_id = any (core.cc_subtree(v_src)) and a."group" = 'EXPENSE'
        and (rl.account_ids is null or cardinality(rl.account_ids) = 0 or l.account_id = any (rl.account_ids))
      group by l.account_id having sum(l.debit - l.credit) > 0
    loop
      v_amts := '{}'; v_sum := 0;
      for i in 1 .. array_length(v_ccs, 1) loop
        v_amts[i] := round(pool.bal * v_ws[i] / v_tot, 2);
        v_sum := v_sum + v_amts[i];
      end loop;
      -- centavos sobrantes: centro de arredondamento (ou o de maior peso)
      select t.ord into v_big from unnest(v_ws) with ordinality as t(w, ord) order by t.w desc, t.ord limit 1;
      v_amts[coalesce(array_position(v_ccs, v_round), v_big)] := v_amts[coalesce(array_position(v_ccs, v_round), v_big)] + (pool.bal - v_sum);
      v_lines := v_lines || jsonb_build_object('account_id', pool.account_id, 'cost_center_id', v_src, 'credit', pool.bal, 'memo', 'Rateio: ' || rl.name);
      for i in 1 .. array_length(v_ccs, 1) loop
        if v_amts[i] <> 0 then
          v_lines := v_lines || jsonb_build_object('account_id', pool.account_id, 'cost_center_id', v_ccs[i], 'debit', v_amts[i], 'memo', 'Rateio: ' || rl.name);
        end if;
      end loop;
      v_rule_total := v_rule_total + pool.bal;
    end loop;

    if jsonb_array_length(v_lines) > 0 then
      v_ref := gen_random_uuid();
      v_entry := private.post_entry(p_entity, v_to, 'ALLOCATION', 'fin.allocation_batches', v_ref,
        format('Rateio %s — %s', rl.name, to_char(v_from, 'MM/YYYY')), v_lines, 'MGMT');
      v_entries := v_entries || v_entry;
      v_total := v_total + v_rule_total;
      v_detail := v_detail || jsonb_build_object('rule', rl.name, 'method', rl.method, 'pool', v_rule_total, 'entry_id', v_entry,
        'weights', (select jsonb_agg(jsonb_build_object('cost_center_id', t.c, 'weight', v_ws[t.ord])) from unnest(v_ccs) with ordinality as t(c, ord)));
    else
      v_detail := v_detail || jsonb_build_object('rule', rl.name, 'skipped', 'sem despesas no pool');
    end if;
  end loop;

  update fin.allocation_batches set total = v_total, detail = v_detail, entry_ids = v_entries where id = b.id returning * into b;
  return b;
end $$;

create or replace function fin.reverse_allocation_batch(p_batch uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare b fin.allocation_batches; e uuid;
begin
  perform private.require_perm('fin.approve');
  select * into b from fin.allocation_batches where id = p_batch and org_id = private.org_id() for update;
  if b.id is null then raise exception 'Lote de rateio não encontrado'; end if;
  if b.status <> 'APPLIED' then raise exception 'O lote já foi estornado' using errcode = 'P0091'; end if;
  perform private.assert_period_open(b.legal_entity_id, (b.competence + interval '1 month - 1 day')::date);
  foreach e in array b.entry_ids loop perform private.reverse_entry(e, coalesce(p_reason, 'Estorno do rateio'), (b.competence + interval '1 month - 1 day')::date); end loop;
  update fin.allocation_batches set status = 'REVERSED', reversed_by = private.member_id(), reversed_at = now(), reversal_reason = p_reason where id = b.id;
end $$;

-- ---------------------------------------------------------------------
-- Fechamento mensal: checklist e fechamento
-- ---------------------------------------------------------------------
create or replace function fin.closing_checklist(p_entity uuid, p_competence date)
returns table (key text, label text, status text, detail text, n int, href text)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_from date := date_trunc('month', p_competence)::date;
  v_to date := (date_trunc('month', p_competence) + interval '1 month - 1 day')::date;
  v_n int; v_emps int; v_rules int; v_batch int; v_rev numeric;
begin
  perform private.require_perm('fin.read');
  if not exists (select 1 from core.legal_entities where id = p_entity and org_id = private.org_id()) then raise exception 'Empresa inválida'; end if;
  select count(*) into v_n from fin.statement_lines s where s.legal_entity_id = p_entity and s.posted_on between v_from and v_to and s.status in ('PENDING', 'PARTIAL');
  key := 'STATEMENT'; label := 'Extratos conciliados'; n := v_n; status := case when v_n = 0 then 'OK' else 'WARN' end;
  detail := case when v_n = 0 then 'Todas as linhas do extrato do mês estão conciliadas ou ignoradas' else v_n || ' linha(s) de extrato sem conciliar' end;
  href := '/financeiro/conciliacao'; return next;

  select count(*) into v_n from fin.cash_transactions t where t.legal_entity_id = p_entity and t.occurred_on between v_from and v_to and not t.reconciled and not t.voided
    and t.kind not in ('CASH_SALE');
  key := 'CASH'; label := 'Movimentos de caixa/banco conferidos'; n := v_n; status := case when v_n = 0 then 'OK' else 'WARN' end;
  detail := case when v_n = 0 then 'Todos os movimentos do mês têm lançamento no extrato' else v_n || ' movimento(s) sem par no extrato' end;
  href := '/financeiro/movimentacoes'; return next;

  select count(*) into v_n from fin.titles t where t.legal_entity_id = p_entity and t.competence_date between v_from and v_to and t.approval_status = 'DRAFT' and t.status <> 'CANCELLED';
  key := 'DRAFT_TITLES'; label := 'Contas a pagar aprovadas'; n := v_n; status := case when v_n = 0 then 'OK' else 'BLOCK' end;
  detail := case when v_n = 0 then 'Nenhum título do mês aguardando aprovação' else v_n || ' título(s) em rascunho com competência do mês' end;
  href := '/financeiro/pagar'; return next;

  select count(*) into v_emps from hr.employees e where e.legal_entity_id = p_entity and e.status = 'ACTIVE' and e.contract_type in ('CLT', 'INTERMITENTE', 'TEMPORARIO', 'APRENDIZ') and e.hire_date <= v_to;
  select count(*) into v_n from hr.payroll_runs r where r.legal_entity_id = p_entity and r.competence = v_from and r.kind = 'MONTHLY' and r.status in ('APPROVED', 'PAID');
  key := 'PAYROLL'; label := 'Folha do mês aprovada'; n := v_emps;
  status := case when v_emps = 0 or v_n > 0 then 'OK' else 'BLOCK' end;
  detail := case when v_emps = 0 then 'Sem colaboradores CLT no mês' when v_n > 0 then 'Folha aprovada' else 'Folha mensal ainda não aprovada' end;
  href := '/equipe/folha'; return next;

  select count(*) into v_n from hr.provision_runs pr where pr.legal_entity_id = p_entity and pr.competence = v_from;
  key := 'PROVISIONS'; label := 'Provisões de 13º, férias e FGTS'; n := v_n;
  status := case when v_emps = 0 or v_n > 0 then 'OK' else 'WARN' end;
  detail := case when v_emps = 0 or v_n > 0 then 'Provisionado' else 'Provisão do mês não lançada' end;
  href := '/equipe/folha'; return next;

  select count(*) into v_n from fiscal.tax_periods tp where tp.legal_entity_id = p_entity and tp.competence = v_from;
  select coalesce(sum(l.credit - l.debit), 0) into v_rev from fin.journal_lines l join fin.journal_entries e on e.id = l.entry_id join fin.chart_accounts a on a.id = l.account_id
    where e.legal_entity_id = p_entity and e.entry_date between v_from and v_to and a."group" = 'REVENUE' and e.ledger = 'LEGAL';
  key := 'DAS'; label := 'DAS do mês apurado'; n := v_n;
  status := case when v_n > 0 or v_rev <= 0 then 'OK' else 'WARN' end;
  detail := case when v_n > 0 then 'Guia gerada' when v_rev <= 0 then 'Sem receita no mês' else 'Receita apurada sem guia do DAS' end;
  href := '/fiscal'; return next;

  select count(*) into v_n from inv.stock_levels sl join inv.locations l on l.id = sl.location_id where l.legal_entity_id = p_entity and sl.on_hand < 0;
  key := 'NEGATIVE_STOCK'; label := 'Estoque sem saldo negativo'; n := v_n; status := case when v_n = 0 then 'OK' else 'WARN' end;
  detail := case when v_n = 0 then 'Nenhuma variante negativa' else v_n || ' variante(s) com saldo negativo' end;
  href := '/produtos/estoque'; return next;

  select count(*) into v_n from fin.v_open_installments i
    where i.legal_entity_id = p_entity and i.direction = 'RECEIVABLE' and i.due_date < v_to and i.days_overdue > 30;
  key := 'OVERDUE_AR'; label := 'Recebimentos em atraso (> 30 dias)'; n := v_n; status := case when v_n = 0 then 'OK' else 'WARN' end;
  detail := case when v_n = 0 then 'Sem atrasos relevantes' else v_n || ' parcela(s) a receber vencida(s) há mais de 30 dias' end;
  href := '/financeiro/receber'; return next;

  select count(*) into v_rules from fin.allocation_rules r where r.active and (r.legal_entity_id is null or r.legal_entity_id = p_entity);
  select count(*) into v_batch from fin.allocation_batches b where b.legal_entity_id = p_entity and b.competence = v_from and b.status = 'APPLIED';
  key := 'ALLOCATION'; label := 'Rateio por direcionadores'; n := v_rules;
  status := case when v_rules = 0 or v_batch > 0 then 'OK' else 'INFO' end;
  detail := case when v_rules = 0 then 'Sem regras de rateio cadastradas' when v_batch > 0 then 'Rateio aplicado' else 'Será aplicado automaticamente ao fechar' end;
  href := '/configuracoes/rateios'; return next;
end $$;

-- Fecha o mês: bloqueios impedem (salvo force), aplica o rateio se houver regras e fecha o período contábil
create or replace function fin.close_month(p_entity uuid, p_competence date, p_force boolean default false) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_from date := date_trunc('month', p_competence)::date;
  v_to date := (date_trunc('month', p_competence) + interval '1 month - 1 day')::date;
  v_block int; v_rules int;
begin
  perform private.require_perm('fin.approve');
  if not exists (select 1 from core.legal_entities where id = p_entity and org_id = private.org_id()) then raise exception 'Empresa inválida'; end if;
  if v_to >= private.today_sp() and not p_force then
    raise exception 'O mês % ainda não terminou: feche depois do último dia (ou force o fechamento)', to_char(v_from, 'MM/YYYY') using errcode = 'P0092';
  end if;
  select count(*) into v_block from fin.closing_checklist(p_entity, v_from) c where c.status = 'BLOCK';
  if v_block > 0 and not p_force then
    raise exception '% pendência(s) impedem o fechamento: resolva no checklist', v_block using errcode = 'P0092';
  end if;
  select count(*) into v_rules from fin.allocation_rules r where r.active and (r.legal_entity_id is null or r.legal_entity_id = p_entity);
  if v_rules > 0 and not exists (select 1 from fin.allocation_batches where legal_entity_id = p_entity and competence = v_from and status = 'APPLIED') then
    perform fin.run_allocation_batch(p_entity, v_from);
  end if;
  perform fin.set_period_status(p_entity, v_from, 'CLOSED', null);
end $$;

create or replace function fin.reopen_month(p_entity uuid, p_competence date, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_from date := date_trunc('month', p_competence)::date; b fin.allocation_batches;
begin
  perform private.require_perm('fin.approve');
  if coalesce(trim(p_reason), '') = '' then raise exception 'Informe o motivo da reabertura' using errcode = 'P0092'; end if;
  perform fin.set_period_status(p_entity, v_from, 'OPEN', 'Reaberto: ' || p_reason);
  select * into b from fin.allocation_batches where legal_entity_id = p_entity and competence = v_from and status = 'APPLIED';
  if b.id is not null then perform fin.reverse_allocation_batch(b.id, 'Reabertura do período: ' || p_reason); end if;
end $$;

grant execute on function fin.cash_flow(date, date, uuid, uuid), fin.budget_vs_actual(uuid, date, date), fin.closing_checklist(uuid, date) to authenticated, service_role;

select private.apply_rls('fin', array['recurring_templates', 'budgets', 'budget_lines', 'allocation_batches'], 'fin.read', 'fin.write');
select private.apply_rls('fin', array['allocation_rules'], 'fin.read', 'fin.approve');
select private.rpc_only('fin', array['budgets', 'budget_lines', 'allocation_batches', 'recurring_templates']);
