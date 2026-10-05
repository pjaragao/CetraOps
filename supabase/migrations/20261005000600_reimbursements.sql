-- =====================================================================
-- Reembolsos: despesas pagas do próprio bolso (sócios, equipe), comprovadas por NF ou recibo.
-- Fluxo: RASCUNHO → ENVIADO → APROVADO (vira conta a pagar para a pessoa, já aprovada e contabilizada por categoria e centro
-- de custo) → PAGO (quando o título é baixado). Recusado volta para a pessoa corrigir e reenviar.
-- Cada item guarda o fornecedor efetivo (quem vendeu: restaurante, posto, papelaria — CNPJ/CPF e nome), o documento
-- (NF-e, NFC-e, NFS-e, cupom, recibo), a chave de acesso (com dígito verificador conferido e sem repetir em outro reembolso)
-- e o arquivo (foto/PDF no Storage, bucket privado fin-docs, pasta da empresa). Sem documento, só com justificativa.
-- Permissões: fin.reimburse (pedir os próprios), fin.read (ver todos), fin.approve (aprovar/recusar).
-- Códigos de erro: P0450 dado inválido · P0451 situação não permite · P0452 não encontrado.
-- =====================================================================

insert into core.permission_catalog (key, area, label, description, position) values
  ('fin.reimburse', 'Financeiro', 'Pedir reembolso', 'Lançar as próprias despesas pagas do bolso (com NF ou recibo) para reembolso.', 73)
on conflict (key) do update set area = excluded.area, label = excluded.label, description = excluded.description, position = excluded.position;
insert into core.role_permissions (role_id, permission_key)
select id, 'fin.reimburse' from core.roles where key in ('seller', 'finance', 'hr') on conflict do nothing;

create table fin.reimbursements (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  number text not null,
  legal_entity_id uuid not null references core.legal_entities(id),
  store_id uuid references core.stores(id),
  party_id uuid not null references crm.parties(id),                 -- quem recebe o reembolso
  requester_member_id uuid references core.members(id),
  purpose text not null,
  status text not null default 'DRAFT' check (status in ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'PAID', 'CANCELLED')),
  total numeric(14, 2) not null default 0,
  submitted_at timestamptz,
  decided_by uuid references core.members(id),
  decided_at timestamptz,
  reject_reason text,
  due_date date,
  title_id uuid references fin.titles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, number)
);
create index reimbursements_status_idx on fin.reimbursements (org_id, status, created_at desc);

create table fin.reimbursement_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  reimbursement_id uuid not null references fin.reimbursements(id) on delete cascade,
  position int not null default 0,
  spent_on date not null,
  description text not null,
  supplier_party_id uuid references crm.parties(id),                 -- fornecedor efetivo, se estiver no cadastro
  supplier_doc text,                                                  -- CNPJ (14) ou CPF (11), só dígitos
  supplier_name text,
  document_kind text not null check (document_kind in ('NFE', 'NFCE', 'NFSE', 'CUPOM', 'RECIBO', 'OUTRO')),
  document_number text,
  access_key text check (access_key is null or access_key ~ '^\d{44}$'),
  amount numeric(14, 2) not null check (amount > 0),
  chart_account_id uuid references fin.chart_accounts(id),
  cost_center_id uuid references core.cost_centers(id),
  attachment_path text,
  attachment_name text,
  no_document_reason text,
  created_at timestamptz not null default now()
);
create index reimbursement_items_key_idx on fin.reimbursement_items (org_id, access_key) where access_key is not null;

select private.attach_updated_at('fin');

-- Leitura: o financeiro vê todos; cada pessoa vê os seus. Escrita só pelas funções abaixo.
alter table fin.reimbursements enable row level security;
alter table fin.reimbursement_items enable row level security;
create policy p_read on fin.reimbursements for select to authenticated
  using (org_id = (select private.org_id()) and ((select private.has_perm('fin.read')) or requester_member_id = (select private.member_id())));
