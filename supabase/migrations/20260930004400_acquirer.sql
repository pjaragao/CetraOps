-- =====================================================================
-- Financeiro › Adquirente: o lado da maquininha na conciliação em 3 vias.
--   venda do sistema (sales.payments) ↔ transação da adquirente ↔ recebíveis/repasse ↔ extrato do banco.
-- Entrada genérica (arquivo no layout padrão ou, no futuro, a API de cada adquirente): o banco casa cada transação com a venda (NSU),
-- liga cada recebível à parcela a receber, audita a taxa cobrada contra a tabela contratada e, no repasse, baixa as parcelas com a
-- taxa REAL cobrada (MDR e antecipação em contas separadas). O valor do banco nunca é alterado: diferença vira pendência.
-- Códigos de erro: P0260 dado inválido · P0261 situação não permite · P0262 valores não fecham · P0263 não encontrado.
-- =====================================================================

create table fin.acquirer_imports (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  acquirer text not null,
  filename text,
  file_hash text,
  transactions_total int not null default 0,
  transactions_new int not null default 0,
  created_by uuid references core.members(id),
  created_at timestamptz not null default now(),
  unique (org_id, acquirer, file_hash)
);

create table fin.acquirer_payouts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  acquirer text not null,
  external_id text not null,
  paid_on date not null,
  amount numeric(14,2) not null check (amount > 0),
  bank_account_id uuid references fin.bank_accounts(id),
  status text not null default 'PENDING' check (status in ('PENDING', 'SETTLED')),
  settlement_id uuid references fin.settlements(id),
  import_id uuid references fin.acquirer_imports(id),
  created_at timestamptz not null default now(),
  unique (org_id, acquirer, external_id)
);

create table fin.acquirer_transactions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  acquirer text not null,
  external_id text not null,
  nsu text,
  auth_code text,
  terminal text,
  brand text,
  last4 text,
  captured_at timestamptz not null,
  method sales.payment_method not null,
  installments smallint not null default 1 check (installments between 1 and 24),
  gross numeric(14,2) not null check (gross > 0),
  mdr_fee numeric(14,2) not null default 0,
  anticipation_fee numeric(14,2) not null default 0,
  payment_id uuid references sales.payments(id),
  match_status text not null default 'UNMATCHED' check (match_status in ('MATCHED', 'UNMATCHED')),
  fee_expected numeric(14,2),
  fee_variance numeric(14,2),                                      -- cobrado − esperado (positivo = a adquirente cobrou a mais)
  import_id uuid references fin.acquirer_imports(id),
  raw jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (org_id, acquirer, external_id)
);
create index on fin.acquirer_transactions (org_id, match_status);
create index on fin.acquirer_transactions (payment_id);

create table fin.acquirer_receivables (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  transaction_id uuid not null references fin.acquirer_transactions(id) on delete cascade,
  n smallint not null,
  expected_date date,
  gross numeric(14,2) not null check (gross > 0),
  mdr_fee numeric(14,2) not null default 0,
  anticipation_fee numeric(14,2) not null default 0,
  net numeric(14,2) not null,
  status text not null default 'EXPECTED' check (status in ('EXPECTED', 'PAID')),
  installment_id uuid references fin.title_installments(id),
  payout_id uuid references fin.acquirer_payouts(id),
  unique (transaction_id, n),
  check (abs(net - (gross - mdr_fee - anticipation_fee)) <= 0.02)
);
create index on fin.acquirer_receivables (payout_id);

select private.apply_rls('fin', array['acquirer_imports', 'acquirer_payouts', 'acquirer_transactions', 'acquirer_receivables'], 'fin.read', 'fin.write');
select private.rpc_only('fin', array['acquirer_imports', 'acquirer_payouts', 'acquirer_transactions', 'acquirer_receivables']);

