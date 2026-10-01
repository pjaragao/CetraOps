-- =====================================================================
-- fin (base): plano de contas, linhas do DRE, contas bancárias, títulos a pagar/receber com parcelas,
--             tabela de taxas da adquirente, contratos (patrocínio JOY)
-- fiscal (base): faixas do Simples Nacional
-- Rateio, conciliação, extratos e orçamento entram no sprint A3/A4.
-- =====================================================================

create table fin.dre_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  code text not null,
  name text not null,
  position int not null,
  sign smallint not null check (sign in (-1, 1)),
  is_subtotal boolean not null default false,
  formula text,                                                  -- para subtotais: códigos somados
  unique (org_id, code)
);

create type fin.account_group as enum ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'DEDUCTION', 'COGS', 'EXPENSE', 'FINANCIAL');

create table fin.chart_accounts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  parent_id uuid references fin.chart_accounts(id),
  code text not null,
  name text not null,
  kind text not null check (kind in ('SYNTHETIC', 'ANALYTIC')),
  nature text not null check (nature in ('DEBIT', 'CREDIT')),
  "group" fin.account_group not null,
  dre_line_id uuid references fin.dre_lines(id),
  cash_flow_group text,
  accountant_code text,                                          -- de-para com o plano do contador
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, code)
);

create table fin.bank_accounts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  legal_entity_id uuid not null references core.legal_entities(id),
  name text not null,
  kind text not null check (kind in ('CHECKING', 'CASH_DRAWER', 'ACQUIRER_BALANCE', 'INVESTMENT')),
  bank_code text,                                                -- 077 Inter, 208 BTG, 323 Mercado Pago
  agency text,
  number text,
  pix_keys text[] not null default '{}',
  chart_account_id uuid references fin.chart_accounts(id),
  opening_balance numeric(14,2) not null default 0,
  opening_date date,
  connection_id uuid references core.integration_connections(id),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Tabela de taxas por adquirente × forma × faixa de parcelas × modo de antecipação
create table fin.acquirer_fee_plans (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  acquirer text not null,                                        -- STONE, SIPAG, MERCADOPAGO
  method text not null check (method in ('PIX', 'DEBIT', 'CREDIT')),
  inst_from smallint not null default 1,
  inst_to smallint not null default 1,
  anticipation_mode text not null check (anticipation_mode in ('NATURAL', 'D1')),
  rate numeric(7,4) not null,                                    -- percentual, ex.: 2.8500
  settlement_days int not null default 1,                        -- D+n (no fluxo natural, por parcela: 30 × n)
  valid_from date not null default current_date,
  valid_to date,
  check (inst_to >= inst_from)
);

create or replace function fin.expected_fee_rate(
  p_org uuid, p_acquirer text, p_method text, p_installments int, p_mode text, p_on date default current_date
) returns numeric
language sql stable security definer set search_path = '' as $$
  select rate from fin.acquirer_fee_plans
  where org_id = p_org and acquirer = p_acquirer and method = p_method and anticipation_mode = p_mode
    and p_installments between inst_from and inst_to
    and valid_from <= p_on and (valid_to is null or valid_to >= p_on)
  order by valid_from desc limit 1
$$;

create type fin.title_direction as enum ('RECEIVABLE', 'PAYABLE');
create type fin.title_status as enum ('OPEN', 'PARTIAL', 'SETTLED', 'CANCELLED', 'RENEGOTIATED');