create policy p_read on fin.reimbursement_items for select to authenticated
  using (exists (select 1 from fin.reimbursements r where r.id = reimbursement_id and r.org_id = (select private.org_id())
                 and ((select private.has_perm('fin.read')) or r.requester_member_id = (select private.member_id()))));
grant select on fin.reimbursements, fin.reimbursement_items to authenticated;

-- Arquivos (NF, recibo): bucket privado; cada empresa na sua pasta (<org_id>/...)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('fin-docs', 'fin-docs', false, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf', 'application/xml', 'text/xml'])
on conflict (id) do nothing;
create policy fin_docs_read on storage.objects for select to authenticated
  using (bucket_id = 'fin-docs' and (storage.foldername(name))[1] = (select private.org_id())::text);
create policy fin_docs_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'fin-docs' and (storage.foldername(name))[1] = (select private.org_id())::text);

-- Chave de acesso de NF (44 dígitos): dígito verificador módulo 11
create or replace function private.valid_nf_key(k text) returns boolean
language plpgsql immutable set search_path = '' as $$
declare s int := 0; w int := 2; i int; d int;
begin
  if k is null or k !~ '^\d{44}$' then return false; end if;
  for i in reverse 43..1 loop
    s := s + substr(k, i, 1)::int * w;
    w := case when w = 9 then 2 else w + 1 end;
  end loop;
  d := 11 - (s % 11);
  if d >= 10 then d := 0; end if;
  return d = substr(k, 44, 1)::int;
end $$;

create or replace function private.can_edit_reimbursement(r fin.reimbursements) returns boolean
language sql stable security definer set search_path = '' as $$
  select r.status in ('DRAFT', 'REJECTED') and (r.requester_member_id = private.member_id() or private.has_perm('fin.write'))
$$;

-- ---------------------------------------------------------------------
-- Salvar (criar ou editar o rascunho). Os itens vêm inteiros: os que não vierem saem.
-- p = {id?, legal_entity_id?, store_id?, purpose, items:[{id?, spent_on, description, supplier_party_id?, supplier_doc?, supplier_name?,
--      document_kind, document_number?, access_key?, amount, chart_account_id?, cost_center_id?, no_document_reason?}]}
-- ---------------------------------------------------------------------
create or replace function fin.save_reimbursement(p jsonb) returns fin.reimbursements
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); v_member uuid := private.member_id(); r fin.reimbursements; it jsonb; v_party uuid; v_le uuid; v_store uuid;
        v_doc text; v_key text; v_kind text; v_amt numeric; v_day date; v_n int := 0; v_total numeric := 0; v_keep uuid[] := '{}'; v_item uuid;
