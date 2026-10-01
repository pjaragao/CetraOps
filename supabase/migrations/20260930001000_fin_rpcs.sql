-- =====================================================================
-- fin: lançamento de títulos com parcelas (a pagar/receber), aprovação e baixa simples.
-- A liquidação completa (conta bancária, conciliação N:M, rateio) entra no sprint A3/A4.
-- =====================================================================

-- p = {direction, legal_entity_id, store_id?, party_id?, description, document_kind?, document_number?,
--      competence_date?, chart_account_id?, cost_center_id?, installments:[{due_date, amount}]}
create or replace function fin.create_title(p jsonb) returns fin.titles
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id();
  t fin.titles;
  it jsonb;
  v_n int := 0;
  v_total numeric := 0;
begin
  perform private.require_perm('fin.write');
  if v_org is null then raise exception 'Sem organização no token' using errcode = '42501'; end if;
  if jsonb_array_length(coalesce(p -> 'installments', '[]')) = 0 then raise exception 'Informe ao menos uma parcela'; end if;
  select coalesce(sum((x ->> 'amount')::numeric), 0) into v_total from jsonb_array_elements(p -> 'installments') x;
  if v_total <= 0 then raise exception 'Valor total deve ser positivo'; end if;
  if not exists (select 1 from core.legal_entities where id = (p ->> 'legal_entity_id')::uuid and org_id = v_org) then
    raise exception 'Empresa inválida';
  end if;

  insert into fin.titles (org_id, legal_entity_id, store_id, direction, number, party_id, document_kind, document_number,
                          competence_date, description, total_amount, chart_account_id, cost_center_id, approval_status,
                          origin_type, created_by)
  values (v_org, (p ->> 'legal_entity_id')::uuid, (p ->> 'store_id')::uuid, (p ->> 'direction')::fin.title_direction,
          core.next_number(v_org, case when p ->> 'direction' = 'PAYABLE' then 'PAG' else 'REC' end),
          (p ->> 'party_id')::uuid, p ->> 'document_kind', p ->> 'document_number',
          coalesce((p ->> 'competence_date')::date, current_date), p ->> 'description', v_total,
          (p ->> 'chart_account_id')::uuid, (p ->> 'cost_center_id')::uuid,
          case when p ->> 'direction' = 'RECEIVABLE' then 'APPROVED' else 'DRAFT' end, 'MANUAL', private.member_id())
  returning * into t;

  for it in select * from jsonb_array_elements(p -> 'installments') loop
    v_n := v_n + 1;
    insert into fin.title_installments (org_id, title_id, n, due_date, expected_date, amount, barcode)
    values (v_org, t.id, v_n, (it ->> 'due_date')::date, (it ->> 'due_date')::date, (it ->> 'amount')::numeric, it ->> 'barcode');
  end loop;
  return t;
end $$;

create or replace function fin.approve_title(p_title uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('fin.approve');
  update fin.titles set approval_status = 'APPROVED', approved_by = private.member_id(), approved_at = now()
  where id = p_title and org_id = private.org_id() and approval_status = 'DRAFT';
end $$;

-- Baixa integral de uma parcela (pagamento/recebimento confirmado manualmente)
create or replace function fin.settle_installment(p_installment uuid, p_amount numeric default null) returns void
language plpgsql security definer set search_path = '' as $$
declare i record;
begin
  perform private.require_perm('fin.write');
  select ti.*, t.approval_status, t.direction into i
  from fin.title_installments ti join fin.titles t on t.id = ti.title_id
  where ti.id = p_installment and ti.org_id = private.org_id() for update of ti;
  if i.id is null then raise exception 'Parcela não encontrada'; end if;
  if i.direction = 'PAYABLE' and i.approval_status <> 'APPROVED' then
    raise exception 'Conta a pagar precisa ser aprovada antes do pagamento' using errcode = 'P0011';
  end if;
  update fin.title_installments set
    amount_settled = coalesce(p_amount, amount),
    status = case when coalesce(p_amount, amount) >= amount then 'SETTLED'::fin.title_status else 'PARTIAL'::fin.title_status end
  where id = p_installment;
end $$;