create table fin.titles (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  legal_entity_id uuid not null references core.legal_entities(id),
  store_id uuid references core.stores(id),
  direction fin.title_direction not null,
  number text not null,
  party_id uuid references crm.parties(id),                      -- no cartão, a devedora é a adquirente
  document_kind text,                                            -- NF, BOLETO, RECIBO, CONTRATO, CARTAO...
  document_number text,
  issue_date date not null default current_date,
  competence_date date not null default current_date,
  description text not null,
  total_amount numeric(14,2) not null check (total_amount > 0),
  status fin.title_status not null default 'OPEN',
  origin_type text not null default 'MANUAL',                    -- ORDER, PURCHASE_RECEIPT, PAYROLL, TAX_PERIOD, CONTRACT, COMMISSION_STATEMENT, RECURRING, MANUAL
  origin_id uuid,
  chart_account_id uuid references fin.chart_accounts(id),
  cost_center_id uuid references core.cost_centers(id),
  approval_status text not null default 'DRAFT' check (approval_status in ('DRAFT', 'APPROVED', 'REJECTED')),
  approved_by uuid references core.members(id),
  approved_at timestamptz,
  tags text[] not null default '{}',
  custom_fields jsonb not null default '{}',
  created_by uuid references core.members(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, number)
);
create index on fin.titles (org_id, direction, status);
create index on fin.titles (origin_type, origin_id);

create table fin.title_installments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  title_id uuid not null references fin.titles(id) on delete cascade,
  n smallint not null,
  due_date date not null,
  expected_date date,                                            -- previsão real de entrada (ex.: repasse da adquirente)
  amount numeric(14,2) not null check (amount > 0),
  fee_expected numeric(14,2) not null default 0,                 -- MDR/antecipação esperados (auditoria de taxa)
  interest numeric(14,2) not null default 0,
  fine numeric(14,2) not null default 0,
  discount numeric(14,2) not null default 0,
  amount_settled numeric(14,2) not null default 0,
  status fin.title_status not null default 'OPEN',
  barcode text,
  pix_emv text,
  boleto_ref text,
  updated_at timestamptz not null default now(),
  unique (title_id, n)
);
create index on fin.title_installments (org_id, due_date) where status in ('OPEN', 'PARTIAL');

-- Status do título acompanha as parcelas
create or replace function private.refresh_title_status() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_title uuid := coalesce(new.title_id, old.title_id);
begin
  update fin.titles t set status = case
      when not exists (select 1 from fin.title_installments i where i.title_id = t.id and i.status not in ('SETTLED', 'CANCELLED'))
        and exists (select 1 from fin.title_installments i where i.title_id = t.id and i.status = 'SETTLED') then 'SETTLED'
      when exists (select 1 from fin.title_installments i where i.title_id = t.id and (i.status in ('PARTIAL', 'SETTLED'))) then 'PARTIAL'
      else t.status end
  where t.id = v_title and t.status not in ('CANCELLED', 'RENEGOTIATED');
  return null;
end $$;
create trigger trg_refresh_title_status after insert or update of status on fin.title_installments
  for each row execute function private.refresh_title_status();