begin
  if not (private.has_perm('fin.reimburse') or private.has_perm('fin.write')) then raise exception 'Sem permissão: fin.reimburse' using errcode = '42501'; end if;
  if length(trim(coalesce(p ->> 'purpose', ''))) < 3 then raise exception 'Diga do que é o reembolso (ex.: almoço com fornecedor, material da loja)' using errcode = 'P0450'; end if;
  if jsonb_array_length(coalesce(p -> 'items', '[]')) = 0 then raise exception 'Inclua ao menos uma despesa' using errcode = 'P0450'; end if;
  if jsonb_array_length(p -> 'items') > 50 then raise exception 'No máximo 50 despesas por reembolso' using errcode = 'P0450'; end if;

  if nullif(p ->> 'id', '') is not null then
    select * into r from fin.reimbursements where id = (p ->> 'id')::uuid and org_id = v_org for update;
    if r.id is null then raise exception 'Reembolso não encontrado' using errcode = 'P0452'; end if;
    if not private.can_edit_reimbursement(r) then raise exception 'Este reembolso não pode mais ser editado (%)', r.status using errcode = 'P0451'; end if;
  else
    select party_id, default_store_id into v_party, v_store from core.members where id = v_member;
    if v_party is null then raise exception 'Seu usuário não está ligado a uma pessoa do cadastro' using errcode = 'P0451'; end if;
  end if;

  v_store := coalesce(nullif(p ->> 'store_id', '')::uuid, r.store_id, v_store);
  v_le := coalesce(nullif(p ->> 'legal_entity_id', '')::uuid, r.legal_entity_id, (select legal_entity_id from core.stores where id = v_store),
                   (select id from core.legal_entities where org_id = v_org order by created_at limit 1));
  if not exists (select 1 from core.legal_entities where id = v_le and org_id = v_org) then raise exception 'Empresa inválida' using errcode = 'P0450'; end if;

  if r.id is null then
    insert into fin.reimbursements (org_id, number, legal_entity_id, store_id, party_id, requester_member_id, purpose)
    values (v_org, core.next_number(v_org, 'REE'), v_le, v_store, v_party, v_member, trim(p ->> 'purpose')) returning * into r;
  else
    update fin.reimbursements set purpose = trim(p ->> 'purpose'), legal_entity_id = v_le, store_id = v_store where id = r.id returning * into r;
  end if;

  for it in select * from jsonb_array_elements(p -> 'items') loop
    v_n := v_n + 1;
    v_kind := upper(coalesce(it ->> 'document_kind', ''));
    if v_kind not in ('NFE', 'NFCE', 'NFSE', 'CUPOM', 'RECIBO', 'OUTRO') then raise exception 'Despesa %: tipo de documento inválido', v_n using errcode = 'P0450'; end if;
    v_amt := round(coalesce(nullif(it ->> 'amount', '')::numeric, 0), 2);
    if v_amt <= 0 then raise exception 'Despesa %: informe o valor', v_n using errcode = 'P0450'; end if;
    v_day := nullif(it ->> 'spent_on', '')::date;
    if v_day is null or v_day > private.today_sp() then raise exception 'Despesa %: data inválida (não pode ser futura)', v_n using errcode = 'P0450'; end if;
    if v_day < private.today_sp() - 180 then raise exception 'Despesa %: mais de 180 dias, fale com o financeiro', v_n using errcode = 'P0450'; end if;
    if length(trim(coalesce(it ->> 'description', ''))) < 2 then raise exception 'Despesa %: descreva o que foi comprado', v_n using errcode = 'P0450'; end if;
    v_doc := nullif(regexp_replace(coalesce(it ->> 'supplier_doc', ''), '\D', '', 'g'), '');
    if v_doc is not null and length(v_doc) = 14 and not private.valid_cnpj(v_doc) then raise exception 'Despesa %: CNPJ do fornecedor inválido', v_n using errcode = 'P0450'; end if;
    if v_doc is not null and length(v_doc) not in (11, 14) then raise exception 'Despesa %: CNPJ (14 dígitos) ou CPF (11 dígitos) do fornecedor', v_n using errcode = 'P0450'; end if;
    v_key := nullif(regexp_replace(coalesce(it ->> 'access_key', ''), '\D', '', 'g'), '');
    if v_key is not null then
      if not private.valid_nf_key(v_key) then raise exception 'Despesa %: chave de acesso da nota inválida (confira os 44 números)', v_n using errcode = 'P0450'; end if;
      if exists (select 1 from fin.reimbursement_items i join fin.reimbursements x on x.id = i.reimbursement_id
                 where i.org_id = v_org and i.access_key = v_key and x.id <> r.id and x.status not in ('CANCELLED', 'REJECTED')) then
        raise exception 'Despesa %: esta nota já está em outro reembolso', v_n using errcode = 'P0451';
      end if;
      if v_doc is null then v_doc := substr(v_key, 7, 14); end if;            -- o CNPJ do emitente está dentro da chave
    end if;
    if nullif(it ->> 'supplier_party_id', '') is not null and not exists (select 1 from crm.parties where id = (it ->> 'supplier_party_id')::uuid and org_id = v_org) then
      raise exception 'Despesa %: fornecedor não encontrado', v_n using errcode = 'P0452';
    end if;

    v_item := nullif(it ->> 'id', '')::uuid;
    if v_item is not null and exists (select 1 from fin.reimbursement_items where id = v_item and reimbursement_id = r.id) then
      update fin.reimbursement_items set position = v_n, spent_on = v_day, description = trim(it ->> 'description'), supplier_party_id = nullif(it ->> 'supplier_party_id', '')::uuid,
             supplier_doc = v_doc, supplier_name = nullif(trim(coalesce(it ->> 'supplier_name', '')), ''), document_kind = v_kind,
             document_number = nullif(trim(coalesce(it ->> 'document_number', '')), ''), access_key = v_key, amount = v_amt,
             chart_account_id = nullif(it ->> 'chart_account_id', '')::uuid, cost_center_id = nullif(it ->> 'cost_center_id', '')::uuid,
             no_document_reason = nullif(trim(coalesce(it ->> 'no_document_reason', '')), '')
      where id = v_item;
    else
      insert into fin.reimbursement_items (org_id, reimbursement_id, position, spent_on, description, supplier_party_id, supplier_doc, supplier_name, document_kind,
                                           document_number, access_key, amount, chart_account_id, cost_center_id, no_document_reason)
      values (v_org, r.id, v_n, v_day, trim(it ->> 'description'), nullif(it ->> 'supplier_party_id', '')::uuid, v_doc, nullif(trim(coalesce(it ->> 'supplier_name', '')), ''), v_kind,
              nullif(trim(coalesce(it ->> 'document_number', '')), ''), v_key, v_amt, nullif(it ->> 'chart_account_id', '')::uuid, nullif(it ->> 'cost_center_id', '')::uuid,
              nullif(trim(coalesce(it ->> 'no_document_reason', '')), ''))
      returning id into v_item;
    end if;
    v_keep := v_keep || v_item;
    v_total := v_total + v_amt;
  end loop;
  delete from fin.reimbursement_items where reimbursement_id = r.id and id <> all (v_keep);
  update fin.reimbursements set total = v_total where id = r.id returning * into r;
  return r;
