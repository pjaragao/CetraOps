-- Notas recebidas (MDe): triagem do destino da nota antes de qualquer lançamento — nem toda NF-e é mercadoria para revenda.
--   * quando o XML chega (fiscal.inbound_dfe.xml), a nota entra na fila ai_tasks/DFE_TRIAGE: o worker aplica regras (NCM,
--     descrição, catálogo, histórico do fornecedor), cruza com reembolsos e contas a pagar do mesmo CNPJ e só chama a IA para
--     o que as regras não decidem. A sugestão fica em inbound_dfe.triage (destino por item, contas, vínculos e alertas);
--   * a pessoa confirma (fiscal.apply_dfe_destination), nunca a IA sozinha:
--       ASSET / EXPENSE → registra a NF-e de entrada (pacote do contador) e cria a conta a pagar em RASCUNHO, já classificada
--                         (patrimônio 1.2.1.x, consumo 1.1.3.02 ou despesa 7.2.x), sem passar pelo estoque;
--       REIMBURSED      → a nota foi paga do bolso: liga aos reembolsos da pessoa (nenhuma conta nova, sem despesa em dobro);
--       PAYABLE         → já existe conta a pagar do fornecedor (aberta ou paga): a nota vira o documento dela, sem conta nova;
--       PAID            → já saiu do banco: concilia a linha do extrato pendente classificando na conta escolhida, ou só liga ao
--                         movimento já lançado direto (sem conta a pagar);
--       IGNORED         → não gera nada (com o motivo).
--     Mercadoria segue pelo botão de sempre (purch.import_inbound_dfe → recebimento → estoque);
--   * fiscal.reopen_dfe_destination desfaz enquanto a conta não foi aprovada; o fornecedor guarda o destino escolhido
--     (crm.parties.preferences.nfe_destino) e a próxima nota dele já sai com a mesma sugestão, sem IA.
-- Desligar o automático: core.settings 'fiscal.dfe_triage' = false.

alter table fiscal.inbound_dfe
  add column if not exists triage jsonb,
  add column if not exists triage_status text check (triage_status in ('QUEUED', 'RUNNING', 'SUGGESTED', 'FAILED', 'APPLIED')),
  add column if not exists triage_note text,
  add column if not exists triage_at timestamptz,
  add column if not exists destination text check (destination in ('ASSET', 'EXPENSE', 'REIMBURSED', 'PAYABLE', 'PAID', 'IGNORED')),
  add column if not exists destination_title_id uuid references fin.titles (id),
  add column if not exists destination_note text,
  add column if not exists reimbursement_ids uuid[] not null default '{}',
  add column if not exists cash_transaction_id uuid references fin.cash_transactions (id),
  add column if not exists statement_line_id uuid references fin.statement_lines (id),
  add column if not exists decided_by uuid references core.members (id),
  add column if not exists decided_at timestamptz;

create index if not exists inbound_dfe_reimbursements_idx on fiscal.inbound_dfe using gin (reimbursement_ids);

-- o XML chegou (busca automática, chave de acesso ou reenvio): entra na fila de triagem
create or replace function private.dfe_triage_auto() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.xml is not null and length(trim(new.xml)) > 0 and (tg_op = 'INSERT' or old.xml is null or length(trim(old.xml)) = 0)
     and new.document_id is null and new.destination is null
     and coalesce((select value <> 'false'::jsonb from core.settings where org_id = new.org_id and key = 'fiscal.dfe_triage'), true) then
    new.triage_status := 'QUEUED';
    new.triage_note := null;
    perform private.enqueue('ai_tasks', jsonb_build_object('action', 'DFE_TRIAGE', 'org_id', new.org_id, 'dfe_id', new.id), 5);
  end if;
  return new;
end $$;
drop trigger if exists trg_dfe_triage_auto on fiscal.inbound_dfe;
create trigger trg_dfe_triage_auto before insert or update of xml on fiscal.inbound_dfe for each row execute function private.dfe_triage_auto();

