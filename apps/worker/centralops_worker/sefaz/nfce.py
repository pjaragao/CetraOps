"""Monta e assina a NFC-e (modelo 65, leiaute 4.00 — MOC 7.0 / PL_010) a partir do payload de `fiscal.emission_payload`.
Escopo: venda a consumidor final dentro da UF, emitente do Simples Nacional (CRT 1/4, CSOSN 102/103/300/400/500), emissão normal (tpEmis 1).
Nada é inventado: falta de NCM, CFOP, IE ou pagamento interrompe a emissão com a explicação."""
from __future__ import annotations

import hashlib
import re
import secrets
import unicodedata
from dataclasses import dataclass, field
from datetime import datetime
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from lxml import etree

from ..adapters.errors import PermanentError
from . import xmldsig
from .certificate import A1Certificate
from .endpoints import CUF, nfce_qr_base

NFE = "http://www.portalfiscal.inf.br/nfe"
HOMOLOG_XPROD = "NOTA FISCAL EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL"
VER_PROC = "CetraOps 1.0"
CARD_TPAG = {"03", "04", "10", "11", "15", "17", "18"}     # grupo <card> (tpIntegra=2, POS não integrado) nos meios eletrônicos
CSOSN_SN102 = {"102", "103", "300", "400"}
PAG_LABEL = {"01": "Dinheiro", "02": "Cheque", "03": "Cartão de Crédito", "04": "Cartão de Débito", "05": "Crédito Loja", "10": "Vale Alimentação",
             "11": "Vale Refeição", "12": "Vale Presente", "13": "Vale Combustível", "15": "Boleto Bancário", "16": "Depósito Bancário", "17": "PIX",
             "18": "Transferência bancária", "19": "Programa de fidelidade", "90": "Sem pagamento", "99": "Outros"}

C2 = Decimal("0.01")


def dec(v: Any) -> Decimal:
    try:
        return Decimal(str(v if v not in (None, "") else 0))
    except Exception as e:  # noqa: BLE001
        raise PermanentError(f"Valor numérico inválido: {v!r}") from e


def m2(v: Decimal) -> str:
    return str(v.quantize(C2, ROUND_HALF_UP))


def digits(v: Any) -> str:
    return re.sub(r"\D", "", str(v or ""))


