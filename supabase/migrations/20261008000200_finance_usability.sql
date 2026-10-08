-- =====================================================================
-- Financeiro mais completo no dia a dia.
--   • fin.v_installments: todas as parcelas (abertas, pagas, canceladas) com favorecido e texto de busca — listas com filtro e paginação.
--   • fin.update_title: editar um título com segurança.
--       - sempre (se não cancelado): descrição, documento e número;
--       - sem nenhuma baixa e lançado à mão (ou recorrência/empréstimo): favorecido, competência, classificação (conta/centro de custo/rateio)
--         e parcelas (valores e vencimentos). Se já estava aprovado, a competência é estornada e lançada de novo com os dados novos;
--       - gerado por venda, compra, folha etc.: só o texto e o vencimento (pela origem é que se corrige o resto).
--   • fin.set_recurring_active: pausar/retomar recorrência (a tabela só aceita escrita por função).
--   • Empréstimos e financiamentos (fin.loans + fin.create_loan): o dinheiro entra na conta (passivo de empréstimo) e cada parcela
--     vira uma conta a pagar com a amortização (abate o passivo) e os juros (despesa financeira), pela tabela Price.
--   • fin.update_bank_account / core.update_store: editar o que é seguro editar.
--   • IOF passa a ser 8.1.06: 8.1.04 já é "Diferenças de conciliação e caixa".
-- Códigos de erro: P0500 dado inválido · P0501 não encontrado · P0502 situação não permite.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0) IOF em 8.1.06 (onde ainda não há uma conta de IOF)
-- ---------------------------------------------------------------------
insert into fin.chart_accounts (org_id, parent_id, code, name, kind, nature, "group", dre_line_id, cash_flow_group)
select ref.org_id, ref.parent_id, '8.1.06', 'IOF e encargos sobre operações financeiras', 'ANALYTIC', 'DEBIT', 'FINANCIAL', ref.dre_line_id, ref.cash_flow_group
from fin.chart_accounts ref
where ref.code = '8.1.02'
  and not exists (select 1 from fin.chart_accounts x where x.org_id = ref.org_id and x.name ilike 'IOF%' and x.archived_at is null)
on conflict (org_id, code) do nothing;

-- ---------------------------------------------------------------------
-- 1) Todas as parcelas, para listar, buscar e paginar
-- ---------------------------------------------------------------------
create or replace view fin.v_installments with (security_invoker = true) as
select i.id as installment_id, i.org_id, t.id as title_id, t.legal_entity_id, t.store_id, t.direction, t.number as title_number, t.description,
       t.document_kind, t.document_number, t.origin_type, t.party_id, p.display_name as party_name, t.receiver_party_id, rp.display_name as receiver_name,
       t.approval_status, t.status as title_status, t.cost_center_id, t.competence_date, i.n, i.due_date, i.amount, i.amount_settled,
       i.amount - i.amount_settled as balance, i.fee_expected, i.status,
       case when i.status in ('OPEN', 'PARTIAL') then greatest(private.today_sp() - i.due_date, 0) else 0 end as days_overdue,
       (select max(s.settled_on) from fin.settlement_lines sl join fin.settlements s on s.id = sl.settlement_id
         where sl.installment_id = i.id and s.status = 'POSTED') as settled_on,
       lower(concat_ws(' ', t.number, t.description, t.document_number, p.display_name, rp.display_name)) as search
from fin.title_installments i
join fin.titles t on t.id = i.title_id
left join crm.parties p on p.id = t.party_id
left join crm.parties rp on rp.id = t.receiver_party_id;
grant select on fin.v_installments to authenticated;

-- Recontabilização após edição: o razão é idempotente por origem, então a
-- competência refeita usa como origem o estorno da anterior (única por edição).
drop function if exists private.post_title_accrual(uuid);
create or replace function private.post_title_accrual(p_title uuid, p_edit uuid default null) returns uuid
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

  v_e := private.post_entry(t.legal_entity_id, t.competence_date, 'TITLE_ACCRUAL', case when p_edit is null then 'fin.titles' else 'fin.titles.edit' end, coalesce(p_edit, t.id),
                            format('Título %s — %s', t.number, t.description), v_lines);
  update fin.titles set accrual_entry_id = v_e where id = t.id;
  return v_e;
