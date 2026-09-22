"""
Módulo de parsing e conferência de XML de NF-e (Nota Fiscal Eletrônica) para o ERP SIÉ Joy OS.
Compatível com o layout padrão SEFAZ NF-e 4.00 e pedidos eletrônicos de faturamento.
"""

import xml.etree.ElementTree as ET
import re

def clean_cnpj(cnpj_str):
    if not cnpj_str:
        return ""
    return re.sub(r"[^\d]", "", str(cnpj_str))

def format_cnpj(digits):
    d = clean_cnpj(digits)
    if len(d) == 14:
        return f"{d[:2]}.{d[2:5]}.{d[5:8]}/{d[8:12]}-{d[12:]}"
    return digits

def parse_nfe_xml(xml_content):
    """
    Realiza o parsing de uma NF-e em XML e extrai:
    - Dados da NF (chave, número, série, data emissão, valor total)
    - Emitente (CNPJ, Razão Social, Nome Fantasia, IE)
    - Destinatário (CNPJ, Razão Social, Endereço, Cidade, UF)
    - Itens de Produto (cProd, xProd, NCM, CFOP, uCom, qCom, vUnCom, vProd)
    - Duplicatas / Faturas se houver
    """
    if isinstance(xml_content, bytes):
        xml_content = xml_content.decode("utf-8", errors="replace")

    # Remove namespaces padrão do SEFAZ para facilitar a busca de tags
    # ex: xmlns="http://www.portalfiscal.inf.br/nfe"
    xml_cleaned = re.sub(r'\sxmlns="[^"]+"', '', xml_content, count=1)
    xml_cleaned = re.sub(r'\sxmlns:xsi="[^"]+"', '', xml_cleaned)
    xml_cleaned = re.sub(r'\sxmlns:xsd="[^"]+"', '', xml_cleaned)

    root = ET.fromstring(xml_cleaned)

    # Localizar infNFe
    inf_nfe = root.find(".//infNFe")
    if inf_nfe is None:
        inf_nfe = root

    # Chave de acesso
    access_key = inf_nfe.attrib.get("Id", "")
    if access_key.startswith("NFe"):
        access_key = access_key[3:]

    # Identificação da Nota (ide)
    ide = inf_nfe.find("ide")
    n_nf = ide.findtext("nNF", "") if ide is not None else ""
    serie = ide.findtext("serie", "1") if ide is not None else "1"
    dh_emi = ide.findtext("dhEmi", "") or ide.findtext("dEmi", "") if ide is not None else ""
    issue_date = dh_emi[:10] if dh_emi else ""

    # Emitente (Fornecedor)
    emit = inf_nfe.find("emit")
    emit_cnpj = emit.findtext("CNPJ", "") if emit is not None else ""
    emit_name = emit.findtext("xNome", "Fornecedor") if emit is not None else "Fornecedor"
    emit_fantasy = emit.findtext("xFant", emit_name) if emit is not None else emit_name
    emit_ie = emit.findtext("IE", "") if emit is not None else ""

    # Destinatário (Quem está recebendo a mercadoria)
    dest = inf_nfe.find("dest")
    dest_cnpj = dest.findtext("CNPJ", "") if dest is not None else ""
    dest_name = dest.findtext("xNome", "") if dest is not None else ""
    ender_dest = dest.find("enderDest") if dest is not None else None
    
    dest_address = ""
    dest_city = ""
    dest_uf = ""
    if ender_dest is not None:
        logr = ender_dest.findtext("xLgr", "")
        nro = ender_dest.findtext("nro", "")
        bairro = ender_dest.findtext("xBairro", "")
        dest_city = ender_dest.findtext("xMun", "")
        dest_uf = ender_dest.findtext("UF", "")
        dest_address = f"{logr}, {nro} - {bairro}, {dest_city}/{dest_uf}".strip(", -")

    # Totais
    total_val = 0.0
    total_tag = inf_nfe.find(".//total/ICMSTot")
    if total_tag is not None:
        try:
            total_val = float(total_tag.findtext("vNF", "0.0"))
        except ValueError:
            total_val = 0.0

    # Itens / Produtos (det)
    items = []
    default_markup = 2.4

    for idx, det in enumerate(inf_nfe.findall(".//det")):
        prod = det.find("prod")
        if prod is None:
            continue

        c_prod = prod.findtext("cProd", f"SKU-{idx+1}")
        x_prod = prod.findtext("xProd", f"Item #{idx+1}")
        ncm = prod.findtext("NCM", "")
        cfop = prod.findtext("CFOP", "")
        u_com = prod.findtext("uCom", "UN")
        
        try:
            q_com = float(prod.findtext("qCom", "1.0"))
        except ValueError:
            q_com = 1.0

        try:
            v_un_com = float(prod.findtext("vUnCom", "0.0"))
        except ValueError:
            v_un_com = 0.0

        try:
            v_prod = float(prod.findtext("vProd", str(round(q_com * v_un_com, 2))))
        except ValueError:
            v_prod = round(q_com * v_un_com, 2)

        # Cálculo do preço sugerido por markup padrão
        suggested_price = round(v_un_com * default_markup, 2)
        gross_margin_val = round(suggested_price - v_un_com, 2)
        gross_margin_pct = round((gross_margin_val / suggested_price * 100), 1) if suggested_price > 0 else 0.0

        items.append({
            "itemIndex": idx + 1,
            "cProd": c_prod,
            "xProd": x_prod,
            "ncm": ncm,
            "cfop": cfop,
            "uCom": u_com,
            "quantity": q_com,
            "unitCost": v_un_com,
            "totalCost": v_prod,
            "markup": default_markup,
            "salePrice": suggested_price,
            "grossMarginVal": gross_margin_val,
            "grossMarginPct": gross_margin_pct
        })

    # Duplicatas / Cobrança
    installments = []
    cobr = inf_nfe.find(".//cobr")
    if cobr is not None:
        for dup in cobr.findall(".//dup"):
            n_dup = dup.findtext("nDup", "")
            d_venc = dup.findtext("dVenc", "")
            try:
                v_dup = float(dup.findtext("vDup", "0.0"))
            except ValueError:
                v_dup = 0.0
            installments.append({
                "number": n_dup,
                "dueDate": d_venc,
                "amount": v_dup
            })

    return {
        "nfeInfo": {
            "accessKey": access_key,
            "number": n_nf,
            "series": serie,
            "issueDate": issue_date,
            "totalAmount": total_val
        },
        "supplier": {
            "cnpj": format_cnpj(emit_cnpj),
            "rawCnpj": clean_cnpj(emit_cnpj),
            "name": emit_name,
            "fantasyName": emit_fantasy,
            "ie": emit_ie
        },
        "destination": {
            "cnpj": format_cnpj(dest_cnpj),
            "rawCnpj": clean_cnpj(dest_cnpj),
            "name": dest_name,
            "address": dest_address,
            "city": dest_city,
            "uf": dest_uf
        },
        "items": items,
        "installments": installments
    }