end $$;

-- Arquivo do comprovante (enviado ao Storage pela tela); o caminho precisa estar na pasta da empresa
create or replace function fin.set_reimbursement_attachment(p_item uuid, p_path text, p_name text) returns void
language plpgsql security definer set search_path = '' as $$
declare r fin.reimbursements;
begin
  select x.* into r from fin.reimbursements x join fin.reimbursement_items i on i.reimbursement_id = x.id where i.id = p_item and x.org_id = private.org_id();
  if r.id is null then raise exception 'Despesa não encontrada' using errcode = 'P0452'; end if;
  if not private.can_edit_reimbursement(r) then raise exception 'Este reembolso não pode mais ser editado' using errcode = 'P0451'; end if;
  if p_path is not null and p_path not like r.org_id::text || '/%' then raise exception 'Arquivo fora da pasta da empresa' using errcode = 'P0450'; end if;
  update fin.reimbursement_items set attachment_path = p_path, attachment_name = left(p_name, 200) where id = p_item;
end $$;

-- Enviar para aprovação: toda despesa precisa de comprovante ou de justificativa
create or replace function fin.submit_reimbursement(p_id uuid) returns fin.reimbursements
language plpgsql security definer set search_path = '' as $$
declare r fin.reimbursements; v_missing int; m record;
begin
  select * into r from fin.reimbursements where id = p_id and org_id = private.org_id() for update;
  if r.id is null then raise exception 'Reembolso não encontrado' using errcode = 'P0452'; end if;
  if not private.can_edit_reimbursement(r) then raise exception 'Este reembolso já foi enviado (%)', r.status using errcode = 'P0451'; end if;
  if not exists (select 1 from fin.reimbursement_items where reimbursement_id = r.id) then raise exception 'Inclua ao menos uma despesa' using errcode = 'P0450'; end if;
  select count(*) into v_missing from fin.reimbursement_items where reimbursement_id = r.id and attachment_path is null and length(coalesce(no_document_reason, '')) < 10;
  if v_missing > 0 then raise exception '% despesa(s) sem comprovante: anexe a foto/PDF da nota ou do recibo, ou explique por que não há', v_missing using errcode = 'P0451'; end if;
  update fin.reimbursements set status = 'SUBMITTED', submitted_at = now(), reject_reason = null, decided_by = null, decided_at = null where id = r.id returning * into r;
  -- avisa quem aprova
  for m in select distinct mb.id from core.members mb join core.member_roles mr on mr.member_id = mb.id join core.roles ro on ro.id = mr.role_id
           left join core.role_permissions rp on rp.role_id = ro.id and rp.permission_key = 'fin.approve'
           where mb.org_id = r.org_id and mb.status = 'ACTIVE' and (ro.is_superuser or rp.role_id is not null) and mb.id is distinct from r.requester_member_id loop
    insert into core.notifications (org_id, member_id, kind, title, payload)
    values (r.org_id, m.id, 'REIMBURSEMENT_SUBMITTED', format('Reembolso %s para aprovar: R$ %s', r.number, to_char(r.total, 'FM999G990D00')), jsonb_build_object('reimbursement_id', r.id));
  end loop;
  return r;