end $$;
revoke execute on function private.post_title_accrual(uuid, uuid) from public, authenticated, anon;

-- ---------------------------------------------------------------------
-- 2) Editar título
-- p = {id, description?, document_kind?, document_number?, party_id?, competence_date?, chart_account_id?, cost_center_id?,
--      allocation_template_id?, lines?:[{chart_account_id, cost_center_id?, amount}], installments?:[{due_date, amount, barcode?}]}
-- ---------------------------------------------------------------------
create or replace function fin.update_title(p jsonb) returns fin.titles
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id(); t fin.titles; v_settled boolean; v_manual boolean; v_fin boolean; v_total numeric; v_lines_total numeric;
  it jsonb; ln jsonb; r record; v_n int := 0; v_was_posted boolean; v_rev uuid;
begin
  perform private.require_perm('fin.write');
  select * into t from fin.titles where id = nullif(p ->> 'id', '')::uuid and org_id = v_org for update;
  if t.id is null then raise exception 'Título não encontrado' using errcode = 'P0501'; end if;
  if t.status = 'CANCELLED' then raise exception 'Título cancelado não se edita' using errcode = 'P0502'; end if;
  if length(trim(coalesce(p ->> 'description', t.description))) < 2 then raise exception 'Informe a descrição' using errcode = 'P0500'; end if;

  -- texto: sempre
  update fin.titles set description = trim(coalesce(p ->> 'description', description)),
         document_kind = case when p ? 'document_kind' then nullif(trim(p ->> 'document_kind'), '') else document_kind end,
         document_number = case when p ? 'document_number' then nullif(trim(p ->> 'document_number'), '') else document_number end
  where id = t.id;

  v_fin := p ?| array['party_id', 'competence_date', 'chart_account_id', 'cost_center_id', 'allocation_template_id', 'lines', 'installments'];
  if not v_fin then select * into t from fin.titles where id = t.id; return t; end if;

  v_settled := exists (select 1 from fin.title_installments where title_id = t.id and amount_settled > 0);
  v_manual := t.origin_type in ('MANUAL', 'RECURRING', 'LOAN') and t.accrual_mode = 'AUTO';
  if v_settled then raise exception 'Este título já tem pagamento/recebimento: estorne a baixa antes de mudar valores, favorecido ou classificação' using errcode = 'P0502'; end if;
  if not v_manual then raise exception 'Título gerado por % : corrija pela origem (aqui só a descrição, o documento e o vencimento)', t.origin_type using errcode = 'P0502'; end if;
  if nullif(p ->> 'party_id', '') is not null and not exists (select 1 from crm.parties where id = (p ->> 'party_id')::uuid and org_id = v_org and merged_into_id is null) then
    raise exception 'Favorecido não encontrado' using errcode = 'P0501';
  end if;

  -- se já estava contabilizado, estorna a competência (lança de novo no fim)
  v_was_posted := t.accrual_entry_id is not null;
  if v_was_posted then
    v_rev := private.reverse_entry(t.accrual_entry_id, 'Edição do título ' || t.number);
    update fin.titles set accrual_entry_id = null where id = t.id;
  end if;

  -- parcelas
  if jsonb_array_length(coalesce(p -> 'installments', '[]')) > 0 then
    select coalesce(sum(round((x ->> 'amount')::numeric, 2)), 0) into v_total from jsonb_array_elements(p -> 'installments') x;
    if v_total <= 0 then raise exception 'Valor total deve ser positivo' using errcode = 'P0500'; end if;
    delete from fin.title_installments where title_id = t.id;
    for it in select * from jsonb_array_elements(p -> 'installments') loop
      v_n := v_n + 1;
      if (it ->> 'due_date') is null or round((it ->> 'amount')::numeric, 2) <= 0 then raise exception 'Parcela % sem vencimento ou valor', v_n using errcode = 'P0500'; end if;
      insert into fin.title_installments (org_id, title_id, n, due_date, expected_date, amount, barcode)
      values (v_org, t.id, v_n, (it ->> 'due_date')::date, (it ->> 'due_date')::date, round((it ->> 'amount')::numeric, 2), nullif(it ->> 'barcode', ''));
    end loop;
    update fin.titles set total_amount = v_total where id = t.id;
  else
    v_total := t.total_amount;
  end if;

  update fin.titles set
    party_id = case when p ? 'party_id' then nullif(p ->> 'party_id', '')::uuid else party_id end,
    competence_date = coalesce(nullif(p ->> 'competence_date', '')::date, competence_date),
    chart_account_id = case when p ? 'chart_account_id' then nullif(p ->> 'chart_account_id', '')::uuid else chart_account_id end,
    cost_center_id = case when p ? 'cost_center_id' then nullif(p ->> 'cost_center_id', '')::uuid else cost_center_id end
  where id = t.id returning * into t;

  -- classificação: linhas, modelo de rateio, ou conta/centro únicos (refaz a composição com o total atual)
  if p ? 'lines' or p ? 'chart_account_id' or p ? 'allocation_template_id' or p ? 'installments' or p ? 'cost_center_id' then
    if jsonb_array_length(coalesce(p -> 'lines', '[]')) > 0 then
      select coalesce(sum(round((x ->> 'amount')::numeric, 2)), 0) into v_lines_total from jsonb_array_elements(p -> 'lines') x;
      if v_lines_total <> v_total then raise exception 'A divisão (%) precisa somar o valor total (%)', v_lines_total, v_total using errcode = 'P0500'; end if;
      delete from fin.title_lines where title_id = t.id;
      for ln in select * from jsonb_array_elements(p -> 'lines') loop
        insert into fin.title_lines (org_id, title_id, chart_account_id, cost_center_id, amount)
        values (v_org, t.id, (ln ->> 'chart_account_id')::uuid, nullif(ln ->> 'cost_center_id', '')::uuid, round((ln ->> 'amount')::numeric, 2));
      end loop;
    elsif nullif(p ->> 'allocation_template_id', '') is not null and t.chart_account_id is not null then
      delete from fin.title_lines where title_id = t.id;
      for r in select * from fin.split_by_template((p ->> 'allocation_template_id')::uuid, v_total) loop
        insert into fin.title_lines (org_id, title_id, chart_account_id, cost_center_id, amount) values (v_org, t.id, t.chart_account_id, r.cost_center_id, r.amount);
      end loop;
    elsif t.chart_account_id is not null and (p ? 'chart_account_id' or p ? 'cost_center_id'
          or (select count(distinct (chart_account_id, cost_center_id)) from fin.title_lines where title_id = t.id) <= 1) then
      delete from fin.title_lines where title_id = t.id;
      insert into fin.title_lines (org_id, title_id, chart_account_id, cost_center_id, amount) values (v_org, t.id, t.chart_account_id, t.cost_center_id, v_total);
    elsif (select coalesce(sum(amount), 0) from fin.title_lines where title_id = t.id) not in (0, v_total) then
      raise exception 'O valor mudou e o título tem rateio: refaça a divisão por conta e centro de custo' using errcode = 'P0500';
    end if;
  end if;

  if v_was_posted then perform private.post_title_accrual(t.id, v_rev); end if;
  select * into t from fin.titles where id = t.id;
  return t;
