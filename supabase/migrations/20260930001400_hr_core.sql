-- =====================================================================
-- hr (núcleo): colaboradores (cadastro único com crm.parties), histórico de salário imutável, dados sensíveis,
-- dependentes, benefícios, afastamentos, exames (ASO), feriados e tabelas oficiais (INSS, IRRF, salário mínimo,
-- salário-família). fiscal: calendário de obrigações e fila de eventos do eSocial.
--
-- Cálculos aqui são PRÉVIA para conferência com o contador: as tabelas ficam em hr.tax_tables com vigência
-- e fonte, e o contador pode importar a folha oficial (payroll_runs.source = ACCOUNTANT_IMPORT).
-- =====================================================================

select private.init_schema('hr');

-- ---------------------------------------------------------------------
-- Utilitários
-- ---------------------------------------------------------------------
create or replace function private.valid_cpf(p text) returns boolean
language plpgsql immutable as $$
declare d text := regexp_replace(coalesce(p, ''), '\D', '', 'g'); s int; i int; r int;
begin
  if length(d) <> 11 or d ~ '^(\d)\1{10}$' then return false; end if;
  for k in 9 .. 10 loop
    s := 0;
    for i in 1 .. k loop s := s + substr(d, i, 1)::int * (k + 2 - i); end loop;
    r := (s * 10) % 11;
    if r = 10 then r := 0; end if;
    if r <> substr(d, k + 1, 1)::int then return false; end if;
  end loop;
  return true;
end $$;

-- ---------------------------------------------------------------------
-- Feriados (nacional, estadual, municipal ou da loja) — alimentam escala, DSR e prazos
-- ---------------------------------------------------------------------
create table hr.holidays (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  holiday_date date not null,
  name text not null,
  scope text not null default 'NATIONAL' check (scope in ('NATIONAL', 'STATE', 'MUNICIPAL', 'STORE')),
  uf char(2),
  store_id uuid references core.stores(id),
  optional boolean not null default false,               -- ponto facultativo (Carnaval, Corpus Christi): a loja decide
  created_at timestamptz not null default now()
);
create unique index holidays_uq on hr.holidays (org_id, holiday_date, scope, coalesce(store_id, '00000000-0000-0000-0000-000000000000'::uuid));

create or replace function private.is_holiday(p_org uuid, p_date date, p_store uuid default null, p_include_optional boolean default false) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from hr.holidays h
    where h.org_id = p_org and h.holiday_date = p_date and (p_include_optional or not h.optional)
      and (h.scope in ('NATIONAL', 'STATE', 'MUNICIPAL') or h.store_id = p_store)
  )
$$;

-- ---------------------------------------------------------------------
-- Tabelas oficiais com vigência (globais). Atualizar quando a lei mudar; nada fixo no código.
-- ---------------------------------------------------------------------
create table hr.tax_tables (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('INSS', 'IRRF', 'MINIMUM_WAGE', 'FAMILY_ALLOWANCE', 'FGTS')),
  valid_from date not null,
  data jsonb not null,
  source text,
  notes text,
  unique (kind, valid_from)
);
grant select on hr.tax_tables to authenticated;

insert into hr.tax_tables (kind, valid_from, data, source, notes) values
  ('INSS', '2026-01-01',
   '{"brackets":[{"upto":1621.00,"rate":7.5},{"upto":2902.84,"rate":9},{"upto":4354.27,"rate":12},{"upto":8475.55,"rate":14}],"ceiling":8475.55,"prolabore_rate":11}',
   'Portaria Interministerial MPS/MF nº 13, de 09/01/2026', 'Contribuição progressiva (cada alíquota só sobre a parcela da faixa). Conferir com o contador.'),
  ('IRRF', '2026-01-01',
   '{"brackets":[{"upto":2428.80,"rate":0,"deduction":0},{"upto":2826.65,"rate":7.5,"deduction":182.16},{"upto":3751.05,"rate":15,"deduction":394.16},{"upto":4664.68,"rate":22.5,"deduction":675.49},{"upto":null,"rate":27.5,"deduction":908.73}],"dependent":189.59,"simplified":607.20,"reducer":{"exempt_up_to":5000.00,"phase_out_to":7350.00,"a":978.62,"b":0.133145}}',
   'Lei 15.270/2025 (vigência 01/01/2026)', 'Redutor: até R$ 5.000 zera o imposto; de 5.000,01 a 7.350 reduz 978,62 − 0,133145 × rendimentos tributáveis. Desconto simplificado R$ 607,20.'),
  ('MINIMUM_WAGE', '2026-01-01', '{"amount":1621.00}', 'Decreto 12.797/2025', null),
  ('FAMILY_ALLOWANCE', '2026-01-01', '{"quota":67.54,"limit":1980.38}', 'Portaria Interministerial MPS/MF nº 13/2026', 'Filhos até 14 anos ou inválidos'),
  ('FGTS', '2026-01-01', '{"rate":8,"apprentice_rate":2,"fine_without_cause":40,"fine_mutual_agreement":20}', 'Lei 8.036/1990', 'Multa de 40% sobre o saldo (sem justa causa) e 20% (acordo, art. 484-A)')
