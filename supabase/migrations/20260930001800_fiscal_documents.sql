-- =====================================================================
-- fiscal: documentos fiscais (NF-e / NFC-e, entrada e saída) e leitura do XML da NF-e recebida no próprio banco.
-- O parser mora aqui (e não no app) para que web, worker e MDe usem a MESMA regra, dentro da transação.
-- =====================================================================

create table fiscal.documents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  legal_entity_id uuid not null references core.legal_entities(id),
  direction text not null check (direction in ('IN', 'OUT')),
  model text not null check (model in ('55', '65')),
  series int,
  number int,
  access_key char(44),
  status text not null default 'DRAFT' check (status in (
    'DRAFT', 'PROCESSING', 'AUTHORIZED', 'REJECTED', 'DENIED', 'CANCELLED', 'NUMBER_VOIDED', 'CONTINGENCY_PENDING')),
  fin_nfe smallint not null default 1,                          -- 1 normal · 2 complementar · 3 ajuste · 4 devolução
  operation_nature text,
  cfop_main text,
  issue_at timestamptz,
  protocol text,
  sefaz_code text,
  sefaz_msg text,
  counterpart_party_id uuid references crm.parties(id),
  counterpart_cnpj text,
  counterpart_name text,
  totals jsonb not null default '{}',                           -- vProd, vDesc, vFrete, vSeg, vOutro, vIPI, vST, vNF...
  order_id uuid references sales.orders(id),
  return_id uuid,
  receipt_id uuid,
  transfer_id uuid,
  referenced_keys text[] not null default '{}',
  provider_ref text,
  xml text,
  xml_path text,
  danfe_path text,
  events jsonb not null default '[]',
  idempotency_key text,
  created_by uuid references core.members(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index documents_key_uq on fiscal.documents (org_id, access_key) where access_key is not null;
create unique index documents_idem_uq on fiscal.documents (org_id, idempotency_key) where idempotency_key is not null;
create index documents_entity_idx on fiscal.documents (legal_entity_id, direction, issue_at desc);
create index documents_order_idx on fiscal.documents (order_id) where order_id is not null;

create table fiscal.document_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  document_id uuid not null references fiscal.documents(id) on delete cascade,
  n_item int not null,
  variant_id uuid references catalog.variants(id),
  cprod text,
  cean text,
  xprod text,
  ncm text,
  cest text,
  cfop text,
  ucom text,
  qcom numeric(14,4),
  vuncom numeric(18,6),
  vprod numeric(14,2),
  vdesc numeric(14,2) not null default 0,
  vfrete numeric(14,2) not null default 0,
  vseg numeric(14,2) not null default 0,
  voutro numeric(14,2) not null default 0,
  vipi numeric(14,2) not null default 0,
  vicmsst numeric(14,2) not null default 0,
  csosn text,
  cst text,
  taxes jsonb not null default '{}',
  unique (document_id, n_item)
);

create table fiscal.document_installments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  document_id uuid not null references fiscal.documents(id) on delete cascade,
  n_dup text,
  due_date date not null,
  amount numeric(14,2) not null check (amount > 0)
);
create index on fiscal.document_installments (document_id);

-- Manifestação do destinatário (MDe): notas emitidas contra o CNPJ, descobertas pela SEFAZ/provedor
create table fiscal.inbound_dfe (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  legal_entity_id uuid not null references core.legal_entities(id),
  access_key char(44) not null,
  nsu text,
  issuer_cnpj text,
  issuer_name text,
  amount numeric(14,2),
  issue_at timestamptz,
  manifest_status text not null default 'PENDING'
    check (manifest_status in ('PENDING', 'CIENCIA', 'CONFIRMADA', 'DESCONHECIDA', 'NAO_REALIZADA')),
  xml_downloaded boolean not null default false,
  document_id uuid references fiscal.documents(id),
  created_at timestamptz not null default now(),
  unique (org_id, access_key)
);

create trigger trg_documents_updated before update on fiscal.documents
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------
-- Chave de acesso: 44 dígitos, DV módulo 11 (pesos 2..9 da direita para a esquerda)
-- ---------------------------------------------------------------------
create or replace function fiscal.nfe_key_dv(p_key43 text) returns int
language plpgsql stable set search_path = '' as $$
declare i int; w int := 2; s int := 0; r int;
begin
  if p_key43 !~ '^\d{43}$' then return null; end if;
  for i in reverse 43 .. 1 loop
    s := s + substr(p_key43, i, 1)::int * w;
    w := case when w = 9 then 2 else w + 1 end;
  end loop;
  r := 11 - (s % 11);
  return case when r >= 10 then 0 else r end;
