begin;
create extension if not exists pgtap with schema extensions;
select plan(24);

create or replace function pg_temp.login(p_user uuid) returns void language plpgsql as $$
declare m record;
begin
  select id, org_id into m from core.members where user_id = p_user;
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated',
    'app_metadata', json_build_object('org_id', m.org_id, 'member_id', m.id))::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
grant execute on function pg_temp.login(uuid) to authenticated, anon;

-- NF-e mínima (mesma estrutura do 005): 3 itens de NCM informado, 2 duplicatas de 1.170, total 2.340
create or replace function pg_temp.nfe(p_nnf int, p_ncm text default '61046300') returns text language plpgsql as $f$
declare k43 text; k text; x text := $X$<?xml version="1.0" encoding="UTF-8"?>
<nfeProc versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe"><NFe xmlns="http://www.portalfiscal.inf.br/nfe"><infNFe Id="NFe{{KEY}}" versao="4.00">
<ide><cUF>42</cUF><cNF>{{CNF}}</cNF><natOp>VENDA</natOp><mod>55</mod><serie>1</serie><nNF>{{NNF}}</nNF><dhEmi>2026-09-15T10:22:31-03:00</dhEmi><tpNF>1</tpNF><idDest>1</idDest>
<cMunFG>4205407</cMunFG><tpImp>1</tpImp><tpEmis>1</tpEmis><cDV>{{DV}}</cDV><tpAmb>1</tpAmb><finNFe>1</finNFe><indFinal>0</indFinal><indPres>0</indPres><procEmi>0</procEmi><verProc>1.0</verProc></ide>
<emit><CNPJ>12345678000195</CNPJ><xNome>CONFECCOES ALFA LTDA</xNome><xFant>Alfa Confecções</xFant><enderEmit><xLgr>RUA A</xLgr><nro>1</nro><xBairro>C</xBairro><cMun>4202404</cMun><xMun>BLUMENAU</xMun><UF>SC</UF><CEP>89010000</CEP></enderEmit><IE>255123456</IE><CRT>1</CRT></emit>
<dest><CNPJ>11222333000181</CNPJ><xNome>EMPRESA DE TESTE LTDA</xNome><enderDest><xLgr>RUA B</xLgr><nro>10</nro><xBairro>C</xBairro><cMun>4205407</cMun><xMun>FLORIANOPOLIS</xMun><UF>SC</UF></enderDest><indIEDest>9</indIEDest></dest>
<det nItem="1"><prod><cProd>P1</cProd><cEAN>SEM GTIN</cEAN><xProd>LEGGING P</xProd><NCM>{{NCM}}</NCM><CFOP>5102</CFOP><uCom>UN</uCom><qCom>10.0000</qCom><vUnCom>58.0000000000</vUnCom><vProd>580.00</vProd><cEANTrib>SEM GTIN</cEANTrib><uTrib>UN</uTrib><qTrib>10.0000</qTrib><vUnTrib>58.0000000000</vUnTrib><indTot>1</indTot></prod><imposto><ICMS><ICMSSN102><orig>0</orig><CSOSN>102</CSOSN></ICMSSN102></ICMS></imposto></det>
<det nItem="2"><prod><cProd>P2</cProd><cEAN>SEM GTIN</cEAN><xProd>LEGGING M</xProd><NCM>{{NCM}}</NCM><CFOP>5102</CFOP><uCom>UN</uCom><qCom>20.0000</qCom><vUnCom>58.0000000000</vUnCom><vProd>1160.00</vProd><cEANTrib>SEM GTIN</cEANTrib><uTrib>UN</uTrib><qTrib>20.0000</qTrib><vUnTrib>58.0000000000</vUnTrib><indTot>1</indTot></prod><imposto><ICMS><ICMSSN102><orig>0</orig><CSOSN>102</CSOSN></ICMSSN102></ICMS></imposto></det>
<det nItem="3"><prod><cProd>P3</cProd><cEAN>SEM GTIN</cEAN><xProd>LEGGING G</xProd><NCM>{{NCM}}</NCM><CFOP>5102</CFOP><uCom>UN</uCom><qCom>10.0000</qCom><vUnCom>60.0000000000</vUnCom><vProd>600.00</vProd><cEANTrib>SEM GTIN</cEANTrib><uTrib>UN</uTrib><qTrib>10.0000</qTrib><vUnTrib>60.0000000000</vUnTrib><indTot>1</indTot></prod><imposto><ICMS><ICMSSN102><orig>0</orig><CSOSN>102</CSOSN></ICMSSN102></ICMS></imposto></det>
<total><ICMSTot><vBC>0.00</vBC><vICMS>0.00</vICMS><vICMSDeson>0.00</vICMSDeson><vFCP>0.00</vFCP><vBCST>0.00</vBCST><vST>0.00</vST><vFCPST>0.00</vFCPST><vFCPSTRet>0.00</vFCPSTRet><vProd>2340.00</vProd><vFrete>0.00</vFrete><vSeg>0.00</vSeg><vDesc>0.00</vDesc><vII>0.00</vII><vIPI>0.00</vIPI><vIPIDevol>0.00</vIPIDevol><vPIS>0.00</vPIS><vCOFINS>0.00</vCOFINS><vOutro>0.00</vOutro><vNF>2340.00</vNF></ICMSTot></total>
<transp><modFrete>0</modFrete></transp><cobr><fat><nFat>{{NNF}}</nFat><vOrig>2340.00</vOrig><vDesc>0.00</vDesc><vLiq>2340.00</vLiq></fat><dup><nDup>001</nDup><dVenc>2026-10-15</dVenc><vDup>1170.00</vDup></dup><dup><nDup>002</nDup><dVenc>2026-11-14</dVenc><vDup>1170.00</vDup></dup></cobr>
<pag><detPag><indPag>1</indPag><tPag>15</tPag><vPag>2340.00</vPag></detPag></pag></infNFe></NFe>
<protNFe versao="4.00"><infProt><tpAmb>1</tpAmb><verAplic>SC1.0</verAplic><chNFe>{{KEY}}</chNFe><dhRecbto>2026-09-15T10:22:40-03:00</dhRecbto><nProt>342260000012345</nProt><digVal>abc=</digVal><cStat>100</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo></infProt></protNFe></nfeProc>$X$;
begin
  k43 := '42' || '2609' || '12345678000195' || '55' || '001' || lpad(p_nnf::text, 9, '0') || '1' || lpad(p_nnf::text, 8, '0');
  k := k43 || fiscal.nfe_key_dv(k43);
  return replace(replace(replace(replace(replace(replace(x, '{{KEY}}', k), '{{DV}}', right(k, 1)), '{{NNF}}', p_nnf::text), '{{CNF}}', lpad(p_nnf::text, 8, '0')), '{{NCM}}', p_ncm), '{{X}}', '');
