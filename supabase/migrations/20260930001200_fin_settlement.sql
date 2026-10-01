-- =====================================================================
-- fin: baixa (liquidação) com rateio, movimentos de caixa e composição dos títulos.
--
-- Modelo: UM movimento no banco (settlement) pode baixar N parcelas (mesmo de títulos diferentes) e carregar
-- componentes além do principal — juros, multa, desconto, taxa da adquirente, retenção, tarifa, adiantamento,
-- uso de crédito. Cada item vira linha do settlement com efeito em caixa; a soma dos efeitos TEM que fechar com
-- o valor do movimento. Cada componente é contabilizado na sua conta e no seu centro de custo — é o rateio na baixa,
-- e é ele que permite conciliar UMA linha de extrato com VÁRIOS títulos.
-- =====================================================================

alter table fin.bank_accounts add column store_id uuid references core.stores(id);

alter table fin.titles
  add column control_account_id uuid references fin.chart_accounts(id),      -- conta de controle (fornecedores, clientes...)
  add column accrual_mode text not null default 'AUTO' check (accrual_mode in ('AUTO', 'EXTERNAL')),
  add column accrual_entry_id uuid references fin.journal_entries(id);
comment on column fin.titles.accrual_mode is 'AUTO: o título contabiliza a própria competência ao ser aprovado; EXTERNAL: quem originou (vendas, folha) já contabilizou';

alter table fin.title_installments
  add column fee_anticipation_expected numeric(14,2) not null default 0;      -- parte de fee_expected que é antecipação (o resto é MDR)

-- Composição do título: conta e centro de custo de cada parte (rateio no lançamento)
create table fin.title_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  title_id uuid not null references fin.titles(id) on delete cascade,
  chart_account_id uuid not null references fin.chart_accounts(id),
  cost_center_id uuid references core.cost_centers(id),
  amount numeric(14,2) not null check (amount > 0),
  memo text
);
create index on fin.title_lines (title_id);

-- Modelos de rateio por centro de custo (ex.: Meta Ads 80% digital / 20% balcão)
create table fin.allocation_templates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  name text not null,
  description text,
  active boolean not null default true,
  unique (org_id, name)
);
create table fin.allocation_template_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  template_id uuid not null references fin.allocation_templates(id) on delete cascade,
  cost_center_id uuid not null references core.cost_centers(id),
  pct numeric(7,4) not null check (pct > 0 and pct <= 100)
);

create or replace function fin.split_by_template(p_template uuid, p_amount numeric)
returns table (cost_center_id uuid, amount numeric)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_total numeric;
  ccs uuid[]; pcts numeric[]; amts numeric[]; v_sum numeric := 0; i int; v_max int := 1;
begin
  select array_agg(l.cost_center_id order by l.pct desc, l.id), array_agg(l.pct order by l.pct desc, l.id), sum(l.pct)
    into ccs, pcts, v_total
  from fin.allocation_template_lines l join fin.allocation_templates t on t.id = l.template_id
  where l.template_id = p_template and t.org_id = private.org_id();
  if ccs is null then raise exception 'Modelo de rateio não encontrado ou vazio'; end if;
  if v_total <> 100 then raise exception 'Modelo de rateio soma % %%, precisa somar 100 %%', v_total; end if;
  for i in 1 .. array_length(ccs, 1) loop
    amts[i] := round(p_amount * pcts[i] / 100, 2);
    v_sum := v_sum + amts[i];
  end loop;
  amts[1] := amts[1] + (p_amount - v_sum);      -- centavos sobrantes vão para a maior fatia
  for i in 1 .. array_length(ccs, 1) loop
    cost_center_id := ccs[i]; amount := amts[i]; return next;
  end loop;
end $$;

-- Adiantamentos e créditos com terceiros (sobra de pagamento, adiantamento a fornecedor, sinal de cliente)
create table fin.party_credits (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  legal_entity_id uuid not null references core.legal_entities(id),
  party_id uuid references crm.parties(id),
  direction fin.title_direction not null,    -- PAYABLE: adiantamos a um fornecedor (crédito nosso) · RECEIVABLE: recebemos adiantado de um cliente
  amount numeric(14,2) not null check (amount > 0),
  used numeric(14,2) not null default 0 check (used >= 0 and used <= amount),
  status text not null default 'OPEN' check (status in ('OPEN', 'USED', 'CANCELLED')),
  source_settlement_id uuid,
  memo text,
  created_at timestamptz not null default now()
);
create index on fin.party_credits (org_id, party_id) where status = 'OPEN';

-- ---------------------------------------------------------------------
-- Baixas
-- ---------------------------------------------------------------------
create table fin.settlements (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  legal_entity_id uuid not null references core.legal_entities(id),
  number text not null,
  direction fin.title_direction not null,
  bank_account_id uuid not null references fin.bank_accounts(id),
  settled_on date not null,
  method text not null check (method in ('PIX', 'TED', 'BOLETO', 'CASH', 'CARD_PAYOUT', 'DEBIT_AUTO', 'CHECK', 'OFFSET', 'OTHER')),
  party_id uuid references crm.parties(id),
  amount numeric(14,2) not null check (amount >= 0),         -- movimento líquido no banco
  reference text,                                            -- e2eId do Pix, autenticação, nº do documento
  description text,
  status text not null default 'POSTED' check (status in ('POSTED', 'REVERSED')),
  reversal_reason text,
  reversed_at timestamptz,
  reversed_by uuid references core.members(id),
  idempotency_key text,
  created_by uuid references core.members(id),
  created_at timestamptz not null default now(),
  unique (org_id, number)
);
create unique index settlements_idem_uq on fin.settlements (org_id, idempotency_key) where idempotency_key is not null;
create index on fin.settlements (org_id, settled_on desc);
create index on fin.settlements (bank_account_id, settled_on);

alter table fin.party_credits add constraint party_credits_settlement_fk
  foreign key (source_settlement_id) references fin.settlements(id);

create table fin.settlement_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  settlement_id uuid not null references fin.settlements(id),
  line_no smallint not null,
  kind text not null check (kind in ('PRINCIPAL', 'INTEREST', 'FINE', 'CHARGE', 'ADVANCE', 'DISCOUNT', 'FEE', 'WITHHOLDING', 'CREDIT_USE')),
  installment_id uuid references fin.title_installments(id),
  chart_account_id uuid references fin.chart_accounts(id),   -- conta do componente (juros, tarifa, retenção...); vazio = padrão do papel
  cost_center_id uuid references core.cost_centers(id),      -- vazio = proporcional à composição do título
  credit_id uuid references fin.party_credits(id),
  amount numeric(14,2) not null check (amount > 0),
  cash_effect numeric(14,2) not null,                        -- + soma ao movimento, − reduz (conforme o tipo)
  memo text
);
create index on fin.settlement_lines (settlement_id);
create index on fin.settlement_lines (installment_id) where installment_id is not null;

create trigger trg_settlement_lines_immutable before update or delete on fin.settlement_lines
  for each row execute function private.forbid_mutation();

-- Cabeçalho: só o estorno pode alterar (status e motivo)
create or replace function private.guard_settlement_update() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Baixas não podem ser excluídas: estorne' using errcode = 'P0001';
  end if;
  if (to_jsonb(new) - 'status' - 'reversal_reason' - 'reversed_at' - 'reversed_by' - 'amount')
     is distinct from (to_jsonb(old) - 'status' - 'reversal_reason' - 'reversed_at' - 'reversed_by' - 'amount') then
    raise exception 'Baixa é imutável: estorne e refaça' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger trg_settlements_guard before update or delete on fin.settlements
  for each row execute function private.guard_settlement_update();

-- ---------------------------------------------------------------------
-- Movimentos de caixa/banco: a "ponta" do livro que o extrato concilia
-- ---------------------------------------------------------------------
create table fin.cash_transactions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  legal_entity_id uuid not null references core.legal_entities(id),
  bank_account_id uuid not null references fin.bank_accounts(id),
  occurred_on date not null,
  amount numeric(14,2) not null check (amount <> 0),         -- + entrada · − saída
  kind text not null check (kind in ('SETTLEMENT', 'TRANSFER', 'BANK_FEE', 'INTEREST_INCOME', 'OWNER_CONTRIBUTION',
                                     'PROFIT_DISTRIBUTION', 'LOAN', 'ADJUSTMENT', 'ACQUIRER_PAYOUT', 'CASH_SALE', 'CASH_DEPOSIT', 'OTHER')),
  settlement_id uuid references fin.settlements(id),
  transfer_group_id uuid,
  chart_account_id uuid references fin.chart_accounts(id),   -- contrapartida contábil (kinds sem baixa)
  cost_center_id uuid references core.cost_centers(id),
  party_id uuid references crm.parties(id),
  description text,
  reference text,
  reconciled_amount numeric(14,2) not null default 0,
  reconciled boolean not null default false,
  voided boolean not null default false,                     -- par estornado (anula-se sozinho)
  reversal_of_id uuid references fin.cash_transactions(id),
  journal_entry_id uuid references fin.journal_entries(id),
  created_by uuid references core.members(id),
  created_at timestamptz not null default now()
);
create index on fin.cash_transactions (bank_account_id, occurred_on);
create index on fin.cash_transactions (settlement_id) where settlement_id is not null;
create index on fin.cash_transactions (org_id, occurred_on) where not reconciled and not voided;