-- analisar de novo, à mão
create or replace function fiscal.request_dfe_triage(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare d fiscal.inbound_dfe;
begin
  perform private.require_perm('fiscal.write');
  select * into d from fiscal.inbound_dfe where id = p_id and org_id = private.org_id() for update;
  if d.id is null then raise exception 'Nota recebida não encontrada' using errcode = 'P0082'; end if;
  if d.xml is null or length(trim(d.xml)) = 0 then raise exception 'O XML desta nota ainda não foi baixado da SEFAZ' using errcode = 'P0082'; end if;
  if d.destination is not null or d.document_id is not null then raise exception 'Esta nota já teve o destino decidido' using errcode = 'P0082'; end if;
  update fiscal.inbound_dfe set triage_status = 'QUEUED', triage_note = null where id = d.id;
  perform private.enqueue('ai_tasks', jsonb_build_object('action', 'DFE_TRIAGE', 'org_id', d.org_id, 'dfe_id', d.id), 0);
end $$;

-- NF-e de entrada no fiscal.documents (pacote do contador), sem recebimento de estoque; devolve o documento e o fornecedor
create or replace function private.register_inbound_nfe(d fiscal.inbound_dfe, j jsonb, p_actor uuid, out o_doc uuid, out o_supplier uuid)
language plpgsql security definer set search_path = '' as $$
declare v_cnpj text := j #>> '{issuer,cnpj}';
begin
  select id into o_supplier from crm.parties where org_id = d.org_id and cnpj = v_cnpj and merged_into_id is null;
  if o_supplier is null then
    insert into crm.parties (org_id, kind, display_name, legal_name, cnpj, city, uf, source)
    values (d.org_id, 'COMPANY', coalesce(nullif(j #>> '{issuer,fantasy}', ''), j #>> '{issuer,name}'), j #>> '{issuer,name}', v_cnpj,
            j #>> '{issuer,city}', nullif(j #>> '{issuer,uf}', '')::char(2), 'NFE_IMPORT')
    returning id into o_supplier;
  end if;
  insert into crm.party_roles (party_id, org_id, role) values (o_supplier, d.org_id, 'SUPPLIER') on conflict do nothing;

  select id into o_doc from fiscal.documents where org_id = d.org_id and access_key = d.access_key;
  if o_doc is not null then return; end if;
  insert into fiscal.documents (org_id, legal_entity_id, direction, model, series, number, access_key, status, fin_nfe, operation_nature, cfop_main,
                                issue_at, protocol, sefaz_code, counterpart_party_id, counterpart_cnpj, counterpart_name, totals, referenced_keys, xml, created_by)
  values (d.org_id, d.legal_entity_id, 'IN', '55', (j #>> '{header,series}')::int, (j #>> '{header,number}')::int, d.access_key, 'AUTHORIZED',
          coalesce((j #>> '{header,fin_nfe}')::int, 1), j #>> '{header,operation_nature}',
          (select i ->> 'cfop' from jsonb_array_elements(j -> 'items') i group by i ->> 'cfop' order by count(*) desc, i ->> 'cfop' limit 1),
          (j #>> '{header,issue_at}')::timestamptz, j #>> '{protocol,number}', j #>> '{protocol,cstat}', o_supplier, v_cnpj, j #>> '{issuer,name}', j -> 'totals',
          case when coalesce(j #>> '{header,referenced_key}', '') <> '' then array[j #>> '{header,referenced_key}'] else '{}'::text[] end, d.xml, p_actor)
  returning id into o_doc;
  insert into fiscal.document_items (org_id, document_id, n_item, cprod, cean, xprod, ncm, cest, cfop, ucom, qcom, vuncom, vprod,
                                     vdesc, vfrete, vseg, voutro, vipi, vicmsst, csosn, cst, taxes)
  select d.org_id, o_doc, (it ->> 'n_item')::int, it ->> 'cprod', it ->> 'cean', it ->> 'xprod', it ->> 'ncm', it ->> 'cest', it ->> 'cfop',
         it ->> 'ucom', (it ->> 'qcom')::numeric, (it ->> 'vuncom')::numeric, (it ->> 'vprod')::numeric, (it ->> 'vdesc')::numeric,
         (it ->> 'vfrete')::numeric, (it ->> 'vseg')::numeric, (it ->> 'voutro')::numeric, (it ->> 'vipi')::numeric, (it ->> 'vicmsst')::numeric,
         it ->> 'csosn', it ->> 'cst', jsonb_build_object('orig', it ->> 'orig')
  from jsonb_array_elements(j -> 'items') it;
  insert into fiscal.document_installments (org_id, document_id, n_dup, due_date, amount)
  select d.org_id, o_doc, x ->> 'n_dup', (x ->> 'due_date')::date, (x ->> 'amount')::numeric
  from jsonb_array_elements(coalesce(j -> 'installments', '[]')) x where (x ->> 'amount')::numeric > 0;
end $$;

-- A pessoa confirma o destino (a sugestão da IA vem pré-preenchida na tela; aqui vale o que ela mandou)
--   p = { destination, lines: [{chart_account_id, amount}], due_date, reimbursement_ids: [uuid], title_id, statement_line_id, cash_transaction_id, note }
create or replace function fiscal.apply_dfe_destination(p_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id(); v_actor uuid := private.member_id(); d fiscal.inbound_dfe; j jsonb; v_dest text := upper(coalesce(p ->> 'destination', ''));
  v_doc uuid; v_supplier uuid; v_total numeric; v_lines jsonb; v_sum numeric; v_inst jsonb; t fin.titles; v_ids uuid[]; v_first uuid; v_desc text; x jsonb;
  v_line fin.statement_lines; v_tx uuid; v_stmt uuid; ct fin.cash_transactions;
begin
  perform private.require_perm('fin.write');
  select * into d from fiscal.inbound_dfe where id = p_id and org_id = v_org for update;
  if d.id is null then raise exception 'Nota recebida não encontrada' using errcode = 'P0082'; end if;
  if d.xml is null or length(trim(d.xml)) = 0 then raise exception 'O XML desta nota ainda não foi baixado da SEFAZ' using errcode = 'P0082'; end if;
  if d.destination is not null then raise exception 'O destino desta nota já foi decidido: desfaça antes de mudar' using errcode = 'P0082'; end if;
  if d.document_id is not null and exists (select 1 from fiscal.documents where id = d.document_id and receipt_id is not null) then
    raise exception 'Esta nota já entrou pelo recebimento de mercadoria' using errcode = 'P0082';
  end if;
  if v_dest not in ('ASSET', 'EXPENSE', 'REIMBURSED', 'PAYABLE', 'PAID', 'IGNORED') then raise exception 'Destino inválido' using errcode = 'P0082'; end if;

  j := fiscal.parse_nfe(d.xml);
  v_total := round((j #>> '{totals,vNF}')::numeric, 2);
  v_desc := format('NF-e %s — %s: %s', j #>> '{header,number}', coalesce(nullif(j #>> '{issuer,fantasy}', ''), j #>> '{issuer,name}'),
                   left(coalesce(j #>> '{items,0,xprod}', ''), 80) || case when jsonb_array_length(j -> 'items') > 1 then format(' e mais %s item(ns)', jsonb_array_length(j -> 'items') - 1) else '' end);

  if v_dest = 'IGNORED' then
    if length(trim(coalesce(p ->> 'note', ''))) < 5 then raise exception 'Diga por que esta nota não gera lançamento' using errcode = 'P0082'; end if;
  else
    select o_doc, o_supplier into v_doc, v_supplier from private.register_inbound_nfe(d, j, v_actor);
  end if;

  if v_dest in ('ASSET', 'EXPENSE') then
    select coalesce(jsonb_agg(jsonb_build_object('chart_account_id', (l ->> 'chart_account_id')::uuid, 'amount', round((l ->> 'amount')::numeric, 2), 'memo', 'NF-e ' || (j #>> '{header,number}'))), '[]'),
           coalesce(sum(round((l ->> 'amount')::numeric, 2)), 0)
      into v_lines, v_sum
    from jsonb_array_elements(coalesce(p -> 'lines', '[]')) l where coalesce((l ->> 'amount')::numeric, 0) > 0;
    if jsonb_array_length(v_lines) = 0 then raise exception 'Escolha a conta (patrimônio ou despesa)' using errcode = 'P0082'; end if;
    if v_sum <> v_total then raise exception 'A classificação (%) precisa somar o valor da nota (%)', v_sum, v_total using errcode = 'P0082'; end if;
    for x in select * from jsonb_array_elements(v_lines) loop
      if not exists (select 1 from fin.chart_accounts where id = (x ->> 'chart_account_id')::uuid and org_id = v_org and kind = 'ANALYTIC' and archived_at is null) then
        raise exception 'Conta inválida na classificação' using errcode = 'P0082';
      end if;
    end loop;
    -- parcelas da própria nota (duplicatas); sem duplicata, uma parcela no vencimento informado (ou hoje)
    select coalesce(jsonb_agg(jsonb_build_object('due_date', x2 ->> 'due_date', 'amount', (x2 ->> 'amount')::numeric) order by x2 ->> 'due_date'), '[]') into v_inst
    from jsonb_array_elements(coalesce(j -> 'installments', '[]')) x2 where (x2 ->> 'amount')::numeric > 0 and (x2 ->> 'due_date') is not null;
    if jsonb_array_length(v_inst) = 0 or (select sum((y ->> 'amount')::numeric) from jsonb_array_elements(v_inst) y) <> v_total then
      v_inst := jsonb_build_array(jsonb_build_object('due_date', coalesce(nullif(p ->> 'due_date', '')::date, private.today_sp()), 'amount', v_total));
    end if;
    t := private.insert_title(jsonb_build_object(
      'direction', 'PAYABLE', 'legal_entity_id', d.legal_entity_id, 'party_id', v_supplier, 'description', v_desc,
      'document_kind', 'NF-e', 'document_number', j #>> '{header,number}', 'issue_date', (j #>> '{header,issue_at}')::timestamptz::date,
      'competence_date', (j #>> '{header,issue_at}')::timestamptz::date, 'approval_status', 'DRAFT',
      'origin_type', 'INBOUND_NFE', 'origin_id', d.id, 'lines', v_lines, 'installments', v_inst), v_actor);
    v_first := (v_lines -> 0 ->> 'chart_account_id')::uuid;
    -- o fornecedor aprende o destino: a próxima nota dele já vem com a mesma sugestão
    update crm.parties set preferences = coalesce(preferences, '{}') || jsonb_build_object('nfe_destino', jsonb_build_object('destination', v_dest, 'chart_account_id', v_first))
    where id = v_supplier;
  elsif v_dest = 'REIMBURSED' then
    select coalesce(array_agg(distinct r.id), '{}') into v_ids
    from fin.reimbursements r where r.org_id = v_org and r.status <> 'CANCELLED'
      and r.id in (select (e)::uuid from jsonb_array_elements_text(coalesce(p -> 'reimbursement_ids', '[]')) e);
    if cardinality(v_ids) = 0 then raise exception 'Escolha o(s) reembolso(s) que pagaram esta nota' using errcode = 'P0082'; end if;
    -- classificação dos itens ainda sem conta (antes da decisão do reembolso), com a conta sugerida
    v_first := nullif(p #>> '{lines,0,chart_account_id}', '')::uuid;
    if v_first is not null and exists (select 1 from fin.chart_accounts where id = v_first and org_id = v_org and kind = 'ANALYTIC') then
      update fin.reimbursement_items ri set chart_account_id = v_first
      from fin.reimbursements r where r.id = ri.reimbursement_id and r.id = any (v_ids) and r.status in ('DRAFT', 'SUBMITTED', 'REJECTED') and ri.chart_account_id is null;
    end if;
  elsif v_dest = 'PAYABLE' then
    -- conta já lançada do fornecedor (aberta ou paga): a nota vira o documento dela
    select * into t from fin.titles where id = nullif(p ->> 'title_id', '')::uuid and org_id = v_org and direction = 'PAYABLE' and status <> 'CANCELLED' for update;
    if t.id is null then raise exception 'Escolha a conta a pagar que corresponde a esta nota' using errcode = 'P0082'; end if;
    if exists (select 1 from fiscal.inbound_dfe where destination_title_id = t.id and id <> d.id) then
      raise exception 'A conta % já está ligada a outra nota', t.number using errcode = 'P0082';
    end if;
    update fin.titles set document_kind = coalesce(nullif(document_kind, ''), 'NF-e'), document_number = coalesce(nullif(document_number, ''), j #>> '{header,number}'),
           party_id = coalesce(party_id, v_supplier)
    where id = t.id;
  elsif v_dest = 'PAID' then
    if nullif(p ->> 'statement_line_id', '') is not null then
      -- saída do extrato ainda sem conciliação: vira o movimento da nota, classificado na conta escolhida
      select * into v_line from fin.statement_lines where id = (p ->> 'statement_line_id')::uuid and org_id = v_org;
      if v_line.id is null or v_line.amount >= 0 then raise exception 'Linha do extrato inválida (precisa ser uma saída)' using errcode = 'P0082'; end if;
      if abs(v_line.amount) <> v_total then
        raise exception 'O valor do extrato (%) é diferente da nota (%): concilie em Financeiro › Conciliação', abs(v_line.amount), v_total using errcode = 'P0082';
      end if;
      if jsonb_array_length(coalesce(p -> 'lines', '[]')) <> 1 then raise exception 'Para conciliar com o extrato, escolha uma conta só' using errcode = 'P0082'; end if;
      v_tx := fin.classify_statement_line(v_line.id, jsonb_build_object('kind', 'OTHER', 'chart_account_id', p #>> '{lines,0,chart_account_id}', 'party_id', v_supplier, 'description', v_desc));
      v_stmt := v_line.id;
    else
      -- movimento já lançado direto (sem conta a pagar): só liga
      select * into ct from fin.cash_transactions where id = nullif(p ->> 'cash_transaction_id', '')::uuid and org_id = v_org and not voided and amount < 0;
      if ct.id is null then raise exception 'Escolha o pagamento (extrato ou movimento) que quitou esta nota' using errcode = 'P0082'; end if;
      if exists (select 1 from fiscal.inbound_dfe where cash_transaction_id = ct.id and id <> d.id) then raise exception 'Este movimento já está ligado a outra nota' using errcode = 'P0082'; end if;
      v_tx := ct.id;
    end if;
  end if;

  update fiscal.inbound_dfe set destination = v_dest, destination_title_id = t.id, reimbursement_ids = coalesce(v_ids, '{}'),
         cash_transaction_id = v_tx, statement_line_id = v_stmt,
         destination_note = nullif(trim(coalesce(p ->> 'note', '')), ''), document_id = coalesce(v_doc, document_id),
         triage_status = case when triage is not null then 'APPLIED' else triage_status end, decided_by = v_actor, decided_at = now()
  where id = d.id;
  return jsonb_build_object('destination', v_dest, 'title_id', t.id, 'title_number', t.number, 'reimbursement_ids', to_jsonb(coalesce(v_ids, '{}')));
end $$;

-- Desfaz a decisão enquanto a conta a pagar não foi aprovada (o documento fiscal registrado sai junto)
create or replace function fiscal.reopen_dfe_destination(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare d fiscal.inbound_dfe; t fin.titles;
begin
  perform private.require_perm('fin.write');
  select * into d from fiscal.inbound_dfe where id = p_id and org_id = private.org_id() for update;
  if d.id is null then raise exception 'Nota recebida não encontrada' using errcode = 'P0082'; end if;
  if d.destination is null then return; end if;
  if d.statement_line_id is not null then
    raise exception 'A nota conciliou uma linha do extrato: para mudar, estorne o movimento em Financeiro › Movimentações' using errcode = 'P0082';
  end if;
  if d.destination_title_id is not null and d.destination in ('ASSET', 'EXPENSE') then   -- conta criada pela nota; PAYABLE só desliga
    select * into t from fin.titles where id = d.destination_title_id for update;
    if t.status <> 'CANCELLED' then
      if t.approval_status <> 'DRAFT' or exists (select 1 from fin.title_installments where title_id = t.id and amount_settled > 0) then
        raise exception 'A conta a pagar % já foi aprovada: cancele-a em Contas a pagar antes de mudar o destino da nota', t.number using errcode = 'P0082';
      end if;
      update fin.title_installments set status = 'CANCELLED' where title_id = t.id;
      update fin.titles set status = 'CANCELLED', tags = array_append(tags, 'cancelado') where id = t.id;
    end if;
  end if;
  if d.document_id is not null and exists (select 1 from fiscal.documents where id = d.document_id and receipt_id is null) then
    delete from fiscal.document_items where document_id = d.document_id;
    delete from fiscal.document_installments where document_id = d.document_id;
    update fiscal.inbound_dfe set document_id = null where id = d.id;
    delete from fiscal.documents where id = d.document_id;
  end if;
  update fiscal.inbound_dfe set destination = null, destination_title_id = null, destination_note = null, reimbursement_ids = '{}', cash_transaction_id = null,
         decided_by = null, decided_at = null, triage_status = case when triage is not null then 'SUGGESTED' else null end
  where id = d.id;
end $$;

insert into private.internal_functions (fqname) values ('private.dfe_triage_auto'), ('private.register_inbound_nfe') on conflict do nothing;
select private.lock_functions();

-- notas que já estão com o XML e ainda sem destino entram na fila agora
do $$
declare d record;
begin
  for d in select id, org_id from fiscal.inbound_dfe where xml is not null and document_id is null and destination is null and triage_status is null loop
    update fiscal.inbound_dfe set triage_status = 'QUEUED' where id = d.id;
    perform private.enqueue('ai_tasks', jsonb_build_object('action', 'DFE_TRIAGE', 'org_id', d.org_id, 'dfe_id', d.id), 0);
  end loop;
end $$;