on conflict (kind, valid_from) do nothing;

create or replace function hr.tax_data(p_kind text, p_on date) returns jsonb
language sql stable as $$
  select data from hr.tax_tables where kind = p_kind and valid_from <= p_on order by valid_from desc limit 1
$$;

-- INSS do empregado: progressivo por faixa, limitado ao teto
create or replace function hr.calc_inss(p_base numeric, p_on date) returns numeric
language plpgsql stable as $$
declare d jsonb := hr.tax_data('INSS', p_on); b jsonb; prev numeric := 0; v_total numeric := 0; v_base numeric;
begin
  if d is null then raise exception 'Tabela do INSS não cadastrada para %', p_on; end if;
  v_base := least(greatest(p_base, 0), (d ->> 'ceiling')::numeric);
  for b in select * from jsonb_array_elements(d -> 'brackets') loop
    if v_base > prev then
      v_total := v_total + (least(v_base, (b ->> 'upto')::numeric) - prev) * (b ->> 'rate')::numeric / 100;
    end if;
    prev := (b ->> 'upto')::numeric;
  end loop;
  return round(v_total, 2);
end $$;

-- INSS do pró-labore / contribuinte individual: 11% limitado ao teto
create or replace function hr.calc_inss_prolabore(p_base numeric, p_on date) returns numeric
language sql stable as $$
  select round(least(greatest(p_base, 0), (hr.tax_data('INSS', p_on) ->> 'ceiling')::numeric) * (hr.tax_data('INSS', p_on) ->> 'prolabore_rate')::numeric / 100, 2)
$$;

-- IRRF mensal (Lei 15.270): base = rendimento − max(deduções legais, desconto simplificado); tabela progressiva; redutor
create or replace function hr.calc_irrf(
  p_taxable numeric, p_inss numeric, p_dependents int, p_on date, p_other_deductions numeric default 0, p_apply_reducer boolean default true
) returns numeric
language plpgsql stable as $$
declare
  d jsonb := hr.tax_data('IRRF', p_on);
  b jsonb;
  v_ded numeric;
  v_base numeric;
  v_tax numeric := 0;
  v_red numeric := 0;
  r jsonb;
begin
  if d is null then raise exception 'Tabela do IRRF não cadastrada para %', p_on; end if;
  v_ded := greatest(p_inss + p_dependents * (d ->> 'dependent')::numeric + p_other_deductions, (d ->> 'simplified')::numeric);
  v_base := greatest(p_taxable - v_ded, 0);
  for b in select * from jsonb_array_elements(d -> 'brackets') loop
    if (b ->> 'upto') is null or v_base <= (b ->> 'upto')::numeric then
      v_tax := greatest(v_base * (b ->> 'rate')::numeric / 100 - (b ->> 'deduction')::numeric, 0);
      exit;
    end if;
  end loop;
  v_tax := round(v_tax, 2);
  if p_apply_reducer and d ? 'reducer' then
    r := d -> 'reducer';
    if p_taxable <= (r ->> 'exempt_up_to')::numeric then v_red := v_tax;
    elsif p_taxable <= (r ->> 'phase_out_to')::numeric then
      v_red := greatest((r ->> 'a')::numeric - (r ->> 'b')::numeric * p_taxable, 0);
    end if;
  end if;
  return greatest(round(v_tax - least(v_red, v_tax), 2), 0);
end $$;