end $$;

create or replace function fiscal.nfe_key_valid(p_key text) returns boolean
language sql immutable set search_path = '' as $$
  select p_key ~ '^\d{44}$' and fiscal.nfe_key_dv(left(p_key, 43)) = right(p_key, 1)::int
$$;

-- ---------------------------------------------------------------------
-- Leitura do XML da NF-e (nfeProc ou NFe). Devolve jsonb; NÃO grava nada.
-- Rejeita XML com DTD/ENTITY (as NF-e nunca têm), chave com DV inválido, modelo ≠ 55 e nota cancelada/denegada.
-- ---------------------------------------------------------------------
create or replace function fiscal.parse_nfe(p_xml text) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  x xml;
  h record;
  v_key text;
  v_items jsonb;
  v_dups jsonb;
  v_pays jsonb;
  v_sum numeric;
  v_warn jsonb := '[]';
  v_prot jsonb;
  v_ns constant text := 'http://www.portalfiscal.inf.br/nfe';
begin
  if p_xml is null or length(btrim(p_xml)) = 0 then raise exception 'XML vazio' using errcode = 'P0080'; end if;
  if p_xml ~* '<!\s*(doctype|entity)' then raise exception 'XML com DTD/ENTITY não é aceito' using errcode = 'P0080'; end if;
  begin
    x := xmlparse(document regexp_replace(p_xml, '^[\s\ufeff]+', ''));
  exception when others then
    raise exception 'Não foi possível ler o XML: %', sqlerrm using errcode = 'P0080';
  end;

  select * into h from xmltable(xmlnamespaces(v_ns as n), '//n:infNFe' passing x columns
    id text path '@Id',
    versao text path '@versao',
    cuf text path 'n:ide/n:cUF',
    nat_op text path 'n:ide/n:natOp',
    modelo text path 'n:ide/n:mod',
    serie text path 'n:ide/n:serie',
    nnf text path 'n:ide/n:nNF',
    dh_emi text path '(n:ide/n:dhEmi | n:ide/n:dEmi)[1]',
    tp_nf text path 'n:ide/n:tpNF',
    fin_nfe text path 'n:ide/n:finNFe',
    tp_amb text path 'n:ide/n:tpAmb',
    emit_cnpj text path 'n:emit/n:CNPJ',
    emit_cpf text path 'n:emit/n:CPF',
    emit_nome text path 'n:emit/n:xNome',
    emit_fant text path 'n:emit/n:xFant',
    emit_ie text path 'n:emit/n:IE',
    emit_crt text path 'n:emit/n:CRT',
    emit_uf text path 'n:emit/n:enderEmit/n:UF',
    emit_mun text path 'n:emit/n:enderEmit/n:xMun',
    dest_cnpj text path 'n:dest/n:CNPJ',
    dest_cpf text path 'n:dest/n:CPF',
    dest_nome text path 'n:dest/n:xNome',
    v_bc numeric path 'n:total/n:ICMSTot/n:vBC',
    v_icms numeric path 'n:total/n:ICMSTot/n:vICMS',
    v_bcst numeric path 'n:total/n:ICMSTot/n:vBCST',
    v_st numeric path 'n:total/n:ICMSTot/n:vST',
    v_prod numeric path 'n:total/n:ICMSTot/n:vProd',
    v_frete numeric path 'n:total/n:ICMSTot/n:vFrete',
    v_seg numeric path 'n:total/n:ICMSTot/n:vSeg',
    v_desc numeric path 'n:total/n:ICMSTot/n:vDesc',
    v_ipi numeric path 'n:total/n:ICMSTot/n:vIPI',
    v_outro numeric path 'n:total/n:ICMSTot/n:vOutro',
    v_nf numeric path 'n:total/n:ICMSTot/n:vNF',
    mod_frete text path 'n:transp/n:modFrete',
    inf_cpl text path 'n:infAdic/n:infCpl',
    ref_key text path '(n:ide/n:NFref/n:refNFe)[1]'
  );
  if h.id is null then
    raise exception 'XML não é uma NF-e (elemento infNFe não encontrado)' using errcode = 'P0080';
  end if;

  v_key := regexp_replace(h.id, '^NFe', '');
  if not fiscal.nfe_key_valid(v_key) then
    raise exception 'Chave de acesso inválida (%): dígito verificador não confere', v_key using errcode = 'P0080';
  end if;
  if h.modelo is distinct from '55' then
    raise exception 'Somente NF-e modelo 55 (recebido: %)', coalesce(h.modelo, '?') using errcode = 'P0080';
  end if;
  if h.emit_cnpj is null then
    raise exception 'Emitente sem CNPJ não é suportado' using errcode = 'P0080';
  end if;
  if h.v_nf is null then raise exception 'NF-e sem totais (vNF)' using errcode = 'P0080'; end if;

  -- protocolo de autorização (nfeProc)
  declare pr record;
  begin
    select * into pr from xmltable(xmlnamespaces(v_ns as n), '//n:protNFe/n:infProt' passing x columns
      ch text path 'n:chNFe', prot text path 'n:nProt', cstat text path 'n:cStat', motivo text path 'n:xMotivo', recbto text path 'n:dhRecbto');
    if pr.ch is null then
      v_warn := v_warn || to_jsonb('XML sem protocolo de autorização (protNFe): confirme a situação da nota no portal da SEFAZ'::text);
    else
      if pr.ch <> v_key then raise exception 'Protocolo pertence a outra chave (%)', pr.ch using errcode = 'P0080'; end if;
      v_prot := jsonb_build_object('number', pr.prot, 'cstat', pr.cstat, 'received_at', pr.recbto);
      if pr.cstat not in ('100', '150') then
        raise exception 'NF-e não autorizada (cStat %: %)', pr.cstat, coalesce(pr.motivo, '') using errcode = 'P0080';
      end if;
    end if;
    if h.tp_amb = '2' then
      v_warn := v_warn || to_jsonb('NF-e de HOMOLOGAÇÃO (sem valor fiscal)'::text);
    end if;

    select coalesce(jsonb_agg(jsonb_build_object(
      'n_item', d.n_item, 'cprod', d.cprod, 'cean', d.cean, 'xprod', d.xprod, 'ncm', d.ncm, 'cest', d.cest, 'cfop', d.cfop, 'ucom', d.ucom,
      'qcom', d.qcom, 'vuncom', d.vuncom, 'vprod', d.vprod, 'vdesc', coalesce(d.vdesc, 0), 'vfrete', coalesce(d.vfrete, 0),
      'vseg', coalesce(d.vseg, 0), 'voutro', coalesce(d.voutro, 0), 'vipi', coalesce(d.vipi, 0), 'vicmsst', coalesce(d.vicmsst, 0),
      'csosn', d.csosn, 'cst', d.cst, 'orig', d.orig, 'xped', d.xped) order by d.n_item), '[]')
    into v_items
    from xmltable(xmlnamespaces(v_ns as n), '//n:infNFe/n:det' passing x columns
      n_item int path '@nItem',
      cprod text path 'n:prod/n:cProd', cean text path 'n:prod/n:cEAN', xprod text path 'n:prod/n:xProd',
      ncm text path 'n:prod/n:NCM', cest text path 'n:prod/n:CEST', cfop text path 'n:prod/n:CFOP', ucom text path 'n:prod/n:uCom',
      qcom numeric path 'n:prod/n:qCom', vuncom numeric path 'n:prod/n:vUnCom', vprod numeric path 'n:prod/n:vProd',
      vdesc numeric path 'n:prod/n:vDesc', vfrete numeric path 'n:prod/n:vFrete', vseg numeric path 'n:prod/n:vSeg',
      voutro numeric path 'n:prod/n:vOutro', xped text path 'n:prod/n:xPed',
      vipi numeric path 'n:imposto/n:IPI/n:IPITrib/n:vIPI',
      vicmsst numeric path 'n:imposto/n:ICMS/*/n:vICMSST',
      csosn text path 'n:imposto/n:ICMS/*/n:CSOSN', cst text path 'n:imposto/n:ICMS/*/n:CST', orig text path 'n:imposto/n:ICMS/*/n:orig'
    ) d;
  end;
  if jsonb_array_length(v_items) = 0 then raise exception 'NF-e sem itens' using errcode = 'P0080'; end if;

  select coalesce(jsonb_agg(jsonb_build_object('n_dup', c.n_dup, 'due_date', c.d_venc, 'amount', c.v_dup) order by c.d_venc, c.n_dup), '[]')
  into v_dups
  from xmltable(xmlnamespaces(v_ns as n), '//n:infNFe/n:cobr/n:dup' passing x columns
    n_dup text path 'n:nDup', d_venc date path 'n:dVenc', v_dup numeric path 'n:vDup') c;

  select coalesce(jsonb_agg(jsonb_build_object('t_pag', p.t_pag, 'amount', p.v_pag)), '[]')
  into v_pays
  from xmltable(xmlnamespaces(v_ns as n), '//n:infNFe/n:pag/n:detPag' passing x columns
    t_pag text path 'n:tPag', v_pag numeric path 'n:vPag') p;

  select coalesce(sum((i ->> 'vprod')::numeric - (i ->> 'vdesc')::numeric + (i ->> 'vfrete')::numeric + (i ->> 'vseg')::numeric
                      + (i ->> 'voutro')::numeric + (i ->> 'vipi')::numeric + (i ->> 'vicmsst')::numeric), 0)
  into v_sum from jsonb_array_elements(v_items) i;
  if abs(coalesce(h.v_prod, 0) - coalesce(h.v_desc, 0) + coalesce(h.v_frete, 0) + coalesce(h.v_seg, 0) + coalesce(h.v_outro, 0)
         + coalesce(h.v_ipi, 0) + coalesce(h.v_st, 0) - h.v_nf) > 0.05 then
    v_warn := v_warn || to_jsonb('Os totais da nota não fecham (produtos − desconto + frete + seguro + outras + IPI + ST ≠ valor da nota)'::text);
  end if;
  if (select coalesce(sum((d ->> 'amount')::numeric), 0) from jsonb_array_elements(v_dups) d) not in (0, h.v_nf) then
    v_warn := v_warn || to_jsonb('A soma das duplicatas difere do total da nota'::text);
  end if;

  return jsonb_build_object(
    'access_key', v_key, 'version', h.versao,
    'header', jsonb_build_object('series', nullif(h.serie, '')::int, 'number', nullif(h.nnf, '')::int, 'issue_at', h.dh_emi,
      'operation_nature', h.nat_op, 'fin_nfe', coalesce(nullif(h.fin_nfe, '')::int, 1), 'tp_nf', h.tp_nf, 'tp_amb', h.tp_amb,
      'mod_frete', h.mod_frete, 'info', h.inf_cpl, 'referenced_key', h.ref_key),
    'issuer', jsonb_build_object('cnpj', h.emit_cnpj, 'name', h.emit_nome, 'fantasy', h.emit_fant, 'ie', h.emit_ie, 'crt', h.emit_crt,
      'uf', h.emit_uf, 'city', h.emit_mun),
    'recipient', jsonb_build_object('cnpj', h.dest_cnpj, 'cpf', h.dest_cpf, 'name', h.dest_nome),
    'totals', jsonb_build_object('vBC', h.v_bc, 'vICMS', h.v_icms, 'vBCST', h.v_bcst, 'vST', h.v_st, 'vProd', h.v_prod,
      'vFrete', coalesce(h.v_frete, 0), 'vSeg', coalesce(h.v_seg, 0), 'vDesc', coalesce(h.v_desc, 0), 'vIPI', coalesce(h.v_ipi, 0),
      'vOutro', coalesce(h.v_outro, 0), 'vNF', h.v_nf),
    'protocol', v_prot, 'items', v_items, 'installments', v_dups, 'payments', v_pays, 'items_sum', v_sum, 'warnings', v_warn);
end $$;

grant execute on function fiscal.parse_nfe(text), fiscal.nfe_key_valid(text), fiscal.nfe_key_dv(text) to authenticated, service_role;

select private.apply_rls('fiscal', array['documents', 'document_items', 'document_installments', 'inbound_dfe'], 'fiscal.read', 'fiscal.write');
select private.rpc_only('fiscal', array['documents', 'document_items', 'document_installments']);
