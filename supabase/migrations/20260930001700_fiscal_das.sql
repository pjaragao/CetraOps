-- =====================================================================
-- fiscal (Simples Nacional): apuração do DAS a partir do razão contábil (receitas por anexo, devoluções),
-- com a regra de RBT12 para início de atividade (LC 123, art. 18 §§ 2º e 3º), e geração da guia como conta a pagar
-- contabilizada (Dr deduções da receita · Cr DAS a recolher) com vencimento no dia 20 do mês seguinte.
-- ESTIMATIVA para conferência com o contador (PGDAS-D é o oficial).
-- =====================================================================

create table fiscal.tax_periods (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  legal_entity_id uuid not null references core.legal_entities(id),
  competence date not null check (competence = date_trunc('month', competence)::date),
  revenue_annex1 numeric(14,2) not null default 0,
  revenue_annex3 numeric(14,2) not null default 0,
  returns_amount numeric(14,2) not null default 0,
  rbt12 numeric(14,2) not null default 0,
  rbt12_method text not null,
  rate1 numeric(8,4) not null default 0,
  rate3 numeric(8,4) not null default 0,
  das_estimated numeric(14,2) not null default 0,
  title_id uuid references fin.titles(id),
  status text not null default 'POSTED' check (status in ('POSTED', 'CANCELLED')),
  created_by uuid references core.members(id),
  created_at timestamptz not null default now(),
  unique (legal_entity_id, competence)
);

-- Cálculo (sem gravar). Receita = crédito − débito das contas de receita do razão oficial; serviços (4.1.05) vão para o Anexo III.
create or replace function fiscal.simples_calc(p_entity uuid, p_competence date)
returns table (revenue_annex1 numeric, revenue_annex3 numeric, returns_amount numeric, rbt12 numeric, rbt12_method text, rate1 numeric, rate3 numeric, das numeric)
language plpgsql stable as $$
declare
  comp date := date_trunc('month', p_competence)::date;
  nxt date := (date_trunc('month', p_competence) + interval '1 month')::date;
  v_org uuid; v_serv uuid; v_ret uuid;
  r1 numeric; r3 numeric; rets numeric; first_m date; prev_sum numeric; prev_n int;
  v_rbt numeric; v_method text; v_rate1 numeric; v_rate3 numeric;
begin
  select org_id into v_org from core.legal_entities where id = p_entity;
  select chart_account_id into v_serv from fin.account_roles where org_id = v_org and role = 'REV_SERVICE';
  select chart_account_id into v_ret from fin.account_roles where org_id = v_org and role = 'SALES_RETURNS';

  select coalesce(sum(case when l.account_id = v_serv then 0 else l.credit - l.debit end), 0),
         coalesce(sum(case when l.account_id = v_serv then l.credit - l.debit else 0 end), 0)
    into r1, r3
  from fin.journal_lines l join fin.journal_entries e on e.id = l.entry_id join fin.chart_accounts a on a.id = l.account_id
  where e.legal_entity_id = p_entity and e.ledger = 'LEGAL' and a."group" = 'REVENUE' and e.entry_date >= comp and e.entry_date < nxt;

  select coalesce(sum(l.debit - l.credit), 0) into rets
  from fin.journal_lines l join fin.journal_entries e on e.id = l.entry_id
  where e.legal_entity_id = p_entity and e.ledger = 'LEGAL' and l.account_id = v_ret and e.entry_date >= comp and e.entry_date < nxt;

  select min(date_trunc('month', e.entry_date)::date) into first_m
  from fin.journal_lines l join fin.journal_entries e on e.id = l.entry_id join fin.chart_accounts a on a.id = l.account_id
  where e.legal_entity_id = p_entity and e.ledger = 'LEGAL' and a."group" = 'REVENUE' and l.credit > 0;

  -- RBT12: 12 meses anteriores; no início de atividade, mês × 12 (1º mês) ou média dos meses anteriores × 12
  if first_m is null or comp <= first_m then
    v_rbt := (r1 + r3 - rets) * 12; v_method := 'Início de atividade: receita do mês × 12';
  else
    select coalesce(sum(m.rev), 0), count(*)::int into prev_sum, prev_n from (
      select date_trunc('month', e.entry_date)::date as mth, sum(l.credit - l.debit) as rev
      from fin.journal_lines l join fin.journal_entries e on e.id = l.entry_id join fin.chart_accounts a on a.id = l.account_id
      where e.legal_entity_id = p_entity and e.ledger = 'LEGAL' and a."group" = 'REVENUE'
        and e.entry_date >= greatest(first_m, (comp - interval '12 months')::date) and e.entry_date < comp
      group by 1) m;
    prev_n := (extract(year from age(comp, first_m)) * 12 + extract(month from age(comp, first_m)))::int;
    if prev_n < 12 then
      v_rbt := prev_sum / greatest(prev_n, 1) * 12; v_method := format('Início de atividade: média de %s mês(es) × 12', prev_n);
    else
      v_rbt := prev_sum; v_method := 'Receita bruta dos 12 meses anteriores';
    end if;
  end if;
  v_rate1 := coalesce(fiscal.simples_effective_rate('I', v_rbt), 0);
  v_rate3 := coalesce(fiscal.simples_effective_rate('III', v_rbt), 0);

  revenue_annex1 := round(r1, 2); revenue_annex3 := round(r3, 2); returns_amount := round(rets, 2);
  rbt12 := round(v_rbt, 2); rbt12_method := v_method; rate1 := v_rate1; rate3 := v_rate3;
  das := round(greatest(r1 - rets, 0) * v_rate1 / 100 + r3 * v_rate3 / 100, 2);
  return next;