def text(v: Any, size: int) -> str:
    """Texto aceito pelo schema (TString): sem controle, sem espaço duplo nem nas pontas, cortado no tamanho."""
    s = unicodedata.normalize("NFC", str(v or ""))
    s = re.sub(r"[\x00-\x1f\x7f]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s[:size].strip()


@dataclass
class Emitter:
    cnpj: str
    razao_social: str
    ie: str
    crt: int
    street: str
    number: str
    district: str
    city: str
    cmun: str
    uf: str
    cep: str
    complement: str = ""
    fantasia: str = ""
    phone: str = ""

    def check(self) -> None:
        missing = [label for label, ok in (("CNPJ", len(digits(self.cnpj)) == 14), ("razão social", bool(self.razao_social.strip())),
                                           ("inscrição estadual", bool(digits(self.ie))), ("logradouro", bool(self.street.strip())),
                                           ("número", bool(self.number.strip())), ("bairro", bool(self.district.strip())), ("cidade", bool(self.city.strip())),
                                           ("código IBGE do município (7 dígitos)", len(digits(self.cmun)) == 7), ("UF", self.uf.upper() in CUF),
                                           ("CEP", len(digits(self.cep)) == 8)) if not ok]
        if missing:
            raise PermanentError("Cadastro do emitente incompleto para a NFC-e: " + ", ".join(missing))
        if self.crt not in (1, 4):
            raise PermanentError("Emissão direta preparada para o Simples Nacional (CRT 1 ou 4): o regime da empresa pede revisão da matriz fiscal com o contador")


@dataclass
class RespTec:
    cnpj: str
    contato: str
    email: str
    fone: str


@dataclass
class TaxApprox:
    """Lei 12.741/2012: carga tributária aproximada (% sobre o valor do item), da tabela do IBPT ou do contador. Em branco: não informa."""
    federal: Decimal = Decimal(0)
    estadual: Decimal = Decimal(0)
    municipal: Decimal = Decimal(0)
    fonte: str = ""

    @property
    def total_pct(self) -> Decimal:
        return self.federal + self.estadual + self.municipal


@dataclass
class NfceBuild:
    xml: str
    access_key: str
    qr_url: str
    url_chave: str
    vnf: Decimal
    danfe: dict[str, Any] = field(default_factory=dict)


def dv_mod11(base: str) -> int:
    total, weight = 0, 2
    for ch in reversed(base):
        total += int(ch) * weight
        weight = 2 if weight == 9 else weight + 1
    r = total % 11
    return 0 if r in (0, 1) else 11 - r


def access_key(cuf: int, dh: datetime, cnpj: str, model: int, series: int, number: int, tp_emis: int, cnf: int) -> str:
    base = f"{cuf:02d}{dh:%y%m}{digits(cnpj):0>14}{model:02d}{series:03d}{number:09d}{tp_emis}{cnf:08d}"
    return base + str(dv_mod11(base))


def new_cnf(number: int) -> int:
    """Código numérico aleatório (8 dígitos), diferente do número da nota (regra da chave de acesso)."""
    while True:
        c = secrets.randbelow(99_999_999) + 1
        if c != number:
            return c


def qr_code(base_url: str, key: str, tp_amb: int, csc_id: str | None = None, csc_token: str | None = None) -> str:
    """QR Code da NFC-e emitida on-line. Versão 3 (NT 2025.001): só chave|3|tpAmb, sem CSC.
    Com CSC informado, versão 2 (Manual do DANFE NFC-e v5): chave|2|tpAmb|idCSC|SHA1(chave|2|tpAmb|idCSC + CSC)."""
    if csc_id and csc_token:
        seq = f"{key}|2|{tp_amb}|{int(digits(csc_id))}"
        h = hashlib.sha1((seq + csc_token.strip()).encode()).hexdigest().upper()  # noqa: S324 — exigido pelo manual
        return f"{base_url}?p={seq}|{h}"
    return f"{base_url}?p={key}|3|{tp_amb}"


def _sub(parent: etree._Element, tag: str, value: Any = None, **attrs: str) -> etree._Element:
    el = etree.SubElement(parent, f"{{{NFE}}}{tag}", **attrs)
    if value is not None:
        el.text = str(value)
    return el


def _items(document: dict[str, Any]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for i, it in enumerate(document.get("itens") or [], start=1):
        desc = text(it.get("descricao"), 120)
        ncm, cfop = digits(it.get("codigo_ncm")), digits(it.get("cfop"))
        if len(ncm) != 8:
            raise PermanentError(f"Item «{desc}» sem NCM de 8 dígitos")
        if len(cfop) != 4 or cfop[0] != "5":
            raise PermanentError(f"Item «{desc}» com CFOP {cfop or 'vazio'}: NFC-e é venda dentro do estado (CFOP 5xxx)")
        q = dec(it.get("quantidade_comercial"))
        vun = dec(it.get("valor_unitario_comercial"))
        vprod = dec(it.get("valor_bruto")) or (q * vun)
        vprod = vprod.quantize(C2, ROUND_HALF_UP)
        if q <= 0 or vprod <= 0:
            raise PermanentError(f"Item «{desc}» com quantidade ou valor zerado")
        desconto = dec(it.get("valor_desconto")).quantize(C2, ROUND_HALF_UP)
        csosn = str(it.get("icms_situacao_tributaria") or "102").strip()
        if csosn not in CSOSN_SN102 and csosn != "500":
            raise PermanentError(f"Item «{desc}» com CSOSN {csosn}: a emissão direta trata 102, 103, 300, 400 e 500")
        out.append({"n": i, "cProd": text(it.get("codigo_produto") or f"ITEM{i}", 60), "xProd": desc, "NCM": ncm, "CFOP": cfop,
                    "uCom": text(it.get("unidade_comercial") or "UN", 6), "qCom": q, "vUnCom": vun, "vProd": vprod,
                    "vDesc": max(desconto, Decimal(0)), "vOutro": max(-desconto, Decimal(0)), "vFrete": Decimal(0),
                    "orig": int(it.get("icms_origem") or 0), "CSOSN": csosn})
    if not out:
        raise PermanentError("Nota sem itens")
    return out


def _payments(document: dict[str, Any]) -> list[dict[str, Any]]:
    pays = []
    for p in document.get("formas_pagamento") or []:
        t = digits(p.get("forma_pagamento") or "99").zfill(2)
        v = dec(p.get("valor_pagamento")).quantize(C2, ROUND_HALF_UP)
        if v > 0:
            pays.append({"tPag": t, "vPag": v, "xPag": text(p.get("descricao_pagamento") or "Outros", 60) if t == "99" else None})
    if not pays:
        raise PermanentError("Nota sem forma de pagamento registrada")
    return pays


def build_nfce(document: dict[str, Any], emitter: Emitter, *, tp_amb: int, series: int, number: int, cnf: int, dh_emi: datetime,
               cert: A1Certificate, resp_tec: RespTec | None = None, csc_id: str | None = None, csc_token: str | None = None,
               inf_cpl: str | None = None, taxes: TaxApprox | None = None) -> NfceBuild:
    emitter.check()
    uf = emitter.uf.upper()
    cuf = CUF[uf]
    items = _items(document)
    pays = _payments(document)

    frete = dec(document.get("valor_frete")).quantize(C2, ROUND_HALF_UP)
    if frete > 0:                                                          # rateio proporcional; o último item leva a sobra dos centavos
        base_total = sum((i["vProd"] - i["vDesc"] for i in items), Decimal(0))
        left = frete
        for i in items[:-1]:
            share = (frete * (i["vProd"] - i["vDesc"]) / base_total).quantize(C2, ROUND_HALF_UP) if base_total > 0 else Decimal(0)
            i["vFrete"], left = share, left - share
        items[-1]["vFrete"] = left

    vprod = sum((i["vProd"] for i in items), Decimal(0))
    vdesc = sum((i["vDesc"] for i in items), Decimal(0))
    vfrete = sum((i["vFrete"] for i in items), Decimal(0))
    voutro = sum((i["vOutro"] for i in items), Decimal(0))
    vnf = vprod - vdesc + vfrete + voutro
    use_tax = taxes is not None and taxes.total_pct > 0
    paid = sum((p["vPag"] for p in pays), Decimal(0))
    gap = vnf - paid
    if Decimal(0) < gap <= Decimal("0.05"):                               # centavos do rateio do cupom: vão para o desconto do maior item
        big = max(items, key=lambda i: i["vProd"] - i["vDesc"])
        big["vDesc"] += gap
        vdesc += gap
        vnf = paid
    elif gap > 0:
        raise PermanentError(f"Pagamentos (R$ {m2(paid)}) menores que o total da nota (R$ {m2(vnf)}): confira o pedido")
    troco = paid - vnf

    key = access_key(cuf, dh_emi, emitter.cnpj, 65, series, number, 1, cnf)
    dh = dh_emi.isoformat(timespec="seconds")
    dest_cpf = digits(document.get("cpf_destinatario"))
    ind_pres = int(document.get("presenca_comprador") or 1)
    if ind_pres not in (1, 4):
        ind_pres = 1
    mod_frete = int(document.get("modalidade_frete") if document.get("modalidade_frete") is not None else 9) if ind_pres == 4 else 9

    nfe = etree.Element(f"{{{NFE}}}NFe", nsmap={None: NFE})
    inf = _sub(nfe, "infNFe", versao="4.00", Id=f"NFe{key}")
    ide = _sub(inf, "ide")
    for tag, val in (("cUF", cuf), ("cNF", f"{cnf:08d}"), ("natOp", text(document.get("natureza_operacao") or "VENDA AO CONSUMIDOR", 60)), ("mod", 65),
                     ("serie", series), ("nNF", number), ("dhEmi", dh), ("tpNF", 1), ("idDest", 1), ("cMunFG", digits(emitter.cmun)), ("tpImp", 4),
                     ("tpEmis", 1), ("cDV", key[-1]), ("tpAmb", tp_amb), ("finNFe", 1), ("indFinal", 1), ("indPres", ind_pres), ("indIntermed", 0),
                     ("procEmi", 0), ("verProc", VER_PROC)):
        _sub(ide, tag, val)

    emit = _sub(inf, "emit")
    _sub(emit, "CNPJ", digits(emitter.cnpj))
    _sub(emit, "xNome", text(emitter.razao_social, 60))
    if emitter.fantasia.strip():
        _sub(emit, "xFant", text(emitter.fantasia, 60))
    ender = _sub(emit, "enderEmit")
    _sub(ender, "xLgr", text(emitter.street, 60))
    _sub(ender, "nro", text(emitter.number, 60))
    if emitter.complement.strip():
        _sub(ender, "xCpl", text(emitter.complement, 60))
    for tag, val in (("xBairro", text(emitter.district, 60)), ("cMun", digits(emitter.cmun)), ("xMun", text(emitter.city, 60)), ("UF", uf),
                     ("CEP", digits(emitter.cep)), ("cPais", 1058), ("xPais", "Brasil")):
        _sub(ender, tag, val)
    if 6 <= len(digits(emitter.phone)) <= 14:
        _sub(ender, "fone", digits(emitter.phone))
    _sub(emit, "IE", digits(emitter.ie))
    _sub(emit, "CRT", emitter.crt)

    if dest_cpf:
        if len(dest_cpf) != 11:
            raise PermanentError("CPF na nota com quantidade de dígitos errada")
        dest = _sub(inf, "dest")
        _sub(dest, "CPF", dest_cpf)
        _sub(dest, "indIEDest", 9)

    for i in items:
        det = _sub(inf, "det", nItem=str(i["n"]))
        prod = _sub(det, "prod")
        xprod = HOMOLOG_XPROD if tp_amb == 2 and i["n"] == 1 else i["xProd"]
        for tag, val in (("cProd", i["cProd"]), ("cEAN", "SEM GTIN"), ("xProd", xprod), ("NCM", i["NCM"]), ("CFOP", i["CFOP"]), ("uCom", i["uCom"]),
                         ("qCom", f"{i['qCom']:.4f}"), ("vUnCom", f"{i['vUnCom']:.2f}" if i["vUnCom"] == i["vUnCom"].quantize(C2) else f"{i['vUnCom']:.10f}"),
                         ("vProd", m2(i["vProd"])), ("cEANTrib", "SEM GTIN"), ("uTrib", i["uCom"]), ("qTrib", f"{i['qCom']:.4f}"),
                         ("vUnTrib", f"{i['vUnCom']:.2f}" if i["vUnCom"] == i["vUnCom"].quantize(C2) else f"{i['vUnCom']:.10f}")):
            _sub(prod, tag, val)
        if i["vFrete"] > 0:
            _sub(prod, "vFrete", m2(i["vFrete"]))
        if i["vDesc"] > 0:
            _sub(prod, "vDesc", m2(i["vDesc"]))
        if i["vOutro"] > 0:
            _sub(prod, "vOutro", m2(i["vOutro"]))
        _sub(prod, "indTot", 1)
        imp = _sub(det, "imposto")
        if use_tax:
            i["vTotTrib"] = ((i["vProd"] - i["vDesc"] + i["vOutro"]) * taxes.total_pct / 100).quantize(C2, ROUND_HALF_UP)  # type: ignore[union-attr]
            _sub(imp, "vTotTrib", m2(i["vTotTrib"]))
        icms = _sub(imp, "ICMS")
        grp = _sub(icms, "ICMSSN500" if i["CSOSN"] == "500" else "ICMSSN102")
        _sub(grp, "orig", i["orig"])
        _sub(grp, "CSOSN", i["CSOSN"])

    tot = _sub(_sub(inf, "total"), "ICMSTot")
    for tag, val in (("vBC", 0), ("vICMS", 0), ("vICMSDeson", 0), ("vFCP", 0), ("vBCST", 0), ("vST", 0), ("vFCPST", 0), ("vFCPSTRet", 0),
                     ("vProd", vprod), ("vFrete", vfrete), ("vSeg", 0), ("vDesc", vdesc), ("vII", 0), ("vIPI", 0), ("vIPIDevol", 0), ("vPIS", 0),
                     ("vCOFINS", 0), ("vOutro", voutro), ("vNF", vnf)):
        _sub(tot, tag, m2(Decimal(val)))
    trib: dict[str, str] | None = None
    if use_tax:
        _sub(tot, "vTotTrib", m2(sum((i["vTotTrib"] for i in items), Decimal(0))))
        base = vprod - vdesc + voutro
        part = lambda pct: m2(base * pct / 100)  # noqa: E731
        trib = {"federal": part(taxes.federal), "estadual": part(taxes.estadual), "municipal": part(taxes.municipal),  # type: ignore[union-attr]
                "total": m2(sum((i["vTotTrib"] for i in items), Decimal(0))), "fonte": text(taxes.fonte, 60)}  # type: ignore[union-attr]

    _sub(_sub(inf, "transp"), "modFrete", mod_frete)

    pag = _sub(inf, "pag")
    for p in pays:
        dp = _sub(pag, "detPag")
        _sub(dp, "tPag", p["tPag"])
        if p["xPag"]:
            _sub(dp, "xPag", p["xPag"])
        _sub(dp, "vPag", m2(p["vPag"]))
        if p["tPag"] in CARD_TPAG:
            _sub(_sub(dp, "card"), "tpIntegra", 2)
    if troco > 0:
        _sub(pag, "vTroco", m2(troco))

    if inf_cpl:
        _sub(_sub(inf, "infAdic"), "infCpl", text(inf_cpl, 5000))

    if resp_tec and len(digits(resp_tec.cnpj)) == 14 and resp_tec.email.strip() and 6 <= len(digits(resp_tec.fone)) <= 14:
        rt = _sub(inf, "infRespTec")
        _sub(rt, "CNPJ", digits(resp_tec.cnpj))
        _sub(rt, "xContato", text(resp_tec.contato or emitter.razao_social, 60))
        _sub(rt, "email", text(resp_tec.email, 60))
        _sub(rt, "fone", digits(resp_tec.fone))

    base_qr = nfce_qr_base(uf, tp_amb)
    qr = qr_code(base_qr, key, tp_amb, csc_id, csc_token)
    supl = _sub(nfe, "infNFeSupl")
    _sub(supl, "qrCode", qr)
    _sub(supl, "urlChave", base_qr)
    nfe = xmldsig.sign(nfe, f"NFe{key}", cert)

    danfe = {
        "emit": {"razao_social": emitter.razao_social, "fantasia": emitter.fantasia, "cnpj": digits(emitter.cnpj), "ie": digits(emitter.ie),
                 "endereco": ", ".join(x for x in (f"{emitter.street}, {emitter.number}", emitter.complement, emitter.district, f"{emitter.city}/{uf}") if x.strip())},
        "items": [{"codigo": i["cProd"], "descricao": HOMOLOG_XPROD if tp_amb == 2 and i["n"] == 1 else i["xProd"], "qtd": str(i["qCom"].normalize()),
                   "un": i["uCom"], "vun": m2(i["vUnCom"]), "vtot": m2(i["vProd"])} for i in items],
        "vProd": m2(vprod), "vDesc": m2(vdesc), "vFrete": m2(vfrete), "vOutro": m2(voutro), "vNF": m2(vnf), "troco": m2(troco),
        "pagamentos": [{"tPag": p["tPag"], "label": p["xPag"] or PAG_LABEL.get(p["tPag"], "Outros"), "valor": m2(p["vPag"])} for p in pays],
        "access_key": key, "number": number, "series": series, "dh_emi": dh, "tp_amb": tp_amb, "qr_url": qr, "url_chave": base_qr,
        "cpf": dest_cpf or None, "tributos": trib,
    }
    xml = etree.tostring(nfe, encoding="unicode")
    return NfceBuild(xml=xml, access_key=key, qr_url=qr, url_chave=base_qr, vnf=vnf, danfe=danfe)