-- ---------------------------------------------------------------------
-- Importação (arquivo ou API): grava, casa com a venda, liga a parcela, audita a taxa
-- p = {acquirer, filename, hash, bank_account_id?, transactions: [{external_id, nsu, auth_code, terminal, brand, last4, captured_at, method, installments, gross, mdr_fee,
--      anticipation_fee, receivables: [{n, expected_date, gross, mdr_fee, anticipation_fee, net, payout_external_id}]}],
--      payouts: [{external_id, paid_on, amount}]}
-- ---------------------------------------------------------------------
create or replace function fin.import_acquirer(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id(); v_acq text := upper(trim(coalesce(p ->> 'acquirer', ''))); v_imp uuid; t jsonb; r jsonb; po jsonb;
  v_tx uuid; v_pay sales.payments; v_n_new int := 0; v_n_dup int := 0; v_matched int := 0; v_pay_new int := 0; v_ti uuid; v_cnt int; v_method sales.payment_method;
  v_gross numeric; v_mdr numeric; v_ant numeric; v_exp numeric; v_cand int; v_flag int := 0; v_total int;
begin
  perform private.require_perm('fin.write');
  if length(v_acq) not between 2 and 30 then raise exception 'Informe a adquirente (2 a 30 caracteres)' using errcode = 'P0260'; end if;
  if jsonb_typeof(p -> 'transactions') is distinct from 'array' and jsonb_typeof(p -> 'payouts') is distinct from 'array' then raise exception 'O arquivo não traz transações nem repasses' using errcode = 'P0260'; end if;
  v_total := coalesce(jsonb_array_length(p -> 'transactions'), 0);
  if v_total > 5000 then raise exception 'Máximo de 5.000 transações por arquivo: divida em partes' using errcode = 'P0260'; end if;
  if nullif(p ->> 'hash', '') is not null and exists (select 1 from fin.acquirer_imports where org_id = v_org and acquirer = v_acq and file_hash = p ->> 'hash') then
    raise exception 'Este arquivo já foi importado' using errcode = 'P0261';
  end if;
  insert into fin.acquirer_imports (org_id, acquirer, filename, file_hash, transactions_total, created_by)
  values (v_org, v_acq, left(p ->> 'filename', 200), nullif(p ->> 'hash', ''), v_total, private.member_id()) returning id into v_imp;

  for po in select * from jsonb_array_elements(coalesce(p -> 'payouts', '[]')) loop
    if nullif(po ->> 'external_id', '') is null or (po ->> 'amount')::numeric <= 0 or (po ->> 'paid_on') is null then raise exception 'Repasse inválido (código, data e valor são obrigatórios)' using errcode = 'P0260'; end if;
    insert into fin.acquirer_payouts (org_id, acquirer, external_id, paid_on, amount, bank_account_id, import_id)
    values (v_org, v_acq, po ->> 'external_id', (po ->> 'paid_on')::date, (po ->> 'amount')::numeric, nullif(p ->> 'bank_account_id', '')::uuid, v_imp)
    on conflict (org_id, acquirer, external_id) do nothing;
    get diagnostics v_cnt = row_count; v_pay_new := v_pay_new + v_cnt;
  end loop;

  for t in select * from jsonb_array_elements(coalesce(p -> 'transactions', '[]')) loop
    if nullif(t ->> 'external_id', '') is null or coalesce((t ->> 'gross')::numeric, 0) <= 0 or (t ->> 'captured_at') is null then raise exception 'Transação inválida (código, data e valor são obrigatórios)' using errcode = 'P0260'; end if;
    v_method := (case upper(coalesce(t ->> 'method', '')) when 'PIX' then 'PIX' when 'DEBIT' then 'DEBIT' when 'CREDIT' then 'CREDIT' else null end)::sales.payment_method;
    if v_method is null then raise exception 'Forma de pagamento inválida na transação % (use PIX, DEBIT ou CREDIT)', t ->> 'external_id' using errcode = 'P0260'; end if;
    v_gross := round((t ->> 'gross')::numeric, 2); v_mdr := round(coalesce((t ->> 'mdr_fee')::numeric, 0), 2); v_ant := round(coalesce((t ->> 'anticipation_fee')::numeric, 0), 2);
    if jsonb_typeof(t -> 'receivables') = 'array' and abs((select coalesce(sum((x ->> 'gross')::numeric), 0) from jsonb_array_elements(t -> 'receivables') x) - v_gross) > 0.05 then
      raise exception 'Transação %: as parcelas a receber não somam o valor da venda', t ->> 'external_id' using errcode = 'P0262';
    end if;

    -- casa com a venda do sistema: NSU exato; sem NSU, só quando houver um único candidato (mesmo valor, forma, parcelas e dia)
    v_pay := null;
    if nullif(t ->> 'nsu', '') is not null then
      select * into v_pay from sales.payments where org_id = v_org and nsu = t ->> 'nsu' and amount = v_gross and method = v_method
        and not exists (select 1 from fin.acquirer_transactions x where x.payment_id = sales.payments.id) limit 1;
    end if;
    if v_pay.id is null then
      select count(*) into v_cand from sales.payments x where x.org_id = v_org and x.method = v_method and x.amount = v_gross and x.installments = coalesce((t ->> 'installments')::int, 1)
        and x.created_at::date between ((t ->> 'captured_at')::timestamptz at time zone 'America/Sao_Paulo')::date - 1 and ((t ->> 'captured_at')::timestamptz at time zone 'America/Sao_Paulo')::date + 1
        and not exists (select 1 from fin.acquirer_transactions y where y.payment_id = x.id);
      if v_cand = 1 then
        select x.* into v_pay from sales.payments x where x.org_id = v_org and x.method = v_method and x.amount = v_gross and x.installments = coalesce((t ->> 'installments')::int, 1)
          and x.created_at::date between ((t ->> 'captured_at')::timestamptz at time zone 'America/Sao_Paulo')::date - 1 and ((t ->> 'captured_at')::timestamptz at time zone 'America/Sao_Paulo')::date + 1
          and not exists (select 1 from fin.acquirer_transactions y where y.payment_id = x.id);
      end if;
    end if;
    v_exp := case when v_pay.id is not null then v_pay.fee_expected end;

    insert into fin.acquirer_transactions (org_id, acquirer, external_id, nsu, auth_code, terminal, brand, last4, captured_at, method, installments, gross, mdr_fee, anticipation_fee,
                                           payment_id, match_status, fee_expected, fee_variance, import_id, raw)
    values (v_org, v_acq, t ->> 'external_id', nullif(t ->> 'nsu', ''), t ->> 'auth_code', t ->> 'terminal', t ->> 'brand', t ->> 'last4', (t ->> 'captured_at')::timestamptz, v_method,
            coalesce((t ->> 'installments')::int, 1), v_gross, v_mdr, v_ant, v_pay.id, case when v_pay.id is null then 'UNMATCHED' else 'MATCHED' end, v_exp,
            case when v_exp is null then null else round(v_mdr + v_ant - v_exp, 2) end, v_imp, t - 'receivables')
    on conflict (org_id, acquirer, external_id) do nothing returning id into v_tx;
    if v_tx is null then v_n_dup := v_n_dup + 1; continue; end if;
    v_n_new := v_n_new + 1;
    if v_pay.id is not null then v_matched := v_matched + 1; end if;

    for r in select * from jsonb_array_elements(coalesce(t -> 'receivables', '[]')) loop
      v_ti := null;
      if v_pay.id is not null then
        select count(*), min(ti.id::text)::uuid into v_cnt, v_ti from fin.title_installments ti join fin.titles ti_t on ti_t.id = ti.title_id
        where ti_t.org_id = v_org and ti_t.origin_type = 'ORDER' and ti_t.origin_id = v_pay.order_id and ti_t.document_kind = v_method::text and ti.n = (r ->> 'n')::int
          and abs(ti.amount - (r ->> 'gross')::numeric) <= 0.05;
        if v_cnt <> 1 then v_ti := null; end if;
      end if;
      insert into fin.acquirer_receivables (org_id, transaction_id, n, expected_date, gross, mdr_fee, anticipation_fee, net, installment_id, payout_id)
      values (v_org, v_tx, (r ->> 'n')::int, (r ->> 'expected_date')::date, (r ->> 'gross')::numeric, coalesce((r ->> 'mdr_fee')::numeric, 0), coalesce((r ->> 'anticipation_fee')::numeric, 0),
              (r ->> 'net')::numeric, v_ti,
              (select id from fin.acquirer_payouts where org_id = v_org and acquirer = v_acq and external_id = nullif(r ->> 'payout_external_id', '')));
    end loop;

    -- taxa cobrada acima do contratado: abre uma sugestão para conferir com a adquirente
    if v_exp is not null and (v_mdr + v_ant - v_exp) > greatest(1.00, 0.005 * v_gross) then
      v_flag := v_flag + 1;
      perform private.open_suggestion(v_org, 'ANOMALY', 'FEE:' || v_tx, 'FEE_MISMATCH', 'MEDIUM',
        format('Taxa cobrada acima da contratada (%s, NSU %s)', v_acq, coalesce(t ->> 'nsu', '—')),
        format('Cobrado R$ %s; esperado pela tabela R$ %s. Confira o contrato e conteste a diferença com a adquirente.', to_char(v_mdr + v_ant, 'FM999990.00'), to_char(v_exp, 'FM999990.00')),
        '/financeiro/adquirente', 'fin.acquirer_transactions', v_tx);
    end if;
  end loop;

  update fin.acquirer_imports set transactions_new = v_n_new where id = v_imp;
  return jsonb_build_object('import_id', v_imp, 'transactions_new', v_n_new, 'transactions_duplicate', v_n_dup, 'matched', v_matched, 'unmatched', v_n_new - v_matched, 'payouts_new', v_pay_new, 'fee_alerts', v_flag);
end $$;

-- ---------------------------------------------------------------------
-- Repasse: baixa as parcelas a receber ligadas a ele, com a taxa REAL cobrada, e tenta casar com o extrato
-- ---------------------------------------------------------------------
create or replace function fin.settle_acquirer_payout(p_payout uuid, p_bank_account uuid default null) returns fin.settlements
language plpgsql security definer set search_path = '' as $$
declare
  po fin.acquirer_payouts; v_bank uuid; v_lines jsonb := '[]'; r record; v_total numeric := 0; v_unlinked int; v_mdr uuid; v_ant uuid; s fin.settlements;
begin
  perform private.require_perm('fin.write');
  select * into po from fin.acquirer_payouts where id = p_payout and org_id = private.org_id() for update;
  if po.id is null then raise exception 'Repasse não encontrado' using errcode = 'P0263'; end if;
  if po.status = 'SETTLED' then raise exception 'Este repasse já foi baixado' using errcode = 'P0261'; end if;
  v_bank := coalesce(p_bank_account, po.bank_account_id);
  if v_bank is null then raise exception 'Escolha a conta bancária que recebeu o repasse' using errcode = 'P0260'; end if;
  select count(*) into v_unlinked from fin.acquirer_receivables where payout_id = po.id and installment_id is null;
  if v_unlinked > 0 then raise exception '% parcela(s) deste repasse não casam com vendas do sistema: resolva antes de baixar', v_unlinked using errcode = 'P0261'; end if;
  if not exists (select 1 from fin.acquirer_receivables where payout_id = po.id) then raise exception 'Este repasse não tem parcelas ligadas' using errcode = 'P0261'; end if;
  select id into v_mdr from fin.chart_accounts where org_id = po.org_id and code = '7.1.02';
  select id into v_ant from fin.chart_accounts where org_id = po.org_id and code = '8.1.01';
  if v_mdr is null or v_ant is null then raise exception 'Faltam as contas de MDR (7.1.02) e de antecipação (8.1.01) no plano de contas' using errcode = 'P0261'; end if;

  for r in select * from fin.acquirer_receivables where payout_id = po.id order by transaction_id, n loop
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('kind', 'PRINCIPAL', 'amount', r.gross, 'installment_id', r.installment_id));
    if r.mdr_fee > 0 then v_lines := v_lines || jsonb_build_array(jsonb_build_object('kind', 'FEE', 'amount', r.mdr_fee, 'installment_id', r.installment_id, 'chart_account_id', v_mdr)); end if;
    if r.anticipation_fee > 0 then v_lines := v_lines || jsonb_build_array(jsonb_build_object('kind', 'FEE', 'amount', r.anticipation_fee, 'installment_id', r.installment_id, 'chart_account_id', v_ant)); end if;
    v_total := v_total + r.net;
  end loop;
  if abs(v_total - po.amount) > 0.01 then
    raise exception 'As parcelas somam R$ % líquidos, mas o repasse é de R$ %: confira o arquivo', to_char(v_total, 'FM999990.00'), to_char(po.amount, 'FM999990.00') using errcode = 'P0262';
  end if;

  s := fin.settle(jsonb_build_object('bank_account_id', v_bank, 'direction', 'RECEIVABLE', 'method', 'CARD_PAYOUT', 'settled_on', po.paid_on, 'amount', po.amount,
        'description', format('Repasse %s %s', po.acquirer, po.external_id), 'idempotency_key', 'acqpayout:' || po.id, 'lines', v_lines));
  update fin.acquirer_receivables set status = 'PAID' where payout_id = po.id;
  update fin.acquirer_payouts set status = 'SETTLED', settlement_id = s.id, bank_account_id = v_bank where id = po.id;
  perform fin.auto_match(v_bank);                                    -- liga o crédito do extrato à baixa recém-criada, quando o valor e a data conferem
  return s;
end $$;

-- ---------------------------------------------------------------------
-- Auditoria de taxa: cobrado × contratado por adquirente, forma e parcelas
-- ---------------------------------------------------------------------
create or replace function fin.acquirer_audit(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_perm('fin.read');
  return coalesce((select jsonb_agg(row_to_json(x)::jsonb order by x.variance desc) from (
    select t.acquirer, t.method::text as method, t.installments, count(*) as transactions, sum(t.gross) as gross, sum(t.mdr_fee + t.anticipation_fee) as charged,
           sum(t.fee_expected) as expected, sum(t.fee_variance) as variance
    from fin.acquirer_transactions t
    where t.org_id = private.org_id() and t.match_status = 'MATCHED' and (t.captured_at at time zone 'America/Sao_Paulo')::date between p_from and p_to
    group by t.acquirer, t.method, t.installments) x), '[]'::jsonb);
end $$;

select private.lock_functions();