def match_nfe_destination(nfe_dest, cnpjs_and_stores_data):
    """
    Cruza as informações do destinatário com a lista de CNPJs e Lojas cadastradas.
    Retorna o CNPJ correspondente, a Loja sugerida e status de conferência.
    """
    dest_raw_cnpj = clean_cnpj(nfe_dest.get("rawCnpj", ""))
    cnpjs = cnpjs_and_stores_data.get("cnpjs", [])
    stores = cnpjs_and_stores_data.get("stores", [])

    matched_cnpj = None
    for c in cnpjs:
        if clean_cnpj(c.get("cnpj", "")) == dest_raw_cnpj:
            matched_cnpj = c
            break

    # Se não bateu pelo CNPJ exato, tenta por proximidade de razão social
    if not matched_cnpj and dest_raw_cnpj:
        for c in cnpjs:
            if "SIE" in c.get("razaoSocial", "").upper() and "SIE" in nfe_dest.get("name", "").upper():
                matched_cnpj = c
                break

    matched_store = None
    if matched_cnpj:
        # Busca lojas vinculadas a esse CNPJ
        linked_stores = [s for s in stores if s.get("cnpjId") == matched_cnpj["id"]]
        # Verifica se o endereço da NF cita cidade/local da loja
        dest_addr_upper = (nfe_dest.get("address", "") + " " + nfe_dest.get("city", "")).upper()
        for s in linked_stores:
            s_city = s.get("city", "").upper().split("/")[0]
            if s_city and s_city in dest_addr_upper:
                matched_store = s
                break
        if not matched_store and linked_stores:
            matched_store = linked_stores[0] # Default primeira loja do CNPJ

    is_valid = matched_cnpj is not None

    return {
        "isValid": is_valid,
        "matchedCnpjId": matched_cnpj["id"] if matched_cnpj else "cnpj-01",
        "matchedCnpjNumber": matched_cnpj["cnpj"] if matched_cnpj else nfe_dest.get("cnpj"),
        "matchedCnpjName": matched_cnpj["nomeFantasia"] if matched_cnpj else "Não identificado no grupo",
        "matchedStoreId": matched_store["id"] if matched_store else "store-01",
        "matchedStoreName": matched_store["name"] if matched_store else "Boutique JOY Club - Centro Floripa",
        "confidence": "HIGH" if (matched_cnpj and matched_store) else ("MEDIUM" if matched_cnpj else "LOW"),
        "statusMessage": (
            f"✅ Destinatário conferido com sucesso: {matched_cnpj['nomeFantasia']} ({matched_cnpj['cnpj']}) • Loja sugerida: {matched_store['name']}"
            if (matched_cnpj and matched_store) else
            "⚠️ Destinatário não corresponde com precisão a nenhum CNPJ cadastrado. Por favor, confira a unidade receptora."
        )
    }
