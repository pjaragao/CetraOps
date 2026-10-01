-- =====================================================================
-- purch: compras — pedidos ao fornecedor, recebimento por NF-e (XML) com conferência de grade,
-- custo de aquisição rateado (frete/seguro/IPI/ST), contas a pagar pelas duplicatas, divergências como crédito
-- com o fornecedor, contabilização (estoque × fornecedores) e sugestão de reposição por tamanho.
-- =====================================================================

select private.init_schema('purch');

create table purch.payment_terms (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  name text not null,
  installments jsonb not null default '[{"days":30,"pct":100}]',   -- [{days, pct}] contados da emissão da nota
  active boolean not null default true,
  unique (org_id, name)
);

create table purch.purchase_orders (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  legal_entity_id uuid not null references core.legal_entities(id),
  location_id uuid not null references inv.locations(id),
  store_id uuid references core.stores(id),
  supplier_party_id uuid not null references crm.parties(id),
  number text not null,
  status text not null default 'DRAFT' check (status in ('DRAFT', 'APPROVED', 'PARTIAL', 'RECEIVED', 'CANCELLED')),
  expected_date date,
  payment_terms_id uuid references purch.payment_terms(id),
  collection_id uuid references catalog.collections(id),
  notes text,
  total numeric(14,2) not null default 0,
  approved_by uuid references core.members(id),
  approved_at timestamptz,
  cancelled_reason text,
  created_by uuid references core.members(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, number)
);
create index on purch.purchase_orders (org_id, status);
create index on purch.purchase_orders (supplier_party_id);

create table purch.po_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  po_id uuid not null references purch.purchase_orders(id) on delete cascade,
  variant_id uuid not null references catalog.variants(id),
  qty_ordered numeric(12,3) not null check (qty_ordered > 0),
  unit_cost numeric(14,4) not null check (unit_cost >= 0),
  qty_received numeric(12,3) not null default 0 check (qty_received >= 0),
  unique (po_id, variant_id)
);
create index on purch.po_items (variant_id);

create table purch.receipts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  legal_entity_id uuid not null references core.legal_entities(id),
  location_id uuid not null references inv.locations(id),
  store_id uuid references core.stores(id),
  supplier_party_id uuid not null references crm.parties(id),
  document_id uuid references fiscal.documents(id),
  po_id uuid references purch.purchase_orders(id),
  number text not null,
  status text not null default 'PENDING_CHECK' check (status in ('PENDING_CHECK', 'CHECKED', 'POSTED')),
  nf_total numeric(14,2) not null,
  landed_total numeric(14,2),
  shortage_total numeric(14,2) not null default 0,
  title_id uuid references fin.titles(id),
  entry_id uuid,
  credit_id uuid references fin.party_credits(id),
  post_ref uuid,                                   -- origem do lançamento contábil (muda a cada lançamento, permite refazer após estorno)
  notes text,
  checked_by uuid references core.members(id),
  checked_at timestamptz,
  posted_by uuid references core.members(id),
  posted_at timestamptz,
  created_by uuid references core.members(id),
  created_at timestamptz not null default now(),
  unique (org_id, number)
);
create index on purch.receipts (org_id, status);
create index on purch.receipts (supplier_party_id);
create unique index receipts_document_uq on purch.receipts (document_id) where document_id is not null;

create table purch.receipt_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  receipt_id uuid not null references purch.receipts(id) on delete cascade,
  n_item int not null,
  supplier_cprod text,
  cean text,
  description text,
  ncm text,
  cfop text,
  unit text,
  qty_nfe numeric(12,3) not null check (qty_nfe > 0),
  qty_counted numeric(12,3) check (qty_counted >= 0),
  unit_cost_nfe numeric(18,6),
  item_total numeric(14,2) not null,               -- produtos − desconto + frete + seguro + outras + IPI + ST (+ rateio do que só veio no cabeçalho)
  landed_unit_cost numeric(14,4),
  variant_id uuid references catalog.variants(id),
  match_status text not null default 'UNMATCHED'
    check (match_status in ('EXACT_EAN', 'LEARNED', 'SUGGESTED', 'MANUAL', 'UNMATCHED')),
  match_confidence numeric(4,3),
  movement_id bigint references inv.movements(id),
  unique (receipt_id, n_item)
);
create index on purch.receipt_items (variant_id);

create trigger trg_po_updated before update on purch.purchase_orders
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------
-- Utilitários
-- ---------------------------------------------------------------------
create or replace function private.regex_escape(t text) returns text
language sql immutable set search_path = '' as $$
  select regexp_replace(coalesce(t, ''), '([\\^$.|?*+(){}\[\]-])', '\\\1', 'g')
$$;

create or replace function private.valid_cnpj(p text) returns boolean
language plpgsql immutable set search_path = '' as $$
declare d text := regexp_replace(coalesce(p, ''), '\D', '', 'g'); w1 int[] := array[5,4,3,2,9,8,7,6,5,4,3,2]; w2 int[] := array[6,5,4,3,2,9,8,7,6,5,4,3,2];
        s int; i int; r int;
begin
  if length(d) <> 14 or d ~ '^(\d)\1{13}$' then return false; end if;
  s := 0; for i in 1 .. 12 loop s := s + substr(d, i, 1)::int * w1[i]; end loop;
  r := s % 11; r := case when r < 2 then 0 else 11 - r end;
  if r <> substr(d, 13, 1)::int then return false; end if;
  s := 0; for i in 1 .. 13 loop s := s + substr(d, i, 1)::int * w2[i]; end loop;
  r := s % 11; r := case when r < 2 then 0 else 11 - r end;
  return r = substr(d, 14, 1)::int;
end $$;

