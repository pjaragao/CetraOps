-- =====================================================================
-- fin (razão contábil): papéis contábeis, lançamentos em partidas dobradas (imutáveis), períodos,
-- relatórios (balancete, razão, DRE) e helpers de RLS/schema para os módulos seguintes (hr, comm, purch...).
-- Todo módulo que gera efeito financeiro contabiliza por private.post_entry — uma única porta de entrada.
-- =====================================================================

create or replace function private.today_sp() returns date
language sql stable as $$ select (now() at time zone 'America/Sao_Paulo')::date $$;
grant execute on function private.today_sp() to authenticated, service_role;

-- ---------------------------------------------------------------------
-- Helpers para novos schemas de domínio (mesmo padrão da fundação)
-- ---------------------------------------------------------------------
create or replace function private.init_schema(p_schema text) returns void
language plpgsql as $$
begin
  execute format('create schema if not exists %I', p_schema);
  execute format('revoke all on schema %I from anon, public', p_schema);
  execute format('grant usage on schema %I to authenticated, service_role', p_schema);
  execute format('alter default privileges in schema %I grant select, insert, update, delete on tables to authenticated', p_schema);
  execute format('alter default privileges in schema %I grant all on tables to service_role', p_schema);
  execute format('alter default privileges in schema %I grant usage, select on sequences to authenticated, service_role', p_schema);
  execute format('alter default privileges in schema %I grant execute on functions to authenticated, service_role', p_schema);
  execute format('alter default privileges in schema %I revoke execute on functions from public, anon', p_schema);
end $$;

-- RLS padrão por tabela: leitura/escrita por permissão + escopo de loja (se houver store_id)
create or replace function private.apply_rls(p_schema text, p_tables text[], p_read text default null, p_write text default null)
returns void language plpgsql as $$
declare
  t text; has_store boolean; cr text; cw text;
  rd text := coalesce(p_read, p_schema || '.read');
  wr text := coalesce(p_write, p_schema || '.write');
begin
  foreach t in array p_tables loop
    execute format('alter table %I.%I enable row level security', p_schema, t);
    select exists (select 1 from information_schema.columns where table_schema = p_schema and table_name = t and column_name = 'store_id') into has_store;
    cr := format('org_id = (select private.org_id()) and (select private.has_perm(%L))', rd);
    cw := format('org_id = (select private.org_id()) and (select private.has_perm(%L))', wr);
    if has_store then
      cr := cr || ' and private.can_store(store_id)';
      cw := cw || ' and private.can_store(store_id)';
    end if;
    execute format('drop policy if exists p_read on %I.%I', p_schema, t);
    execute format('drop policy if exists p_insert on %I.%I', p_schema, t);
    execute format('drop policy if exists p_update on %I.%I', p_schema, t);
    execute format('drop policy if exists p_delete on %I.%I', p_schema, t);
    execute format('create policy p_read on %I.%I for select to authenticated using (%s)', p_schema, t, cr);
    execute format('create policy p_insert on %I.%I for insert to authenticated with check (%s)', p_schema, t, cw);
    execute format('create policy p_update on %I.%I for update to authenticated using (%s) with check (%s)', p_schema, t, cw, cw);
    execute format('create policy p_delete on %I.%I for delete to authenticated using (%s)', p_schema, t, cw);
  end loop;
end $$;

-- Tabelas escritas só por RPC (security definer): mantém a leitura por RLS e tira a escrita direta
create or replace function private.rpc_only(p_schema text, p_tables text[]) returns void
language plpgsql as $$
declare t text;
begin
  foreach t in array p_tables loop
    execute format('revoke insert, update, delete on %I.%I from authenticated', p_schema, t);
  end loop;
end $$;

-- Subárvore de centros de custo (para filtros do DRE por loja/CNPJ)
create or replace function core.cc_subtree(p_root uuid) returns uuid[]
language sql stable as $$
  with recursive t as (
    select id from core.cost_centers where id = p_root
    union all
    select c.id from core.cost_centers c join t on c.parent_id = t.id
  )
  select coalesce(array_agg(id), '{}') from t