end $$;

-- Aprovar (vira conta a pagar para a pessoa, por categoria e centro de custo) ou recusar (volta para correção)
create or replace function fin.decide_reimbursement(p_id uuid, p_approve boolean, p_reason text default null, p_due_date date default null) returns fin.reimbursements
language plpgsql security definer set search_path = '' as $$
declare r fin.reimbursements; t fin.titles; v_lines jsonb; v_comp date; v_unclassified uuid;
begin
  perform private.require_perm('fin.approve');
  select * into r from fin.reimbursements where id = p_id and org_id = private.org_id() for update;
  if r.id is null then raise exception 'Reembolso não encontrado' using errcode = 'P0452'; end if;
  if r.status <> 'SUBMITTED' then raise exception 'Só reembolsos enviados podem ser decididos (está %)', r.status using errcode = 'P0451'; end if;
  if r.requester_member_id = private.member_id() and not exists (
       select 1 from core.member_roles mr join core.roles ro on ro.id = mr.role_id where mr.member_id = private.member_id() and ro.is_superuser) then
    raise exception 'Quem pediu o reembolso não pode aprovar o próprio' using errcode = 'P0451';
  end if;

  if not p_approve then
    if length(trim(coalesce(p_reason, ''))) < 5 then raise exception 'Explique o motivo da recusa' using errcode = 'P0450'; end if;
    update fin.reimbursements set status = 'REJECTED', reject_reason = trim(p_reason), decided_by = private.member_id(), decided_at = now() where id = r.id returning * into r;
    if r.requester_member_id is not null then
      insert into core.notifications (org_id, member_id, kind, title, payload)
      values (r.org_id, r.requester_member_id, 'REIMBURSEMENT_REJECTED', format('Reembolso %s recusado: %s', r.number, left(trim(p_reason), 120)), jsonb_build_object('reimbursement_id', r.id));
    end if;
    return r;
  end if;

  v_unclassified := private.acct(r.org_id, 'UNCLASSIFIED_EXPENSE');
  select jsonb_agg(jsonb_build_object('chart_account_id', coalesce(chart_account_id, v_unclassified), 'cost_center_id', cost_center_id, 'amount', amt, 'memo', 'Reembolso ' || r.number)), max(day)
    into v_lines, v_comp
  from (select chart_account_id, cost_center_id, sum(amount) as amt, max(spent_on) as day from fin.reimbursement_items where reimbursement_id = r.id group by 1, 2) g;

  t := private.insert_title(jsonb_build_object(
    'direction', 'PAYABLE', 'legal_entity_id', r.legal_entity_id, 'store_id', r.store_id, 'party_id', r.party_id,
    'description', 'Reembolso ' || r.number || ' — ' || r.purpose, 'document_kind', 'REEMBOLSO', 'document_number', r.number,
    'competence_date', v_comp, 'approval_status', 'APPROVED', 'origin_type', 'REIMBURSEMENT', 'origin_id', r.id, 'lines', v_lines,
    'installments', jsonb_build_array(jsonb_build_object('due_date', coalesce(p_due_date, private.today_sp() + 5), 'amount', r.total))), private.member_id());

  update fin.reimbursements set status = 'APPROVED', title_id = t.id, due_date = coalesce(p_due_date, private.today_sp() + 5), decided_by = private.member_id(), decided_at = now()
  where id = r.id returning * into r;
  if r.requester_member_id is not null then
    insert into core.notifications (org_id, member_id, kind, title, payload)
    values (r.org_id, r.requester_member_id, 'REIMBURSEMENT_APPROVED', format('Reembolso %s aprovado: R$ %s para %s', r.number, to_char(r.total, 'FM999G990D00'), to_char(r.due_date, 'DD/MM')), jsonb_build_object('reimbursement_id', r.id));
  end if;
  return r;