end $$;

-- ---------------------------------------------------------------------
-- 3) Recorrência: pausar / retomar
-- ---------------------------------------------------------------------
create or replace function fin.set_recurring_active(p_id uuid, p_active boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('fin.write');
  update fin.recurring_templates set active = p_active where id = p_id and org_id = private.org_id();
  if not found then raise exception 'Recorrência não encontrada' using errcode = 'P0501'; end if;
end $$;

-- ---------------------------------------------------------------------
-- 4) Empréstimos e financiamentos
-- ---------------------------------------------------------------------
create table fin.loans (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  legal_entity_id uuid not null references core.legal_entities(id),
  bank_account_id uuid not null references fin.bank_accounts(id),
  party_id uuid references crm.parties(id),                     -- banco / credor
  description text not null,
  principal numeric(14,2) not null check (principal > 0),       -- valor que entrou na conta
  monthly_rate numeric(9,6) not null default 0,                -- taxa ao mês (0,0199 = 1,99%)
  installments int not null check (installments between 1 and 360),
  installment_amount numeric(14,2) not null,
  first_due date not null,
  received_on date not null,
  cost_center_id uuid references core.cost_centers(id),
  cash_transaction_id uuid references fin.cash_transactions(id),
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'PAID', 'CANCELLED')),
  notes text,
  created_by uuid references core.members(id),
  created_at timestamptz not null default now()
);
select private.apply_rls('fin', array['loans'], 'fin.read', 'fin.write');
select private.rpc_only('fin', array['loans']);