$$;

-- ---------------------------------------------------------------------
-- Papéis contábeis: o código de negócio fala em papéis (SUPPLIERS, REV_POS...), não em códigos de conta
-- ---------------------------------------------------------------------
create table fin.account_roles (
  org_id uuid not null references core.orgs(id),
  role text not null,
  chart_account_id uuid not null references fin.chart_accounts(id),
  primary key (org_id, role)
);

create or replace function private.acct(p_org uuid, p_role text) returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare v uuid;
begin
  select chart_account_id into v from fin.account_roles where org_id = p_org and role = p_role;
  if v is null then
    raise exception 'Papel contábil % não configurado (Configurações › Plano de contas)', p_role using errcode = 'P0021';
  end if;
  return v;
end $$;

-- ---------------------------------------------------------------------
-- Períodos contábeis (ausência de linha = aberto)
-- ---------------------------------------------------------------------
create table fin.periods (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  legal_entity_id uuid not null references core.legal_entities(id),
  competence date not null check (competence = date_trunc('month', competence)::date),
  status text not null default 'OPEN' check (status in ('OPEN', 'CLOSED')),
  closed_by uuid references core.members(id),
  closed_at timestamptz,
  notes text,
  unique (legal_entity_id, competence)
);

create or replace function private.assert_period_open(p_entity uuid, p_date date) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if exists (select 1 from fin.periods where legal_entity_id = p_entity
             and competence = date_trunc('month', p_date)::date and status = 'CLOSED') then
    raise exception 'Período %/% está fechado para esta empresa', to_char(p_date, 'MM'), to_char(p_date, 'YYYY') using errcode = 'P0022';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Lançamentos (cabeçalho) e linhas (débito/crédito) — somente inserção
-- ledger LEGAL = contabilidade oficial; MGMT = ajustes gerenciais (rateios entre centros de custo)
-- ---------------------------------------------------------------------
create table fin.journal_entries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  legal_entity_id uuid not null references core.legal_entities(id),
  number text not null,
  ledger text not null default 'LEGAL' check (ledger in ('LEGAL', 'MGMT')),
  entry_date date not null,
  kind text not null,                      -- SALE, COGS, TITLE_ACCRUAL, SETTLEMENT, TRANSFER, CASH_MOVEMENT, PAYROLL, PROVISION, ALLOCATION, MANUAL...
  source_type text,
  source_id uuid,
  description text not null,
  reversal_of_id uuid references fin.journal_entries(id),
  created_by uuid references core.members(id),
  created_at timestamptz not null default now(),
  unique (org_id, number)
);
create unique index journal_entries_source_uq on fin.journal_entries (org_id, ledger, kind, source_type, source_id)
  where source_id is not null and reversal_of_id is null;
create unique index journal_entries_reversal_uq on fin.journal_entries (reversal_of_id) where reversal_of_id is not null;
create index on fin.journal_entries (org_id, legal_entity_id, entry_date);
create index on fin.journal_entries (source_type, source_id);

create table fin.journal_lines (
  id bigint generated always as identity primary key,
  entry_id uuid not null references fin.journal_entries(id),
  org_id uuid not null references core.orgs(id),
  line_no smallint not null,
  account_id uuid not null references fin.chart_accounts(id),
  cost_center_id uuid references core.cost_centers(id),
  party_id uuid references crm.parties(id),
  debit numeric(14,2) not null default 0 check (debit >= 0),
  credit numeric(14,2) not null default 0 check (credit >= 0),
  memo text,
  check ((debit = 0) <> (credit = 0))
);
create index on fin.journal_lines (entry_id);
create index on fin.journal_lines (org_id, account_id);
create index on fin.journal_lines (cost_center_id) where cost_center_id is not null;

create trigger trg_journal_entries_immutable before update or delete on fin.journal_entries
  for each row execute function private.forbid_mutation();
create trigger trg_journal_lines_immutable before update or delete on fin.journal_lines
  for each row execute function private.forbid_mutation();