end $f$;
grant execute on function pg_temp.nfe(int, text) to authenticated, anon;
create or replace function pg_temp.sha(t text) returns text language sql as $$ select encode(extensions.digest(t, 'sha256'), 'hex') $$;
grant execute on function pg_temp.sha(text) to authenticated, anon;
create temp table ids (k text primary key, v uuid);
grant all on ids to authenticated;

-- ---------- Preparação (dono do banco): o CNPJ 11444777000161 do boleto é da Contabilidade Exemplo do seed ----------
insert into crm.parties (id, org_id, kind, display_name, cnpj) values
  ('00000000-0000-4000-8000-0000000078a2', '00000000-0000-4000-8000-000000000001', 'PERSON', 'Sócio (pessoa)', null);
update core.members set party_id = '00000000-0000-4000-8000-0000000078a2' where user_id = '00000000-0000-4000-8000-0000000000f1';

select pg_temp.login('00000000-0000-4000-8000-0000000000f1');

-- ---------- Boleto → conta a pagar ----------
insert into ids select 'b1', (fin.doc_inbox_add(jsonb_build_object('sha256', pg_temp.sha('boleto-1'), 'kind', 'boleto', 'label', 'Boleto de Energia SC', 'file_name', 'luz.jpg', 'mime', 'image/jpeg',
  'storage_path', '00000000-0000-4000-8000-000000000001/caixa/luz.jpg',
  'fields', jsonb_build_object('beneficiario', 'Energia SC', 'beneficiario_cnpj', '11444777000161', 'valor', 320.5, 'vencimento', '2026-11-10', 'codigo_barras', '83640000003205000000000000000000000000000000')))).id;