-- Prestação pela tabela Price
create or replace function private.price_installment(p_principal numeric, p_rate numeric, p_n int) returns numeric
language sql immutable set search_path = '' as $$
  select case when p_rate <= 0 then round(p_principal / p_n, 2) else round(p_principal * p_rate / (1 - power(1 + p_rate, -p_n)), 2) end
$$;

-- p = {legal_entity_id?, bank_account_id, party_id?, description, principal, installments, first_due, received_on?,
--      monthly_rate_pct? | installment_amount?, cost_center_id?, notes?}
-- Informe a taxa (% ao mês) OU o valor da parcela: o outro é calculado.
create or replace function fin.create_loan(p jsonb) returns fin.loans
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id(); v_ba fin.bank_accounts; l fin.loans;
  v_p numeric := round((p ->> 'principal')::numeric, 2); v_n int := (p ->> 'installments')::int;
  v_rate numeric := nullif(p ->> 'monthly_rate_pct', '')::numeric / 100; v_pmt numeric := nullif(p ->> 'installment_amount', '')::numeric;
  v_lo numeric := 0; v_hi numeric := 1; v_mid numeric; v_bal numeric; v_int numeric; v_amort numeric; v_due date; v_first date := (p ->> 'first_due')::date;
  v_recv date := coalesce(nullif(p ->> 'received_on', '')::date, private.today_sp()); v_liab uuid; v_intacc uuid; v_tx uuid; i int; v_t fin.titles;
  v_desc text := trim(coalesce(p ->> 'description', ''));