-- Rede de segurança: no commit, cada lançamento precisa ter débitos = créditos
create or replace function private.check_entry_balance() returns trigger
language plpgsql as $$
declare d numeric; c numeric;
begin
  select coalesce(sum(debit), 0), coalesce(sum(credit), 0) into d, c from fin.journal_lines where entry_id = new.entry_id;
  if d <> c then
    raise exception 'Lançamento % desbalanceado: débitos % ≠ créditos %', new.entry_id, d, c using errcode = 'P0020';
  end if;
  return null;
end $$;
create constraint trigger trg_entry_balance after insert on fin.journal_lines
  deferrable initially deferred for each row execute function private.check_entry_balance();

-- Porta única de contabilização.
-- p_lines = [{account_id | role, cost_center_id?, party_id?, debit?, credit?, memo?}]
create or replace function private.post_entry(
  p_entity uuid, p_date date, p_kind text, p_source_type text, p_source_id uuid,
  p_description text, p_lines jsonb, p_ledger text default 'LEGAL', p_reversal_of uuid default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
  e_id uuid;
  ln jsonb;
  v_no int := 0;
  v_deb numeric := 0;
  v_cre numeric := 0;
  v_acc uuid;
  v_d numeric;
  v_c numeric;
begin
  select org_id into v_org from core.legal_entities where id = p_entity;
  if v_org is null then raise exception 'Empresa inválida para lançamento contábil'; end if;

  if p_source_id is not null and p_reversal_of is null then
    select id into e_id from fin.journal_entries
    where org_id = v_org and ledger = p_ledger and kind = p_kind and source_type = p_source_type
      and source_id = p_source_id and reversal_of_id is null;
    if e_id is not null then return e_id; end if;   -- idempotente
  end if;

  perform private.assert_period_open(p_entity, p_date);

  insert into fin.journal_entries (org_id, legal_entity_id, number, ledger, entry_date, kind, source_type, source_id,
                                   description, reversal_of_id, created_by)
  values (v_org, p_entity, core.next_number(v_org, case p_ledger when 'MGMT' then 'GER' else 'LAN' end), p_ledger, p_date,
          p_kind, p_source_type, p_source_id, p_description, p_reversal_of, private.member_id())
  returning id into e_id;

  for ln in select * from jsonb_array_elements(p_lines) loop
    v_d := round(coalesce((ln ->> 'debit')::numeric, 0), 2);
    v_c := round(coalesce((ln ->> 'credit')::numeric, 0), 2);
    if v_d = 0 and v_c = 0 then continue; end if;
    v_acc := coalesce((ln ->> 'account_id')::uuid, private.acct(v_org, ln ->> 'role'));
    if not exists (select 1 from fin.chart_accounts a where a.id = v_acc and a.org_id = v_org and a.kind = 'ANALYTIC') then
      raise exception 'Conta contábil inválida ou sintética no lançamento (%)', coalesce(ln ->> 'role', v_acc::text) using errcode = 'P0021';
    end if;
    v_no := v_no + 1;
    insert into fin.journal_lines (entry_id, org_id, line_no, account_id, cost_center_id, party_id, debit, credit, memo)
    values (e_id, v_org, v_no, v_acc, (ln ->> 'cost_center_id')::uuid, (ln ->> 'party_id')::uuid, v_d, v_c, ln ->> 'memo');
    v_deb := v_deb + v_d;
    v_cre := v_cre + v_c;
  end loop;

  if v_no < 2 or v_deb <> v_cre or v_deb = 0 then
    raise exception 'Lançamento inválido (%): débitos % ≠ créditos % ou menos de 2 linhas', p_description, v_deb, v_cre using errcode = 'P0020';
  end if;
  return e_id;
end $$;

-- Estorno: lançamento espelho com débito/crédito trocados
create or replace function private.reverse_entry(p_entry uuid, p_reason text, p_date date default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare e fin.journal_entries; v_new uuid;
begin
  select * into e from fin.journal_entries where id = p_entry;
  if e.id is null then raise exception 'Lançamento não encontrado'; end if;
  select id into v_new from fin.journal_entries where reversal_of_id = p_entry;
  if v_new is not null then return v_new; end if;
  return private.post_entry(e.legal_entity_id, coalesce(p_date, private.today_sp()), e.kind, e.source_type, e.source_id,
    'Estorno de ' || e.number || ': ' || coalesce(p_reason, e.description),
    (select coalesce(jsonb_agg(jsonb_build_object('account_id', l.account_id, 'cost_center_id', l.cost_center_id,
        'party_id', l.party_id, 'debit', l.credit, 'credit', l.debit, 'memo', l.memo) order by l.line_no), '[]')
     from fin.journal_lines l where l.entry_id = e.id),
    e.ledger, e.id);
end $$;

-- Lançamento manual (ajustes do contador/financeiro)
create or replace function fin.post_manual_entry(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('fin.approve');
  if not exists (select 1 from core.legal_entities where id = (p ->> 'legal_entity_id')::uuid and org_id = private.org_id()) then
    raise exception 'Empresa inválida';
  end if;
  return private.post_entry((p ->> 'legal_entity_id')::uuid, coalesce((p ->> 'entry_date')::date, private.today_sp()),
    'MANUAL', null, null, coalesce(p ->> 'description', 'Lançamento manual'), p -> 'lines', 'LEGAL');
end $$;

-- Fechamento e reabertura de período
create or replace function fin.set_period_status(p_entity uuid, p_competence date, p_status text, p_notes text default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('fin.approve');
  if not exists (select 1 from core.legal_entities where id = p_entity and org_id = private.org_id()) then raise exception 'Empresa inválida'; end if;
  insert into fin.periods (org_id, legal_entity_id, competence, status, closed_by, closed_at, notes)
  values (private.org_id(), p_entity, date_trunc('month', p_competence)::date, p_status,
          case when p_status = 'CLOSED' then private.member_id() end, case when p_status = 'CLOSED' then now() end, p_notes)
  on conflict (legal_entity_id, competence) do update set status = excluded.status,
    closed_by = excluded.closed_by, closed_at = excluded.closed_at, notes = coalesce(excluded.notes, fin.periods.notes);
end $$;

-- ---------------------------------------------------------------------
-- Relatórios
-- ---------------------------------------------------------------------
create or replace function fin.trial_balance(p_from date, p_to date, p_entity uuid default null, p_ledger text default 'LEGAL')
returns table (account_id uuid, code text, name text, grp fin.account_group, nature text,
               opening numeric, debit numeric, credit numeric, closing numeric)
language sql stable security invoker as $$
  select a.id, a.code, a.name, a."group", a.nature,
    coalesce(sum(case when e.entry_date < p_from then case when a.nature = 'DEBIT' then l.debit - l.credit else l.credit - l.debit end end), 0),
    coalesce(sum(case when e.entry_date >= p_from then l.debit end), 0),
    coalesce(sum(case when e.entry_date >= p_from then l.credit end), 0),
    coalesce(sum(case when a.nature = 'DEBIT' then l.debit - l.credit else l.credit - l.debit end), 0)
  from fin.chart_accounts a
  join fin.journal_lines l on l.account_id = a.id
  join fin.journal_entries e on e.id = l.entry_id
  where e.entry_date <= p_to
    and (p_entity is null or e.legal_entity_id = p_entity)
    and (p_ledger = 'ALL' or e.ledger = p_ledger)
  group by a.id, a.code, a.name, a."group", a.nature
  order by a.code
$$;

create or replace function fin.account_ledger(p_account uuid, p_from date, p_to date, p_entity uuid default null)
returns table (entry_id uuid, entry_number text, entry_date date, kind text, description text, memo text,
               cost_center_code text, debit numeric, credit numeric, running numeric)
language sql stable security invoker as $$
  with acc as (select nature from fin.chart_accounts where id = p_account),
  base as (
    select coalesce(sum(case when (select nature from acc) = 'DEBIT' then l.debit - l.credit else l.credit - l.debit end), 0) as v
    from fin.journal_lines l join fin.journal_entries e on e.id = l.entry_id
    where l.account_id = p_account and e.entry_date < p_from and (p_entity is null or e.legal_entity_id = p_entity) and e.ledger = 'LEGAL'
  ),
  mv as (
    select e.id as eid, e.number as enumber, e.entry_date as edate, e.kind as ekind, e.description as edesc, l.memo as lmemo,
           cc.code as cc, l.debit as d, l.credit as c, l.id as lid
    from fin.journal_lines l join fin.journal_entries e on e.id = l.entry_id
    left join core.cost_centers cc on cc.id = l.cost_center_id
    where l.account_id = p_account and e.entry_date between p_from and p_to and (p_entity is null or e.legal_entity_id = p_entity) and e.ledger = 'LEGAL'
  )
  select mv.eid, mv.enumber, mv.edate, mv.ekind, mv.edesc, mv.lmemo, mv.cc, mv.d, mv.c,
         (select v from base) + sum(case when (select nature from acc) = 'DEBIT' then mv.d - mv.c else mv.c - mv.d end)
           over (order by mv.edate, mv.lid)
  from mv order by mv.edate, mv.lid
$$;

-- DRE a partir do razão. ledger 'ALL' inclui os ajustes gerenciais (rateios).
-- Linhas com sign = 1 somam crédito − débito (receitas, resultado financeiro líquido); sign = −1 somam débito − crédito.
create or replace function fin.dre(p_from date, p_to date, p_entity uuid default null, p_cost_centers uuid[] default null, p_ledger text default 'ALL')
returns table (code text, name text, pos int, sign smallint, is_subtotal boolean, amount numeric)
language plpgsql stable security invoker as $$
declare
  r record;
  amounts jsonb := '{}';
  v_amt numeric;
  tok text;
  v_sign numeric;
begin
  for r in select * from fin.dre_lines order by position loop
    if not r.is_subtotal then
      select coalesce(sum(case when r.sign = 1 then l.credit - l.debit else l.debit - l.credit end), 0) into v_amt
      from fin.journal_lines l
      join fin.journal_entries e on e.id = l.entry_id
      join fin.chart_accounts a on a.id = l.account_id
      where a.dre_line_id = r.id and e.entry_date between p_from and p_to
        and (p_entity is null or e.legal_entity_id = p_entity)
        and (p_ledger = 'ALL' or e.ledger = p_ledger)
        and (p_cost_centers is null or l.cost_center_id = any (p_cost_centers));
    else
      v_amt := 0;
      for tok in select (regexp_matches(r.formula, '[+-]?[A-Z]+', 'g'))[1] loop
        v_sign := case when left(tok, 1) = '-' then -1 else 1 end;
        v_amt := v_amt + v_sign * coalesce((amounts ->> ltrim(tok, '+-'))::numeric, 0);
      end loop;
    end if;
    amounts := amounts || jsonb_build_object(r.code, v_amt);
    code := r.code; name := r.name; pos := r.position; sign := r.sign; is_subtotal := r.is_subtotal; amount := v_amt;
    return next;
  end loop;
end $$;

select private.attach_updated_at('fin');

select private.apply_rls('fin', array['account_roles', 'periods', 'journal_entries', 'journal_lines'], 'fin.read', 'fin.write');
select private.rpc_only('fin', array['journal_entries', 'journal_lines', 'periods']);

-- Papéis contábeis: só quem aprova no financeiro altera
drop policy p_insert on fin.account_roles;
drop policy p_update on fin.account_roles;
drop policy p_delete on fin.account_roles;
create policy p_admin on fin.account_roles for all to authenticated
  using (org_id = (select private.org_id()) and (select private.has_perm('fin.approve')))
  with check (org_id = (select private.org_id()) and (select private.has_perm('fin.approve')));

revoke execute on function private.post_entry(uuid, date, text, text, uuid, text, jsonb, text, uuid) from authenticated;
revoke execute on function private.reverse_entry(uuid, text, date) from authenticated;