create or replace function private.guard_cash_tx_update() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'Movimentos não podem ser excluídos: estorne' using errcode = 'P0001'; end if;
  if (to_jsonb(new) - 'reconciled_amount' - 'reconciled' - 'voided' - 'journal_entry_id')
     is distinct from (to_jsonb(old) - 'reconciled_amount' - 'reconciled' - 'voided' - 'journal_entry_id') then
    raise exception 'Movimento é imutável: estorne' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger trg_cash_tx_guard before update or delete on fin.cash_transactions
  for each row execute function private.guard_cash_tx_update();

-- ---------------------------------------------------------------------
-- Extrato bancário e conciliação (as tabelas vêm antes das funções que as usam)
-- ---------------------------------------------------------------------
create table fin.statement_imports (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  bank_account_id uuid not null references fin.bank_accounts(id),
  source text not null check (source in ('OFX', 'CSV', 'INTER_API', 'BTG_API', 'MERCADOPAGO_API', 'PLUGGY', 'STONE', 'SIPAG_EDI', 'MANUAL')),
  filename text,
  file_hash text,
  period_start date,
  period_end date,
  opening_balance numeric(14,2),
  closing_balance numeric(14,2),
  lines_total int not null default 0,
  lines_new int not null default 0,
  created_by uuid references core.members(id),
  created_at timestamptz not null default now(),
  unique (bank_account_id, file_hash)
);

create table fin.statement_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  legal_entity_id uuid not null references core.legal_entities(id),
  bank_account_id uuid not null references fin.bank_accounts(id),
  import_id uuid references fin.statement_imports(id),
  posted_on date not null,
  amount numeric(14,2) not null check (amount <> 0),          -- + crédito · − débito (visão do banco)
  description text,
  counterpart_name text,
  counterpart_doc text,
  external_id text,
  e2e_id text,
  dedupe_key text not null,
  balance_after numeric(14,2),
  status text not null default 'PENDING' check (status in ('PENDING', 'PARTIAL', 'MATCHED', 'IGNORED')),
  matched_amount numeric(14,2) not null default 0,
  ignore_reason text,
  raw jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (bank_account_id, dedupe_key)
);
create index on fin.statement_lines (bank_account_id, posted_on);
create index on fin.statement_lines (org_id, bank_account_id) where status in ('PENDING', 'PARTIAL');

create table fin.reconciliation_links (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  statement_line_id uuid not null references fin.statement_lines(id),
  cash_transaction_id uuid not null references fin.cash_transactions(id),
  amount numeric(14,2) not null check (amount > 0),
  method text not null default 'MANUAL' check (method in ('AUTO', 'MANUAL', 'RULE', 'AI')),
  created_by uuid references core.members(id),
  created_at timestamptz not null default now(),
  unique (statement_line_id, cash_transaction_id)
);
create index on fin.reconciliation_links (cash_transaction_id);

-- Regras de classificação automática (tarifas, rendimentos, IOF...)
create table fin.recon_rules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  name text not null,
  field text not null default 'description' check (field in ('description', 'counterpart_name', 'counterpart_doc')),
  pattern text not null,                                       -- regex, sem diferenciar maiúsculas
  direction text not null default 'ANY' check (direction in ('IN', 'OUT', 'ANY')),
  action_kind text not null check (action_kind in ('BANK_FEE', 'INTEREST_INCOME', 'OWNER_CONTRIBUTION', 'PROFIT_DISTRIBUTION', 'LOAN', 'ADJUSTMENT', 'OTHER')),
  chart_account_id uuid references fin.chart_accounts(id),
  cost_center_id uuid references core.cost_centers(id),
  party_id uuid references crm.parties(id),
  priority int not null default 100,
  active boolean not null default true
);

-- Mantém os saldos conciliados dos dois lados
create or replace function private.refresh_recon() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_line uuid := coalesce(new.statement_line_id, old.statement_line_id);
  v_tx uuid := coalesce(new.cash_transaction_id, old.cash_transaction_id);
  v_l numeric;
  v_t numeric;
begin
  select coalesce(sum(amount), 0) into v_l from fin.reconciliation_links where statement_line_id = v_line;
  update fin.statement_lines l set matched_amount = v_l,
    status = case when l.status = 'IGNORED' then l.status
                  when v_l = 0 then 'PENDING' when v_l >= abs(l.amount) then 'MATCHED' else 'PARTIAL' end
  where l.id = v_line;
  select coalesce(sum(amount), 0) into v_t from fin.reconciliation_links where cash_transaction_id = v_tx;
  update fin.cash_transactions t set reconciled_amount = v_t, reconciled = (v_t >= abs(t.amount))
  where t.id = v_tx and not t.voided;
  return null;
end $$;
create trigger trg_recon_refresh after insert or delete on fin.reconciliation_links
  for each row execute function private.refresh_recon();


-- Saldo por conta: abertura + movimentos
create or replace view fin.v_bank_balances with (security_invoker = true) as
select b.id as bank_account_id, b.org_id, b.legal_entity_id, b.name, b.kind, b.bank_code,
       b.opening_balance + coalesce(sum(t.amount), 0) as balance,
       coalesce(sum(t.amount) filter (where not t.reconciled and not t.voided), 0) as unreconciled_amount,
       count(t.id) filter (where not t.reconciled and not t.voided) as unreconciled_count
from fin.bank_accounts b left join fin.cash_transactions t on t.bank_account_id = b.id
where b.active
group by b.id;

-- Parcelas em aberto com tudo que a tela de baixa precisa
create or replace view fin.v_open_installments with (security_invoker = true) as
select i.id as installment_id, i.org_id, t.id as title_id, t.legal_entity_id, t.store_id, t.direction, t.number as title_number,
       t.description, t.document_kind, t.document_number, t.origin_type, t.party_id, p.display_name as party_name,
       t.approval_status, t.cost_center_id, i.n, i.due_date, i.expected_date, i.amount, i.amount_settled,
       i.amount - i.amount_settled as balance, i.fee_expected, i.fee_anticipation_expected, i.status,
       greatest(private.today_sp() - i.due_date, 0) as days_overdue
from fin.title_installments i
join fin.titles t on t.id = i.title_id
left join crm.parties p on p.id = t.party_id
where i.status in ('OPEN', 'PARTIAL') and t.status not in ('CANCELLED', 'RENEGOTIATED');

-- ---------------------------------------------------------------------
-- Contas de controle padrão de um título
-- ---------------------------------------------------------------------
create or replace function private.default_control_account(p_title uuid) returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare t fin.titles;
begin
  select * into t from fin.titles where id = p_title;
  if t.control_account_id is not null then return t.control_account_id; end if;
  if t.direction = 'PAYABLE' then
    return private.acct(t.org_id, case t.origin_type
      when 'CONTRACT' then 'SPONSORSHIP_PAYABLE'
      when 'PAYROLL' then 'SALARIES_PAYABLE'
      when 'TAX_PERIOD' then 'TAX_PAYABLE_DAS'
      when 'COMMISSION_STATEMENT' then 'COMMISSIONS_PAYABLE'
      else 'SUPPLIERS' end);
  end if;
  return private.acct(t.org_id, case
    when t.document_kind in ('CREDIT', 'DEBIT', 'PAYMENT_LINK') then 'AR_CARD'
    when t.document_kind = 'PIX' then 'AR_PIX'
    else 'AR_B2B' end);
end $$;