-- Contratos com parceiros (patrocínio + licença de espaço JOY, consignação, pop-up, serviços)
create table fin.contracts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  legal_entity_id uuid not null references core.legal_entities(id),
  party_id uuid not null references crm.parties(id),
  store_id uuid references core.stores(id),
  kind text not null check (kind in ('SPONSORSHIP_SPACE_LICENSE', 'CONSIGNMENT_PARTNER', 'POPUP_STAND', 'SERVICE', 'SAAS')),
  title text not null,
  start_date date not null,
  months int not null check (months > 0),
  in_kind_months int not null default 0,                         -- meses pagos em peças (JOY: 3)
  in_kind_description text,
  installment_amount numeric(14,2),                              -- JOY: 6.000
  due_day smallint check (due_day between 1 and 31),
  late_fee_pct numeric(5,2),
  monthly_interest_pct numeric(5,2),
  adjustment_index text,                                         -- IPCA
  exit_penalty_pct numeric(5,2),
  revenue_share_pct numeric(5,2),
  chart_account_id uuid references fin.chart_accounts(id),
  cost_center_id uuid references core.cost_centers(id),
  attachment_id uuid references core.attachments(id),
  status text not null default 'ACTIVE' check (status in ('DRAFT', 'ACTIVE', 'ENDED', 'TERMINATED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table fin.contract_obligations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  contract_id uuid not null references fin.contracts(id) on delete cascade,
  kind text not null check (kind in ('IN_KIND_DELIVERY', 'GUEST_PASS', 'BREAKFAST_ACTIVATION', 'PHOTOSHOOT', 'SCREEN_CONTENT', 'OTHER')),
  description text not null,
  due_date date not null,
  status text not null default 'PENDING' check (status in ('PENDING', 'DONE', 'WAIVED')),
  evidence jsonb not null default '{}',
  done_at timestamptz
);
create index on fin.contract_obligations (org_id, due_date) where status = 'PENDING';

-- Gera o cronograma do contrato: meses em espécie viram obrigações; os demais viram títulos a pagar
create or replace function fin.generate_contract_schedule(p_contract uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare
  c record;
  i int;
  v_due date;
  v_title uuid;
  v_n int := 0;
begin
  perform private.require_perm('fin.write');
  select * into c from fin.contracts where id = p_contract;
  if c.id is null then raise exception 'Contrato não encontrado'; end if;
  if exists (select 1 from fin.titles where origin_type = 'CONTRACT' and origin_id = c.id) then
    raise exception 'Cronograma já gerado para este contrato';
  end if;

  for i in 0 .. c.months - 1 loop
    v_due := (date_trunc('month', c.start_date) + make_interval(months => i))::date
             + (least(coalesce(c.due_day, extract(day from c.start_date)::int), 28) - 1);
    if i < c.in_kind_months then
      insert into fin.contract_obligations (org_id, contract_id, kind, description, due_date)
      values (c.org_id, c.id, 'IN_KIND_DELIVERY',
              format('Mês %s/%s: pagamento em espécie — %s', i + 1, c.months, coalesce(c.in_kind_description, 'peças')), v_due);
    elsif c.installment_amount is not null then
      insert into fin.titles (org_id, legal_entity_id, store_id, direction, number, party_id, document_kind,
                              issue_date, competence_date, description, total_amount, origin_type, origin_id,
                              chart_account_id, cost_center_id, approval_status)
      values (c.org_id, c.legal_entity_id, c.store_id, 'PAYABLE', core.next_number(c.org_id, 'PAG'), c.party_id, 'CONTRATO',
              v_due, date_trunc('month', v_due)::date, format('%s — parcela %s/%s', c.title, i + 1, c.months),
              c.installment_amount, 'CONTRACT', c.id, c.chart_account_id, c.cost_center_id, 'APPROVED')
      returning id into v_title;
      insert into fin.title_installments (org_id, title_id, n, due_date, amount)
      values (c.org_id, v_title, 1, v_due, c.installment_amount);
    end if;
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- ---------------------------------------------------------------------
-- fiscal (base)
-- ---------------------------------------------------------------------
create table fiscal.simples_brackets (
  id uuid primary key default gen_random_uuid(),
  annex text not null check (annex in ('I', 'II', 'III', 'IV', 'V')),
  bracket smallint not null,
  max_rbt12 numeric(14,2) not null,
  nominal_rate numeric(6,4) not null,                            -- percentual
  deduction numeric(14,2) not null,
  icms_share numeric(6,4),                                       -- repartição do ICMS dentro do DAS (%)
  valid_from date not null default '2018-01-01',
  unique (annex, bracket, valid_from)
);
grant select on fiscal.simples_brackets to authenticated;

-- Alíquota efetiva do Simples: ((RBT12 × nominal) − dedução) / RBT12
create or replace function fiscal.simples_effective_rate(p_annex text, p_rbt12 numeric) returns numeric
language sql stable as $$
  select case when p_rbt12 <= 0 then b.nominal_rate
              else round(((p_rbt12 * b.nominal_rate / 100) - b.deduction) / p_rbt12 * 100, 4) end
  from fiscal.simples_brackets b
  where b.annex = p_annex and p_rbt12 <= b.max_rbt12
  order by b.bracket limit 1
$$;

select private.attach_updated_at('fin');
