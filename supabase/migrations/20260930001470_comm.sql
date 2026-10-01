-- =====================================================================
-- comm (comissões): extrato mensal por vendedora, calculado no banco com o plano configurável
-- (core.settings 'commission_plan_default'): taxa por canal + faixas de bônus sobre a base do mês.
-- O extrato aprovado entra na folha como COMISSÃO (+ DSR) e é marcado como pago quando a folha é aprovada.
-- =====================================================================

select private.init_schema('comm');

create table comm.statements (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  member_id uuid not null references core.members(id),
  store_id uuid references core.stores(id),
  competence date not null check (competence = date_trunc('month', competence)::date),
  sales_amount numeric(14,2) not null default 0,             -- vendas creditadas à vendedora
  base_amount numeric(14,2) not null default 0,              -- base das faixas de bônus (loja ou individual)
  commission numeric(14,2) not null default 0,
  bonus numeric(14,2) not null default 0,
  total numeric(14,2) not null default 0,
  detail jsonb not null default '{}',
  status text not null default 'DRAFT' check (status in ('DRAFT', 'APPROVED', 'PAID', 'CANCELLED')),
  approved_by uuid references core.members(id),
  approved_at timestamptz,
  payslip_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (member_id, competence)
);

-- Gera (ou recalcula, enquanto não aprovado) o extrato de uma vendedora no mês
create or replace function comm.generate_statement(p_member uuid, p_competence date) returns comm.statements
language plpgsql security definer set search_path = '' as $$
declare
  m core.members;
  plan jsonb;
  comp date := date_trunc('month', p_competence)::date;
  v_from timestamptz := (comp::timestamp at time zone 'America/Sao_Paulo');
  v_to timestamptz := ((comp + interval '1 month')::timestamp at time zone 'America/Sao_Paulo');
  v_sales numeric := 0;
  v_store_rev numeric := 0;
  v_comm numeric := 0;
  v_base numeric;
  v_bonus numeric := 0;
  r record;
  t jsonb;
  by_channel jsonb := '{}';
  st comm.statements;
  v_status text[] := array['PAID', 'COMPLETED', 'FULFILLING', 'READY_FOR_PICKUP', 'SHIPPED', 'PARTIALLY_RETURNED'];
begin
  perform private.require_perm('hr.payroll.write');
  select * into m from core.members where id = p_member and org_id = coalesce(private.org_id(), org_id);
  if m.id is null then raise exception 'Membro não encontrado'; end if;
  select value into plan from core.settings where org_id = m.org_id and key = 'commission_plan_default';
  if plan is null then raise exception 'Plano de comissão não configurado (Configurações)'; end if;

  select * into st from comm.statements where member_id = m.id and competence = comp;
  if st.id is not null and st.status in ('APPROVED', 'PAID') then return st; end if;

  for r in
    select o.channel::text as channel, sum(o.total * c.share_pct / 100) as amt
    from sales.orders o join sales.order_credits c on c.order_id = o.id
    where c.member_id = m.id and c.role in ('CLOSER', 'ASSIST') and o.status::text = any (v_status)
      and o.created_at >= v_from and o.created_at < v_to
    group by o.channel
  loop
    v_sales := v_sales + r.amt;
    v_comm := v_comm + r.amt * coalesce((plan -> 'rates_by_channel' ->> r.channel)::numeric, 0) / 100;
    by_channel := by_channel || jsonb_build_object(r.channel, round(r.amt, 2));
  end loop;

  select coalesce(sum(o.total), 0) into v_store_rev from sales.orders o
  where o.store_id = m.default_store_id and o.status::text = any (v_status) and o.created_at >= v_from and o.created_at < v_to;

  v_base := case coalesce(plan ->> 'base', 'STORE_REVENUE') when 'INDIVIDUAL_REVENUE' then v_sales else v_store_rev end;
  for t in select * from jsonb_array_elements(coalesce(plan -> 'tiers', '[]')) loop
    if v_base >= (t ->> 'from')::numeric and ((t ->> 'to') is null or v_base < (t ->> 'to')::numeric) then
      if (t ->> 'bonus') is not null then v_bonus := (t ->> 'bonus')::numeric; end if;
      if (t ->> 'pct_over') is not null then v_bonus := round((v_base - (t ->> 'from')::numeric) * (t ->> 'pct_over')::numeric / 100, 2); end if;
    end if;
  end loop;

  insert into comm.statements (org_id, member_id, store_id, competence, sales_amount, base_amount, commission, bonus, total, detail, status)
  values (m.org_id, m.id, m.default_store_id, comp, round(v_sales, 2), round(v_base, 2), round(v_comm, 2), v_bonus, round(v_comm, 2) + v_bonus,
          jsonb_build_object('by_channel', by_channel, 'store_revenue', round(v_store_rev, 2), 'plan_base', coalesce(plan ->> 'base', 'STORE_REVENUE')), 'DRAFT')
  on conflict (member_id, competence) do update set sales_amount = excluded.sales_amount, base_amount = excluded.base_amount,
    commission = excluded.commission, bonus = excluded.bonus, total = excluded.total, detail = excluded.detail, status = 'DRAFT', updated_at = now()
  returning * into st;
  return st;
end $$;

create or replace function comm.approve_statement(p_statement uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('hr.payroll.write');
  update comm.statements set status = 'APPROVED', approved_by = private.member_id(), approved_at = now()
  where id = p_statement and org_id = coalesce(private.org_id(), org_id) and status = 'DRAFT';
  if not found then raise exception 'Só extratos em rascunho podem ser aprovados'; end if;
end $$;

create or replace function comm.reopen_statement(p_statement uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('hr.payroll.write');
  update comm.statements set status = 'DRAFT', approved_by = null, approved_at = null
  where id = p_statement and org_id = coalesce(private.org_id(), org_id) and status = 'APPROVED';
  if not found then raise exception 'Só extratos aprovados e ainda não pagos podem ser reabertos'; end if;
end $$;

select private.attach_updated_at('comm');
select private.apply_rls('comm', array['statements'], 'hr.payroll.read', 'hr.payroll.write');
select private.rpc_only('comm', array['statements']);