-- ---------------------------------------------------------------------
-- Colaboradores
-- ---------------------------------------------------------------------
create table hr.employees (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  party_id uuid not null references crm.parties(id),
  member_id uuid references core.members(id),               -- acesso ao sistema (vendedora, gerente...)
  legal_entity_id uuid not null references core.legal_entities(id),
  store_id uuid references core.stores(id),
  cost_center_id uuid references core.cost_centers(id),
  registration text not null,
  contract_type text not null check (contract_type in ('CLT', 'ESTAGIO', 'APRENDIZ', 'INTERMITENTE', 'TEMPORARIO', 'PRO_LABORE', 'AUTONOMO')),
  job_title text not null,
  cbo text,
  department text,
  hire_date date not null,
  experience_days int[] not null default '{}',              -- ex.: {45,45}
  termination_date date,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'TERMINATED')),
  weekly_hours numeric(4,1) not null default 44,
  daily_minutes int not null default 440,                    -- jornada contratual diária (44h em 6 dias = 440 min)
  work_regime text not null default '6X1' check (work_regime in ('6X1', '5X2', '12X36', 'INTERMITTENT', 'CUSTOM')),
  track_time boolean not null default false,                 -- false: a escala publicada vale como ponto
  time_bank boolean not null default false,                  -- horas extras vão para o banco de horas
  commissioned boolean not null default false,
  fgts boolean not null default true,
  notes text,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, registration)
);
create unique index employees_party_active_uq on hr.employees (party_id) where status = 'ACTIVE';
create index on hr.employees (org_id, legal_entity_id, status);

create table hr.employee_private (
  employee_id uuid primary key references hr.employees(id) on delete cascade,
  org_id uuid not null references core.orgs(id),
  cpf text,
  pis text,
  ctps text,
  rg text,
  mother_name text,
  marital_status text,
  education text,
  bank_code text,
  bank_agency text,
  bank_account text,
  pix_key text,
  address jsonb not null default '{}',
  emergency_contact jsonb not null default '{}',
  updated_at timestamptz not null default now()
);
create unique index employee_private_cpf_uq on hr.employee_private (org_id, cpf) where cpf is not null;

create table hr.dependents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  employee_id uuid not null references hr.employees(id) on delete cascade,
  name text not null,
  cpf text,
  birth_date date,
  relationship text not null default 'FILHO',
  irrf boolean not null default true,                        -- dedução no IRRF
  family_allowance boolean not null default false,           -- salário-família
  created_at timestamptz not null default now()
);

-- Histórico de salário: só inserção (correção = nova vigência)
create table hr.salary_history (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  employee_id uuid not null references hr.employees(id) on delete cascade,
  effective_from date not null,
  amount numeric(12,2) not null check (amount > 0),
  unit text not null default 'MONTH' check (unit in ('MONTH', 'HOUR')),
  reason text,
  created_by uuid references core.members(id),
  created_at timestamptz not null default now(),
  unique (employee_id, effective_from)
);
create trigger trg_salary_immutable before update or delete on hr.salary_history
  for each row execute function private.forbid_mutation();

create or replace function private.monthly_salary(p_employee uuid, p_on date) returns numeric
language sql stable security definer set search_path = '' as $$
  select case h.unit when 'HOUR' then round(h.amount * e.weekly_hours * 5, 2) else h.amount end
  from hr.salary_history h join hr.employees e on e.id = h.employee_id
  where h.employee_id = p_employee and h.effective_from <= p_on
  order by h.effective_from desc limit 1
$$;

-- Descontos recorrentes (pensão alimentícia, consignado, mensalidade)
create table hr.employee_deductions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  employee_id uuid not null references hr.employees(id) on delete cascade,
  event_code text not null check (event_code in ('PENSAO', 'EMPREST', 'OUTROS_DESC')),
  calc text not null default 'FIXED' check (calc in ('FIXED', 'PCT_NET')),
  value numeric(12,4) not null check (value > 0),
  beneficiary_party_id uuid references crm.parties(id),
  start_date date not null default current_date,
  end_date date,
  installments_left int,
  notes text
);