select is((select destination from fin.doc_inbox where id = (select v from ids where k = 'b1')), 'PAYABLE', 'boleto é sugerido como conta a pagar');
select is((fin.doc_inbox_add(jsonb_build_object('sha256', pg_temp.sha('boleto-1'), 'kind', 'boleto', 'fields', '{}'))).id, (select v from ids where k = 'b1'),
          'o mesmo arquivo não entra duas vezes (devolve o que já está na caixa)');
insert into ids select 'b1t', (fin.doc_inbox_confirm((select v from ids where k = 'b1'))).target_id;
select is((select t.total_amount::text || '|' || t.party_id::text || '|' || t.approval_status from fin.titles t where t.id = (select v from ids where k = 'b1t')),
          '320.50|00000000-0000-4000-8000-000000000712|DRAFT', 'confirmar cria a conta a pagar em rascunho, com o favorecido achado pelo CNPJ');
select is((select barcode || '|' || due_date from fin.title_installments where title_id = (select v from ids where k = 'b1t')),
          '83640000003205000000000000000000000000000000|2026-11-10', 'parcela com o código de barras e o vencimento lidos');
select is((select count(*)::int from core.attachments where entity_type = 'fin.titles' and entity_id = (select v from ids where k = 'b1t')), 1, 'o boleto fica anexado à conta');
select is((select status from fin.doc_inbox where id = (select v from ids where k = 'b1')), 'DONE', 'o documento sai da fila');

-- duplicado: outra foto do mesmo boleto
insert into ids select 'b2', (fin.doc_inbox_add(jsonb_build_object('sha256', pg_temp.sha('boleto-2'), 'kind', 'boleto',
  'fields', jsonb_build_object('valor', 320.5, 'vencimento', '2026-11-10', 'codigo_barras', '83640000003205000000000000000000000000000000')))).id;
select ok((select duplicate ->> 'tipo' like '%mesmo código de barras%' from fin.doc_inbox where id = (select v from ids where k = 'b2')), 'outra foto do mesmo boleto é apontada como duplicada');
select throws_ok($$ select fin.doc_inbox_confirm((select v from ids where k = 'b2')) $$, 'P0473', null, 'duplicado não é lançado sem a pessoa insistir');
select is((fin.doc_inbox_discard((select v from ids where k = 'b2'))), null, 'descartar devolve o arquivo a apagar (nenhum aqui)');
select is((select status from fin.doc_inbox where id = (select v from ids where k = 'b2')), 'DISCARDED', 'descartado');

-- ---------- XML de mercadoria → recebimento ----------
insert into ids select 'x1', (fin.doc_inbox_add(jsonb_build_object('sha256', pg_temp.sha(pg_temp.nfe(7801)), 'kind', 'nfe_xml', 'xml', pg_temp.nfe(7801)))).id;
select is((select destination || '|' || (fields ->> 'valor_total') || '|' || label from fin.doc_inbox where id = (select v from ids where k = 'x1')),
          'RECEIPT|2340.00|NF-e 7801 de Alfa Confecções', 'XML de roupa vai para o recebimento, com os campos lidos do próprio XML');
select ok((fin.doc_inbox_confirm((select v from ids where k = 'x1'))).target_label like 'Recebimento RCB-%', 'confirmar importa a nota no recebimento');
select ok(exists (select 1 from purch.receipts r join fiscal.documents d on d.id = r.document_id where d.access_key = (select fields ->> 'chave_acesso' from fin.doc_inbox where id = (select v from ids where k = 'x1'))),
          'o recebimento existe com o documento fiscal da nota');