-- Cadastra (ou reaproveita) um fornecedor pelo CNPJ: cadastro único, papel SUPPLIER
create or replace function purch.ensure_supplier(p_cnpj text, p_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); v_cnpj text := regexp_replace(coalesce(p_cnpj, ''), '\D', '', 'g'); v_id uuid;
begin
  perform private.require_perm('purch.write');
  if not private.valid_cnpj(v_cnpj) then raise exception 'CNPJ inválido' using errcode = 'P0087'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'Informe o nome do fornecedor' using errcode = 'P0087'; end if;
  select id into v_id from crm.parties where org_id = v_org and cnpj = v_cnpj;
  if v_id is null then
    insert into crm.parties (org_id, kind, display_name, legal_name, cnpj, source)
    values (v_org, 'COMPANY', trim(p_name), trim(p_name), v_cnpj, 'MANUAL') returning id into v_id;
  end if;
  insert into crm.party_roles (party_id, org_id, role) values (v_id, v_org, 'SUPPLIER') on conflict do nothing;
  return v_id;
end $$;

-- Casamento item da NF-e → variante: EAN exato → aprendizado do fornecedor → SKU → referência + tamanho (+ cor)
create or replace function private.nfe_match(p_org uuid, p_supplier uuid, p_cprod text, p_cean text, p_xprod text)
returns table (o_variant uuid, o_status text, o_conf numeric)
language plpgsql stable security definer set search_path = '' as $$
declare
  v uuid; v_txt text; v_prod uuid; v_size text; v_cands uuid[]; v_hits uuid[];
begin
  if coalesce(p_cean, '') ~ '^\d{8,14}$' and p_cean !~ '^0+$' then
    select x.id into v from catalog.variants x where x.org_id = p_org and x.gtin = p_cean and x.active limit 1;
    if v is not null then o_variant := v; o_status := 'EXACT_EAN'; o_conf := 1; return next; return; end if;
  end if;

  select si.variant_id into v from catalog.supplier_items si join catalog.variants x on x.id = si.variant_id and x.active
  where si.org_id = p_org and si.supplier_party_id = p_supplier and si.supplier_cprod = p_cprod limit 1;
  if v is not null then o_variant := v; o_status := 'LEARNED'; o_conf := 0.95; return next; return; end if;

  select x.id into v from catalog.variants x
  where x.org_id = p_org and x.active and p_cprod is not null and (upper(x.sku) = upper(p_cprod) or upper(coalesce(x.supplier_sku, '')) = upper(p_cprod)) limit 1;
  if v is not null then o_variant := v; o_status := 'SUGGESTED'; o_conf := 0.9; return next; return; end if;

  v_txt := upper(private.norm(coalesce(p_cprod, '') || ' ' || coalesce(p_xprod, '')));
  select p.id into v_prod from catalog.products p
  where p.org_id = p_org and p.status <> 'DISCONTINUED'
    and v_txt ~ ('(^|[^A-Z0-9])' || private.regex_escape(upper(p.reference_code)) || '([^A-Z0-9]|$)')
  order by length(p.reference_code) desc limit 1;

  if v_prod is not null then
    select t.m[1] into v_size
    from regexp_matches(v_txt, '(?:^|[^A-Z0-9])(XXG|XG|GG|PP|P|M|G|UNICO|U|3[4-9]|4[0-8])(?=$|[^A-Z0-9])', 'g') with ordinality as t(m, n)
    order by t.n desc limit 1;
    if v_size is not null then
      select array_agg(x.id) into v_cands from catalog.variants x
      where x.product_id = v_prod and x.active and upper(x.size) = case v_size when 'UNICO' then 'U' else v_size end;
      if v_cands is not null then
        select array_agg(x.id) into v_hits from catalog.variants x join catalog.colors c on c.id = x.color_id
        where x.id = any (v_cands) and position(upper(private.norm(c.name)) in v_txt) > 0;
        if coalesce(array_length(v_hits, 1), 0) = 1 then
          o_variant := v_hits[1]; o_status := 'SUGGESTED'; o_conf := 0.85; return next; return;
        elsif array_length(v_cands, 1) = 1 then
          o_variant := v_cands[1]; o_status := 'SUGGESTED'; o_conf := 0.70; return next; return;
        end if;
      end if;
    end if;
  end if;

  o_variant := null; o_status := 'UNMATCHED'; o_conf := null; return next;
end $$;

-- ---------------------------------------------------------------------
-- Importação da NF-e recebida (XML) → documento fiscal de entrada + recebimento pendente de conferência
-- ---------------------------------------------------------------------
create or replace function purch.import_nfe(p_xml text, p_location uuid, p_po uuid default null) returns purch.receipts
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id();
  v_actor uuid := private.member_id();
  j jsonb; loc inv.locations; ent core.legal_entities; po purch.purchase_orders; doc fiscal.documents; rc purch.receipts;
  v_supplier uuid; v_supplier_cnpj text; v_dest text; it jsonb; m record;
  v_base numeric; v_items_sum numeric; v_nf numeric; v_diff numeric; v_alloc numeric := 0; v_share numeric; v_total numeric; v_dup_number text;
  v_homolog boolean;