-- ---------------------------------------------------------------------
-- Benefícios (VT, VR/VA, saúde...) e vínculo com o colaborador
-- ---------------------------------------------------------------------
create table hr.benefit_types (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  code text not null,
  name text not null,
  kind text not null check (kind in ('TRANSPORT', 'MEAL', 'FOOD', 'HEALTH', 'DENTAL', 'LIFE', 'DAYCARE', 'EDUCATION', 'OTHER')),
  calc text not null default 'MONTHLY_FIXED' check (calc in ('DAILY', 'MONTHLY_FIXED', 'PCT_SALARY')),
  employee_share_pct numeric(5,2) not null default 0,       -- % do custo (ou do salário no VT) descontada do colaborador
  share_base text not null default 'COST' check (share_base in ('COST', 'SALARY')),
  employee_share_fixed numeric(12,2) not null default 0,
  supplier_party_id uuid references crm.parties(id),
  expense_role text not null default 'PAYROLL_OTHER',
  taxable boolean not null default false,                    -- integra o salário (incide INSS/IRRF/FGTS)
  pay_day smallint check (pay_day between 1 and 31),
  active boolean not null default true,
  unique (org_id, code)
);

create table hr.employee_benefits (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  employee_id uuid not null references hr.employees(id) on delete cascade,
  benefit_type_id uuid not null references hr.benefit_types(id),
  value numeric(12,2) not null check (value >= 0),           -- por dia (DAILY), por mês ou % do salário
  share_pct_override numeric(5,2),
  start_date date not null default current_date,
  end_date date,
  notes text
);
create index on hr.employee_benefits (employee_id);

-- ---------------------------------------------------------------------
-- Afastamentos, faltas e exames
-- ---------------------------------------------------------------------
create table hr.leaves (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  employee_id uuid not null references hr.employees(id) on delete cascade,
  kind text not null check (kind in ('SICK', 'ACCIDENT', 'MATERNITY', 'PATERNITY', 'MARRIAGE', 'BEREAVEMENT', 'BLOOD_DONATION',
                                     'MILITARY', 'UNPAID', 'SUSPENSION', 'JUSTIFIED_ABSENCE', 'UNJUSTIFIED_ABSENCE', 'OTHER')),
  start_date date not null,
  end_date date not null,
  paid boolean not null default true,                        -- remunerado pela empresa
  inss_leave boolean not null default false,                 -- benefício pago pelo INSS (sai da folha)
  cid text,
  doc_ref text,
  notes text,
  created_by uuid references core.members(id),
  created_at timestamptz not null default now(),
  check (end_date >= start_date)
);
create index on hr.leaves (employee_id, start_date);

create table hr.medical_exams (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  employee_id uuid not null references hr.employees(id) on delete cascade,
  kind text not null check (kind in ('ADMISSION', 'PERIODIC', 'RETURN_TO_WORK', 'CHANGE_OF_ROLE', 'DISMISSAL')),
  exam_date date not null,
  valid_until date,
  result text,
  notes text
);
create index on hr.medical_exams (employee_id, valid_until);

-- Dias de um afastamento que caem numa janela (calendário)
create or replace function private.leave_overlap_days(p_employee uuid, p_from date, p_to date, p_mode text) returns int
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(greatest(0, least(l.end_date, p_to) - greatest(l.start_date, p_from) + 1)), 0)::int
  from hr.leaves l
  where l.employee_id = p_employee and l.start_date <= p_to and l.end_date >= p_from
    and case p_mode
      when 'UNPAID' then l.kind <> 'UNJUSTIFIED_ABSENCE' and ((not l.paid and not l.inss_leave) or l.kind in ('SUSPENSION', 'UNPAID'))   -- faltas entram como desconto do espelho de ponto, não aqui
      when 'INSS' then l.inss_leave
      else true end
$$;

-- ---------------------------------------------------------------------
-- fiscal: calendário de obrigações e fila de eventos do eSocial
-- ---------------------------------------------------------------------
create table fiscal.obligations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  legal_entity_id uuid not null references core.legal_entities(id),
  kind text not null check (kind in ('DAS', 'FGTS', 'INSS_DAE', 'IRRF_DARF', 'ISS', 'ESOCIAL', 'REINF', 'DCTFWEB', 'OTHER')),
  competence date not null,
  due_date date not null,
  amount numeric(14,2) not null default 0,
  title_id uuid references fin.titles(id),
  source_type text,
  source_id uuid,
  status text not null default 'PENDING' check (status in ('PENDING', 'PAID', 'WAIVED', 'CANCELLED')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on fiscal.obligations (org_id, due_date) where status = 'PENDING';
create unique index obligations_source_uq on fiscal.obligations (kind, source_type, source_id) where source_id is not null;

create table fiscal.esocial_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  legal_entity_id uuid not null references core.legal_entities(id),
  event text not null,                                       -- S-1200, S-1210, S-2200, S-2206, S-2230, S-2299...
  reference_type text,
  reference_id uuid,
  competence date,
  payload jsonb not null default '{}',
  status text not null default 'PENDING' check (status in ('PENDING', 'EXPORTED', 'SENT', 'ERROR', 'CANCELLED')),
  created_at timestamptz not null default now()
);
create index on fiscal.esocial_events (org_id, status, created_at);

