-- =====================================================================
-- Afiliados (trainers parceiros): cada trainer tem um cupom (desconto para a aluna) e ganha comissão sobre as vendas feitas com ele.
-- O extrato do mês é calculado no banco a partir dos pedidos com o cupom (menos as devoluções do mês); ao aprovar, a comissão vira
-- vale-troca (passivo, com lançamento contábil) ou conta a pagar por Pix (título aprovado), sempre no centro de custo da venda.
-- Códigos de erro: P0160 dado inválido · P0161 situação não permite · P0162 não encontrado.
-- ⚠ Confira o contrato com a academia parceira: a loja pode não poder dirigir funcionários dela — validar com o jurídico antes de cadastrar trainers da academia.
-- =====================================================================

select private.init_schema('aff');

create table aff.affiliates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  party_id uuid not null references crm.parties(id),
  coupon_id uuid not null references sales.coupons(id),
  student_discount_pct numeric(5, 2) not null default 10 check (student_discount_pct between 1 and 50),
  commission_pct numeric(5, 2) not null default 8 check (commission_pct between 0 and 30),
  payout_mode text not null default 'STORE_CREDIT' check (payout_mode in ('STORE_CREDIT', 'PIX')),
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'PAUSED', 'ENDED')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, party_id)
);

create table aff.statements (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  affiliate_id uuid not null references aff.affiliates(id),
  competence date not null check (competence = date_trunc('month', competence)::date),
  orders_count integer not null default 0,
  sales_amount numeric(14, 2) not null default 0,              -- base de comissão das vendas do mês (itens menos desconto, sem frete)
  returns_amount numeric(14, 2) not null default 0,            -- devoluções do mês de pedidos do cupom
  commission_pct numeric(5, 2) not null,
  commission numeric(14, 2) not null default 0,
  payout_mode text not null,
  detail jsonb not null default '{}',                          -- {groups: [{legal_entity_id, cost_center_id, base, commission}]}
  status text not null default 'DRAFT' check (status in ('DRAFT', 'APPROVED', 'PAID')),
  approved_by uuid references core.members(id),
  approved_at timestamptz,
  paid_at timestamptz,
  payable_title_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (affiliate_id, competence)
);
create index statements_competence_idx on aff.statements (org_id, competence desc);

select private.attach_updated_at('aff');
select private.apply_rls('aff', array['affiliates'], 'crm.read', 'crm.write');
select private.apply_rls('aff', array['statements'], 'fin.read', 'fin.write');
select private.rpc_only('aff', array['affiliates', 'statements']);
create trigger trg_audit after insert or update or delete on aff.affiliates for each row execute function private.audit_capture();
create trigger trg_audit after insert or update or delete on aff.statements for each row execute function private.audit_capture();

-- ---------------------------------------------------------------------
-- 1) Cadastro
-- p = {id?, party_id, coupon_code, student_discount_pct?, commission_pct?, payout_mode?, notes?}
-- ---------------------------------------------------------------------
create or replace function aff.save_affiliate(p jsonb) returns aff.affiliates
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id(); v_id uuid := nullif(p ->> 'id', '')::uuid; v_party uuid := nullif(p ->> 'party_id', '')::uuid;
  v_code text := upper(trim(coalesce(p ->> 'coupon_code', ''))); v_disc numeric := coalesce(nullif(p ->> 'student_discount_pct', '')::numeric, 10);
  v_comm numeric := coalesce(nullif(p ->> 'commission_pct', '')::numeric, 8); v_mode text := upper(coalesce(nullif(trim(p ->> 'payout_mode'), ''), 'STORE_CREDIT'));
  a aff.affiliates; v_coupon uuid;