end $$;

-- Gera a guia do mês: conta a pagar (contabiliza a dedução) + obrigação no calendário. Idempotente por empresa/competência.
create or replace function fiscal.post_das(p_entity uuid, p_competence date) returns fiscal.tax_periods
language plpgsql security definer set search_path = '' as $$
declare
  comp date := date_trunc('month', p_competence)::date;
  v_org uuid; c record; tp fiscal.tax_periods; t fin.titles; v_due date;
begin
  perform private.require_perm('fiscal.write');
  perform private.require_perm('fin.write');
  select org_id into v_org from core.legal_entities where id = p_entity and org_id = coalesce(private.org_id(), org_id);
  if v_org is null then raise exception 'Empresa inválida'; end if;
  select * into tp from fiscal.tax_periods where legal_entity_id = p_entity and competence = comp;
  if tp.id is not null and tp.status = 'POSTED' then raise exception 'A guia do DAS de % já foi gerada', to_char(comp, 'MM/YYYY') using errcode = 'P0070'; end if;
  select * into c from fiscal.simples_calc(p_entity, comp);
  if c.das <= 0 then raise exception 'DAS zerado em %: não há receita tributável no mês', to_char(comp, 'MM/YYYY') using errcode = 'P0071'; end if;

  v_due := private.due_next_month(v_org, comp, 20);
  insert into fiscal.tax_periods (org_id, legal_entity_id, competence, revenue_annex1, revenue_annex3, returns_amount, rbt12, rbt12_method, rate1, rate3, das_estimated, created_by)
  values (v_org, p_entity, comp, c.revenue_annex1, c.revenue_annex3, c.returns_amount, c.rbt12, c.rbt12_method, c.rate1, c.rate3, c.das, private.member_id())
  on conflict (legal_entity_id, competence) do update set revenue_annex1 = excluded.revenue_annex1, revenue_annex3 = excluded.revenue_annex3,
    returns_amount = excluded.returns_amount, rbt12 = excluded.rbt12, rbt12_method = excluded.rbt12_method, rate1 = excluded.rate1,
    rate3 = excluded.rate3, das_estimated = excluded.das_estimated, status = 'POSTED', created_by = excluded.created_by
  returning * into tp;

  t := private.insert_title(jsonb_build_object(
    'direction', 'PAYABLE', 'legal_entity_id', p_entity, 'description', 'DAS Simples Nacional — ' || to_char(comp, 'MM/YYYY'), 'document_kind', 'DAS',
    'competence_date', (comp + interval '1 month - 1 day')::date, 'chart_account_id', private.acct(v_org, 'DAS_EXPENSE'),
    'origin_type', 'TAX_PERIOD', 'origin_id', tp.id, 'approval_status', 'APPROVED', 'control_account_id', private.acct(v_org, 'TAX_PAYABLE_DAS'),
    'installments', jsonb_build_array(jsonb_build_object('due_date', v_due, 'amount', c.das))), private.member_id());
  update fiscal.tax_periods set title_id = t.id where id = tp.id returning * into tp;
  insert into fiscal.obligations (org_id, legal_entity_id, kind, competence, due_date, amount, title_id, source_type, source_id, notes)
  values (v_org, p_entity, 'DAS', comp, v_due, c.das, t.id, 'fiscal.tax_periods', tp.id, c.rbt12_method)
  on conflict (kind, source_type, source_id) where source_id is not null do update set amount = excluded.amount, due_date = excluded.due_date, title_id = excluded.title_id;
  return tp;
end $$;

select private.apply_rls('fiscal', array['tax_periods'], 'fiscal.read', 'fiscal.write');
select private.rpc_only('fiscal', array['tax_periods']);