create or replace function private.enqueue_esocial(p_entity uuid, p_event text, p_ref_type text, p_ref_id uuid, p_competence date, p_payload jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into fiscal.esocial_events (org_id, legal_entity_id, event, reference_type, reference_id, competence, payload)
  select org_id, id, p_event, p_ref_type, p_ref_id, p_competence, coalesce(p_payload, '{}')
  from core.legal_entities where id = p_entity;
end $$;

-- Obrigação vira PAGA quando o título é quitado
create or replace function private.sync_obligation_status() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'SETTLED' and old.status is distinct from 'SETTLED' then
    update fiscal.obligations set status = 'PAID', updated_at = now() where title_id = new.id and status = 'PENDING';
  elsif new.status = 'CANCELLED' and old.status is distinct from 'CANCELLED' then
    update fiscal.obligations set status = 'CANCELLED', updated_at = now() where title_id = new.id and status = 'PENDING';
  end if;
  return null;
end $$;
create trigger trg_obligation_status after update of status on fin.titles
  for each row execute function private.sync_obligation_status();

-- ---------------------------------------------------------------------
-- Configuração por empresa: perfil de encargos (Simples × regime geral) e prazos
-- ---------------------------------------------------------------------
create table hr.entity_settings (
  legal_entity_id uuid primary key references core.legal_entities(id) on delete cascade,
  org_id uuid not null references core.orgs(id),
  charge_profile text not null default 'SIMPLES' check (charge_profile in ('SIMPLES', 'SIMPLES_ANEXO_IV', 'GENERAL')),
  inss_employer_pct numeric(5,2) not null default 20,        -- só regime geral / Anexo IV
  rat_pct numeric(5,2) not null default 1,                   -- RAT × FAP (regime geral / Anexo IV)
  third_parties_pct numeric(5,2) not null default 5.8,       -- Sistema S (regime geral)
  pay_business_day smallint not null default 5,              -- 5º dia útil do mês seguinte (CLT art. 459)
  updated_at timestamptz not null default now()
);
comment on table hr.entity_settings is 'SIMPLES: CPP e RAT já estão no DAS (anexos I, II, III e V) e o Sistema S é dispensado — só FGTS e retenções. GENERAL/ANEXO IV: contribuição patronal recolhida à parte. Confirmar com o contador.';

-- ---------------------------------------------------------------------
-- Segurança
-- ---------------------------------------------------------------------
select private.attach_updated_at('hr');
select private.attach_updated_at('fiscal');

select private.apply_rls('hr', array['employees', 'holidays', 'leaves', 'medical_exams', 'benefit_types'], 'hr.read', 'hr.write');
select private.apply_rls('hr', array['salary_history', 'employee_benefits', 'employee_deductions', 'entity_settings'], 'hr.payroll.read', 'hr.payroll.write');
select private.apply_rls('hr', array['employee_private', 'dependents'], 'hr.sensitive', 'hr.sensitive');
select private.rpc_only('hr', array['salary_history']);
create policy p_read on hr.tax_tables for select to authenticated using (true);
alter table hr.tax_tables enable row level security;

select private.apply_rls('fiscal', array['obligations', 'esocial_events'], 'fiscal.read', 'fiscal.write');
select private.rpc_only('fiscal', array['esocial_events']);

-- Auditoria de dados de pessoal
create trigger trg_audit after insert or update or delete on hr.employees for each row execute function private.audit_capture();
create trigger trg_audit after insert or update or delete on hr.salary_history for each row execute function private.audit_capture();
create trigger trg_audit after insert or update or delete on hr.leaves for each row execute function private.audit_capture();