-- ---------- XML de despesa → conta a pagar com as duplicatas ----------
insert into ids select 'x2', (fin.doc_inbox_add(jsonb_build_object('sha256', pg_temp.sha(pg_temp.nfe(7802, '85176299')), 'kind', 'nfe_xml', 'xml', pg_temp.nfe(7802, '85176299')))).id;
select is((select destination from fin.doc_inbox where id = (select v from ids where k = 'x2')), 'PAYABLE', 'XML que não é mercadoria de moda vira conta a pagar');
insert into ids select 'x2t', (fin.doc_inbox_confirm((select v from ids where k = 'x2'))).target_id;
select is((select string_agg(amount::text || '@' || due_date, ',' order by n) from fin.title_installments where title_id = (select v from ids where k = 'x2t')),
          '1170.00@2026-10-15,1170.00@2026-11-14', 'as parcelas são as duplicatas da nota');

-- ---------- Foto de cupom → reembolso para quem enviou ----------
insert into ids select 'r1', (fin.doc_inbox_add(jsonb_build_object('sha256', pg_temp.sha('cupom-1'), 'kind', 'nota_ou_recibo', 'label', 'Comprovante de Papelaria', 'file_name', 'cupom.jpg',
  'storage_path', '00000000-0000-4000-8000-000000000001/caixa/cupom.jpg',
  'fields', jsonb_build_object('emitente', 'Papelaria', 'emitente_cnpj', '12345678000195', 'valor_total', 45.9, 'data', (private.today_sp() - 3)::text, 'descricao', 'Sacolas')))).id;
select is((select destination from fin.doc_inbox where id = (select v from ids where k = 'r1')), 'REIMBURSEMENT', 'foto de cupom vira pedido de reembolso');
insert into ids select 'r1t', (fin.doc_inbox_confirm((select v from ids where k = 'r1'))).target_id;
select is((select r.status || '|' || r.total || '|' || i.document_kind || '|' || i.attachment_path from fin.reimbursements r join fin.reimbursement_items i on i.reimbursement_id = r.id
           where r.id = (select v from ids where k = 'r1t')),
          'SUBMITTED|45.90|CUPOM|00000000-0000-4000-8000-000000000001/caixa/cupom.jpg', 'o reembolso sai enviado para aprovação, com o cupom anexado');

-- ---------- Identidade e revisão ----------
insert into ids select 'id1', (fin.doc_inbox_add(jsonb_build_object('sha256', pg_temp.sha('rg-1'), 'kind', 'identidade', 'storage_path', '00000000-0000-4000-8000-000000000001/caixa/rg.jpg',
  'fields', jsonb_build_object('nome', 'Fulana', 'cpf', '12345678909')))).id;
select is((select destination || '|' || fields::text || '|' || coalesce(storage_path, '-') from fin.doc_inbox where id = (select v from ids where k = 'id1')), 'REVIEW|{}|-',
          'identidade vai para revisão e nada dela fica guardado');
select throws_ok($$ select fin.doc_inbox_confirm((select v from ids where k = 'id1')) $$, 'P0472', null, 'em revisão, é preciso escolher o destino');
select throws_ok($$ select fin.doc_inbox_add('{"sha256":"x","kind":"boleto"}') $$, 'P0470', null, 'entrada sem sha256 válido é recusada');
select throws_ok($$ select fin.doc_inbox_add(jsonb_build_object('sha256', pg_temp.sha('fora'), 'kind', 'boleto', 'storage_path', 'outra-org/caixa/x.jpg')) $$, 'P0470', null,
                 'arquivo fora da pasta da empresa é recusado');

-- ---------- Vendedora ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');
select is((select count(*)::int from fin.doc_inbox), 0, 'a vendedora não vê os documentos dos outros');
insert into ids select 'v1', (fin.doc_inbox_add(jsonb_build_object('sha256', pg_temp.sha('boleto-vend'), 'kind', 'boleto',
  'fields', jsonb_build_object('valor', 10, 'vencimento', '2026-11-30')))).id;
select is((select count(*)::int from fin.doc_inbox), 1, 'a vendedora vê o que ela mesma mandou');
select throws_ok($$ select fin.doc_inbox_confirm((select v from ids where k = 'v1')) $$, '42501', null, 'sem fin.write, a vendedora não lança conta a pagar');

select * from finish();
rollback;