begin
  perform private.require_perm('crm.write');
  if v_code !~ '^[A-Z0-9]{3,20}$' then raise exception 'O cupom usa de 3 a 20 letras ou números (sem espaço nem acento)' using errcode = 'P0160'; end if;
  if v_disc not between 1 and 50 then raise exception 'O desconto da aluna vai de 1%% a 50%%' using errcode = 'P0160'; end if;
  if v_comm not between 0 and 30 then raise exception 'A comissão vai de 0%% a 30%%' using errcode = 'P0160'; end if;
  if v_mode not in ('STORE_CREDIT', 'PIX') then raise exception 'Forma de pagamento inválida' using errcode = 'P0160'; end if;
  if v_id is null then
    if not exists (select 1 from crm.parties where id = v_party and org_id = v_org and merged_into_id is null) then raise exception 'Escolha a pessoa' using errcode = 'P0160'; end if;
    if exists (select 1 from aff.affiliates where org_id = v_org and party_id = v_party) then raise exception 'Essa pessoa já é afiliada' using errcode = 'P0160'; end if;
    if exists (select 1 from sales.coupons where org_id = v_org and upper(code) = v_code) then raise exception 'Já existe um cupom com o código %', v_code using errcode = 'P0160'; end if;
    insert into sales.coupons (org_id, code, kind, value, affiliate_party_id, per_customer_limit) values (v_org, v_code, 'PERCENT', v_disc, v_party, null) returning id into v_coupon;
    insert into aff.affiliates (org_id, party_id, coupon_id, student_discount_pct, commission_pct, payout_mode, notes)
    values (v_org, v_party, v_coupon, v_disc, v_comm, v_mode, nullif(trim(coalesce(p ->> 'notes', '')), '')) returning * into a;
    insert into crm.party_roles (org_id, party_id, role) values (v_org, v_party, 'AFFILIATE_TRAINER') on conflict do nothing;
  else
    select * into a from aff.affiliates where id = v_id and org_id = v_org for update;
    if a.id is null then raise exception 'Afiliada não encontrada' using errcode = 'P0162'; end if;
    if exists (select 1 from sales.coupons where org_id = v_org and upper(code) = v_code and id <> a.coupon_id) then raise exception 'Já existe um cupom com o código %', v_code using errcode = 'P0160'; end if;
    if v_code <> (select upper(code) from sales.coupons where id = a.coupon_id) and exists (select 1 from sales.coupon_redemptions where coupon_id = a.coupon_id) then
      raise exception 'O cupom já foi usado em vendas: o código não pode mudar' using errcode = 'P0161';
    end if;
    update sales.coupons set code = v_code, value = v_disc where id = a.coupon_id;
    update aff.affiliates set student_discount_pct = v_disc, commission_pct = v_comm, payout_mode = v_mode, notes = nullif(trim(coalesce(p ->> 'notes', '')), '') where id = a.id returning * into a;
  end if;
  return a;
end $$;

create or replace function aff.set_affiliate_status(p_id uuid, p_status text) returns aff.affiliates
language plpgsql security definer set search_path = '' as $$
declare a aff.affiliates;
begin
  perform private.require_perm('crm.write');
  if p_status not in ('ACTIVE', 'PAUSED', 'ENDED') then raise exception 'Situação inválida' using errcode = 'P0160'; end if;
  update aff.affiliates set status = p_status where id = p_id and org_id = private.org_id() returning * into a;
  if a.id is null then raise exception 'Afiliada não encontrada' using errcode = 'P0162'; end if;
  update sales.coupons set active = (p_status = 'ACTIVE') where id = a.coupon_id;          -- pausada ou encerrada: o cupom para de valer
  return a;
end $$;

-- ---------------------------------------------------------------------
-- 2) Extrato do mês (recalculável enquanto for rascunho)
-- Base = itens menos desconto (sem frete) dos pedidos com o cupom da afiliada (pagos ou em andamento, exceto compras da própria afiliada), menos devoluções do mês.
-- A comissão é calculada por empresa e centro de custo da venda, para o custo cair onde a receita caiu.
-- ---------------------------------------------------------------------
create or replace function aff.generate_statement(p_affiliate uuid, p_competence date) returns aff.statements
language plpgsql security definer set search_path = '' as $$
declare
  a aff.affiliates; st aff.statements; comp date := date_trunc('month', p_competence)::date;
  v_from timestamptz := (comp::timestamp at time zone 'America/Sao_Paulo'); v_to timestamptz := ((comp + interval '1 month')::timestamp at time zone 'America/Sao_Paulo');
  v_status text[] := array['PAID', 'COMPLETED', 'FULFILLING', 'READY_FOR_PICKUP', 'SHIPPED', 'PARTIALLY_RETURNED'];
  v_groups jsonb := '[]'; v_sales numeric := 0; v_returns numeric := 0; v_comm numeric := 0; v_orders int := 0; g record; v_base numeric; v_c numeric;