begin
  perform private.require_perm('fin.approve');
  select * into v_ba from fin.bank_accounts where id = (p ->> 'bank_account_id')::uuid and org_id = v_org and active;
  if v_ba.id is null then raise exception 'Conta bancária inválida' using errcode = 'P0501'; end if;
  if length(v_desc) < 3 then raise exception 'Descreva o empréstimo (ex.: Capital de giro Banco X)' using errcode = 'P0500'; end if;
  if v_p is null or v_p <= 0 then raise exception 'Informe o valor recebido' using errcode = 'P0500'; end if;
  if v_n is null or v_n not between 1 and 360 then raise exception 'Parcelas: de 1 a 360' using errcode = 'P0500'; end if;
  if v_first is null then raise exception 'Informe o 1º vencimento' using errcode = 'P0500'; end if;
  if v_recv > private.today_sp() then raise exception 'A data em que o dinheiro entrou não pode ser futura' using errcode = 'P0500'; end if;
  if v_rate is null and v_pmt is null then raise exception 'Informe a taxa de juros ao mês ou o valor da parcela' using errcode = 'P0500'; end if;
  if v_rate is not null and v_rate < 0 then raise exception 'Taxa inválida' using errcode = 'P0500'; end if;
  if v_rate is null then
    if v_pmt * v_n < v_p then raise exception 'As parcelas somam menos que o valor recebido' using errcode = 'P0500'; end if;
    -- taxa implícita (bissecção)
    for i in 1..80 loop
      v_mid := (v_lo + v_hi) / 2;
      if private.price_installment(v_p, v_mid, v_n) > v_pmt then v_hi := v_mid; else v_lo := v_mid; end if;
    end loop;
    v_rate := round((v_lo + v_hi) / 2, 6);
  end if;
  v_pmt := coalesce(v_pmt, private.price_installment(v_p, v_rate, v_n));
  v_liab := private.acct(v_org, 'LOAN_LIABILITY');
  v_intacc := private.acct(v_org, 'INTEREST_EXPENSE');
  if v_liab is null or v_intacc is null then raise exception 'Configure as contas de empréstimos e de juros no plano de contas' using errcode = 'P0500'; end if;

  insert into fin.loans (org_id, legal_entity_id, bank_account_id, party_id, description, principal, monthly_rate, installments, installment_amount,
                         first_due, received_on, cost_center_id, notes, created_by)
  values (v_org, v_ba.legal_entity_id, v_ba.id, nullif(p ->> 'party_id', '')::uuid, v_desc, v_p, v_rate, v_n, v_pmt, v_first, v_recv,
          nullif(p ->> 'cost_center_id', '')::uuid, nullif(trim(coalesce(p ->> 'notes', '')), ''), private.member_id())
  returning * into l;

  -- o dinheiro que entrou (passivo de empréstimo)
  v_tx := private.post_cash_movement(jsonb_build_object('bank_account_id', v_ba.id, 'kind', 'LOAN', 'direction', 'IN', 'amount', v_p, 'occurred_on', v_recv,
                                                        'party_id', l.party_id, 'description', 'Empréstimo: ' || v_desc), private.member_id());
  update fin.loans set cash_transaction_id = v_tx where id = l.id;

  -- cada parcela: amortização (abate o passivo) + juros (despesa financeira)
  v_bal := v_p;
  for i in 1..v_n loop
    v_due := (v_first + make_interval(months => i - 1))::date;
    v_int := round(v_bal * v_rate, 2);
    v_amort := case when i = v_n then v_bal else least(v_pmt - v_int, v_bal) end;
    if i = v_n then v_int := greatest(v_pmt - v_amort, 0); end if;
    v_bal := v_bal - v_amort;
    v_t := private.insert_title(jsonb_build_object(
      'legal_entity_id', v_ba.legal_entity_id, 'direction', 'PAYABLE', 'party_id', l.party_id,
      'description', format('%s — parcela %s/%s', v_desc, i, v_n), 'document_kind', 'EMPRESTIMO', 'competence_date', v_due,
      'origin_type', 'LOAN', 'origin_id', l.id, 'approval_status', 'APPROVED',
      'installments', jsonb_build_array(jsonb_build_object('due_date', v_due, 'amount', v_amort + v_int)),
      'lines', (select jsonb_agg(x) from (
                  select jsonb_build_object('chart_account_id', v_liab, 'amount', v_amort, 'memo', 'Amortização') as x where v_amort > 0
                  union all
                  select jsonb_build_object('chart_account_id', v_intacc, 'cost_center_id', l.cost_center_id, 'amount', v_int, 'memo', 'Juros') where v_int > 0) z)
    ), private.member_id());
  end loop;
  return l;
end $$;

