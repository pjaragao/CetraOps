begin;
create extension if not exists pgtap with schema extensions;
select plan(78);

create or replace function pg_temp.login(p_user uuid) returns void language plpgsql as $$
declare m record;
begin
  select id, org_id into m from core.members where user_id = p_user;
  perform set_config('request.jwt.claims', json_build_object(
    'sub', p_user, 'role', 'authenticated',
    'app_metadata', json_build_object('org_id', m.org_id, 'member_id', m.id))::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
grant execute on function pg_temp.login(uuid) to authenticated, anon;

-- NF-e de teste (nfeProc, Simples, frete só no cabeçalho, desconto em um item, 2 duplicatas). Chave com DV válido, gerada pelo número.
create or replace function pg_temp.nfe_xml(p_nnf int, p_dest text default '11222333000181', p_cstat text default '100', p_amb text default '1') returns text
language plpgsql as $f$
declare k43 text; k text; x text := $X$
<?xml version="1.0" encoding="UTF-8"?>
<nfeProc versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe">
  <NFe xmlns="http://www.portalfiscal.inf.br/nfe">
    <infNFe Id="NFe{{KEY}}" versao="4.00">
      <ide>
        <cUF>42</cUF><cNF>{{CNF}}</cNF><natOp>VENDA DE MERCADORIA</natOp><mod>55</mod><serie>1</serie><nNF>{{NNF}}</nNF>
        <dhEmi>2026-09-15T10:22:31-03:00</dhEmi><tpNF>1</tpNF><idDest>1</idDest><cMunFG>4205407</cMunFG><tpImp>1</tpImp><tpEmis>1</tpEmis>
        <cDV>{{DV}}</cDV><tpAmb>{{AMB}}</tpAmb><finNFe>1</finNFe><indFinal>0</indFinal><indPres>0</indPres><procEmi>0</procEmi><verProc>1.0</verProc>
      </ide>
      <emit>
        <CNPJ>12345678000195</CNPJ><xNome>CONFECCOES ALFA LTDA</xNome><xFant>Alfa Confecções &amp; Cia</xFant>
        <enderEmit><xLgr>RUA DAS COSTUREIRAS</xLgr><nro>100</nro><xBairro>CENTRO</xBairro><cMun>4202404</cMun><xMun>BLUMENAU</xMun><UF>SC</UF><CEP>89010000</CEP></enderEmit>
        <IE>255123456</IE><CRT>1</CRT>
      </emit>
      <dest>
        <CNPJ>{{DEST}}</CNPJ><xNome>EMPRESA DE TESTE LTDA</xNome>
        <enderDest><xLgr>RUA DA LOJA</xLgr><nro>10</nro><xBairro>CENTRO</xBairro><cMun>4205407</cMun><xMun>FLORIANOPOLIS</xMun><UF>SC</UF></enderDest>
        <indIEDest>9</indIEDest>
      </dest>
      <det nItem="1">
        <prod><cProd>LEG01-OFW-P</cProd><cEAN>7891234560017</cEAN><xProd>LEGGING SUPPLEX LEG01 OFF WHITE P</xProd><NCM>61046300</NCM><CFOP>5102</CFOP>
          <uCom>UN</uCom><qCom>10.0000</qCom><vUnCom>58.0000000000</vUnCom><vProd>580.00</vProd><cEANTrib>7891234560017</cEANTrib><uTrib>UN</uTrib><qTrib>10.0000</qTrib><vUnTrib>58.0000000000</vUnTrib><indTot>1</indTot></prod>
        <imposto><ICMS><ICMSSN102><orig>0</orig><CSOSN>102</CSOSN></ICMSSN102></ICMS></imposto>
      </det>
      <det nItem="2">
        <prod><cProd>LEG01-OFW-M</cProd><cEAN>7891234560024</cEAN><xProd>LEGGING SUPPLEX LEG01 OFF WHITE M</xProd><NCM>61046300</NCM><CFOP>5102</CFOP>
          <uCom>UN</uCom><qCom>20.0000</qCom><vUnCom>58.0000000000</vUnCom><vProd>1160.00</vProd><cEANTrib>7891234560024</cEANTrib><uTrib>UN</uTrib><qTrib>20.0000</qTrib><vUnTrib>58.0000000000</vUnTrib><vDesc>20.00</vDesc><indTot>1</indTot></prod>
        <imposto><ICMS><ICMSSN102><orig>0</orig><CSOSN>102</CSOSN></ICMSSN102></ICMS></imposto>
      </det>
      <det nItem="3">
        <prod><cProd>LEG01-OFW-G</cProd><cEAN>SEM GTIN</cEAN><xProd>LEGGING SUPPLEX LEG01 OFF WHITE G</xProd><NCM>61046300</NCM><CFOP>5102</CFOP>
          <uCom>UN</uCom><qCom>10.0000</qCom><vUnCom>58.0000000000</vUnCom><vProd>580.00</vProd><cEANTrib>SEM GTIN</cEANTrib><uTrib>UN</uTrib><qTrib>10.0000</qTrib><vUnTrib>58.0000000000</vUnTrib><indTot>1</indTot></prod>
        <imposto><ICMS><ICMSSN102><orig>0</orig><CSOSN>102</CSOSN></ICMSSN102></ICMS></imposto>
      </det>
      <total><ICMSTot><vBC>0.00</vBC><vICMS>0.00</vICMS><vICMSDeson>0.00</vICMSDeson><vFCP>0.00</vFCP><vBCST>0.00</vBCST><vST>0.00</vST><vFCPST>0.00</vFCPST><vFCPSTRet>0.00</vFCPSTRet>
        <vProd>2320.00</vProd><vFrete>40.00</vFrete><vSeg>0.00</vSeg><vDesc>20.00</vDesc><vII>0.00</vII><vIPI>0.00</vIPI><vIPIDevol>0.00</vIPIDevol><vPIS>0.00</vPIS><vCOFINS>0.00</vCOFINS><vOutro>0.00</vOutro><vNF>2340.00</vNF></ICMSTot></total>
      <transp><modFrete>0</modFrete></transp>
      <cobr><fat><nFat>{{NNF}}</nFat><vOrig>2340.00</vOrig><vDesc>0.00</vDesc><vLiq>2340.00</vLiq></fat>
        <dup><nDup>001</nDup><dVenc>2026-10-15</dVenc><vDup>1170.00</vDup></dup><dup><nDup>002</nDup><dVenc>2026-11-14</dVenc><vDup>1170.00</vDup></dup></cobr>
      <pag><detPag><indPag>1</indPag><tPag>15</tPag><vPag>2340.00</vPag></detPag></pag>
      <infAdic><infCpl>Documento emitido por ME/EPP optante pelo Simples Nacional</infCpl></infAdic>
    </infNFe>
  </NFe>
  <protNFe versao="4.00"><infProt><tpAmb>{{AMB}}</tpAmb><verAplic>SC1.0</verAplic><chNFe>{{KEY}}</chNFe><dhRecbto>2026-09-15T10:22:40-03:00</dhRecbto><nProt>342260000012345</nProt><digVal>abc=</digVal><cStat>{{CSTAT}}</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo></infProt></protNFe>
</nfeProc>
$X$;
begin
  k43 := '42' || '2609' || '12345678000195' || '55' || '001' || lpad(p_nnf::text, 9, '0') || '1' || lpad(p_nnf::text, 8, '0');
  k := k43 || fiscal.nfe_key_dv(k43);
  return replace(replace(replace(replace(replace(replace(replace(x, '{{KEY}}', k), '{{DV}}', right(k, 1)), '{{DEST}}', p_dest),
         '{{NNF}}', p_nnf::text), '{{CNF}}', lpad(p_nnf::text, 8, '0')), '{{CSTAT}}', p_cstat), '{{AMB}}', p_amb);
end $f$;
grant execute on function pg_temp.nfe_xml(int, text, text, text) to authenticated, anon;

create temp table ids (k text primary key, v uuid);
grant all on ids to authenticated;

-- ---------- Leitura do XML ----------
select is(fiscal.nfe_key_valid('42260912345678000195550010000012341000012347'), true, 'chave de acesso válida (DV módulo 11)');
select is(fiscal.nfe_key_valid('42260912345678000195550010000012341000012340'), false, 'chave com DV errado é recusada');
select is((fiscal.parse_nfe(pg_temp.nfe_xml(1234)) -> 'totals' ->> 'vNF')::numeric, 2340.00, 'parse: valor total da nota');
select is(jsonb_array_length(fiscal.parse_nfe(pg_temp.nfe_xml(1234)) -> 'items'), 3, 'parse: 3 itens');
select is(jsonb_array_length(fiscal.parse_nfe(pg_temp.nfe_xml(1234)) -> 'installments'), 2, 'parse: 2 duplicatas');
select is(fiscal.parse_nfe(pg_temp.nfe_xml(1234)) #>> '{issuer,fantasy}', 'Alfa Confecções & Cia', 'parse: entidades XML decodificadas');
select is(fiscal.parse_nfe(pg_temp.nfe_xml(1234)) #>> '{protocol,number}', '342260000012345', 'parse: protocolo de autorização');
select throws_ok($$ select fiscal.parse_nfe(regexp_replace(pg_temp.nfe_xml(1234), 'Id="NFe(\d{43})\d"', 'Id="NFe\10"')) $$, 'P0080', null, 'chave com DV inválido no XML');
select throws_ok($$ select fiscal.parse_nfe('<!DOCTYPE x [<!ENTITY e "y">]>' || pg_temp.nfe_xml(1234)) $$, 'P0080', null, 'XML com DTD/ENTITY é recusado (XXE)');
select throws_ok($$ select fiscal.parse_nfe(pg_temp.nfe_xml(1234, p_cstat => '101')) $$, 'P0080', null, 'nota cancelada (cStat 101) é recusada');
select throws_ok($$ select fiscal.parse_nfe(replace(pg_temp.nfe_xml(1234), '<mod>55</mod>', '<mod>65</mod>')) $$, 'P0080', null, 'só modelo 55');
select is(jsonb_array_length(fiscal.parse_nfe(regexp_replace(pg_temp.nfe_xml(1234), '<protNFe.*</protNFe>', '', 's')) -> 'warnings'), 1, 'sem protocolo: avisa para conferir na SEFAZ');

-- ---------- Preparação (sócio): catálogo com 3 tamanhos, um com EAN ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select lives_ok($$ select catalog.import_rows('[
 {"reference_code":"LEG01","name":"Legging Supplex","gender":"FEM","category":"Leggings","ncm":"61046300","color":"Off White","color_code":"OFW","size":"P","price":189.9},
 {"reference_code":"LEG01","name":"Legging Supplex","gender":"FEM","category":"Leggings","ncm":"61046300","color":"Off White","color_code":"OFW","size":"M","gtin":"7891234560024","price":189.9},
 {"reference_code":"LEG01","name":"Legging Supplex","gender":"FEM","category":"Leggings","ncm":"61046300","color":"Off White","color_code":"OFW","size":"G","price":189.9}]'::jsonb) $$,
 'catálogo de teste (LEG01 P/M/G)');

-- ---------- Importação ----------
select lives_ok($$ insert into ids select 'rc1', (purch.import_nfe(pg_temp.nfe_xml(1234), '00000000-0000-4000-8000-0000000000b1')).id $$, 'importa a NF-e');
select is((select status from purch.receipts where id = (select v from ids where k = 'rc1')), 'PENDING_CHECK', 'recebimento aguarda conferência');
select is((select sum(item_total) from purch.receipt_items where receipt_id = (select v from ids where k = 'rc1')), 2340.00, 'custo dos itens (com frete rateado e desconto) soma o total da nota');
select is((select landed_unit_cost from purch.receipt_items where receipt_id = (select v from ids where k = 'rc1') and n_item = 2), 57.9910, 'custo unitário do item 2: (1.160 − 20 + frete rateado) / 20');
select is((select array_agg(match_status order by n_item) from purch.receipt_items where receipt_id = (select v from ids where k = 'rc1')),
          array['SUGGESTED', 'EXACT_EAN', 'SUGGESTED'], 'casamento: EAN exato no item 2, SKU do fornecedor nos demais (sugestão)');
select is((select count(*)::int from crm.party_roles pr join crm.parties p on p.id = pr.party_id where p.cnpj = '12345678000195' and pr.role = 'SUPPLIER'), 1, 'fornecedor criado no cadastro único com papel SUPPLIER');
select is((select status || '/' || protocol from fiscal.documents where access_key = (fiscal.parse_nfe(pg_temp.nfe_xml(1234)) ->> 'access_key')), 'AUTHORIZED/342260000012345', 'documento fiscal de entrada gravado');
select throws_ok($$ select purch.import_nfe(pg_temp.nfe_xml(1234), '00000000-0000-4000-8000-0000000000b1') $$, 'P0081', null, 'a mesma NF-e não entra duas vezes');
select throws_ok($$ select purch.import_nfe(pg_temp.nfe_xml(1235, '99999999000191'), '00000000-0000-4000-8000-0000000000b1') $$, 'P0082', null, 'nota destinada a outro CNPJ é recusada');
select throws_ok($$ select purch.import_nfe(pg_temp.nfe_xml(1236, p_amb => '2'), '00000000-0000-4000-8000-0000000000b1') $$, 'P0082', null, 'NF-e de homologação é recusada');
select throws_ok($$ select purch.confirm_receipt((select v from ids where k = 'rc1')) $$, 'P0083', null, 'não confirma com sugestões pendentes');

-- ---------- Conferência ----------
select is(purch.accept_suggestions((select v from ids where k = 'rc1')), 2, 'confirma as 2 sugestões');
select is((select count(*)::int from catalog.supplier_items where supplier_cprod like 'LEG01-OFW-%'), 2, 'aprende os pares cProd → SKU do fornecedor');
select throws_ok($$ select purch.set_receipt_item((select id from purch.receipt_items where receipt_id = (select v from ids where k = 'rc1') and n_item = 2), '{"qty_counted": 25}') $$,
                 'P0085', null, 'contagem maior que a nota é recusada');
select lives_ok($$ select purch.set_receipt_item((select id from purch.receipt_items where receipt_id = (select v from ids where k = 'rc1') and n_item = 2), '{"qty_counted": 18}') $$,
                'conta 18 de 20 no item 2 (falta de 2)');
select is(purch.count_all((select v from ids where k = 'rc1')), 2, 'iguala os demais itens à nota');
select is((purch.confirm_receipt((select v from ids where k = 'rc1'))).status, 'CHECKED', 'conferência confirmada');

-- ---------- Permissões: vendedora não importa, não vê, não lança ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');
select throws_ok($$ select purch.import_nfe(pg_temp.nfe_xml(1237), '00000000-0000-4000-8000-0000000000b1') $$, '42501', null, 'vendedora não importa NF-e');
select throws_ok($$ select purch.post_receipt((select v from ids where k = 'rc1')) $$, '42501', null, 'vendedora não lança recebimento');
select is((select count(*)::int from purch.receipts), 0, 'vendedora não enxerga compras (RLS)');
select is((select count(*)::int from fiscal.documents), 0, 'vendedora não enxerga documentos fiscais (RLS)');
select throws_ok($$ select * from purch.replenishment('00000000-0000-4000-8000-0000000000b1') $$, '42501', null, 'vendedora não vê a reposição');

-- ---------- Lançamento ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select is((purch.post_receipt((select v from ids where k = 'rc1'))).status, 'POSTED', 'lança o recebimento no estoque e no financeiro');
select is((select array_agg(sl.on_hand order by v.sku) from inv.stock_levels sl join catalog.variants v on v.id = sl.variant_id
           where sl.location_id = '00000000-0000-4000-8000-0000000000b1' and v.sku like 'LEG01-OFW-%'), array[10.000, 18.000, 10.000]::numeric[], 'estoque por tamanho: 10 / 18 (contado) / 10');
select is((select avg_cost from inv.item_costs ic join catalog.variants v on v.id = ic.variant_id where v.sku = 'LEG01-OFW-M'), 57.9910, 'custo médio inicial = custo de aquisição');
select is((select total_amount from fin.titles where origin_type = 'PURCHASE_RECEIPT' and origin_id = (select v from ids where k = 'rc1')), 2340.00, 'conta a pagar pelo total da nota');
select is((select array_agg(i.amount order by i.n) from fin.title_installments i join fin.titles t on t.id = i.title_id where t.origin_id = (select v from ids where k = 'rc1')),
          array[1170.00, 1170.00], 'parcelas seguem as duplicatas da nota');
select is((select array_agg(i.due_date::text order by i.n) from fin.title_installments i join fin.titles t on t.id = i.title_id where t.origin_id = (select v from ids where k = 'rc1')),
          array['2026-10-15', '2026-11-14'], 'vencimentos das duplicatas');
select is((select sum(l.debit) from fin.journal_lines l join fin.journal_entries e on e.id = l.entry_id
           where e.source_type = 'purch.receipts' and e.source_id = (select post_ref from purch.receipts where id = (select v from ids where k = 'rc1'))
             and l.account_id = (select id from fin.chart_accounts where code = '1.1.3.01')), 2224.02, 'razão: estoque debitado pelo valor recebido');
select is((select sum(l.credit) from fin.journal_lines l join fin.journal_entries e on e.id = l.entry_id
           where e.source_type = 'purch.receipts' and e.source_id = (select post_ref from purch.receipts where id = (select v from ids where k = 'rc1'))
             and l.account_id = (select id from fin.chart_accounts where code = '2.1.1.01')), 2340.00, 'razão: fornecedores creditado pelo total da nota');
select is((select amount from fin.party_credits where id = (select credit_id from purch.receipts where id = (select v from ids where k = 'rc1'))), 115.98, 'falta de 2 peças vira crédito com o fornecedor');
select is((select shortage_total || '/' || landed_total from purch.receipts where id = (select v from ids where k = 'rc1')), '115.98/2224.02', 'totais do recebimento');
select throws_ok($$ select purch.post_receipt((select v from ids where k = 'rc1')) $$, 'P0083', null, 'não lança duas vezes');

-- ---------- Pedido de compra ----------
select lives_ok($$ insert into ids select 'po1', (purch.save_po(jsonb_build_object(
  'legal_entity_id', '00000000-0000-4000-8000-0000000000e1', 'location_id', '00000000-0000-4000-8000-0000000000b1',
  'supplier_party_id', (select id from crm.parties where cnpj = '12345678000195'), 'expected_date', '2026-10-20',
  'items', jsonb_build_array(
    jsonb_build_object('variant_id', (select id from catalog.variants where sku = 'LEG01-OFW-P'), 'qty', 10, 'unit_cost', 58),
    jsonb_build_object('variant_id', (select id from catalog.variants where sku = 'LEG01-OFW-M'), 'qty', 30, 'unit_cost', 58),
    jsonb_build_object('variant_id', (select id from catalog.variants where sku = 'LEG01-OFW-G'), 'qty', 10, 'unit_cost', 58))))).id $$, 'cria pedido de compra');
select is((select total from purch.purchase_orders where id = (select v from ids where k = 'po1')), 2900.00, 'total do pedido');
select throws_ok($$ select purch.import_nfe(pg_temp.nfe_xml(2001), '00000000-0000-4000-8000-0000000000b1', (select v from ids where k = 'po1')) $$, 'P0082', null, 'pedido em rascunho não recebe nota');
select is((purch.approve_po((select v from ids where k = 'po1'))).status, 'APPROVED', 'aprova o pedido');
select lives_ok($$ insert into ids select 'rc2', (purch.import_nfe(pg_temp.nfe_xml(2001), '00000000-0000-4000-8000-0000000000b1', (select v from ids where k = 'po1'))).id $$, 'importa a nota do pedido');
select is((select count(*)::int from purch.receipt_items where receipt_id = (select v from ids where k = 'rc2') and match_status in ('LEARNED', 'EXACT_EAN')), 3, 'segunda nota: todos os itens reconhecidos pelo aprendizado/EAN');
select lives_ok($$ select purch.count_all((select v from ids where k = 'rc2')); select purch.confirm_receipt((select v from ids where k = 'rc2')); select purch.post_receipt((select v from ids where k = 'rc2')) $$, 'confere e lança sem divergência');
select is((select status from purch.purchase_orders where id = (select v from ids where k = 'po1')), 'PARTIAL', 'pedido parcialmente recebido (M: 20 de 30)');
select is((select qty_received from purch.po_items i join catalog.variants v on v.id = i.variant_id where i.po_id = (select v from ids where k = 'po1') and v.sku = 'LEG01-OFW-M'), 20.000, 'quantidade recebida do item M');
select throws_ok($$ select purch.cancel_po((select v from ids where k = 'po1'), 'teste') $$, 'P0086', null, 'pedido com recebimento não é cancelado, só encerrado');

-- ---------- Pagamento com uso do crédito de faltas ----------
select lives_ok($$ insert into ids select 'st1', (fin.settle(jsonb_build_object(
  'bank_account_id', '00000000-0000-4000-8000-000000000701', 'direction', 'PAYABLE', 'method', 'PIX',
  'party_id', (select id from crm.parties where cnpj = '12345678000195'),
  'lines', jsonb_build_array(
    jsonb_build_object('kind', 'PRINCIPAL', 'amount', 1170, 'installment_id', (select i.id from fin.title_installments i join fin.titles t on t.id = i.title_id where t.origin_id = (select v from ids where k = 'rc1') and i.n = 1)),
    jsonb_build_object('kind', 'CREDIT_USE', 'amount', 115.98, 'credit_id', (select credit_id from purch.receipts where id = (select v from ids where k = 'rc1'))))))).id $$,
  'paga a 1ª parcela usando o crédito da falta');
select is((select amount from fin.settlements where id = (select v from ids where k = 'st1')), 1054.02, 'Pix de R$ 1.054,02 = parcela − crédito');
select is((select status from fin.party_credits where id = (select credit_id from purch.receipts where id = (select v from ids where k = 'rc1'))), 'USED', 'crédito consumido');
select throws_ok($$ select purch.reverse_receipt((select v from ids where k = 'rc1'), 'teste') $$, 'P0025', null, 'não estorna recebimento com pagamento');

-- ---------- Estorno e refazer ----------
select lives_ok($$ select fin.reverse_settlement((select v from ids where k = 'st1'), 'teste') $$, 'estorna o pagamento');
select is((purch.reverse_receipt((select v from ids where k = 'rc1'), 'contagem errada')).status, 'PENDING_CHECK', 'estorna o recebimento e volta para conferência');
select is((select coalesce(sum(qty), 0) from inv.movements where source_type = 'purch.receipts' and source_id = (select v from ids where k = 'rc1')), 0.000, 'movimentos de estoque compensados');
select is((select status from fin.titles where origin_id = (select v from ids where k = 'rc1')), 'CANCELLED', 'título cancelado');
select lives_ok($$ select purch.confirm_receipt((select v from ids where k = 'rc1')); select purch.post_receipt((select v from ids where k = 'rc1')) $$, 'refaz o lançamento depois do estorno');
select is((select count(*)::int from fin.titles where origin_id = (select v from ids where k = 'rc1')), 2, 'um título cancelado e um novo em aberto');

-- ---------- Fornecedor manual ----------
select is(private.valid_cnpj('11.222.333/0001-81'), true, 'CNPJ válido (módulo 11)');
select is(private.valid_cnpj('11222333000182'), false, 'CNPJ com DV errado');
select is((select purch.ensure_supplier('04.252.011/0001-10', 'Tecidos Beta Ltda')) = (select purch.ensure_supplier('04252011000110', 'Outro nome')), true, 'fornecedor por CNPJ é reaproveitado');
select throws_ok($$ select purch.ensure_supplier('123', 'X') $$, 'P0087', null, 'CNPJ inválido é recusado');
select is((select count(*)::int from crm.party_roles pr join crm.parties p on p.id = pr.party_id where p.cnpj = '04252011000110' and pr.role = 'SUPPLIER'), 1, 'papel SUPPLIER atribuído');

-- ---------- Descartar ----------
select lives_ok($$ insert into ids select 'rc3', (purch.import_nfe(pg_temp.nfe_xml(3001), '00000000-0000-4000-8000-0000000000b1')).id $$, 'importa outra nota');
select lives_ok($$ select purch.discard_receipt((select v from ids where k = 'rc3')) $$, 'descarta o recebimento não lançado');
select lives_ok($$ select purch.import_nfe(pg_temp.nfe_xml(3001), '00000000-0000-4000-8000-0000000000b1') $$, 'depois de descartar, a nota pode ser importada de novo');

-- ---------- Reposição ----------
reset role;
insert into inv.movements (org_id, occurred_at, variant_id, location_id, qty, movement_type, source_type)
select '00000000-0000-4000-8000-000000000001', now() - interval '10 days', v.id, '00000000-0000-4000-8000-0000000000b1', -20, 'SALE', 'test' from catalog.variants v where v.sku = 'LEG01-OFW-M';
insert into inv.movements (org_id, occurred_at, variant_id, location_id, qty, movement_type, source_type)
select '00000000-0000-4000-8000-000000000001', now() - interval '5 days', v.id, '00000000-0000-4000-8000-0000000000b1', -10, 'SALE', 'test' from catalog.variants v where v.sku = 'LEG01-OFW-M';
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select is((select velocity from purch.replenishment('00000000-0000-4000-8000-0000000000b1') where sku = 'LEG01-OFW-M'), 0.500, 'reposição: velocidade de 30 vendas em 60 dias');
select is((select on_order from purch.replenishment('00000000-0000-4000-8000-0000000000b1') where sku = 'LEG01-OFW-M'), 10.000, 'reposição: saldo do pedido em aberto (30 − 20)');
select is((select suggested from purch.replenishment('00000000-0000-4000-8000-0000000000b1') where sku = 'LEG01-OFW-M'), 8::numeric, 'reposição: alvo 25,5 − (estoque 8 + a receber 10) = 8');
select is((purch.close_po((select v from ids where k = 'po1'))).status, 'RECEIVED', 'encerrar o pedido cancela o saldo');

select * from finish();
rollback;