begin
  perform private.require_perm('fin.write');
  select * into a from aff.affiliates where id = p_affiliate and org_id = private.org_id();
  if a.id is null then raise exception 'Afiliada não encontrada' using errcode = 'P0162'; end if;
  select * into st from aff.statements where affiliate_id = a.id and competence = comp;
  if st.id is not null and st.status <> 'DRAFT' then return st; end if;

  select count(*) into v_orders from sales.orders o
  where o.org_id = a.org_id and o.attribution ->> 'affiliate_party_id' = a.party_id::text and o.party_id is distinct from a.party_id
    and o.status::text = any (v_status) and o.created_at >= v_from and o.created_at < v_to;

  for g in
    with sold as (
      select o.legal_entity_id, o.profit_cost_center_id as cc, sum(o.subtotal - o.discount_total) as amt
      from sales.orders o
      where o.org_id = a.org_id and o.attribution ->> 'affiliate_party_id' = a.party_id::text and o.party_id is distinct from a.party_id
        and o.status::text = any (v_status) and o.created_at >= v_from and o.created_at < v_to
      group by 1, 2),
    back as (
      select o.legal_entity_id, o.profit_cost_center_id as cc, sum(r.amount) as amt
      from sales.returns r join sales.orders o on o.id = r.order_id
      where o.org_id = a.org_id and o.attribution ->> 'affiliate_party_id' = a.party_id::text and o.party_id is distinct from a.party_id
        and r.created_at >= v_from and r.created_at < v_to
      group by 1, 2)
    select coalesce(s.legal_entity_id, b.legal_entity_id) as entity, coalesce(s.cc, b.cc) as cc, coalesce(s.amt, 0) as sold, coalesce(b.amt, 0) as returned
    from sold s full join back b on b.legal_entity_id = s.legal_entity_id and b.cc is not distinct from s.cc
  loop
    v_base := g.sold - g.returned;
    v_c := greatest(round(v_base * a.commission_pct / 100, 2), 0);              -- mês com mais devolução que venda não gera comissão negativa
    v_sales := v_sales + g.sold; v_returns := v_returns + g.returned; v_comm := v_comm + v_c;
    v_groups := v_groups || jsonb_build_object('legal_entity_id', g.entity, 'cost_center_id', g.cc, 'base', round(v_base, 2), 'commission', v_c);
  end loop;

  insert into aff.statements (org_id, affiliate_id, competence, orders_count, sales_amount, returns_amount, commission_pct, commission, payout_mode, detail, status)
  values (a.org_id, a.id, comp, v_orders, round(v_sales, 2), round(v_returns, 2), a.commission_pct, v_comm, a.payout_mode, jsonb_build_object('groups', v_groups), 'DRAFT')
  on conflict (affiliate_id, competence) do update set orders_count = excluded.orders_count, sales_amount = excluded.sales_amount, returns_amount = excluded.returns_amount,
    commission_pct = excluded.commission_pct, commission = excluded.commission, payout_mode = excluded.payout_mode, detail = excluded.detail, updated_at = now()
  returning * into st;
  return st;
end $$;

-- ---------------------------------------------------------------------
-- 3) Aprovação e pagamento
-- Vale-troca: lançamento (despesa × passivo de vale) + crédito no livro de vales → extrato PAGO.
-- Pix: um título a pagar aprovado por empresa (a despesa entra na competência; pagar pelo Financeiro) → extrato APROVADO até a baixa.
-- ---------------------------------------------------------------------
create or replace function aff.approve_statement(p_id uuid) returns aff.statements
language plpgsql security definer set search_path = '' as $$
declare
  st aff.statements; a aff.affiliates; g jsonb; e record; v_lines jsonb; v_date date; v_org uuid; v_titles uuid[] := '{}'; v_title fin.titles; v_name text; v_total numeric;
  v_exp uuid; v_cc_lines jsonb;