-- Divide um valor entre os centros de custo da composição do título (proporcional às linhas de resultado)
create or replace function private.title_cc_split(p_title uuid, p_amount numeric)
returns table (cost_center_id uuid, amount numeric)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  ccs uuid[]; ws numeric[]; amts numeric[]; v_tot numeric; v_sum numeric := 0; i int;
begin
  select array_agg(x.cc), array_agg(x.w) into ccs, ws from (
    select tl.cost_center_id as cc, sum(tl.amount) as w
    from fin.title_lines tl join fin.chart_accounts a on a.id = tl.chart_account_id
    where tl.title_id = p_title and a."group" in ('REVENUE', 'DEDUCTION', 'COGS', 'EXPENSE', 'FINANCIAL')
    group by tl.cost_center_id order by sum(tl.amount) desc, tl.cost_center_id nulls last) x;
  if ccs is null then
    cost_center_id := (select t.cost_center_id from fin.titles t where t.id = p_title); amount := p_amount; return next; return;
  end if;
  select sum(w) into v_tot from unnest(ws) w;
  for i in 1 .. array_length(ccs, 1) loop
    amts[i] := round(p_amount * ws[i] / v_tot, 2);
    v_sum := v_sum + amts[i];
  end loop;
  amts[1] := amts[1] + (p_amount - v_sum);
  for i in 1 .. array_length(ccs, 1) loop
    cost_center_id := ccs[i]; amount := amts[i]; return next;
  end loop;
end $$;

-- Conta contábil da conta bancária
create or replace function private.bank_chart(p_bank uuid) returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare b fin.bank_accounts;
begin
  select * into b from fin.bank_accounts where id = p_bank;
  return coalesce(b.chart_account_id, private.acct(b.org_id, case b.kind when 'CASH_DRAWER' then 'CASH_DRAWER' else 'BANK_DEFAULT' end));
end $$;