end $$;

create or replace function fin.cancel_reimbursement(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r fin.reimbursements;
begin
  select * into r from fin.reimbursements where id = p_id and org_id = private.org_id() for update;
  if r.id is null then raise exception 'Reembolso não encontrado' using errcode = 'P0452'; end if;
  if r.status not in ('DRAFT', 'SUBMITTED', 'REJECTED') then raise exception 'Reembolso aprovado se cancela pela conta a pagar' using errcode = 'P0451'; end if;
  if r.requester_member_id is distinct from private.member_id() and not private.has_perm('fin.write') then raise exception 'Sem permissão' using errcode = '42501'; end if;
  update fin.reimbursements set status = 'CANCELLED' where id = r.id;
end $$;

-- Quem aprova classifica cada despesa (categoria e centro de custo) antes de aprovar
create or replace function fin.classify_reimbursement_item(p_item uuid, p_account uuid, p_cost_center uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r fin.reimbursements;
begin
  perform private.require_perm('fin.approve');
  select x.* into r from fin.reimbursements x join fin.reimbursement_items i on i.reimbursement_id = x.id where i.id = p_item and x.org_id = private.org_id();
  if r.id is null then raise exception 'Despesa não encontrada' using errcode = 'P0452'; end if;
  if r.status not in ('SUBMITTED', 'DRAFT', 'REJECTED') then raise exception 'Reembolso já decidido' using errcode = 'P0451'; end if;
  if p_account is not null and not exists (select 1 from fin.chart_accounts where id = p_account and org_id = r.org_id and kind = 'ANALYTIC') then raise exception 'Categoria inválida' using errcode = 'P0450'; end if;
  if p_cost_center is not null and not exists (select 1 from core.cost_centers where id = p_cost_center and org_id = r.org_id) then raise exception 'Centro de custo inválido' using errcode = 'P0450'; end if;
  update fin.reimbursement_items set chart_account_id = p_account, cost_center_id = p_cost_center where id = p_item;
end $$;

-- Pago quando a conta a pagar é baixada; volta para aprovado se a baixa for estornada; cancelado se o título for cancelado
create or replace function private.reimbursement_title_status() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.origin_type = 'REIMBURSEMENT' and new.status is distinct from old.status then
    update fin.reimbursements set status = case new.status::text when 'SETTLED' then 'PAID' when 'CANCELLED' then 'CANCELLED' else 'APPROVED' end
    where id = new.origin_id and status in ('APPROVED', 'PAID');
  end if;
  return null;
end $$;
create trigger trg_reimbursement_title_status after update of status on fin.titles for each row execute function private.reimbursement_title_status();

insert into private.internal_functions (fqname) values ('private.valid_nf_key'), ('private.can_edit_reimbursement'), ('private.reimbursement_title_status') on conflict do nothing;
select private.lock_functions();
