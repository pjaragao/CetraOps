-- Caixa de documentos (23/10/2026): vários arquivos de uma vez → o lançamento certo, sempre confirmado pela pessoa.
--   * a tela Financeiro › Caixa de documentos lê cada arquivo (XML de NF-e sem IA; foto/PDF pela rota vision_extract, com boleto, Pix e
--     chave conferidos pelos leitores sem IA) e chama fin.doc_inbox_add com os campos lidos;
--   * o banco sugere o destino por regras fixas (private.doc_inbox_route): boleto/Pix → conta a pagar; XML de mercadoria de moda →
--     recebimento (que dispara a conferência da IA); XML de despesa → conta a pagar com as duplicatas (ou a tela da nota, se ela já veio
--     da SEFAZ); foto de nota/cupom/recibo → pedido de reembolso para quem enviou; o resto → "para revisar", com o motivo;
--   * antes de lançar procura duplicidade (mesmo arquivo, mesmo código de barras, mesma chave de NF-e já usada em recebimento, reembolso,
--     nota recebida ou outro documento da caixa; mesmo valor, vencimento e favorecido) e só lança duplicado se a pessoa insistir;
--   * fin.doc_inbox_confirm lança pelas funções de sempre (fin.create_title, fin.save_reimbursement + submit, purch.import_nfe), cada uma
--     com a sua permissão; fin.doc_inbox_discard descarta.
-- O comprovante financeiro (boleto, nota, recibo) fica no bucket privado fin-docs, na pasta da empresa, porque o reembolso exige o anexo.
-- Documento de identidade não é guardado: vai para revisão apontando o cadastro.