-- ---------------------------------------------------------------------
-- Títulos: criação com composição (contas e centros de custo), competência e aprovação
-- p = {direction, legal_entity_id, store_id?, party_id?, description, document_kind?, document_number?,
--      issue_date?, competence_date?, chart_account_id?, cost_center_id?, allocation_template_id?,
--      lines?:[{chart_account_id, cost_center_id?, amount, memo?}],
--      installments:[{due_date, amount, barcode?}], origin_type?, origin_id?, control_account_id?, accrual_mode?, approval_status?}
-- ---------------------------------------------------------------------
create or replace function private.post_title_accrual(p_title uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  t fin.titles;
  v_lines jsonb := '[]';
  r record;
  v_ctrl uuid;
  v_fallback uuid;
  v_e uuid;
begin
  select * into t from fin.titles where id = p_title for update;
  if t.id is null or t.accrual_mode <> 'AUTO' or t.accrual_entry_id is not null or t.approval_status <> 'APPROVED' then
    return t.accrual_entry_id;
  end if;
  v_ctrl := private.default_control_account(t.id);

  if t.direction = 'PAYABLE' then
    v_lines := v_lines || jsonb_build_object('account_id', v_ctrl, 'credit', t.total_amount, 'party_id', t.party_id);
  else
    v_lines := v_lines || jsonb_build_object('account_id', v_ctrl, 'debit', t.total_amount, 'party_id', t.party_id);
  end if;

  if exists (select 1 from fin.title_lines where title_id = t.id) then
    for r in select chart_account_id, cost_center_id, sum(amount) as amount from fin.title_lines where title_id = t.id
             group by chart_account_id, cost_center_id loop
      v_lines := v_lines || case when t.direction = 'PAYABLE'
        then jsonb_build_object('account_id', r.chart_account_id, 'cost_center_id', r.cost_center_id, 'debit', r.amount, 'party_id', t.party_id)
        else jsonb_build_object('account_id', r.chart_account_id, 'cost_center_id', r.cost_center_id, 'credit', r.amount, 'party_id', t.party_id) end;
    end loop;
  else
    v_fallback := coalesce(t.chart_account_id, private.acct(t.org_id, case t.direction when 'PAYABLE' then 'UNCLASSIFIED_EXPENSE' else 'UNCLASSIFIED_REVENUE' end));
    v_lines := v_lines || case when t.direction = 'PAYABLE'
      then jsonb_build_object('account_id', v_fallback, 'cost_center_id', t.cost_center_id, 'debit', t.total_amount, 'party_id', t.party_id)
      else jsonb_build_object('account_id', v_fallback, 'cost_center_id', t.cost_center_id, 'credit', t.total_amount, 'party_id', t.party_id) end;
  end if;

  v_e := private.post_entry(t.legal_entity_id, t.competence_date, 'TITLE_ACCRUAL', 'fin.titles', t.id,
                            format('Título %s — %s', t.number, t.description), v_lines);
  update fin.titles set accrual_entry_id = v_e where id = t.id;
  return v_e;
end $$;

create or replace function private.insert_title(p jsonb, p_actor uuid) returns fin.titles
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
  t fin.titles;
  it jsonb;
  ln jsonb;
  v_n int := 0;
  v_total numeric := 0;
  v_lines_total numeric := 0;
  v_dir fin.title_direction := (p ->> 'direction')::fin.title_direction;
  v_approval text;
  r record;
begin
  select org_id into v_org from core.legal_entities where id = (p ->> 'legal_entity_id')::uuid;
  if v_org is null then raise exception 'Empresa inválida'; end if;
  if jsonb_array_length(coalesce(p -> 'installments', '[]')) = 0 then raise exception 'Informe ao menos uma parcela'; end if;
  select coalesce(sum(round((x ->> 'amount')::numeric, 2)), 0) into v_total from jsonb_array_elements(p -> 'installments') x;
  if v_total <= 0 then raise exception 'Valor total deve ser positivo'; end if;

  if p ? 'lines' and jsonb_array_length(p -> 'lines') > 0 then
    select coalesce(sum(round((x ->> 'amount')::numeric, 2)), 0) into v_lines_total from jsonb_array_elements(p -> 'lines') x;
    if v_lines_total <> v_total then
      raise exception 'A composição do título (%) precisa somar o valor total (%)', v_lines_total, v_total using errcode = 'P0024';
    end if;
  end if;

  v_approval := coalesce(p ->> 'approval_status', case when v_dir = 'RECEIVABLE' then 'APPROVED' else 'DRAFT' end);

  insert into fin.titles (org_id, legal_entity_id, store_id, direction, number, party_id, document_kind, document_number,
                          issue_date, competence_date, description, total_amount, chart_account_id, cost_center_id,
                          approval_status, approved_by, approved_at, origin_type, origin_id, control_account_id, accrual_mode,
                          tags, custom_fields, created_by)
  values (v_org, (p ->> 'legal_entity_id')::uuid, (p ->> 'store_id')::uuid, v_dir,
          core.next_number(v_org, case v_dir when 'PAYABLE' then 'PAG' else 'REC' end),
          (p ->> 'party_id')::uuid, p ->> 'document_kind', p ->> 'document_number',
          coalesce((p ->> 'issue_date')::date, private.today_sp()), coalesce((p ->> 'competence_date')::date, private.today_sp()),
          p ->> 'description', v_total, (p ->> 'chart_account_id')::uuid, (p ->> 'cost_center_id')::uuid,
          v_approval, case when v_approval = 'APPROVED' then p_actor end, case when v_approval = 'APPROVED' then now() end,
          coalesce(p ->> 'origin_type', 'MANUAL'), (p ->> 'origin_id')::uuid, (p ->> 'control_account_id')::uuid,
          coalesce(p ->> 'accrual_mode', 'AUTO'),
          coalesce(array(select jsonb_array_elements_text(p -> 'tags')), '{}'), coalesce(p -> 'custom_fields', '{}'), p_actor)
  returning * into t;

  for it in select * from jsonb_array_elements(p -> 'installments') loop
    v_n := v_n + 1;
    insert into fin.title_installments (org_id, title_id, n, due_date, expected_date, amount, barcode)
    values (v_org, t.id, v_n, (it ->> 'due_date')::date, coalesce((it ->> 'expected_date')::date, (it ->> 'due_date')::date),
            round((it ->> 'amount')::numeric, 2), it ->> 'barcode');
  end loop;

  -- Composição: linhas informadas, ou conta única × modelo de rateio, ou conta/centro únicos do cabeçalho
  if p ? 'lines' and jsonb_array_length(p -> 'lines') > 0 then
    for ln in select * from jsonb_array_elements(p -> 'lines') loop
      insert into fin.title_lines (org_id, title_id, chart_account_id, cost_center_id, amount, memo)
      values (v_org, t.id, (ln ->> 'chart_account_id')::uuid, (ln ->> 'cost_center_id')::uuid, round((ln ->> 'amount')::numeric, 2), ln ->> 'memo');
    end loop;
  elsif (p ->> 'allocation_template_id') is not null and (p ->> 'chart_account_id') is not null then
    for r in select * from fin.split_by_template((p ->> 'allocation_template_id')::uuid, v_total) loop
      insert into fin.title_lines (org_id, title_id, chart_account_id, cost_center_id, amount)
      values (v_org, t.id, (p ->> 'chart_account_id')::uuid, r.cost_center_id, r.amount);
    end loop;
  elsif (p ->> 'chart_account_id') is not null and t.accrual_mode = 'AUTO' then
    insert into fin.title_lines (org_id, title_id, chart_account_id, cost_center_id, amount)
    values (v_org, t.id, (p ->> 'chart_account_id')::uuid, (p ->> 'cost_center_id')::uuid, v_total);
  end if;

  if v_approval = 'APPROVED' then perform private.post_title_accrual(t.id); end if;
  select * into t from fin.titles where id = t.id;
  return t;
end $$;

create or replace function fin.create_title(p jsonb) returns fin.titles
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('fin.write');
  if not exists (select 1 from core.legal_entities where id = (p ->> 'legal_entity_id')::uuid and org_id = private.org_id()) then
    raise exception 'Empresa inválida';
  end if;
  -- via tela, o cliente não escolhe origem, modo de contabilização nem aprovação
  return private.insert_title(p - 'origin_type' - 'origin_id' - 'accrual_mode' - 'approval_status' - 'control_account_id', private.member_id());
end $$;

create or replace function fin.approve_title(p_title uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('fin.approve');
  update fin.titles set approval_status = 'APPROVED', approved_by = private.member_id(), approved_at = now()
  where id = p_title and org_id = private.org_id() and approval_status = 'DRAFT';
  if found then perform private.post_title_accrual(p_title); end if;
end $$;

-- Cancelar título sem baixas: estorna a competência
create or replace function fin.cancel_title(p_title uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare t fin.titles;
begin
  perform private.require_perm('fin.approve');
  select * into t from fin.titles where id = p_title and org_id = private.org_id() for update;
  if t.id is null then raise exception 'Título não encontrado'; end if;
  if t.status = 'CANCELLED' then return; end if;
  if exists (select 1 from fin.title_installments where title_id = t.id and amount_settled > 0) then
    raise exception 'Título já possui baixas: estorne as baixas antes de cancelar' using errcode = 'P0025';
  end if;
  if t.accrual_mode = 'EXTERNAL' and t.origin_type in ('ORDER', 'PAYROLL') then
    raise exception 'Título gerado por % só pode ser cancelado pela origem', t.origin_type using errcode = 'P0025';
  end if;
  if t.accrual_entry_id is not null then perform private.reverse_entry(t.accrual_entry_id, 'Cancelamento: ' || coalesce(p_reason, '')); end if;
  update fin.title_installments set status = 'CANCELLED' where title_id = t.id;
  update fin.titles set status = 'CANCELLED', tags = array_append(tags, 'cancelado') where id = t.id;
end $$;

create or replace function fin.reschedule_installment(p_installment uuid, p_due_date date, p_barcode text default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('fin.write');
  update fin.title_installments set due_date = p_due_date, expected_date = p_due_date, barcode = coalesce(p_barcode, barcode)
  where id = p_installment and org_id = private.org_id() and status in ('OPEN', 'PARTIAL');
end $$;

-- ---------------------------------------------------------------------
-- BAIXA
-- p = {bank_account_id, direction, settled_on?, method?, party_id?, amount? (movimento líquido; se vier, precisa fechar),
--      reference?, description?, idempotency_key?, statement_line_id?,
--      lines:[{kind, amount, installment_id?, chart_account_id?, cost_center_id?, credit_id?, memo?}]}
-- kinds que somam ao movimento: PRINCIPAL, INTEREST, FINE, CHARGE, ADVANCE · que reduzem: DISCOUNT, FEE, WITHHOLDING, CREDIT_USE
-- ---------------------------------------------------------------------
create or replace function fin.settle(p jsonb) returns fin.settlements
language plpgsql security definer set search_path = '' as $$
declare
  v_ba fin.bank_accounts;
  v_org uuid;
  v_dir fin.title_direction := (p ->> 'direction')::fin.title_direction;
  s fin.settlements;
  ln jsonb;
  v_kind text;
  v_amt numeric;
  v_eff numeric;
  v_sum numeric := 0;
  v_no int := 0;
  i record;
  v_credit fin.party_credits;
  v_settled_on date := coalesce((p ->> 'settled_on')::date, private.today_sp());
  v_jl jsonb := '[]';
  sl record;
  sp record;
  v_acc uuid;
  v_tx uuid;
  v_entry uuid;
  v_stmt fin.statement_lines;
  v_ctrl uuid;
begin
  perform private.require_perm('fin.write');
  select * into v_ba from fin.bank_accounts where id = (p ->> 'bank_account_id')::uuid and active;
  if v_ba.id is null then raise exception 'Conta bancária inválida ou inativa'; end if;
  v_org := v_ba.org_id;
  if coalesce(auth.role(), '') = 'authenticated' and v_org is distinct from private.org_id() then
    raise exception 'Conta bancária de outra organização' using errcode = '42501';
  end if;
  if v_dir is null then raise exception 'Informe se é pagamento ou recebimento'; end if;
  if v_settled_on > private.today_sp() then raise exception 'A data da baixa não pode ser futura'; end if;
  if jsonb_array_length(coalesce(p -> 'lines', '[]')) = 0 then raise exception 'Informe ao menos um item da baixa'; end if;

  if coalesce(p ->> 'idempotency_key', '') <> '' then
    select * into s from fin.settlements where org_id = v_org and idempotency_key = p ->> 'idempotency_key';
    if s.id is not null then return s; end if;
  end if;

  perform private.assert_period_open(v_ba.legal_entity_id, v_settled_on);

  insert into fin.settlements (org_id, legal_entity_id, number, direction, bank_account_id, settled_on, method, party_id,
                               amount, reference, description, idempotency_key, created_by)
  values (v_org, v_ba.legal_entity_id, core.next_number(v_org, 'BAI'), v_dir, v_ba.id, v_settled_on,
          coalesce(p ->> 'method', 'OTHER'), (p ->> 'party_id')::uuid, 0, p ->> 'reference', p ->> 'description',
          nullif(p ->> 'idempotency_key', ''), private.member_id())
  returning * into s;

  for ln in select * from jsonb_array_elements(p -> 'lines') loop
    v_kind := upper(coalesce(ln ->> 'kind', ''));
    v_amt := round(coalesce((ln ->> 'amount')::numeric, 0), 2);
    if v_kind not in ('PRINCIPAL', 'INTEREST', 'FINE', 'CHARGE', 'ADVANCE', 'DISCOUNT', 'FEE', 'WITHHOLDING', 'CREDIT_USE') then
      raise exception 'Tipo de item inválido: %', v_kind;
    end if;
    if v_amt <= 0 then raise exception 'Valor inválido no item % da baixa', v_kind; end if;
    if v_kind = 'FEE' and v_dir = 'PAYABLE' then raise exception 'Taxa (FEE) só existe em recebimentos; use CHARGE para tarifas pagas'; end if;
    if v_kind = 'CHARGE' and v_dir = 'RECEIVABLE' then raise exception 'Tarifa (CHARGE) só existe em pagamentos; use FEE para taxas descontadas'; end if;
    v_eff := case when v_kind in ('PRINCIPAL', 'INTEREST', 'FINE', 'CHARGE', 'ADVANCE') then v_amt else -v_amt end;

    if (ln ->> 'installment_id') is not null then
      select ti.id, ti.amount, ti.amount_settled, ti.status as istatus, t.direction, t.approval_status, t.legal_entity_id,
             t.number, t.org_id, t.status as tstatus
        into i
      from fin.title_installments ti join fin.titles t on t.id = ti.title_id
      where ti.id = (ln ->> 'installment_id')::uuid for update of ti;
      if i.id is null or i.org_id <> v_org then raise exception 'Parcela não encontrada'; end if;
      if i.direction <> v_dir then raise exception 'Parcela do título % não é de %', i.number, case v_dir when 'PAYABLE' then 'pagamento' else 'recebimento' end; end if;
      if i.legal_entity_id <> v_ba.legal_entity_id then
        raise exception 'Título % é de outra empresa (CNPJ) que a conta bancária escolhida', i.number using errcode = 'P0026';
      end if;
      if i.direction = 'PAYABLE' and i.approval_status <> 'APPROVED' then
        raise exception 'Título % precisa ser aprovado antes do pagamento', i.number using errcode = 'P0011';
      end if;
      -- juros/multa/desconto podem acompanhar uma parcela quitada NESTA MESMA baixa; qualquer outro caso exige parcela em aberto
      if i.tstatus in ('CANCELLED', 'RENEGOTIATED')
         or (i.istatus not in ('OPEN', 'PARTIAL')
             and not exists (select 1 from fin.settlement_lines x where x.settlement_id = s.id and x.installment_id = i.id and x.kind = 'PRINCIPAL')) then
        raise exception 'Parcela do título % não está em aberto', i.number using errcode = 'P0027';
      end if;
      if v_kind = 'PRINCIPAL' then
        if v_amt > i.amount - i.amount_settled then
          raise exception 'Baixa de % maior que o saldo % da parcela do título %', v_amt, i.amount - i.amount_settled, i.number using errcode = 'P0028';
        end if;
        update fin.title_installments set amount_settled = amount_settled + v_amt,
          status = case when amount_settled + v_amt >= amount then 'SETTLED'::fin.title_status else 'PARTIAL'::fin.title_status end
        where id = i.id;
      end if;
    elsif v_kind = 'PRINCIPAL' then
      raise exception 'Item PRINCIPAL exige a parcela (installment_id)';
    end if;

    if v_kind = 'CREDIT_USE' then
      select * into v_credit from fin.party_credits where id = (ln ->> 'credit_id')::uuid for update;
      if v_credit.id is null or v_credit.org_id <> v_org or v_credit.status <> 'OPEN' or v_credit.direction <> v_dir then
        raise exception 'Crédito indisponível para esta baixa';
      end if;
      if v_amt > v_credit.amount - v_credit.used then raise exception 'Crédito tem saldo de % apenas', v_credit.amount - v_credit.used; end if;
      update fin.party_credits set used = used + v_amt, status = case when used + v_amt >= amount then 'USED' else 'OPEN' end where id = v_credit.id;
    end if;

    v_no := v_no + 1;
    insert into fin.settlement_lines (org_id, settlement_id, line_no, kind, installment_id, chart_account_id, cost_center_id, credit_id, amount, cash_effect, memo)
    values (v_org, s.id, v_no, v_kind, (ln ->> 'installment_id')::uuid, (ln ->> 'chart_account_id')::uuid,
            (ln ->> 'cost_center_id')::uuid, (ln ->> 'credit_id')::uuid, v_amt, v_eff, ln ->> 'memo');

    if v_kind = 'ADVANCE' then
      insert into fin.party_credits (org_id, legal_entity_id, party_id, direction, amount, source_settlement_id, memo)
      values (v_org, v_ba.legal_entity_id, (p ->> 'party_id')::uuid, v_dir, v_amt, s.id, coalesce(ln ->> 'memo', 'Adiantamento / sobra da baixa ' || s.number));
    end if;
    v_sum := v_sum + v_eff;
  end loop;

  v_sum := round(v_sum, 2);
  if v_sum < 0 then raise exception 'Descontos, taxas e retenções (%) superam o valor a baixar', -v_sum using errcode = 'P0023'; end if;
  if (p ->> 'amount') is not null and round((p ->> 'amount')::numeric, 2) <> v_sum then
    raise exception 'A soma dos itens (%) difere do valor do movimento (%)', v_sum, round((p ->> 'amount')::numeric, 2) using errcode = 'P0023';
  end if;
  update fin.settlements set amount = v_sum where id = s.id returning * into s;

  -- Ponta financeira
  if v_sum > 0 then
    insert into fin.cash_transactions (org_id, legal_entity_id, bank_account_id, occurred_on, amount, kind, settlement_id,
                                       party_id, description, reference, created_by)
    values (v_org, v_ba.legal_entity_id, v_ba.id, v_settled_on, case v_dir when 'RECEIVABLE' then v_sum else -v_sum end,
            'SETTLEMENT', s.id, s.party_id, coalesce(s.description, 'Baixa ' || s.number), s.reference, private.member_id())
    returning id into v_tx;
  end if;

  -- Ponta contábil: cada componente na sua conta e centro de custo
  for sl in
    select l.*, ti.title_id, t.party_id as title_party
    from fin.settlement_lines l
    left join fin.title_installments ti on ti.id = l.installment_id
    left join fin.titles t on t.id = ti.title_id
    where l.settlement_id = s.id order by l.line_no
  loop
    if sl.kind = 'PRINCIPAL' then
      v_acc := private.default_control_account(sl.title_id);
      v_jl := v_jl || jsonb_build_object('account_id', v_acc, case v_dir when 'PAYABLE' then 'debit' else 'credit' end, sl.amount, 'party_id', sl.title_party);
      continue;
    end if;
    if sl.kind = 'ADVANCE' then
      v_jl := v_jl || jsonb_build_object('account_id', private.acct(v_org, case v_dir when 'PAYABLE' then 'ADVANCE_SUPPLIERS' else 'ADVANCE_CUSTOMERS' end),
                                         case v_dir when 'PAYABLE' then 'debit' else 'credit' end, sl.amount, 'party_id', s.party_id);
      continue;
    end if;
    if sl.kind = 'CREDIT_USE' then
      v_jl := v_jl || jsonb_build_object('account_id', private.acct(v_org, case v_dir when 'PAYABLE' then 'ADVANCE_SUPPLIERS' else 'ADVANCE_CUSTOMERS' end),
                                         case v_dir when 'PAYABLE' then 'credit' else 'debit' end, sl.amount, 'party_id', s.party_id);
      continue;
    end if;
    -- componentes de resultado/tributo: conta do item ou padrão do papel
    v_acc := coalesce(sl.chart_account_id, private.acct(v_org, case
      when sl.kind in ('INTEREST', 'FINE') and v_dir = 'PAYABLE' then 'INTEREST_EXPENSE'
      when sl.kind in ('INTEREST', 'FINE') then 'INTEREST_INCOME'
      when sl.kind = 'CHARGE' then 'BANK_FEES'
      when sl.kind = 'DISCOUNT' and v_dir = 'PAYABLE' then 'DISCOUNT_OBTAINED'
      when sl.kind = 'DISCOUNT' then 'DISCOUNT_GIVEN'
      when sl.kind = 'FEE' then 'MDR_EXPENSE'
      when sl.kind = 'WITHHOLDING' and v_dir = 'PAYABLE' then 'TAX_WITHHELD_PAYABLE'
      else 'TAX_RECOVERABLE' end));
    -- lado: débito para despesa/ativo, crédito para receita/passivo
    -- PAGAR:  INTEREST/FINE/CHARGE = débito · DISCOUNT/WITHHOLDING = crédito
    -- RECEBER: INTEREST/FINE = crédito · DISCOUNT/FEE/WITHHOLDING = débito
    if sl.kind in ('INTEREST', 'FINE', 'CHARGE', 'DISCOUNT', 'FEE') and sl.cost_center_id is null and sl.title_id is not null then
      for sp in select * from private.title_cc_split(sl.title_id, sl.amount) loop
        v_jl := v_jl || jsonb_build_object('account_id', v_acc, 'cost_center_id', sp.cost_center_id, 'party_id', s.party_id,
          case when (v_dir = 'PAYABLE' and sl.kind in ('INTEREST', 'FINE', 'CHARGE'))
                 or (v_dir = 'RECEIVABLE' and sl.kind in ('DISCOUNT', 'FEE')) then 'debit' else 'credit' end, sp.amount);
      end loop;
    else
      v_jl := v_jl || jsonb_build_object('account_id', v_acc, 'cost_center_id', sl.cost_center_id, 'party_id', s.party_id,
        case when (v_dir = 'PAYABLE' and sl.kind in ('INTEREST', 'FINE', 'CHARGE'))
               or (v_dir = 'RECEIVABLE' and sl.kind in ('DISCOUNT', 'FEE', 'WITHHOLDING'))
             then 'debit' else 'credit' end, sl.amount);
    end if;
  end loop;

  if v_sum > 0 then
    v_jl := v_jl || jsonb_build_object('account_id', private.bank_chart(v_ba.id), case v_dir when 'PAYABLE' then 'credit' else 'debit' end, v_sum, 'party_id', s.party_id);
  end if;
  v_entry := private.post_entry(v_ba.legal_entity_id, v_settled_on, 'SETTLEMENT', 'fin.settlements', s.id,
                                format('Baixa %s — %s', s.number, coalesce(s.description, case v_dir when 'PAYABLE' then 'pagamento' else 'recebimento' end)), v_jl);
  if v_tx is not null then update fin.cash_transactions set journal_entry_id = v_entry where id = v_tx; end if;

  -- Conciliação direta quando a baixa nasce de uma linha do extrato
  if (p ->> 'statement_line_id') is not null then
    select * into v_stmt from fin.statement_lines where id = (p ->> 'statement_line_id')::uuid for update;
    if v_stmt.id is null or v_stmt.bank_account_id <> v_ba.id then raise exception 'Linha de extrato inválida para esta conta'; end if;
    if v_stmt.status in ('MATCHED', 'IGNORED') then raise exception 'Linha de extrato já conciliada'; end if;
    if (v_dir = 'RECEIVABLE') <> (v_stmt.amount > 0) then raise exception 'O sentido da linha do extrato não bate com a baixa'; end if;
    if v_tx is null or abs(v_stmt.amount) - v_stmt.matched_amount < v_sum then
      raise exception 'Valor da baixa (%) excede o saldo a conciliar da linha (%)', v_sum, abs(v_stmt.amount) - v_stmt.matched_amount using errcode = 'P0029';
    end if;
    insert into fin.reconciliation_links (org_id, statement_line_id, cash_transaction_id, amount, method, created_by)
    values (v_org, v_stmt.id, v_tx, v_sum, 'MANUAL', private.member_id());
  end if;

  select * into s from fin.settlements where id = s.id;
  return s;
end $$;

-- Estorno da baixa: reabre parcelas, devolve créditos, estorna caixa e razão
create or replace function fin.reverse_settlement(p_settlement uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  s fin.settlements;
  sl record;
  c record;
  v_entry uuid;
  v_rev uuid;
begin
  perform private.require_perm('fin.approve');
  select * into s from fin.settlements where id = p_settlement and org_id = private.org_id() for update;
  if s.id is null then raise exception 'Baixa não encontrada'; end if;
  if s.status = 'REVERSED' then return; end if;
  perform private.assert_period_open(s.legal_entity_id, private.today_sp());

  for sl in select * from fin.settlement_lines where settlement_id = s.id loop
    if sl.kind = 'PRINCIPAL' then
      update fin.title_installments set amount_settled = amount_settled - sl.amount,
        status = case when amount_settled - sl.amount <= 0 then 'OPEN'::fin.title_status else 'PARTIAL'::fin.title_status end
      where id = sl.installment_id;
    elsif sl.kind = 'CREDIT_USE' then
      update fin.party_credits set used = used - sl.amount, status = 'OPEN' where id = sl.credit_id;
    end if;
  end loop;
  for c in select * from fin.party_credits where source_settlement_id = s.id loop
    if c.used > 0 then raise exception 'O adiantamento gerado por esta baixa já foi utilizado: estorne o uso primeiro' using errcode = 'P0030'; end if;
    update fin.party_credits set status = 'CANCELLED' where id = c.id;
  end loop;

  -- desfaz conciliações e anula o par de movimentos
  delete from fin.reconciliation_links where cash_transaction_id in (select id from fin.cash_transactions where settlement_id = s.id);
  insert into fin.cash_transactions (org_id, legal_entity_id, bank_account_id, occurred_on, amount, kind, settlement_id, party_id,
                                     description, reference, reconciled, reconciled_amount, voided, reversal_of_id, created_by)
  select t.org_id, t.legal_entity_id, t.bank_account_id, private.today_sp(), -t.amount, t.kind, t.settlement_id, t.party_id,
         'Estorno: ' || coalesce(p_reason, t.description), t.reference, true, abs(t.amount), true, t.id, private.member_id()
  from fin.cash_transactions t where t.settlement_id = s.id and t.reversal_of_id is null;
  update fin.cash_transactions set voided = true, reconciled = true, reconciled_amount = abs(amount) where settlement_id = s.id;

  select id into v_entry from fin.journal_entries where source_type = 'fin.settlements' and source_id = s.id and kind = 'SETTLEMENT' and reversal_of_id is null;
  if v_entry is not null then v_rev := private.reverse_entry(v_entry, p_reason); end if;
  update fin.settlements set status = 'REVERSED', reversal_reason = p_reason, reversed_at = now(), reversed_by = private.member_id() where id = s.id;
end $$;

-- ---------------------------------------------------------------------
-- Movimentos sem título: transferência entre contas, tarifa, aporte, distribuição, empréstimo, ajuste
-- p = {bank_account_id, kind, direction 'IN'|'OUT', amount, occurred_on?, chart_account_id?, cost_center_id?, party_id?,
--      description?, reference?, statement_line_id?}
-- ---------------------------------------------------------------------
create or replace function private.post_cash_movement(p jsonb, p_actor uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_ba fin.bank_accounts;
  v_kind text := upper(p ->> 'kind');
  v_in boolean := upper(p ->> 'direction') = 'IN';
  v_amt numeric := round((p ->> 'amount')::numeric, 2);
  v_date date := coalesce((p ->> 'occurred_on')::date, private.today_sp());
  v_counter uuid;
  v_cc uuid := (p ->> 'cost_center_id')::uuid;
  v_tx uuid;
  v_e uuid;
  v_stmt fin.statement_lines;
begin
  select * into v_ba from fin.bank_accounts where id = (p ->> 'bank_account_id')::uuid and active;
  if v_ba.id is null then raise exception 'Conta bancária inválida'; end if;
  if v_amt is null or v_amt <= 0 then raise exception 'Valor inválido'; end if;
  if v_kind not in ('BANK_FEE', 'INTEREST_INCOME', 'OWNER_CONTRIBUTION', 'PROFIT_DISTRIBUTION', 'LOAN', 'ADJUSTMENT', 'OTHER', 'CASH_DEPOSIT') then
    raise exception 'Tipo de movimento inválido: %', v_kind;
  end if;
  if v_date > private.today_sp() then raise exception 'A data do movimento não pode ser futura'; end if;
  v_counter := coalesce((p ->> 'chart_account_id')::uuid, case v_kind
    when 'BANK_FEE' then private.acct(v_ba.org_id, 'BANK_FEES')
    when 'INTEREST_INCOME' then private.acct(v_ba.org_id, 'INTEREST_INCOME_INVEST')
    when 'OWNER_CONTRIBUTION' then private.acct(v_ba.org_id, 'EQUITY_CAPITAL')
    when 'PROFIT_DISTRIBUTION' then private.acct(v_ba.org_id, 'PROFIT_DISTRIBUTION')
    when 'LOAN' then private.acct(v_ba.org_id, 'LOAN_LIABILITY')
    else null end);
  if v_counter is null then raise exception 'Informe a conta contábil da contrapartida'; end if;
  if v_kind = 'BANK_FEE' and v_in then raise exception 'Tarifa bancária é uma saída'; end if;
  if v_kind = 'INTEREST_INCOME' and not v_in then raise exception 'Rendimento é uma entrada'; end if;

  insert into fin.cash_transactions (org_id, legal_entity_id, bank_account_id, occurred_on, amount, kind, chart_account_id,
                                     cost_center_id, party_id, description, reference, created_by)
  values (v_ba.org_id, v_ba.legal_entity_id, v_ba.id, v_date, case when v_in then v_amt else -v_amt end, v_kind, v_counter, v_cc,
          (p ->> 'party_id')::uuid, coalesce(p ->> 'description', v_kind), p ->> 'reference', p_actor)
  returning id into v_tx;

  v_e := private.post_entry(v_ba.legal_entity_id, v_date, 'CASH_MOVEMENT', 'fin.cash_transactions', v_tx,
    coalesce(p ->> 'description', v_kind),
    case when v_in
      then jsonb_build_array(jsonb_build_object('account_id', private.bank_chart(v_ba.id), 'debit', v_amt),
                             jsonb_build_object('account_id', v_counter, 'cost_center_id', v_cc, 'party_id', p ->> 'party_id', 'credit', v_amt))
      else jsonb_build_array(jsonb_build_object('account_id', v_counter, 'cost_center_id', v_cc, 'party_id', p ->> 'party_id', 'debit', v_amt),
                             jsonb_build_object('account_id', private.bank_chart(v_ba.id), 'credit', v_amt)) end);
  update fin.cash_transactions set journal_entry_id = v_e where id = v_tx;

  if (p ->> 'statement_line_id') is not null then
    select * into v_stmt from fin.statement_lines where id = (p ->> 'statement_line_id')::uuid for update;
    if v_stmt.id is null or v_stmt.bank_account_id <> v_ba.id then raise exception 'Linha de extrato inválida para esta conta'; end if;
    if v_stmt.status in ('MATCHED', 'IGNORED') then raise exception 'Linha de extrato já conciliada'; end if;
    if (v_stmt.amount > 0) <> v_in or abs(v_stmt.amount) - v_stmt.matched_amount < v_amt then
      raise exception 'Sentido ou valor do movimento não bate com a linha do extrato';
    end if;
    insert into fin.reconciliation_links (org_id, statement_line_id, cash_transaction_id, amount, method, created_by)
    values (v_ba.org_id, v_stmt.id, v_tx, v_amt, 'MANUAL', p_actor);
  end if;
  return v_tx;
end $$;

create or replace function fin.post_cash_movement(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('fin.write');
  if not exists (select 1 from fin.bank_accounts where id = (p ->> 'bank_account_id')::uuid and org_id = private.org_id()) then
    raise exception 'Conta bancária inválida';
  end if;
  if upper(p ->> 'kind') in ('PROFIT_DISTRIBUTION', 'LOAN', 'OWNER_CONTRIBUTION', 'ADJUSTMENT') then
    perform private.require_perm('fin.approve');
  end if;
  return private.post_cash_movement(p, private.member_id());
end $$;

-- Transferência entre contas da mesma empresa (o sistema casa as duas pontas; não vira receita nem despesa)
-- p = {from_bank_account_id, to_bank_account_id, amount, fee?, occurred_on?, description?, reference?,
--      from_statement_line_id?, to_statement_line_id?}
create or replace function fin.transfer(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  a fin.bank_accounts;
  b fin.bank_accounts;
  v_amt numeric := round((p ->> 'amount')::numeric, 2);
  v_fee numeric := round(coalesce((p ->> 'fee')::numeric, 0), 2);
  v_date date := coalesce((p ->> 'occurred_on')::date, private.today_sp());
  v_group uuid := gen_random_uuid();
  v_tx_out uuid;
  v_tx_in uuid;
  v_tx_fee uuid;
  v_lines jsonb;
  v_e uuid;
  v_desc text := coalesce(p ->> 'description', 'Transferência entre contas');
  v_stmt fin.statement_lines;
  v_side text;
  v_sid uuid;
  v_tx uuid;
  v_expected_ba uuid;
begin
  perform private.require_perm('fin.write');
  select * into a from fin.bank_accounts where id = (p ->> 'from_bank_account_id')::uuid and org_id = private.org_id() and active;
  select * into b from fin.bank_accounts where id = (p ->> 'to_bank_account_id')::uuid and org_id = private.org_id() and active;
  if a.id is null or b.id is null then raise exception 'Contas de origem/destino inválidas'; end if;
  if a.id = b.id then raise exception 'Origem e destino devem ser contas diferentes'; end if;
  if a.legal_entity_id <> b.legal_entity_id then
    raise exception 'Transferência entre CNPJs diferentes é operação intercompany (empréstimo/aporte): registre com o contador' using errcode = 'P0026';
  end if;
  if v_amt is null or v_amt <= 0 then raise exception 'Valor inválido'; end if;
  if v_date > private.today_sp() then raise exception 'A data não pode ser futura'; end if;

  insert into fin.cash_transactions (org_id, legal_entity_id, bank_account_id, occurred_on, amount, kind, transfer_group_id, description, reference, created_by)
  values (a.org_id, a.legal_entity_id, a.id, v_date, -v_amt, 'TRANSFER', v_group, v_desc, p ->> 'reference', private.member_id()) returning id into v_tx_out;
  insert into fin.cash_transactions (org_id, legal_entity_id, bank_account_id, occurred_on, amount, kind, transfer_group_id, description, reference, created_by)
  values (b.org_id, b.legal_entity_id, b.id, v_date, v_amt, 'TRANSFER', v_group, v_desc, p ->> 'reference', private.member_id()) returning id into v_tx_in;

  v_lines := jsonb_build_array(
    jsonb_build_object('account_id', private.bank_chart(b.id), 'debit', v_amt),
    jsonb_build_object('account_id', private.bank_chart(a.id), 'credit', v_amt));
  if v_fee > 0 then
    insert into fin.cash_transactions (org_id, legal_entity_id, bank_account_id, occurred_on, amount, kind, transfer_group_id, description, created_by, chart_account_id)
    values (a.org_id, a.legal_entity_id, a.id, v_date, -v_fee, 'BANK_FEE', v_group, 'Tarifa da transferência', private.member_id(), private.acct(a.org_id, 'BANK_FEES'))
    returning id into v_tx_fee;
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('account_id', private.acct(a.org_id, 'BANK_FEES'), 'debit', v_fee),
      jsonb_build_object('account_id', private.bank_chart(a.id), 'credit', v_fee));
  end if;
  v_e := private.post_entry(a.legal_entity_id, v_date, 'TRANSFER', 'fin.cash_transactions', v_tx_out, v_desc, v_lines);
  update fin.cash_transactions set journal_entry_id = v_e where transfer_group_id = v_group;

  -- conciliação das duas pontas, se vierem do extrato
  foreach v_side in array array['from', 'to'] loop
    v_sid := (p ->> (v_side || '_statement_line_id'))::uuid;
    if v_sid is not null then
      select * into v_stmt from fin.statement_lines where id = v_sid for update;
      v_tx := case v_side when 'from' then v_tx_out else v_tx_in end;
      v_expected_ba := case v_side when 'from' then a.id else b.id end;
      if v_stmt.id is null or v_stmt.bank_account_id <> v_expected_ba or v_stmt.status in ('MATCHED', 'IGNORED') or abs(v_stmt.amount) <> v_amt then
        raise exception 'Linha de extrato (%) inválida para a transferência', v_side;
      end if;
      insert into fin.reconciliation_links (org_id, statement_line_id, cash_transaction_id, amount, method, created_by)
      values (a.org_id, v_stmt.id, v_tx, v_amt, 'MANUAL', private.member_id());
    end if;
  end loop;
  return v_group;
end $$;

-- ---------------------------------------------------------------------
-- Auditoria de taxa da adquirente: cobrado (FEE na baixa) × esperado (tabela vigente na venda)
-- ---------------------------------------------------------------------
create or replace view fin.v_fee_audit with (security_invoker = true) as
select sl.org_id, s.id as settlement_id, s.number as settlement_number, s.settled_on, sl.installment_id, t.number as title_number,
       t.description, i.amount as gross, sum(sl.amount) as fee_charged, i.fee_expected, sum(sl.amount) - i.fee_expected as variance
from fin.settlement_lines sl
join fin.settlements s on s.id = sl.settlement_id and s.status = 'POSTED'
join fin.title_installments i on i.id = sl.installment_id
join fin.titles t on t.id = i.title_id
where sl.kind = 'FEE'
group by sl.org_id, s.id, s.number, s.settled_on, sl.installment_id, t.number, t.description, i.amount, i.fee_expected;

-- p = {bank_account_id, source, filename?, file_hash?, period_start?, period_end?, opening_balance?, closing_balance?,
--      lines:[{posted_on, amount, description?, external_id?, e2e_id?, counterpart_name?, counterpart_doc?, balance_after?}]}
create or replace function fin.import_statement(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ba fin.bank_accounts;
  imp fin.statement_imports;
  ln jsonb;
  v_base text;
  v_key text;
  v_occ int;
  seen jsonb := '{}';
  v_new int := 0;
  v_total int := 0;
  v_ins int;
begin
  perform private.require_perm('fin.write');
  select * into v_ba from fin.bank_accounts where id = (p ->> 'bank_account_id')::uuid and org_id = private.org_id();
  if v_ba.id is null then raise exception 'Conta bancária inválida'; end if;
  if jsonb_array_length(coalesce(p -> 'lines', '[]')) = 0 then raise exception 'O arquivo não trouxe lançamentos'; end if;

  if coalesce(p ->> 'file_hash', '') <> '' then
    select * into imp from fin.statement_imports where bank_account_id = v_ba.id and file_hash = p ->> 'file_hash';
    if imp.id is not null then
      return jsonb_build_object('import_id', imp.id, 'duplicate_file', true, 'inserted', 0, 'total', imp.lines_total);
    end if;
  end if;

  insert into fin.statement_imports (org_id, bank_account_id, source, filename, file_hash, period_start, period_end,
                                     opening_balance, closing_balance, created_by)
  values (v_ba.org_id, v_ba.id, coalesce(p ->> 'source', 'MANUAL'), p ->> 'filename', nullif(p ->> 'file_hash', ''),
          (p ->> 'period_start')::date, (p ->> 'period_end')::date,
          (p ->> 'opening_balance')::numeric, (p ->> 'closing_balance')::numeric, private.member_id())
  returning * into imp;

  for ln in select * from jsonb_array_elements(p -> 'lines') loop
    v_total := v_total + 1;
    if coalesce((ln ->> 'amount')::numeric, 0) = 0 then continue; end if;
    v_base := coalesce(nullif(ln ->> 'external_id', ''),
                       md5(concat_ws('|', ln ->> 'posted_on', ln ->> 'amount', lower(coalesce(ln ->> 'description', '')))));
    v_occ := coalesce((seen ->> v_base)::int, 0) + 1;
    seen := seen || jsonb_build_object(v_base, v_occ);
    v_key := case when nullif(ln ->> 'external_id', '') is not null then v_base else v_base || ':' || v_occ end;
    insert into fin.statement_lines (org_id, legal_entity_id, bank_account_id, import_id, posted_on, amount, description,
                                     counterpart_name, counterpart_doc, external_id, e2e_id, dedupe_key, balance_after, raw)
    values (v_ba.org_id, v_ba.legal_entity_id, v_ba.id, imp.id, (ln ->> 'posted_on')::date, round((ln ->> 'amount')::numeric, 2),
            ln ->> 'description', ln ->> 'counterpart_name', ln ->> 'counterpart_doc', nullif(ln ->> 'external_id', ''),
            nullif(ln ->> 'e2e_id', ''), v_key, (ln ->> 'balance_after')::numeric, ln)
    on conflict (bank_account_id, dedupe_key) do nothing;
    get diagnostics v_ins = row_count;
    v_new := v_new + v_ins;
  end loop;
  update fin.statement_imports set lines_total = v_total, lines_new = v_new where id = imp.id;
  return jsonb_build_object('import_id', imp.id, 'duplicate_file', false, 'inserted', v_new, 'total', v_total);
end $$;

-- Casa linhas do extrato com movimentos já lançados: mesmo valor, data próxima; só liga quando não há ambiguidade
create or replace function fin.auto_match(p_bank_account uuid, p_days int default 3) returns int
language plpgsql security definer set search_path = '' as $$
declare
  l record;
  v_cands uuid[];
  v_pick uuid;
  v_n int := 0;
begin
  perform private.require_perm('fin.write');
  if not exists (select 1 from fin.bank_accounts where id = p_bank_account and org_id = private.org_id()) then
    raise exception 'Conta bancária inválida';
  end if;
  for l in select * from fin.statement_lines where bank_account_id = p_bank_account and status = 'PENDING' order by posted_on, id loop
    select array_agg(t.id order by abs(t.occurred_on - l.posted_on), t.created_at) into v_cands
    from fin.cash_transactions t
    where t.bank_account_id = l.bank_account_id and not t.voided and t.reconciled_amount = 0
      and t.amount = l.amount and abs(t.occurred_on - l.posted_on) <= p_days;
    v_pick := null;
    if v_cands is not null then
      if array_length(v_cands, 1) = 1 then
        v_pick := v_cands[1];
      else
        -- referência (e2eId/nº de documento) resolve empates
        select t.id into v_pick from fin.cash_transactions t
        where t.id = any (v_cands) and t.reference is not null and t.reference in (l.e2e_id, l.external_id) limit 1;
      end if;
    end if;
    if v_pick is not null then
      insert into fin.reconciliation_links (org_id, statement_line_id, cash_transaction_id, amount, method, created_by)
      values (l.org_id, l.id, v_pick, abs(l.amount), 'AUTO', private.member_id());
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end $$;

create or replace function fin.link_statement_line(p_line uuid, p_tx uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare l fin.statement_lines; t fin.cash_transactions; v_amt numeric;
begin
  perform private.require_perm('fin.write');
  select * into l from fin.statement_lines where id = p_line and org_id = private.org_id() for update;
  select * into t from fin.cash_transactions where id = p_tx and org_id = private.org_id() for update;
  if l.id is null or t.id is null then raise exception 'Linha ou movimento não encontrado'; end if;
  if l.bank_account_id <> t.bank_account_id then raise exception 'Linha e movimento são de contas diferentes'; end if;
  if (l.amount > 0) <> (t.amount > 0) then raise exception 'Sentidos diferentes (entrada × saída)'; end if;
  if l.status in ('MATCHED', 'IGNORED') or t.voided or t.reconciled then raise exception 'Linha ou movimento já conciliado'; end if;
  v_amt := least(abs(l.amount) - l.matched_amount, abs(t.amount) - t.reconciled_amount);
  insert into fin.reconciliation_links (org_id, statement_line_id, cash_transaction_id, amount, method, created_by)
  values (l.org_id, l.id, t.id, v_amt, 'MANUAL', private.member_id());
end $$;

create or replace function fin.unlink_statement_line(p_line uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('fin.write');
  if not exists (select 1 from fin.statement_lines where id = p_line and org_id = private.org_id()) then raise exception 'Linha não encontrada'; end if;
  delete from fin.reconciliation_links where statement_line_id = p_line;
end $$;

create or replace function fin.ignore_statement_line(p_line uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('fin.write');
  update fin.statement_lines set status = 'IGNORED', ignore_reason = p_reason
  where id = p_line and org_id = private.org_id() and status = 'PENDING';
  if not found then raise exception 'Só linhas pendentes podem ser ignoradas'; end if;
end $$;

create or replace function fin.restore_statement_line(p_line uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('fin.write');
  update fin.statement_lines set status = 'PENDING', ignore_reason = null
  where id = p_line and org_id = private.org_id() and status = 'IGNORED';
end $$;

-- Classifica uma linha do extrato sem título (tarifa, rendimento, aporte...) criando o movimento e conciliando
create or replace function fin.classify_statement_line(p_line uuid, p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare l fin.statement_lines;
begin
  perform private.require_perm('fin.write');
  select * into l from fin.statement_lines where id = p_line and org_id = private.org_id() for update;
  if l.id is null then raise exception 'Linha não encontrada'; end if;
  if l.status <> 'PENDING' then raise exception 'Linha já tratada'; end if;
  if upper(p ->> 'kind') in ('PROFIT_DISTRIBUTION', 'LOAN', 'OWNER_CONTRIBUTION', 'ADJUSTMENT') then
    perform private.require_perm('fin.approve');
  end if;
  return private.post_cash_movement(
    p || jsonb_build_object('bank_account_id', l.bank_account_id, 'amount', abs(l.amount),
                            'direction', case when l.amount > 0 then 'IN' else 'OUT' end,
                            'occurred_on', l.posted_on, 'statement_line_id', l.id,
                            'description', coalesce(p ->> 'description', l.description),
                            'reference', coalesce(p ->> 'reference', l.e2e_id, l.external_id)),
    private.member_id());
end $$;

-- Aplica as regras cadastradas às linhas pendentes (tarifas, IOF, rendimentos...)
create or replace function fin.apply_recon_rules(p_bank_account uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare l record; r record; v_n int := 0; v_text text;
begin
  perform private.require_perm('fin.write');
  if not exists (select 1 from fin.bank_accounts where id = p_bank_account and org_id = private.org_id()) then raise exception 'Conta inválida'; end if;
  for l in select * from fin.statement_lines where bank_account_id = p_bank_account and status = 'PENDING' order by posted_on loop
    for r in select * from fin.recon_rules where org_id = l.org_id and active order by priority, id loop
      v_text := case r.field when 'description' then l.description when 'counterpart_name' then l.counterpart_name else l.counterpart_doc end;
      if v_text ~* r.pattern and (r.direction = 'ANY' or (r.direction = 'IN') = (l.amount > 0)) then
        perform private.post_cash_movement(jsonb_build_object(
          'bank_account_id', l.bank_account_id, 'kind', r.action_kind, 'direction', case when l.amount > 0 then 'IN' else 'OUT' end,
          'amount', abs(l.amount), 'occurred_on', l.posted_on, 'chart_account_id', r.chart_account_id,
          'cost_center_id', r.cost_center_id, 'party_id', r.party_id, 'description', l.description, 'statement_line_id', l.id),
          private.member_id());
        v_n := v_n + 1;
        exit;
      end if;
    end loop;
  end loop;
  return v_n;
end $$;

-- ---------------------------------------------------------------------
-- Segurança
-- ---------------------------------------------------------------------
select private.apply_rls('fin', array['title_lines', 'allocation_templates', 'allocation_template_lines', 'party_credits', 'settlements',
  'settlement_lines', 'cash_transactions', 'statement_imports', 'statement_lines', 'reconciliation_links', 'recon_rules'], 'fin.read', 'fin.write');
-- Livros e documentos financeiros: a escrita só passa pelas RPCs (que aplicam as regras e contabilizam)
select private.rpc_only('fin', array['titles', 'title_installments', 'title_lines', 'party_credits', 'settlements', 'settlement_lines',
  'cash_transactions', 'statement_imports', 'statement_lines', 'reconciliation_links']);
select private.attach_updated_at('fin');

revoke execute on function private.post_title_accrual(uuid) from authenticated;
revoke execute on function private.insert_title(jsonb, uuid) from authenticated;
revoke execute on function private.post_cash_movement(jsonb, uuid) from authenticated;