-- ---------------------------------------------------------------------
-- 5) Conta bancária e loja: editar o que é seguro
-- ---------------------------------------------------------------------
-- p = {id, name, bank_code?, agency?, number?, pix_keys?:[...], store_id?, chart_account_id?, active?}
create or replace function fin.update_bank_account(p jsonb) returns fin.bank_accounts
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); b fin.bank_accounts; v_moves boolean; v_acc uuid := nullif(p ->> 'chart_account_id', '')::uuid; v_bal numeric;
begin
  if not (private.has_perm('fin.write') or private.has_perm('core.admin')) then raise exception 'Sem permissão' using errcode = '42501'; end if;
  select * into b from fin.bank_accounts where id = nullif(p ->> 'id', '')::uuid and org_id = v_org for update;
  if b.id is null then raise exception 'Conta não encontrada' using errcode = 'P0501'; end if;
  if length(trim(coalesce(p ->> 'name', ''))) not between 2 and 80 then raise exception 'Nome: 2 a 80 caracteres' using errcode = 'P0500'; end if;
  if nullif(p ->> 'store_id', '') is not null and not exists (select 1 from core.stores where id = (p ->> 'store_id')::uuid and org_id = v_org) then raise exception 'Loja inválida' using errcode = 'P0501'; end if;
  v_moves := exists (select 1 from fin.cash_transactions where bank_account_id = b.id);
  if v_acc is not null and v_acc is distinct from b.chart_account_id then
    if v_moves then raise exception 'A conta já tem movimentos: a conta do plano não muda (o histórico contábil depende dela)' using errcode = 'P0502'; end if;
    if not exists (select 1 from fin.chart_accounts where id = v_acc and org_id = v_org and kind = 'ANALYTIC' and "group" = 'ASSET' and archived_at is null) then
      raise exception 'Escolha uma conta analítica do ativo' using errcode = 'P0500';
    end if;
  end if;
  if p ? 'active' and not (p ->> 'active')::boolean and b.active then
    select coalesce(balance, 0) into v_bal from fin.v_bank_balances where bank_account_id = b.id;
    if coalesce(v_bal, 0) <> 0 then raise exception 'Zere o saldo (transfira) antes de desativar a conta' using errcode = 'P0502'; end if;
  end if;
  update fin.bank_accounts set name = trim(p ->> 'name'), bank_code = nullif(trim(coalesce(p ->> 'bank_code', '')), ''),
         agency = nullif(trim(coalesce(p ->> 'agency', '')), ''), number = nullif(trim(coalesce(p ->> 'number', '')), ''),
         pix_keys = coalesce(array(select trim(x) from jsonb_array_elements_text(coalesce(p -> 'pix_keys', '[]')) x where trim(x) <> ''), '{}'),
         store_id = nullif(p ->> 'store_id', '')::uuid, chart_account_id = coalesce(v_acc, chart_account_id),
         active = coalesce((p ->> 'active')::boolean, active)
  where id = b.id returning * into b;
  return b;
end $$;

-- p = {id, name, format, status, opened_at?, closed_at?, area_m2?}
create or replace function core.update_store(p jsonb) returns core.stores
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); s core.stores; v_fmt core.store_format; v_st core.store_status;
begin
  perform private.require_perm('core.admin');
  select * into s from core.stores where id = nullif(p ->> 'id', '')::uuid and org_id = v_org for update;
  if s.id is null then raise exception 'Loja não encontrada' using errcode = 'P0501'; end if;
  if length(trim(coalesce(p ->> 'name', ''))) not between 2 and 80 then raise exception 'Nome: 2 a 80 caracteres' using errcode = 'P0500'; end if;
  begin v_fmt := coalesce(nullif(p ->> 'format', ''), s.format::text)::core.store_format; v_st := coalesce(nullif(p ->> 'status', ''), s.status::text)::core.store_status;
  exception when others then raise exception 'Formato ou situação inválidos' using errcode = 'P0500'; end;
  if nullif(p ->> 'area_m2', '') is not null and (p ->> 'area_m2')::numeric <= 0 then raise exception 'Área inválida' using errcode = 'P0500'; end if;
  update core.stores set name = trim(p ->> 'name'), format = v_fmt, status = v_st,
         opened_at = case when p ? 'opened_at' then nullif(p ->> 'opened_at', '')::date else opened_at end,
         closed_at = case when v_st = 'CLOSED' then coalesce(nullif(p ->> 'closed_at', '')::date, closed_at, private.today_sp()) else null end,
         area_m2 = case when p ? 'area_m2' then nullif(p ->> 'area_m2', '')::numeric else area_m2 end
  where id = s.id returning * into s;
  -- o centro de custo da loja acompanha o nome
  update core.cost_centers set name = 'Loja ' || s.name where id = s.cost_center_id and kind = 'STORE' and name like 'Loja %';
  return s;
end $$;

insert into private.internal_functions (fqname) values ('private.price_installment') on conflict do nothing;
select private.lock_functions();