begin
  perform private.require_perm('purch.write');
  if v_org is null then raise exception 'Sem organização no token' using errcode = '42501'; end if;
  select * into loc from inv.locations where id = p_location and org_id = v_org;
  if loc.id is null then raise exception 'Local de recebimento inválido'; end if;
  if loc.store_id is not null and coalesce(auth.role(), '') = 'authenticated' and not private.can_store(loc.store_id) then
    raise exception 'Sem acesso à loja do local de recebimento' using errcode = '42501';
  end if;

  j := fiscal.parse_nfe(p_xml);

  v_dest := regexp_replace(coalesce(j #>> '{recipient,cnpj}', ''), '\D', '', 'g');
  select * into ent from core.legal_entities where org_id = v_org and cnpj = v_dest;
  if ent.id is null then
    raise exception 'A NF-e é destinada ao CNPJ %, que não está cadastrado em Configurações › Empresas',
      coalesce(nullif(v_dest, ''), '(destinatário sem CNPJ)') using errcode = 'P0082';
  end if;
  if ent.id <> loc.legal_entity_id then
    raise exception 'O local de recebimento pertence a outro CNPJ: esta nota é de %', ent.razao_social using errcode = 'P0082';
  end if;
  v_supplier_cnpj := j #>> '{issuer,cnpj}';
  if exists (select 1 from core.legal_entities where org_id = v_org and cnpj = v_supplier_cnpj) then
    raise exception 'A nota foi emitida pela própria empresa (transferência ou saída): use o fluxo de transferência' using errcode = 'P0082';
  end if;
  select coalesce(value = 'true'::jsonb, false) into v_homolog from core.settings where org_id = v_org and key = 'fiscal.accept_homolog';
  if (j #>> '{header,tp_amb}') = '2' and not coalesce(v_homolog, false) then
    raise exception 'NF-e de homologação (sem valor fiscal) não pode ser recebida' using errcode = 'P0082';
  end if;

  select * into doc from fiscal.documents where org_id = v_org and access_key = (j ->> 'access_key');
  if doc.id is not null then
    select number into v_dup_number from purch.receipts where document_id = doc.id;
    raise exception 'NF-e % já foi importada%', j ->> 'access_key', coalesce(' (recebimento ' || v_dup_number || ')', '') using errcode = 'P0081';
  end if;

  -- fornecedor: cadastro único, papel SUPPLIER
  select id into v_supplier from crm.parties where org_id = v_org and cnpj = v_supplier_cnpj;
  if v_supplier is null then
    insert into crm.parties (org_id, kind, display_name, legal_name, cnpj, city, uf, source)
    values (v_org, 'COMPANY', coalesce(nullif(j #>> '{issuer,fantasy}', ''), j #>> '{issuer,name}'), j #>> '{issuer,name}', v_supplier_cnpj,
            j #>> '{issuer,city}', nullif(j #>> '{issuer,uf}', '')::char(2), 'NFE_IMPORT')
    returning id into v_supplier;
  end if;
  insert into crm.party_roles (party_id, org_id, role) values (v_supplier, v_org, 'SUPPLIER') on conflict do nothing;

  if p_po is not null then
    select * into po from purch.purchase_orders where id = p_po and org_id = v_org;
    if po.id is null or po.status not in ('APPROVED', 'PARTIAL') then raise exception 'Pedido de compra inválido ou não aprovado' using errcode = 'P0082'; end if;
    if po.supplier_party_id <> v_supplier then raise exception 'O pedido de compra é de outro fornecedor' using errcode = 'P0082'; end if;
    if po.legal_entity_id <> ent.id then raise exception 'O pedido de compra é de outro CNPJ' using errcode = 'P0082'; end if;
  end if;

  insert into fiscal.documents (org_id, legal_entity_id, direction, model, series, number, access_key, status, fin_nfe, operation_nature, cfop_main,
                                issue_at, protocol, sefaz_code, counterpart_party_id, counterpart_cnpj, counterpart_name, totals,
                                referenced_keys, xml, created_by)
  values (v_org, ent.id, 'IN', '55', (j #>> '{header,series}')::int, (j #>> '{header,number}')::int, j ->> 'access_key', 'AUTHORIZED',
          coalesce((j #>> '{header,fin_nfe}')::int, 1), j #>> '{header,operation_nature}',
          (select i ->> 'cfop' from jsonb_array_elements(j -> 'items') i group by i ->> 'cfop' order by count(*) desc, i ->> 'cfop' limit 1),
          (j #>> '{header,issue_at}')::timestamptz, j #>> '{protocol,number}', j #>> '{protocol,cstat}', v_supplier, v_supplier_cnpj,
          j #>> '{issuer,name}', j -> 'totals',
          case when coalesce(j #>> '{header,referenced_key}', '') <> '' then array[j #>> '{header,referenced_key}'] else '{}'::text[] end,
          p_xml, v_actor)
  returning * into doc;

  insert into fiscal.document_installments (org_id, document_id, n_dup, due_date, amount)
  select v_org, doc.id, d ->> 'n_dup', (d ->> 'due_date')::date, (d ->> 'amount')::numeric
  from jsonb_array_elements(j -> 'installments') d where (d ->> 'amount')::numeric > 0;

  v_nf := (j #>> '{totals,vNF}')::numeric;
  select coalesce(sum((i ->> 'vprod')::numeric - (i ->> 'vdesc')::numeric + (i ->> 'vfrete')::numeric + (i ->> 'vseg')::numeric
                      + (i ->> 'voutro')::numeric + (i ->> 'vipi')::numeric + (i ->> 'vicmsst')::numeric), 0)
  into v_items_sum from jsonb_array_elements(j -> 'items') i;
  v_diff := v_nf - v_items_sum;

  insert into purch.receipts (org_id, legal_entity_id, location_id, store_id, supplier_party_id, document_id, po_id, number, nf_total, created_by)
  values (v_org, ent.id, loc.id, loc.store_id, v_supplier, doc.id, p_po, core.next_number(v_org, 'RCB'), v_nf, v_actor)
  returning * into rc;
  update fiscal.documents set receipt_id = rc.id where id = doc.id;

  for it in select * from jsonb_array_elements(j -> 'items') loop
    v_base := (it ->> 'vprod')::numeric - (it ->> 'vdesc')::numeric + (it ->> 'vfrete')::numeric + (it ->> 'vseg')::numeric
              + (it ->> 'voutro')::numeric + (it ->> 'vipi')::numeric + (it ->> 'vicmsst')::numeric;
    v_share := case when v_items_sum > 0 then round(v_diff * v_base / v_items_sum, 2) else 0 end;
    v_alloc := v_alloc + v_share;
    v_total := v_base + v_share;

    insert into fiscal.document_items (org_id, document_id, n_item, cprod, cean, xprod, ncm, cest, cfop, ucom, qcom, vuncom, vprod,
                                       vdesc, vfrete, vseg, voutro, vipi, vicmsst, csosn, cst, taxes)
    values (v_org, doc.id, (it ->> 'n_item')::int, it ->> 'cprod', it ->> 'cean', it ->> 'xprod', it ->> 'ncm', it ->> 'cest', it ->> 'cfop',
            it ->> 'ucom', (it ->> 'qcom')::numeric, (it ->> 'vuncom')::numeric, (it ->> 'vprod')::numeric, (it ->> 'vdesc')::numeric,
            (it ->> 'vfrete')::numeric, (it ->> 'vseg')::numeric, (it ->> 'voutro')::numeric, (it ->> 'vipi')::numeric, (it ->> 'vicmsst')::numeric,
            it ->> 'csosn', it ->> 'cst', jsonb_build_object('orig', it ->> 'orig'));

    select * into m from private.nfe_match(v_org, v_supplier, it ->> 'cprod', it ->> 'cean', it ->> 'xprod');
    insert into purch.receipt_items (org_id, receipt_id, n_item, supplier_cprod, cean, description, ncm, cfop, unit, qty_nfe, unit_cost_nfe,
                                     item_total, variant_id, match_status, match_confidence)
    values (v_org, rc.id, (it ->> 'n_item')::int, it ->> 'cprod', it ->> 'cean', it ->> 'xprod', it ->> 'ncm', it ->> 'cfop', it ->> 'ucom',
            (it ->> 'qcom')::numeric, (it ->> 'vuncom')::numeric, v_total, m.o_variant, m.o_status, m.o_conf);
  end loop;

  -- centavos do rateio vão para o item de maior valor
  if v_diff <> v_alloc then
    update purch.receipt_items set item_total = item_total + (v_diff - v_alloc)
    where id = (select id from purch.receipt_items where receipt_id = rc.id order by item_total desc, n_item limit 1);
  end if;
  update purch.receipt_items set landed_unit_cost = round(item_total / qty_nfe, 4) where receipt_id = rc.id;
  update fiscal.document_items di set variant_id = ri.variant_id
  from purch.receipt_items ri where ri.receipt_id = rc.id and di.document_id = doc.id and di.n_item = ri.n_item;

  select * into rc from purch.receipts where id = rc.id;
  return rc;
end $$;

-- ---------------------------------------------------------------------
-- Conferência: vincular variante, contar, confirmar sugestões
-- ---------------------------------------------------------------------
create or replace function purch.set_receipt_item(p_item uuid, p jsonb) returns purch.receipt_items
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id();
  ri purch.receipt_items; rc purch.receipts; v_var uuid; v_qty numeric;
begin
  perform private.require_perm('purch.write');
  select * into ri from purch.receipt_items where id = p_item and org_id = v_org for update;
  if ri.id is null then raise exception 'Item não encontrado'; end if;
  select * into rc from purch.receipts where id = ri.receipt_id;
  if rc.status = 'POSTED' then raise exception 'Recebimento já lançado no estoque' using errcode = 'P0083'; end if;
  if rc.status = 'CHECKED' then update purch.receipts set status = 'PENDING_CHECK', checked_by = null, checked_at = null where id = rc.id; end if;

  if p ? 'variant_id' then
    v_var := nullif(p ->> 'variant_id', '')::uuid;
    if v_var is not null and not exists (select 1 from catalog.variants where id = v_var and org_id = v_org and active) then
      raise exception 'Variante inválida ou inativa';
    end if;
    update purch.receipt_items set variant_id = v_var, match_status = case when v_var is null then 'UNMATCHED' else 'MANUAL' end,
           match_confidence = null where id = ri.id;
    if v_var is not null and coalesce((p ->> 'learn')::boolean, true) then
      -- aprende o par (cProd do fornecedor → SKU) e o EAN, se ainda livre
      insert into catalog.supplier_items (org_id, supplier_party_id, supplier_cprod, supplier_ean, supplier_desc, variant_id, confirmed_by)
      values (v_org, rc.supplier_party_id, ri.supplier_cprod, ri.cean, ri.description, v_var, private.member_id())
      on conflict (org_id, supplier_party_id, supplier_cprod) do update set variant_id = excluded.variant_id,
        supplier_ean = excluded.supplier_ean, supplier_desc = excluded.supplier_desc, confirmed_by = excluded.confirmed_by;
      if coalesce(ri.cean, '') ~ '^\d{8,14}$' and ri.cean !~ '^0+$' then
        update catalog.variants set gtin = ri.cean
        where id = v_var and gtin is null and not exists (select 1 from catalog.variants o where o.org_id = v_org and o.gtin = ri.cean);
      end if;
    end if;
  end if;

  if p ? 'qty_counted' then
    v_qty := nullif(p ->> 'qty_counted', '')::numeric;
    if v_qty is not null and (v_qty < 0 or v_qty > ri.qty_nfe) then
      raise exception 'Quantidade contada (%) deve ficar entre 0 e a quantidade da nota (%). Sobras: peça nota complementar ao fornecedor.', v_qty, ri.qty_nfe using errcode = 'P0085';
    end if;
    update purch.receipt_items set qty_counted = v_qty where id = ri.id;
  end if;
  select * into ri from purch.receipt_items where id = p_item;
  return ri;
end $$;

-- Confirma de uma vez as sugestões automáticas (e aprende os pares)
create or replace function purch.accept_suggestions(p_receipt uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare r record; n int := 0;
begin
  perform private.require_perm('purch.write');
  for r in select id, variant_id from purch.receipt_items
           where receipt_id = p_receipt and org_id = private.org_id() and match_status = 'SUGGESTED' and variant_id is not null loop
    perform purch.set_receipt_item(r.id, jsonb_build_object('variant_id', r.variant_id, 'learn', true));
    n := n + 1;
  end loop;
  return n;
end $$;

-- Iguala a contagem à nota nos itens ainda não contados (conferência sem divergência)
create or replace function purch.count_all(p_receipt uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare rc purch.receipts; n int;
begin
  perform private.require_perm('purch.write');
  select * into rc from purch.receipts where id = p_receipt and org_id = private.org_id() for update;
  if rc.id is null then raise exception 'Recebimento não encontrado'; end if;
  if rc.status = 'POSTED' then raise exception 'Recebimento já lançado no estoque' using errcode = 'P0083'; end if;
  update purch.receipt_items set qty_counted = qty_nfe where receipt_id = rc.id and qty_counted is null;
  get diagnostics n = row_count;
  if n > 0 and rc.status = 'CHECKED' then update purch.receipts set status = 'PENDING_CHECK', checked_by = null, checked_at = null where id = rc.id; end if;
  return n;
end $$;

create or replace function purch.confirm_receipt(p_receipt uuid) returns purch.receipts
language plpgsql security definer set search_path = '' as $$
declare rc purch.receipts; v_pending int; v_sugg int; v_uncounted int;
begin
  perform private.require_perm('purch.write');
  select * into rc from purch.receipts where id = p_receipt and org_id = private.org_id() for update;
  if rc.id is null then raise exception 'Recebimento não encontrado'; end if;
  if rc.status = 'POSTED' then raise exception 'Recebimento já lançado no estoque' using errcode = 'P0083'; end if;
  select count(*) filter (where variant_id is null), count(*) filter (where match_status = 'SUGGESTED'), count(*) filter (where qty_counted is null)
  into v_pending, v_sugg, v_uncounted from purch.receipt_items where receipt_id = rc.id;
  if v_pending > 0 then raise exception '% item(ns) sem produto vinculado', v_pending using errcode = 'P0083'; end if;
  if v_sugg > 0 then raise exception '% sugestão(ões) de vínculo ainda não confirmada(s)', v_sugg using errcode = 'P0083'; end if;
  if v_uncounted > 0 then raise exception '% item(ns) sem quantidade contada', v_uncounted using errcode = 'P0083'; end if;
  update purch.receipts set status = 'CHECKED', checked_by = private.member_id(), checked_at = now() where id = rc.id returning * into rc;
  return rc;
end $$;

-- ---------------------------------------------------------------------
-- Lançamento: estoque (custo de aquisição), contas a pagar, contabilidade, crédito de faltas, pedido de compra
-- p_installments = [{due_date, amount}] opcional (senão: duplicatas da nota → condição do pedido → 30 dias)
-- ---------------------------------------------------------------------
create or replace function purch.post_receipt(p_receipt uuid, p_installments jsonb default null) returns purch.receipts
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id();
  v_actor uuid := private.member_id();
  rc purch.receipts; doc fiscal.documents; r record; po purch.purchase_orders; terms jsonb;
  v_stock numeric; v_short numeric; v_resid numeric; v_mv bigint; v_lines jsonb; v_entry uuid; v_credit uuid;
  v_inst jsonb; v_sum numeric; v_n int; v_title fin.titles; v_issue date; v_ref uuid := gen_random_uuid(); v_left numeric; v_amt numeric; t jsonb; i int := 0;
begin
  perform private.require_perm('purch.approve');
  select * into rc from purch.receipts where id = p_receipt and org_id = v_org for update;
  if rc.id is null then raise exception 'Recebimento não encontrado'; end if;
  if rc.status <> 'CHECKED' then raise exception 'Confirme a conferência antes de lançar no estoque (situação: %)', rc.status using errcode = 'P0083'; end if;
  select * into doc from fiscal.documents where id = rc.document_id;
  perform private.assert_period_open(rc.legal_entity_id, private.today_sp());
  v_issue := (doc.issue_at at time zone 'America/Sao_Paulo')::date;

  -- vencimentos (validados antes de mexer no estoque)
  v_inst := p_installments;
  if v_inst is null or jsonb_array_length(v_inst) = 0 then
    select jsonb_agg(jsonb_build_object('due_date', due_date, 'amount', amount) order by due_date, n_dup) into v_inst
    from fiscal.document_installments where document_id = doc.id;
  end if;
  if v_inst is null or jsonb_array_length(v_inst) = 0 then
    if rc.po_id is not null then
      select t2.installments into terms from purch.purchase_orders p join purch.payment_terms t2 on t2.id = p.payment_terms_id where p.id = rc.po_id;
    end if;
    if terms is not null then
      v_inst := '[]'; v_left := rc.nf_total; v_n := jsonb_array_length(terms);
      for t in select * from jsonb_array_elements(terms) loop
        i := i + 1;
        v_amt := case when i = v_n then v_left else round(rc.nf_total * (t ->> 'pct')::numeric / 100, 2) end;
        v_left := v_left - v_amt;
        v_inst := v_inst || jsonb_build_object('due_date', v_issue + (t ->> 'days')::int, 'amount', v_amt);
      end loop;
    else
      v_inst := jsonb_build_array(jsonb_build_object('due_date', v_issue + 30, 'amount', rc.nf_total));
    end if;
  end if;
  select coalesce(sum(round((x ->> 'amount')::numeric, 2)), 0) into v_sum from jsonb_array_elements(v_inst) x;
  if v_sum <> rc.nf_total then
    if abs(v_sum - rc.nf_total) <= 1 then
      -- pequenas diferenças de centavos vão para a última parcela
      select jsonb_agg(case when x.n = jsonb_array_length(v_inst)
                            then jsonb_set(x.e, '{amount}', to_jsonb(round((x.e ->> 'amount')::numeric, 2) + (rc.nf_total - v_sum))) else x.e end order by x.n)
      into v_inst from jsonb_array_elements(v_inst) with ordinality as x(e, n);
    else
      raise exception 'Os vencimentos somam % e a nota % — ajuste as parcelas', v_sum, rc.nf_total using errcode = 'P0084';
    end if;
  end if;

  -- estoque
  for r in select * from purch.receipt_items where receipt_id = rc.id order by n_item loop
    if r.variant_id is null or r.qty_counted is null then raise exception 'Item % sem produto ou sem contagem', r.n_item using errcode = 'P0083'; end if;
    if r.qty_counted > 0 then
      insert into inv.movements (org_id, occurred_at, variant_id, location_id, qty, unit_cost, movement_type, source_type, source_id, source_line_id, notes, created_by)
      values (v_org, now(), r.variant_id, rc.location_id, r.qty_counted, r.landed_unit_cost, 'PURCHASE_RECEIPT', 'purch.receipts', rc.id, r.id,
              'NF-e ' || doc.number || '/' || doc.series, v_actor)
      returning id into v_mv;
      update purch.receipt_items set movement_id = v_mv where id = r.id;
    end if;
  end loop;

  select coalesce(sum(m.total_cost), 0) into v_stock from inv.movements m
  where m.id in (select movement_id from purch.receipt_items where receipt_id = rc.id and movement_id is not null);
  select coalesce(sum(round(item_total * (qty_nfe - qty_counted) / qty_nfe, 2)), 0) into v_short
  from purch.receipt_items where receipt_id = rc.id and qty_counted < qty_nfe;
  v_resid := rc.nf_total - v_stock - v_short;
  if abs(v_resid) > 0.5 then raise exception 'Diferença de arredondamento inesperada (%)', v_resid using errcode = 'P0084'; end if;

  -- contabilidade: estoque (+ crédito de faltas) × fornecedores
  v_lines := jsonb_build_array(
    jsonb_build_object('role', 'INVENTORY', 'debit', v_stock, 'party_id', rc.supplier_party_id, 'memo', 'Mercadorias — NF-e ' || doc.number),
    jsonb_build_object('role', 'SUPPLIERS', 'credit', rc.nf_total, 'party_id', rc.supplier_party_id, 'memo', 'NF-e ' || doc.number || '/' || doc.series));
  if v_short > 0 then
    v_lines := v_lines || jsonb_build_object('role', 'ADVANCE_SUPPLIERS', 'debit', v_short, 'party_id', rc.supplier_party_id, 'memo', 'Falta na conferência');
  end if;
  if v_resid > 0 then v_lines := v_lines || jsonb_build_object('role', 'RECON_DIFFERENCE', 'debit', v_resid, 'memo', 'Arredondamento do custo');
  elsif v_resid < 0 then v_lines := v_lines || jsonb_build_object('role', 'RECON_DIFFERENCE', 'credit', -v_resid, 'memo', 'Arredondamento do custo'); end if;
  v_entry := private.post_entry(rc.legal_entity_id, private.today_sp(), 'PURCHASE_RECEIPT', 'purch.receipts', v_ref,
    format('Recebimento %s — NF-e %s', rc.number, doc.number), v_lines);

  -- contas a pagar (duplicatas da nota) — a contabilização é a do recebimento (EXTERNAL)
  v_title := private.insert_title(jsonb_build_object(
    'direction', 'PAYABLE', 'legal_entity_id', rc.legal_entity_id, 'store_id', rc.store_id, 'party_id', rc.supplier_party_id,
    'description', format('NF-e %s — %s', doc.number, doc.counterpart_name), 'document_kind', 'NFE',
    'document_number', doc.number || '/' || doc.series, 'issue_date', v_issue, 'competence_date', private.today_sp(),
    'installments', v_inst, 'origin_type', 'PURCHASE_RECEIPT', 'origin_id', rc.id, 'accrual_mode', 'EXTERNAL',
    'approval_status', 'APPROVED', 'tags', jsonb_build_array('compra')), v_actor);
  update fin.titles set accrual_entry_id = v_entry where id = v_title.id;

  if v_short > 0 then
    insert into fin.party_credits (org_id, legal_entity_id, party_id, direction, amount, memo)
    values (v_org, rc.legal_entity_id, rc.supplier_party_id, 'PAYABLE', v_short,
            format('Falta na conferência do recebimento %s (NF-e %s)', rc.number, doc.number))
    returning id into v_credit;
  end if;

  if rc.po_id is not null then
    for r in select variant_id, qty_counted from purch.receipt_items where receipt_id = rc.id and qty_counted > 0 loop
      update purch.po_items set qty_received = qty_received + r.qty_counted where po_id = rc.po_id and variant_id = r.variant_id;
    end loop;
    update purch.purchase_orders set status = case when exists (select 1 from purch.po_items where po_id = rc.po_id and qty_received < qty_ordered)
                                                   then 'PARTIAL' else 'RECEIVED' end where id = rc.po_id;
  end if;

  update purch.receipts set status = 'POSTED', landed_total = v_stock, shortage_total = v_short, title_id = v_title.id, entry_id = v_entry,
         credit_id = v_credit, post_ref = v_ref, posted_by = v_actor, posted_at = now() where id = rc.id returning * into rc;
  return rc;
end $$;

-- Estorna um recebimento lançado (estoque, título, contabilidade, crédito, pedido) e o devolve para conferência
create or replace function purch.reverse_receipt(p_receipt uuid, p_reason text) returns purch.receipts
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id();
  rc purch.receipts; r record;
begin
  perform private.require_perm('purch.approve');
  select * into rc from purch.receipts where id = p_receipt and org_id = v_org for update;
  if rc.id is null then raise exception 'Recebimento não encontrado'; end if;
  if rc.status <> 'POSTED' then raise exception 'Somente recebimentos lançados podem ser estornados' using errcode = 'P0083'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Informe o motivo do estorno'; end if;
  if exists (select 1 from fin.title_installments where title_id = rc.title_id and amount_settled > 0) then
    raise exception 'O título da nota já tem pagamentos: estorne as baixas no financeiro antes' using errcode = 'P0025';
  end if;
  if rc.credit_id is not null and exists (select 1 from fin.party_credits where id = rc.credit_id and used > 0) then
    raise exception 'O crédito de faltas deste recebimento já foi usado em um pagamento' using errcode = 'P0025';
  end if;
  perform private.assert_period_open(rc.legal_entity_id, private.today_sp());

  for r in select m.* from inv.movements m
           where m.id in (select movement_id from purch.receipt_items where receipt_id = rc.id and movement_id is not null) loop
    insert into inv.movements (org_id, occurred_at, variant_id, location_id, qty, unit_cost, movement_type, source_type, source_id, source_line_id,
                               reversal_of_id, notes, created_by)
    values (v_org, now(), r.variant_id, r.location_id, -r.qty, r.unit_cost, 'SUPPLIER_RETURN', 'purch.receipts', rc.id, r.source_line_id,
            r.id, 'Estorno do recebimento ' || rc.number || ': ' || p_reason, private.member_id());
  end loop;
  perform private.reverse_entry(rc.entry_id, p_reason);
  update fin.title_installments set status = 'CANCELLED' where title_id = rc.title_id;
  update fin.titles set status = 'CANCELLED', tags = array_append(tags, 'cancelado') where id = rc.title_id;
  if rc.credit_id is not null then update fin.party_credits set status = 'CANCELLED' where id = rc.credit_id; end if;
  if rc.po_id is not null then
    for r in select variant_id, qty_counted from purch.receipt_items where receipt_id = rc.id and qty_counted > 0 loop
      update purch.po_items set qty_received = greatest(qty_received - r.qty_counted, 0) where po_id = rc.po_id and variant_id = r.variant_id;
    end loop;
    update purch.purchase_orders set status = case when exists (select 1 from purch.po_items where po_id = rc.po_id and qty_received > 0) then 'PARTIAL' else 'APPROVED' end
    where id = rc.po_id and status in ('PARTIAL', 'RECEIVED');
  end if;
  update purch.receipt_items set movement_id = null where receipt_id = rc.id;
  update purch.receipts set status = 'PENDING_CHECK', title_id = null, entry_id = null, credit_id = null, post_ref = null, landed_total = null,
         shortage_total = 0, checked_by = null, checked_at = null, posted_by = null, posted_at = null,
         notes = concat_ws(' · ', notes, 'Estornado: ' || p_reason)
  where id = rc.id returning * into rc;
  return rc;
end $$;

-- Descarta um recebimento ainda não lançado (permite importar a mesma nota de novo)
create or replace function purch.discard_receipt(p_receipt uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare rc purch.receipts;
begin
  perform private.require_perm('purch.write');
  select * into rc from purch.receipts where id = p_receipt and org_id = private.org_id() for update;
  if rc.id is null then raise exception 'Recebimento não encontrado'; end if;
  if rc.status = 'POSTED' then raise exception 'Recebimento lançado: estorne antes de descartar' using errcode = 'P0083'; end if;
  delete from purch.receipts where id = rc.id;
  delete from fiscal.documents where id = rc.document_id and direction = 'IN' and org_id = rc.org_id;
end $$;

-- ---------------------------------------------------------------------
-- Pedidos de compra
-- p = {id?, legal_entity_id, location_id, supplier_party_id, expected_date?, payment_terms_id?, collection_id?, notes?,
--      items:[{variant_id, qty, unit_cost}]}
-- ---------------------------------------------------------------------
create or replace function purch.save_po(p jsonb) returns purch.purchase_orders
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id();
  po purch.purchase_orders; loc inv.locations; it jsonb; v_total numeric := 0;
begin
  perform private.require_perm('purch.write');
  select * into loc from inv.locations where id = (p ->> 'location_id')::uuid and org_id = v_org;
  if loc.id is null then raise exception 'Local de entrega inválido'; end if;
  if loc.legal_entity_id <> (p ->> 'legal_entity_id')::uuid then raise exception 'O local de entrega pertence a outro CNPJ'; end if;
  if not exists (select 1 from crm.parties where id = (p ->> 'supplier_party_id')::uuid and org_id = v_org) then raise exception 'Fornecedor inválido'; end if;
  if jsonb_array_length(coalesce(p -> 'items', '[]')) = 0 then raise exception 'Inclua ao menos um item'; end if;

  if (p ->> 'id') is not null then
    select * into po from purch.purchase_orders where id = (p ->> 'id')::uuid and org_id = v_org for update;
    if po.id is null then raise exception 'Pedido não encontrado'; end if;
    if po.status <> 'DRAFT' then raise exception 'Somente pedidos em rascunho podem ser editados' using errcode = 'P0086'; end if;
    update purch.purchase_orders set legal_entity_id = loc.legal_entity_id, location_id = loc.id, store_id = loc.store_id,
           supplier_party_id = (p ->> 'supplier_party_id')::uuid, expected_date = (p ->> 'expected_date')::date,
           payment_terms_id = (p ->> 'payment_terms_id')::uuid, collection_id = (p ->> 'collection_id')::uuid, notes = p ->> 'notes'
    where id = po.id;
    delete from purch.po_items where po_id = po.id;
  else
    insert into purch.purchase_orders (org_id, legal_entity_id, location_id, store_id, supplier_party_id, number, expected_date, payment_terms_id,
                                       collection_id, notes, created_by)
    values (v_org, loc.legal_entity_id, loc.id, loc.store_id, (p ->> 'supplier_party_id')::uuid, core.next_number(v_org, 'PC'),
            (p ->> 'expected_date')::date, (p ->> 'payment_terms_id')::uuid, (p ->> 'collection_id')::uuid, p ->> 'notes', private.member_id())
    returning * into po;
  end if;

  for it in select * from jsonb_array_elements(p -> 'items') loop
    if (it ->> 'qty')::numeric <= 0 then continue; end if;
    if not exists (select 1 from catalog.variants where id = (it ->> 'variant_id')::uuid and org_id = v_org) then raise exception 'Variante inválida no pedido'; end if;
    insert into purch.po_items (org_id, po_id, variant_id, qty_ordered, unit_cost)
    values (v_org, po.id, (it ->> 'variant_id')::uuid, (it ->> 'qty')::numeric, coalesce((it ->> 'unit_cost')::numeric, 0))
    on conflict (po_id, variant_id) do update set qty_ordered = purch.po_items.qty_ordered + excluded.qty_ordered, unit_cost = excluded.unit_cost;
  end loop;
  select coalesce(sum(round(qty_ordered * unit_cost, 2)), 0) into v_total from purch.po_items where po_id = po.id;
  if not exists (select 1 from purch.po_items where po_id = po.id) then raise exception 'Inclua ao menos um item com quantidade'; end if;
  update purch.purchase_orders set total = v_total where id = po.id returning * into po;
  return po;
end $$;

create or replace function purch.approve_po(p_po uuid) returns purch.purchase_orders
language plpgsql security definer set search_path = '' as $$
declare po purch.purchase_orders;
begin
  perform private.require_perm('purch.approve');
  update purch.purchase_orders set status = 'APPROVED', approved_by = private.member_id(), approved_at = now()
  where id = p_po and org_id = private.org_id() and status = 'DRAFT' returning * into po;
  if po.id is null then raise exception 'Pedido não encontrado ou já aprovado' using errcode = 'P0086'; end if;
  return po;
end $$;

create or replace function purch.cancel_po(p_po uuid, p_reason text) returns purch.purchase_orders
language plpgsql security definer set search_path = '' as $$
declare po purch.purchase_orders;
begin
  perform private.require_perm('purch.approve');
  select * into po from purch.purchase_orders where id = p_po and org_id = private.org_id() for update;
  if po.id is null then raise exception 'Pedido não encontrado'; end if;
  if po.status in ('CANCELLED', 'RECEIVED') then raise exception 'Pedido já encerrado' using errcode = 'P0086'; end if;
  if exists (select 1 from purch.receipts where po_id = po.id and status = 'POSTED') then
    raise exception 'O pedido já tem recebimentos lançados: use "encerrar" para cancelar só o saldo' using errcode = 'P0086';
  end if;
  update purch.purchase_orders set status = 'CANCELLED', cancelled_reason = p_reason where id = po.id returning * into po;
  return po;
end $$;

-- Encerra o pedido com saldo (o fornecedor não entregará o resto)
create or replace function purch.close_po(p_po uuid) returns purch.purchase_orders
language plpgsql security definer set search_path = '' as $$
declare po purch.purchase_orders;
begin
  perform private.require_perm('purch.approve');
  update purch.purchase_orders set status = 'RECEIVED' where id = p_po and org_id = private.org_id() and status in ('APPROVED', 'PARTIAL') returning * into po;
  if po.id is null then raise exception 'Pedido não encontrado ou já encerrado' using errcode = 'P0086'; end if;
  return po;
end $$;

-- ---------------------------------------------------------------------
-- Sugestão de reposição por variante (tamanho × cor): velocidade de venda, cobertura e pedidos em aberto
-- alvo = velocidade × (prazo do fornecedor + dias de cobertura + segurança); sugerido = alvo − (disponível + a receber)
-- ---------------------------------------------------------------------
create or replace function purch.replenishment(p_location uuid, p_lookback int default 60, p_lead int default 14, p_cover int default 30, p_safety int default 7)
returns table (variant_id uuid, sku text, product_name text, color text, size text, on_hand numeric, reserved numeric, on_order numeric,
               sold numeric, velocity numeric, days_cover numeric, target numeric, suggested numeric, last_cost numeric, supplier_party_id uuid)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare v_org uuid := private.org_id(); v_entity uuid;
begin
  perform private.require_perm('purch.read');
  select l.legal_entity_id into v_entity from inv.locations l where l.id = p_location and l.org_id = v_org;
  if v_entity is null then raise exception 'Local inválido'; end if;
  return query
  with sold_cte as (
    select m.variant_id, -sum(m.qty) filter (where m.movement_type in ('SALE', 'EXCHANGE_OUT', 'SALE_RETURN', 'EXCHANGE_IN')) as sold
    from inv.movements m
    where m.org_id = v_org and m.location_id = p_location and m.occurred_at >= now() - make_interval(days => p_lookback)
    group by m.variant_id
  ), ordered as (
    select i.variant_id, sum(i.qty_ordered - i.qty_received) as open_qty
    from purch.po_items i join purch.purchase_orders o on o.id = i.po_id
    where o.org_id = v_org and o.location_id = p_location and o.status in ('APPROVED', 'PARTIAL')
    group by i.variant_id
  ), last_sup as (
    select distinct on (ri.variant_id) ri.variant_id, rc.supplier_party_id
    from purch.receipt_items ri join purch.receipts rc on rc.id = ri.receipt_id
    where rc.org_id = v_org and rc.status = 'POSTED' and ri.variant_id is not null
    order by ri.variant_id, rc.posted_at desc
  )
  select v.id, v.sku, p.name, c.name, v.size,
         coalesce(sl.on_hand, 0), coalesce(sl.reserved, 0), coalesce(o.open_qty, 0),
         s.sold, round(s.sold / p_lookback, 3),
         case when s.sold > 0 then round(greatest(coalesce(sl.on_hand, 0) - coalesce(sl.reserved, 0), 0) / (s.sold / p_lookback), 1) end,
         round(s.sold / p_lookback * (p_lead + p_cover + p_safety), 1),
         greatest(ceil(s.sold / p_lookback * (p_lead + p_cover + p_safety) - (coalesce(sl.on_hand, 0) - coalesce(sl.reserved, 0) + coalesce(o.open_qty, 0))), 0),
         ic.last_cost, ls.supplier_party_id
  from sold_cte s
  join catalog.variants v on v.id = s.variant_id and v.active
  join catalog.products p on p.id = v.product_id
  left join catalog.colors c on c.id = v.color_id
  left join inv.stock_levels sl on sl.variant_id = v.id and sl.location_id = p_location
  left join ordered o on o.variant_id = v.id
  left join inv.item_costs ic on ic.variant_id = v.id and ic.legal_entity_id = v_entity
  left join last_sup ls on ls.variant_id = v.id
  where s.sold > 0
  order by greatest(ceil(s.sold / p_lookback * (p_lead + p_cover + p_safety) - (coalesce(sl.on_hand, 0) - coalesce(sl.reserved, 0) + coalesce(o.open_qty, 0))), 0) desc, p.name, v.size;
end $$;

-- Cancelar título gerado por recebimento só pelo estorno do recebimento
create or replace function fin.cancel_title(p_title uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare t fin.titles;
begin
  perform private.require_perm('fin.approve');
  select * into t from fin.titles where id = p_title and org_id = private.org_id() for update;
  if t.id is null then raise exception 'Título não encontrado'; end if;
  if t.status = 'CANCELLED' then return; end if;
  if exists (select 1 from fin.title_installments where title_id = t.id and amount_settled > 0) then
    raise exception 'Título já possui baixas: estorne as baixas antes de cancelar' using errcode = 'P0025';
  end if;
  if t.accrual_mode = 'EXTERNAL' and t.origin_type in ('ORDER', 'PAYROLL', 'PURCHASE_RECEIPT') then
    raise exception 'Título gerado por % só pode ser cancelado pela origem', t.origin_type using errcode = 'P0025';
  end if;
  if t.accrual_entry_id is not null then perform private.reverse_entry(t.accrual_entry_id, 'Cancelamento: ' || coalesce(p_reason, '')); end if;
  update fin.title_installments set status = 'CANCELLED' where title_id = t.id;
  update fin.titles set status = 'CANCELLED', tags = array_append(tags, 'cancelado') where id = t.id;
end $$;

select private.apply_rls('purch', array['payment_terms', 'purchase_orders', 'po_items', 'receipts', 'receipt_items'], 'purch.read', 'purch.write');
select private.rpc_only('purch', array['purchase_orders', 'po_items', 'receipts', 'receipt_items']);