begin
  perform private.require_perm('fin.approve');
  select * into st from aff.statements where id = p_id and org_id = private.org_id() for update;
  if st.id is null then raise exception 'Extrato não encontrado' using errcode = 'P0162'; end if;
  if st.status <> 'DRAFT' then raise exception 'Só extratos em rascunho podem ser aprovados' using errcode = 'P0161'; end if;
  if st.commission <= 0 then raise exception 'Este extrato não tem comissão a pagar' using errcode = 'P0161'; end if;
  v_org := st.org_id;
  select * into a from aff.affiliates where id = st.affiliate_id;
  select display_name into v_name from crm.parties where id = a.party_id;
  v_exp := private.acct(v_org, 'AFFILIATE_EXPENSE');

  for e in select (x ->> 'legal_entity_id')::uuid as entity from jsonb_array_elements(st.detail -> 'groups') x where (x ->> 'commission')::numeric > 0 group by 1 loop
    v_date := (st.competence + interval '1 month - 1 day')::date;
    if exists (select 1 from fin.periods where legal_entity_id = e.entity and competence = st.competence and status = 'CLOSED') then v_date := private.today_sp(); end if;
    v_cc_lines := '[]'; v_total := 0;
    for g in select x from jsonb_array_elements(st.detail -> 'groups') x where (x ->> 'legal_entity_id')::uuid = e.entity and (x ->> 'commission')::numeric > 0 loop
      v_cc_lines := v_cc_lines || jsonb_build_object('cost_center_id', g ->> 'cost_center_id', 'amount', (g ->> 'commission')::numeric);
      v_total := v_total + (g ->> 'commission')::numeric;
    end loop;

    if st.payout_mode = 'STORE_CREDIT' then
      v_lines := '[]';
      for g in select x from jsonb_array_elements(v_cc_lines) x loop
        v_lines := v_lines || jsonb_build_object('role', 'AFFILIATE_EXPENSE', 'debit', (g ->> 'amount')::numeric, 'cost_center_id', g ->> 'cost_center_id', 'party_id', a.party_id,
                                                 'memo', 'Comissão ' || v_name);
      end loop;
      v_lines := v_lines || jsonb_build_object('role', 'STORE_CREDIT_LIABILITY', 'credit', v_total, 'party_id', a.party_id, 'memo', 'Vale-troca da comissão de ' || v_name);
      perform private.post_entry(e.entity, v_date, 'AFFILIATE_COMMISSION', 'aff.statements', md5(st.id::text || e.entity::text)::uuid,
        format('Comissão de afiliada %s — %s', v_name, to_char(st.competence, 'MM/YYYY')), v_lines);
    else
      select * into v_title from private.insert_title(jsonb_build_object(
        'direction', 'PAYABLE', 'legal_entity_id', e.entity, 'party_id', a.party_id, 'description', format('Comissão de afiliada %s — %s', v_name, to_char(st.competence, 'MM/YYYY')),
        'document_kind', 'COMISSAO_AFILIADO', 'competence_date', v_date, 'issue_date', private.today_sp(),
        'installments', jsonb_build_array(jsonb_build_object('due_date', private.today_sp() + 5, 'amount', v_total)),
        'origin_type', 'COMMISSION_STATEMENT', 'origin_id', st.id, 'approval_status', 'APPROVED', 'tags', jsonb_build_array('afiliado'),
        'lines', (select jsonb_agg(jsonb_build_object('chart_account_id', v_exp, 'cost_center_id', l ->> 'cost_center_id', 'amount', (l ->> 'amount')::numeric)) from jsonb_array_elements(v_cc_lines) l)),
        private.member_id());
      v_titles := v_titles || v_title.id;
    end if;
  end loop;

  if st.payout_mode = 'STORE_CREDIT' then
    insert into sales.store_credit_ledger (org_id, party_id, amount, reason, source_type, source_id, created_by)
    values (v_org, a.party_id, st.commission, 'AFFILIATE_COMMISSION', 'aff.statements', st.id, private.member_id());
    update aff.statements set status = 'PAID', approved_by = private.member_id(), approved_at = now(), paid_at = now() where id = st.id returning * into st;
  else
    update aff.statements set status = 'APPROVED', approved_by = private.member_id(), approved_at = now(), payable_title_ids = v_titles where id = st.id returning * into st;
  end if;
  perform private.timeline(v_org, a.party_id, 'AFFILIATE_STATEMENT', 'aff.statements', st.id, format('Comissão de %s aprovada: R$ %s', to_char(st.competence, 'MM/YYYY'), to_char(st.commission, 'FM999990.00')));
  return st;
end $$;

select private.lock_functions();