create table fin.doc_inbox (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs (id),
  member_id uuid references core.members (id),
  file_name text,
  mime text,
  sha256 text not null,
  storage_path text,
  kind text not null check (kind in ('boleto', 'pix', 'nota_ou_recibo', 'nfe_xml', 'identidade', 'comprovante_endereco', 'etiqueta_produto', 'outro')),
  label text not null default 'Documento',
  fields jsonb not null default '{}',
  checks jsonb not null default '[]',
  xml text,
  destination text not null check (destination in ('PAYABLE', 'REIMBURSEMENT', 'RECEIPT', 'REVIEW')),
  destination_reason text,
  duplicate jsonb,
  status text not null default 'PENDING' check (status in ('PENDING', 'DONE', 'DISCARDED')),
  target_type text,
  target_id uuid,
  target_label text,
  target_href text,
  decided_by uuid references core.members (id),
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create index doc_inbox_org_status_idx on fin.doc_inbox (org_id, status, created_at desc);
create unique index doc_inbox_sha_uq on fin.doc_inbox (org_id, sha256) where status <> 'DISCARDED';
alter table fin.doc_inbox enable row level security;
-- cada um vê o que mandou; financeiro e compras veem a caixa inteira. Escrita só pelas funções abaixo.
create policy p_read on fin.doc_inbox for select to authenticated using (
  org_id = (select private.org_id())
  and (member_id = (select private.member_id()) or (select private.has_perm('fin.write')) or (select private.has_perm('purch.write'))));
grant select on fin.doc_inbox to authenticated;
grant all on fin.doc_inbox to service_role;

create or replace function private.doc_inbox_perm() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if coalesce(auth.role(), '') = 'authenticated'
     and not (private.has_perm('fin.write') or private.has_perm('fin.reimburse') or private.has_perm('purch.write')) then
    raise exception 'Sem permissão para a caixa de documentos' using errcode = '42501';
  end if;
  if coalesce(auth.role(), '') = 'anon' then raise exception 'Acesso anônimo negado' using errcode = '42501'; end if;
end $$;

-- Destino sugerido (regras fixas, sem IA)
create or replace function private.doc_inbox_route(p_org uuid, p_member uuid, p_kind text, p_fields jsonb, p_xml text)
returns table (destination text, reason text)
language plpgsql stable security definer set search_path = '' as $$
declare j jsonb; v_key text := p_fields ->> 'chave_acesso';
begin
  case p_kind
  when 'boleto', 'pix' then
    destination := 'PAYABLE'; reason := 'Boleto ou Pix: vira conta a pagar (sai em rascunho para aprovação).';
  when 'nfe_xml' then
    begin
      j := fiscal.parse_nfe(p_xml);
    exception when others then
      destination := 'REVIEW'; reason := 'Não consegui ler este XML de NF-e.'; return next; return;
    end;
    if exists (select 1 from jsonb_array_elements(coalesce(j -> 'items', '[]')) it where left(coalesce(it ->> 'ncm', ''), 2) in ('61', '62', '63', '64', '65', '42', '71')) then
      destination := 'RECEIPT'; reason := 'Mercadoria (roupas e acessórios): entra pelo recebimento, com a conferência da IA e a contagem.';
    elsif exists (select 1 from fiscal.inbound_dfe d where d.org_id = p_org and d.access_key = v_key and d.destination is null) then
      destination := 'REVIEW'; reason := 'Esta nota já veio da SEFAZ: escolha o destino na tela da nota (patrimônio, despesa, reembolso…).';
    else
      destination := 'PAYABLE'; reason := 'Nota de despesa ou serviço: vira conta a pagar com as duplicatas da nota.';
    end if;
  when 'nota_ou_recibo' then
    if exists (select 1 from core.members m where m.id = p_member and m.party_id is not null) then
      destination := 'REIMBURSEMENT'; reason := 'Comprovante de gasto: vira pedido de reembolso para quem enviou, já com o anexo.';
    else
      destination := 'REVIEW'; reason := 'Seu usuário não está ligado a uma pessoa do cadastro: não dá para pedir reembolso. Escolha conta a pagar se a loja ainda deve.';
    end if;
  when 'identidade' then
    destination := 'REVIEW'; reason := 'Documento de identidade: use Cadastros › Nova pessoa › "Preencher com foto" (a imagem não foi guardada).';
  else
    destination := 'REVIEW'; reason := 'Não reconheci um boleto, Pix ou nota neste arquivo.';
  end case;
  return next;
end $$;

-- Lançamento que já existe para o mesmo documento (null = nenhum)
create or replace function private.doc_inbox_duplicate(p_org uuid, p_self uuid, p_kind text, p_fields jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_bar text := nullif(regexp_replace(coalesce(p_fields ->> 'codigo_barras', ''), '\D', '', 'g'), '');
  v_key text := nullif(regexp_replace(coalesce(p_fields ->> 'chave_acesso', ''), '\D', '', 'g'), '');
  v_cnpj text := nullif(regexp_replace(coalesce(p_fields ->> 'beneficiario_cnpj', p_fields ->> 'emitente_cnpj', ''), '\D', '', 'g'), '');
  v_amt numeric; v_due date; x record;
begin
  if v_bar is not null then
    select t.id, t.number into x from fin.title_installments i join fin.titles t on t.id = i.title_id
    where i.org_id = p_org and regexp_replace(coalesce(i.barcode, ''), '\D', '', 'g') = v_bar and t.status <> 'CANCELLED' limit 1;
    if x.id is not null then return jsonb_build_object('tipo', 'Conta a pagar com o mesmo código de barras', 'ref', x.number, 'href', '/financeiro/pagar?titulo=' || x.id); end if;
  end if;
  if v_key is not null then
    select r.id, r.number into x from purch.receipts r join fiscal.documents d on d.id = r.document_id where r.org_id = p_org and d.access_key = v_key limit 1;
    if x.id is not null then return jsonb_build_object('tipo', 'NF-e já recebida', 'ref', x.number, 'href', '/produtos/recebimento/' || x.id); end if;
    select r.id, r.number into x from fin.reimbursement_items i join fin.reimbursements r on r.id = i.reimbursement_id
    where i.org_id = p_org and i.access_key = v_key and r.status not in ('CANCELLED', 'REJECTED') limit 1;
    if x.id is not null then return jsonb_build_object('tipo', 'Nota já usada em reembolso', 'ref', x.number, 'href', '/financeiro/reembolsos/' || x.id); end if;
    select d.id, d.destination into x from fiscal.inbound_dfe d where d.org_id = p_org and d.access_key = v_key and d.destination is not null limit 1;
    if x.id is not null then return jsonb_build_object('tipo', 'Nota recebida com destino já decidido', 'ref', x.destination, 'href', '/fiscal/recebidas/nota/' || v_key); end if;
    select b.id, b.target_label into x from fin.doc_inbox b where b.org_id = p_org and b.id is distinct from p_self and b.status = 'DONE' and b.fields ->> 'chave_acesso' = v_key limit 1;
    if x.id is not null then return jsonb_build_object('tipo', 'Nota já lançada pela caixa de documentos', 'ref', x.target_label, 'href', '/financeiro/documentos?ver=feitos'); end if;
  end if;
  -- boleto sem código lido: mesmo favorecido, valor e vencimento
  if p_kind = 'boleto' and v_cnpj is not null then
    begin
      v_amt := round((p_fields ->> 'valor')::numeric, 2); v_due := (p_fields ->> 'vencimento')::date;
    exception when others then v_amt := null;
    end;
    if v_amt is not null and v_due is not null then
      select t.id, t.number into x from fin.title_installments i join fin.titles t on t.id = i.title_id join crm.parties pa on pa.id = t.party_id
      where i.org_id = p_org and i.amount = v_amt and i.due_date = v_due and pa.cnpj = v_cnpj and t.status <> 'CANCELLED' limit 1;
      if x.id is not null then return jsonb_build_object('tipo', 'Conta a pagar do mesmo favorecido, valor e vencimento', 'ref', x.number, 'href', '/financeiro/pagar?titulo=' || x.id); end if;
    end if;
  end if;
  return null;
end $$;

-- Entrada de um documento lido. O mesmo arquivo (sha256) não entra duas vezes: devolve o que já está na caixa.
create or replace function fin.doc_inbox_add(p jsonb) returns fin.doc_inbox
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id(); v_member uuid := private.member_id(); r fin.doc_inbox; v_kind text := p ->> 'kind';
  v_fields jsonb := coalesce(p -> 'fields', '{}'); v_xml text; v_label text := nullif(trim(coalesce(p ->> 'label', '')), ''); v_path text := nullif(p ->> 'storage_path', '');
  j jsonb; v_route record;
begin
  perform private.doc_inbox_perm();
  if v_org is null then raise exception 'Sem organização no token' using errcode = '42501'; end if;
  if coalesce(p ->> 'sha256', '') !~ '^[0-9a-f]{64}$' then raise exception 'Arquivo sem identificação (sha256)' using errcode = 'P0470'; end if;
  select * into r from fin.doc_inbox where org_id = v_org and sha256 = p ->> 'sha256' and status <> 'DISCARDED';
  if r.id is not null then
    if r.member_id is distinct from v_member and coalesce(auth.role(), '') = 'authenticated' and not (private.has_perm('fin.write') or private.has_perm('purch.write')) then
      raise exception 'Este arquivo já foi enviado por outra pessoa' using errcode = 'P0474';
    end if;
    return r;
  end if;
  if v_kind is null or v_kind not in ('boleto', 'pix', 'nota_ou_recibo', 'nfe_xml', 'identidade', 'comprovante_endereco', 'etiqueta_produto', 'outro') then
    raise exception 'Tipo de documento inválido' using errcode = 'P0470';
  end if;
  if jsonb_typeof(v_fields) <> 'object' then raise exception 'Campos inválidos' using errcode = 'P0470'; end if;
  if v_path is not null and v_path not like v_org::text || '/caixa/%' then raise exception 'Arquivo fora da pasta da empresa' using errcode = 'P0470'; end if;

  if v_kind = 'nfe_xml' then
    v_xml := p ->> 'xml';
    begin
      j := fiscal.parse_nfe(v_xml);
      v_fields := jsonb_strip_nulls(jsonb_build_object(
        'emitente', coalesce(nullif(j #>> '{issuer,fantasy}', ''), j #>> '{issuer,name}'), 'emitente_cnpj', j #>> '{issuer,cnpj}',
        'valor_total', round((j #>> '{totals,vNF}')::numeric, 2), 'data', left(j #>> '{header,issue_at}', 10), 'chave_acesso', j ->> 'access_key',
        'numero', j #>> '{header,number}', 'itens', jsonb_array_length(coalesce(j -> 'items', '[]')),
        'descricao', left(coalesce(j #>> '{items,0,xprod}', ''), 80) || case when jsonb_array_length(coalesce(j -> 'items', '[]')) > 1
                       then format(' e mais %s item(ns)', jsonb_array_length(j -> 'items') - 1) else '' end));
      v_label := format('NF-e %s de %s', j #>> '{header,number}', v_fields ->> 'emitente');
    exception when others then
      v_fields := '{}';
    end;
  end if;
  if v_kind = 'identidade' then v_path := null; v_fields := '{}'; end if;     -- nada da identidade fica na caixa

  select * into v_route from private.doc_inbox_route(v_org, v_member, v_kind, v_fields, v_xml);
  insert into fin.doc_inbox (org_id, member_id, file_name, mime, sha256, storage_path, kind, label, fields, checks, xml, destination, destination_reason, duplicate)
  values (v_org, v_member, left(p ->> 'file_name', 200), left(p ->> 'mime', 100), p ->> 'sha256', v_path, v_kind, coalesce(v_label, 'Documento'), v_fields,
          case when jsonb_typeof(p -> 'checks') = 'array' then p -> 'checks' else '[]' end, v_xml, v_route.destination, v_route.reason,
          private.doc_inbox_duplicate(v_org, null, v_kind, v_fields))
  returning * into r;
  return r;
end $$;

-- Confirma: lança no destino (o sugerido ou o escolhido em p.destination), com os campos corrigidos em p.fields.
-- p.force = true lança mesmo apontado como duplicado. p.location_id escolhe o local do recebimento.
create or replace function fin.doc_inbox_confirm(p_id uuid, p jsonb default '{}') returns fin.doc_inbox
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id(); v_member uuid := private.member_id(); r fin.doc_inbox; f jsonb; v_dest text; j jsonb;
  v_amount numeric; v_due date; v_day date; v_party uuid; v_cnpj text; v_desc text; v_le uuid; v_store uuid; v_loc uuid; v_inst jsonb;
  t fin.titles; rr fin.reimbursements; rc purch.receipts; v_item uuid; v_key text; v_doc_kind text; v_label text; v_href text; v_type text; v_target uuid;
begin
  perform private.doc_inbox_perm();
  select * into r from fin.doc_inbox where id = p_id and org_id = v_org for update;
  if r.id is null then raise exception 'Documento não encontrado na caixa' using errcode = 'P0471'; end if;
  if r.status <> 'PENDING' then raise exception 'Este documento já foi % ', case r.status when 'DONE' then 'lançado' else 'descartado' end using errcode = 'P0471'; end if;
  if r.member_id is distinct from v_member and coalesce(auth.role(), '') = 'authenticated' and not (private.has_perm('fin.write') or private.has_perm('purch.write')) then
    raise exception 'Este documento é de outra pessoa' using errcode = '42501';
  end if;
  v_dest := upper(coalesce(nullif(p ->> 'destination', ''), r.destination));
  if v_dest not in ('PAYABLE', 'REIMBURSEMENT', 'RECEIPT') then raise exception 'Escolha o destino: conta a pagar, reembolso ou recebimento' using errcode = 'P0472'; end if;
  r.duplicate := private.doc_inbox_duplicate(v_org, r.id, r.kind, r.fields);    -- confere de novo: pode ter sido lançado depois de entrar
  if r.duplicate is not null and not coalesce((p ->> 'force')::boolean, false) then
    raise exception 'Parece duplicado (% %): confira e, se for outro documento, confirme de novo com "lançar mesmo assim"',
      r.duplicate ->> 'tipo', coalesce(r.duplicate ->> 'ref', '') using errcode = 'P0473';
  end if;

  f := r.fields || jsonb_strip_nulls(coalesce(p -> 'fields', '{}'));
  begin
    v_amount := round(coalesce(nullif(f ->> 'valor', ''), nullif(f ->> 'valor_total', ''))::numeric, 2);
    v_due := nullif(f ->> 'vencimento', '')::date;
    v_day := nullif(f ->> 'data', '')::date;
  exception when others then
    raise exception 'Valor ou data inválidos: corrija na linha do documento' using errcode = 'P0472';
  end;
  v_cnpj := nullif(regexp_replace(coalesce(f ->> 'beneficiario_cnpj', f ->> 'emitente_cnpj', ''), '\D', '', 'g'), '');
  v_key := nullif(regexp_replace(coalesce(f ->> 'chave_acesso', ''), '\D', '', 'g'), '');
  v_desc := coalesce(nullif(trim(coalesce(f ->> 'descricao', '')), ''), r.label);
  select m.default_store_id into v_store from core.members m where m.id = v_member;
  v_le := coalesce((select legal_entity_id from core.stores where id = v_store), (select id from core.legal_entities where org_id = v_org order by created_at limit 1));

  if v_dest = 'PAYABLE' then
    if r.kind in ('identidade', 'comprovante_endereco', 'etiqueta_produto') then raise exception 'Este documento não é uma cobrança' using errcode = 'P0472'; end if;
    v_party := coalesce(nullif(f ->> 'party_id', '')::uuid,
                        (select pa.id from crm.parties pa where pa.org_id = v_org and pa.cnpj = v_cnpj and pa.merged_into_id is null order by pa.created_at limit 1));
    if v_party is not null and not exists (select 1 from crm.parties where id = v_party and org_id = v_org) then raise exception 'Favorecido não encontrado' using errcode = 'P0472'; end if;
    -- parcelas: as duplicatas da NF-e quando somam o total; senão uma parcela no vencimento
    if r.kind = 'nfe_xml' and r.xml is not null then
      j := fiscal.parse_nfe(r.xml);
      select coalesce(jsonb_agg(jsonb_build_object('due_date', x ->> 'due_date', 'amount', (x ->> 'amount')::numeric) order by x ->> 'due_date'), '[]') into v_inst
      from jsonb_array_elements(coalesce(j -> 'installments', '[]')) x where (x ->> 'amount')::numeric > 0 and x ->> 'due_date' is not null;
      if jsonb_array_length(v_inst) = 0 or (select sum((y ->> 'amount')::numeric) from jsonb_array_elements(v_inst) y) <> v_amount then v_inst := null; end if;
    end if;
    if v_inst is null then
      if v_amount is null or v_amount <= 0 then raise exception 'Informe o valor' using errcode = 'P0472'; end if;
      if v_due is null then raise exception 'Informe o vencimento' using errcode = 'P0472'; end if;
      v_inst := jsonb_build_array(jsonb_build_object('due_date', v_due, 'amount', v_amount, 'barcode', nullif(regexp_replace(coalesce(f ->> 'codigo_barras', ''), '\D', '', 'g'), '')));
    end if;
    t := fin.create_title(jsonb_build_object(
      'direction', 'PAYABLE', 'legal_entity_id', v_le, 'store_id', v_store, 'party_id', v_party, 'description', v_desc,
      'document_kind', case r.kind when 'boleto' then 'BOLETO' when 'pix' then 'PIX' else 'NF' end, 'document_number', nullif(f ->> 'numero', ''),
      'competence_date', coalesce(v_day, private.today_sp()), 'installments', v_inst));
    if r.storage_path is not null then
      insert into core.attachments (org_id, entity_type, entity_id, storage_path, sha256, mime, created_by)
      values (v_org, 'fin.titles', t.id, r.storage_path, r.sha256, r.mime, v_member);
    end if;
    v_type := 'fin.titles'; v_target := t.id; v_label := 'Conta a pagar ' || t.number; v_href := '/financeiro/pagar?titulo=' || t.id;

  elsif v_dest = 'REIMBURSEMENT' then
    if r.member_id is distinct from v_member then raise exception 'Só quem enviou o comprovante pode pedir o reembolso' using errcode = 'P0472'; end if;
    if v_amount is null or v_amount <= 0 then raise exception 'Informe o valor' using errcode = 'P0472'; end if;
    v_doc_kind := case when substr(coalesce(v_key, ''), 21, 2) = '55' then 'NFE' when substr(coalesce(v_key, ''), 21, 2) = '65' then 'NFCE'
                       when v_cnpj is not null then 'CUPOM' else 'RECIBO' end;
    rr := fin.save_reimbursement(jsonb_build_object(
      'purpose', coalesce(nullif(trim(coalesce(f ->> 'motivo', '')), ''), v_desc),
      'store_id', v_store,
      'items', jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
        'spent_on', coalesce(v_day, private.today_sp()), 'description', v_desc, 'supplier_doc', v_cnpj, 'supplier_name', nullif(f ->> 'emitente', ''),
        'document_kind', v_doc_kind, 'access_key', v_key, 'amount', v_amount)))));
    select id into v_item from fin.reimbursement_items where reimbursement_id = rr.id order by position limit 1;
    if r.storage_path is not null then
      perform fin.set_reimbursement_attachment(v_item, r.storage_path, coalesce(r.file_name, 'comprovante'));
      rr := fin.submit_reimbursement(rr.id);
      v_label := 'Reembolso ' || rr.number || ' enviado para aprovação';
    else
      v_label := 'Reembolso ' || rr.number || ' em rascunho (anexe o comprovante)';
    end if;
    v_type := 'fin.reimbursements'; v_target := rr.id; v_href := '/financeiro/reembolsos/' || rr.id;

  else -- RECEIPT
    if r.xml is null then raise exception 'O recebimento precisa do XML da NF-e (a foto da DANFE não serve)' using errcode = 'P0472'; end if;
    v_loc := coalesce(nullif(p ->> 'location_id', '')::uuid,
                      (select l.id from inv.locations l where l.org_id = v_org and l.store_id = v_store and l.kind = 'SALES_FLOOR' order by l.created_at limit 1),
                      (select l.id from inv.locations l where l.org_id = v_org and l.kind = 'SALES_FLOOR' order by l.created_at limit 1));
    if v_loc is null then raise exception 'Cadastre o local de estoque da loja antes de receber mercadoria' using errcode = 'P0472'; end if;
    rc := purch.import_nfe(r.xml, v_loc);
    v_type := 'purch.receipts'; v_target := rc.id; v_label := 'Recebimento ' || rc.number || ' (conferir)'; v_href := '/produtos/recebimento/' || rc.id;
  end if;

  update fin.doc_inbox set status = 'DONE', destination = v_dest, fields = f, duplicate = r.duplicate, target_type = v_type, target_id = v_target,
         target_label = v_label, target_href = v_href, decided_by = v_member, decided_at = now()
  where id = r.id returning * into r;
  return r;
end $$;

-- Descarta (o arquivo guardado é apagado pela tela com o caminho devolvido)
create or replace function fin.doc_inbox_discard(p_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); r fin.doc_inbox;
begin
  perform private.doc_inbox_perm();
  select * into r from fin.doc_inbox where id = p_id and org_id = v_org for update;
  if r.id is null then raise exception 'Documento não encontrado na caixa' using errcode = 'P0471'; end if;
  if r.status <> 'PENDING' then raise exception 'Só dá para descartar o que ainda não foi lançado' using errcode = 'P0471'; end if;
  if r.member_id is distinct from private.member_id() and not (private.has_perm('fin.write') or private.has_perm('purch.write')) then
    raise exception 'Este documento é de outra pessoa' using errcode = '42501';
  end if;
  update fin.doc_inbox set status = 'DISCARDED', decided_by = private.member_id(), decided_at = now(), storage_path = null where id = r.id;
  return r.storage_path;
end $$;

insert into private.internal_functions (fqname) values ('private.doc_inbox_perm'), ('private.doc_inbox_route'), ('private.doc_inbox_duplicate')
on conflict do nothing;
select private.lock_functions();
