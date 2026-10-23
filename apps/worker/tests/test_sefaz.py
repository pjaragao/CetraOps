"""Emissão direta na SEFAZ: XML conferido contra os schemas oficiais (PL_010 v1.30), assinatura conferida por uma biblioteca
independente (signxml) e o diálogo SOAP simulado com respostas no formato dos manuais."""
from __future__ import annotations

import base64
import datetime as dt
import gzip
import re
from decimal import Decimal
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx
import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import pkcs12
from cryptography.x509.oid import NameOID
from lxml import etree

from centralops_worker.adapters.errors import PermanentError
from centralops_worker.sefaz import nfce
from centralops_worker.sefaz.certificate import A1Certificate
from centralops_worker.sefaz.client import SefazClient, SefazNetworkError, nfe_proc, parse_dfe_doc

SCHEMAS = Path(__file__).parent / "schemas" / "PL_010_V1.30"
NFE = "http://www.portalfiscal.inf.br/nfe"
CNPJ = "69510606000173"
TZ = ZoneInfo("America/Sao_Paulo")


def _schema(name: str) -> etree.XMLSchema:
    return etree.XMLSchema(etree.parse(str(SCHEMAS / name)))


def _pfx(cnpj: str = CNPJ, password: str = "senha123", days: int = 365) -> bytes:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COUNTRY_NAME, "BR"), x509.NameAttribute(NameOID.ORGANIZATION_NAME, "ICP-Brasil"),
                      x509.NameAttribute(NameOID.COMMON_NAME, f"LPO COMERCIO LTDA:{cnpj}")])
    now = dt.datetime.now(dt.UTC)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - dt.timedelta(days=max(1, -days + 1))).not_valid_after(now + dt.timedelta(days=days)).sign(key, hashes.SHA256()))
    return pkcs12.serialize_key_and_certificates(b"teste", key, cert, None, serialization.BestAvailableEncryption(password.encode()))


@pytest.fixture(scope="module")
def cert() -> A1Certificate:
    return A1Certificate.from_pfx(base64.b64encode(_pfx()).decode(), "senha123")


EMITTER = nfce.Emitter(cnpj=CNPJ, razao_social="LPO COMERCIO LTDA", fantasia="SIE JOY", ie="261234567", crt=1, street="Rua Madalena Barbi", number="160",
                       complement="apto 402", district="Centro", city="Florianópolis", cmun="4205407", uf="SC", cep="88015-190", phone="48999998888")
RESP = nfce.RespTec(cnpj=CNPJ, contato="Paulo", email="contato@example.com", fone="48999998888")


def _doc(**over: object) -> dict:
    d = {"natureza_operacao": "VENDA AO CONSUMIDOR", "presenca_comprador": 1, "modalidade_frete": 9, "cpf_destinatario": None,
         "itens": [{"codigo_produto": "TOP-PRT-M", "descricao": "Top Fitness  Preto M", "codigo_ncm": "61124100", "cfop": "5102", "unidade_comercial": "UN",
                    "quantidade_comercial": 2, "valor_unitario_comercial": 89.9, "valor_bruto": 179.8, "valor_desconto": 9.8, "icms_origem": 0,
                    "icms_situacao_tributaria": "102"},
                   {"codigo_produto": "LEG-AZ-P", "descricao": "Legging Azul P", "codigo_ncm": "61046300", "cfop": "5102", "unidade_comercial": "UN",
                    "quantidade_comercial": 1, "valor_unitario_comercial": 129.9, "valor_bruto": 129.9, "valor_desconto": 0, "icms_origem": 0,
                    "icms_situacao_tributaria": "102"}],
         "formas_pagamento": [{"forma_pagamento": "17", "valor_pagamento": 200.0}, {"forma_pagamento": "01", "valor_pagamento": 110.0}]}
    d.update(over)
    return d


def _build(cert: A1Certificate, doc: dict | None = None, tp_amb: int = 2, **kw: object) -> nfce.NfceBuild:
    return nfce.build_nfce(doc or _doc(), EMITTER, tp_amb=tp_amb, series=1, number=123, cnf=12345678, dh_emi=dt.datetime(2026, 10, 13, 15, 30, tzinfo=TZ),
                           cert=cert, resp_tec=RESP, inf_cpl="Pedido P-1001", **kw)


def _verify_signature(xml: str, ref_id: str, cert: A1Certificate) -> None:
    """Conferência independente do lxml: canonicalização da biblioteca padrão (xml.etree, C14N 2.0 — igual à 1.0 para estes documentos,
    sem comentários nem prefixos) + verificação RSA-SHA1 do cryptography, como faria a SEFAZ a partir do texto."""
    import hashlib
    import xml.etree.ElementTree as ET

    from cryptography.hazmat.primitives.asymmetric import padding

    ds = "{http://www.w3.org/2000/09/xmldsig#}"
    root = ET.fromstring(xml)
    sig = root.find(f"{ds}Signature")
    assert sig.find(f"{ds}SignedInfo/{ds}Reference").get("URI") == f"#{ref_id}"

    def canon(tag: str, ns: str) -> bytes:
        """Recorta o elemento do TEXTO recebido, declara nele o namespace herdado e canonicaliza o fragmento isolado."""
        m = re.search(rf"<{tag}\b[^>]*>.*?</{tag}>", xml, flags=re.S)
        frag = re.sub(rf"^<{tag}\b", f'<{tag} xmlns="{ns}"', m.group(0)) if "xmlns=" not in m.group(0).split(">", 1)[0] else m.group(0)
        return ET.canonicalize(frag).encode()

    signed_tag = next(e for e in root.iter() if e.get("Id") == ref_id).tag.split("}")[1]
    digest = base64.b64encode(hashlib.sha1(canon(signed_tag, NFE)).digest()).decode()
    assert sig.findtext(f"{ds}SignedInfo/{ds}Reference/{ds}DigestValue") == digest
    signed_info = canon("SignedInfo", "http://www.w3.org/2000/09/xmldsig#")
    x5 = x509.load_der_x509_certificate(base64.b64decode(sig.findtext(f"{ds}KeyInfo/{ds}X509Data/{ds}X509Certificate")))
    assert x5 == cert.cert
    x5.public_key().verify(base64.b64decode(sig.findtext(f"{ds}SignatureValue")), signed_info, padding.PKCS1v15(), hashes.SHA1())


def test_certificate_reads_cnpj_and_rejects_wrong_password() -> None:
    raw = _pfx()
    c = A1Certificate.from_pfx(raw, "senha123")
    assert c.cnpj == CNPJ and c.days_left() >= 364
    c.ensure_valid(CNPJ)
    with pytest.raises(PermanentError, match="CNPJ"):
        c.ensure_valid("11222333000181")
    with pytest.raises(PermanentError, match="senha"):
        A1Certificate.from_pfx(raw, "errada")
    with pytest.raises(PermanentError, match="vencido"):
        A1Certificate.from_pfx(_pfx(days=-2), "senha123").ensure_valid(CNPJ)


def test_ssl_context_loads_client_certificate(cert: A1Certificate) -> None:
    ctx = cert.ssl_context()
    assert ctx.verify_mode.name == "CERT_REQUIRED"
    assert any("Raiz Brasileira" in str(c.get("subject")) for c in ctx.get_ca_certs())


def test_access_key_check_digit() -> None:
    k = nfce.access_key(42, dt.datetime(2026, 10, 1), CNPJ, 65, 1, 123, 1, 12345678)
    assert len(k) == 44 and k.startswith("422610" + CNPJ + "65001000000123" + "1" + "12345678")
    total = sum(int(c) * w for c, w in zip(reversed(k[:43]), [2, 3, 4, 5, 6, 7, 8, 9] * 6, strict=False))
    assert int(k[-1]) == (0 if total % 11 < 2 else 11 - total % 11)


def test_nfce_is_valid_against_official_schema_and_signature_verifies(cert: A1Certificate) -> None:
    b = _build(cert, _doc(cpf_destinatario="123.456.789-09", presenca_comprador=4, modalidade_frete=0, valor_frete=15,
                          formas_pagamento=[{"forma_pagamento": "03", "valor_pagamento": 315.0}, {"forma_pagamento": "99", "valor_pagamento": 10.0}]))
    root = etree.fromstring(b.xml.encode())
    _schema("nfe_v4.00.xsd").assertValid(root)
    _verify_signature(b.xml, f"NFe{b.access_key}", cert)

    t = lambda path: root.findtext(path, namespaces={"n": NFE})  # noqa: E731
    assert t(".//n:ide/n:tpAmb") == "2" and t(".//n:ide/n:indPres") == "4" and t(".//n:transp/n:modFrete") == "0"
    assert t(".//n:det[@nItem='1']/n:prod/n:xProd") == nfce.HOMOLOG_XPROD                   # regra da homologação (item 1)
    assert t(".//n:ICMSTot/n:vProd") == "309.70" and t(".//n:ICMSTot/n:vDesc") == "9.80" and t(".//n:ICMSTot/n:vFrete") == "15.00"
    assert t(".//n:ICMSTot/n:vNF") == "314.90" and t(".//n:pag/n:vTroco") == "10.10"
    frete = [Decimal(e.text) for e in root.iterfind(".//n:prod/n:vFrete", namespaces={"n": NFE})]
    assert sum(frete) == Decimal("15.00")
    assert root.find(".//n:detPag/n:card/n:tpIntegra", namespaces={"n": NFE}).text == "2"
    assert t(".//n:detPag[n:tPag='99']/n:xPag") == "Outros"
    assert t(".//n:dest/n:CPF") == "12345678909" and t(".//n:dest/n:indIEDest") == "9"
    assert t(".//n:infNFeSupl/n:qrCode") == f"https://hom.sat.sef.sc.gov.br/nfce/consulta?p={b.access_key}|3|2"
    assert t(".//n:infNFeSupl/n:urlChave") == "https://hom.sat.sef.sc.gov.br/nfce/consulta"
    assert t(".//n:emit/n:IE") == "261234567" and t(".//n:infRespTec/n:CNPJ") == CNPJ
    assert b.danfe["vNF"] == "314.90" and b.danfe["items"][1]["descricao"] == "Legging Azul P"


def test_production_keeps_item_name_and_qr_v2_with_csc(cert: A1Certificate) -> None:
    b = _build(cert, tp_amb=1, csc_id="000001", csc_token="0123456789ABCDEF")
    root = etree.fromstring(b.xml.encode())
    _schema("nfe_v4.00.xsd").assertValid(root)
    assert root.findtext(f".//{{{NFE}}}det/{{{NFE}}}prod/{{{NFE}}}xProd") == "Top Fitness Preto M"
    qr = root.findtext(f".//{{{NFE}}}qrCode")
    m = re.fullmatch(r"https://sat\.sef\.sc\.gov\.br/nfce/consulta\?p=(\d{44})\|2\|1\|1\|([0-9A-F]{40})", qr)
    assert m and m.group(1) == b.access_key
    import hashlib
    assert m.group(2) == hashlib.sha1(f"{b.access_key}|2|1|1".encode() + b"0123456789ABCDEF").hexdigest().upper()


def test_tax_approximation_is_optional_and_schema_valid(cert: A1Certificate) -> None:
    assert _build(cert).danfe["tributos"] is None
    b = _build(cert, taxes=nfce.TaxApprox(federal=Decimal("13.45"), estadual=Decimal("17"), fonte="IBPT"))
    root = etree.fromstring(b.xml.encode())
    _schema("nfe_v4.00.xsd").assertValid(root)
    items = sum(Decimal(e.text) for e in root.iterfind(f".//{{{NFE}}}imposto/{{{NFE}}}vTotTrib"))
    assert root.findtext(f".//{{{NFE}}}ICMSTot/{{{NFE}}}vTotTrib") == str(items) == "91.32"   # soma dos itens (30,45% de cada um)
    assert b.danfe["tributos"] == {"federal": "40.34", "estadual": "50.98", "municipal": "0.00", "total": "91.32", "fonte": "IBPT"}


def test_nfce_never_invents_data(cert: A1Certificate) -> None:
    item = _doc()["itens"][0]
    with pytest.raises(PermanentError, match="NCM"):
        _build(cert, _doc(itens=[{**item, "codigo_ncm": None}]))
    with pytest.raises(PermanentError, match="CFOP"):
        _build(cert, _doc(itens=[{**item, "cfop": "6102"}]))
    with pytest.raises(PermanentError, match="Pagamentos"):
        _build(cert, _doc(formas_pagamento=[{"forma_pagamento": "01", "valor_pagamento": 100}]))
    with pytest.raises(PermanentError, match="inscrição estadual"):
        nfce.build_nfce(_doc(), nfce.Emitter(**{**EMITTER.__dict__, "ie": ""}), tp_amb=2, series=1, number=1, cnf=2, dh_emi=dt.datetime.now(TZ), cert=cert)
    # centavos do rateio do cupom: o pagamento manda e a diferença vira desconto
    b = _build(cert, _doc(formas_pagamento=[{"forma_pagamento": "01", "valor_pagamento": 299.88}]))
    assert b.danfe["vNF"] == "299.88"


# ---------------------------------------------------------------- SOAP simulado
def _soap(inner: str, wrapper: str = "nfeResultMsg", ns: str = "NFeAutorizacao4") -> httpx.Response:
    body = (f'<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body>'
            f'<{wrapper} xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/{ns}">{inner}</{wrapper}></soap:Body></soap:Envelope>')
    return httpx.Response(200, content=body.encode(), headers={"Content-Type": "application/soap+xml"})


def _body(req: httpx.Request) -> etree._Element:
    env = etree.fromstring(req.content)
    msg = env.find(".//{*}nfeDadosMsg")
    return msg[0]


async def test_authorize_sends_valid_lote_and_reads_protocol(cert: A1Certificate) -> None:
    b = _build(cert)
    seen: list[httpx.Request] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(req)
        prot = (f'<protNFe versao="4.00"><infProt><tpAmb>2</tpAmb><verAplic>SVRS</verAplic><chNFe>{b.access_key}</chNFe>'
                f'<dhRecbto>2026-10-13T15:30:05-03:00</dhRecbto><nProt>342260000000001</nProt><digVal>abc=</digVal><cStat>100</cStat>'
                f'<xMotivo>Autorizado o uso da NF-e</xMotivo></infProt></protNFe>')
        return _soap(f'<retEnviNFe xmlns="{NFE}" versao="4.00"><tpAmb>2</tpAmb><verAplic>SVRS</verAplic><cStat>104</cStat><xMotivo>Lote processado</xMotivo>'
                     f'<cUF>42</cUF><dhRecbto>2026-10-13T15:30:05-03:00</dhRecbto>{prot}</retEnviNFe>')

    async with SefazClient(cert, "SC", 2, transport=httpx.MockTransport(handler)) as c:
        res = await c.authorize(b.xml)
    req = seen[0]
    assert str(req.url) == "https://nfce-homologacao.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx"
    assert 'action="http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4/nfeAutorizacaoLote"' in req.headers["content-type"]
    lote = _body(req)
    _schema("enviNFe_v4.00.xsd").assertValid(lote)
    assert lote.findtext(f"{{{NFE}}}indSinc") == "1"
    assert res.cstat == "104" and res.protocol and res.protocol.authorized and res.protocol.nprot == "342260000000001"
    _schema("procNFe_v4.00.xsd").assertValid(etree.fromstring(nfe_proc(b.xml, res.protocol.xml).encode()))


async def test_events_and_queries_follow_schemas(cert: A1Certificate) -> None:
    key = _build(cert).access_key
    bodies: dict[str, etree._Element] = {}

    def handler(req: httpx.Request) -> httpx.Response:
        el = _body(req)
        name = etree.QName(el).localname
        bodies[name] = el
        if name == "consStatServ":
            return _soap(f'<retConsStatServ xmlns="{NFE}" versao="4.00"><tpAmb>2</tpAmb><verAplic>SVRS</verAplic><cStat>107</cStat><xMotivo>Servico em Operacao</xMotivo>'
                         f'<cUF>42</cUF><dhRecbto>2026-10-13T15:00:00-03:00</dhRecbto></retConsStatServ>', ns="NFeStatusServico4")
        if name == "envEvento":
            ev = el.find(f"{{{NFE}}}evento/{{{NFE}}}infEvento")
            tp = ev.findtext(f"{{{NFE}}}tpEvento")
            return _soap(f'<retEnvEvento xmlns="{NFE}" versao="1.00"><idLote>1</idLote><tpAmb>2</tpAmb><verAplic>X</verAplic><cOrgao>42</cOrgao><cStat>128</cStat>'
                         f'<xMotivo>Lote de Evento Processado</xMotivo><retEvento versao="1.00"><infEvento><tpAmb>2</tpAmb><verAplic>X</verAplic><cOrgao>42</cOrgao>'
                         f'<cStat>135</cStat><xMotivo>Evento registrado e vinculado a NF-e</xMotivo><chNFe>{key}</chNFe><tpEvento>{tp}</tpEvento>'
                         f'<nSeqEvento>1</nSeqEvento><dhRegEvento>2026-10-13T15:40:00-03:00</dhRegEvento><nProt>342260000000002</nProt></infEvento></retEvento></retEnvEvento>',
                         ns="NFeRecepcaoEvento4")
        if name == "inutNFe":
            return _soap(f'<retInutNFe xmlns="{NFE}" versao="4.00"><infInut><tpAmb>2</tpAmb><verAplic>X</verAplic><cStat>102</cStat><xMotivo>Inutilizacao de numero homologado</xMotivo>'
                         f'<cUF>42</cUF><dhRecbto>2026-10-13T15:00:00-03:00</dhRecbto><nProt>342260000000003</nProt></infInut></retInutNFe>', ns="NFeInutilizacao4")
        if name == "consSitNFe":
            return _soap(f'<retConsSitNFe xmlns="{NFE}" versao="4.00"><tpAmb>2</tpAmb><verAplic>X</verAplic><cStat>217</cStat><xMotivo>NF-e nao consta na base de dados da SEFAZ</xMotivo>'
                         f'<cUF>42</cUF><dhRecbto>2026-10-13T15:00:00-03:00</dhRecbto><chNFe>{key}</chNFe></retConsSitNFe>', ns="NFeConsultaProtocolo4")
        if name == "distDFeInt":
            res = gzip.compress((f'<resNFe xmlns="{NFE}" versao="1.01"><chNFe>{key}</chNFe><CNPJ>11222333000181</CNPJ><xNome>FORNECEDOR LTDA</xNome><IE>123</IE>'
                                 f'<dhEmi>2026-10-10T10:00:00-03:00</dhEmi><tpNF>1</tpNF><vNF>1250.75</vNF><digVal>x=</digVal><dhRecbto>2026-10-10T10:00:05-03:00</dhRecbto>'
                                 f'<nProt>1</nProt><cSitNFe>1</cSitNFe></resNFe>').encode())
            return _soap(f'<retDistDFeInt xmlns="{NFE}" versao="1.01"><tpAmb>2</tpAmb><verAplic>1.4.0</verAplic><cStat>138</cStat><xMotivo>Documento(s) localizado(s)</xMotivo>'
                         f'<dhResp>2026-10-13T15:00:00-03:00</dhResp><ultNSU>000000000000201</ultNSU><maxNSU>000000000000201</maxNSU><loteDistDFeInt>'
                         f'<docZip NSU="000000000000201" schema="resNFe_v1.01.xsd">{base64.b64encode(res).decode()}</docZip></loteDistDFeInt></retDistDFeInt>',
                         wrapper="nfeDistDFeInteresseResponse", ns="NFeDistribuicaoDFe")
        raise AssertionError(name)

    async with SefazClient(cert, "SC", 2, transport=httpx.MockTransport(handler)) as c:
        assert await c.status() == ("107", "Servico em Operacao")
        prot, proc = await c.cancel(CNPJ, key, "342260000000001", "Cliente desistiu da compra no caixa")
        assert prot.cstat == "135" and prot.nprot == "342260000000002" and "procEventoNFe" in proc
        assert (await c.void_numbers(CNPJ, 1, 124, 124, "Numero pulado por falha no sistema")).cstat == "102"
        assert (await c.consult(key)).cstat == "217"
        dist = await c.distribution(CNPJ, ult_nsu=200)
        mani = await c.manifest(CNPJ, key, "CIENCIA")
    assert mani.cstat == "135"
    _schema("consStatServ_v4.00.xsd").assertValid(bodies["consStatServ"])
    _schema("envEventoCancNFe_v1.00.xsd").assertValid(_CANCEL[0])
    ev = _CANCEL[0].find(f"{{{NFE}}}evento")
    _verify_signature(etree.tostring(ev, encoding="unicode"), ev.find(f"{{{NFE}}}infEvento").get("Id"), cert)
    inut = bodies["inutNFe"]
    _verify_signature(etree.tostring(inut, encoding="unicode"), inut.find(f"{{{NFE}}}infInut").get("Id"), cert)
    _schema("inutNFe_v4.00.xsd").assertValid(bodies["inutNFe"])
    _schema("consSitNFe_v4.00.xsd").assertValid(bodies["consSitNFe"])
    _schema("distDFeInt_v1.01.xsd").assertValid(bodies["distDFeInt"])
    _schema("envConfRecebto_v1.00.xsd").assertValid(bodies["envEvento"])          # o último envEvento foi a manifestação (cOrgao 91)
    assert bodies["envEvento"].findtext(f".//{{{NFE}}}cOrgao") == "91"
    assert dist.cstat == "138" and dist.ult_nsu == 201 and dist.max_nsu == 201
    row = parse_dfe_doc(dist.docs[0])
    assert row and row["access_key"] == key and row["issuer_cnpj"] == "11222333000181" and row["amount"] == "1250.75"


_CANCEL: list[etree._Element] = []


@pytest.fixture(autouse=True)
def _capture_cancel(monkeypatch: pytest.MonkeyPatch) -> None:
    """Guarda o primeiro envEvento (cancelamento) antes de a manifestação sobrescrever."""
    _CANCEL.clear()
    orig = SefazClient._call

    async def spy(self: SefazClient, svc, body):  # type: ignore[no-untyped-def]
        if isinstance(body, str) and "<envEvento" in body and "110111" in body and not _CANCEL:
            _CANCEL.append(etree.fromstring(body.encode()))
        return await orig(self, svc, body)

    monkeypatch.setattr(SefazClient, "_call", spy)


async def test_network_errors_say_if_request_may_have_arrived(cert: A1Certificate) -> None:
    def refuse(req: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=req)

    def hang(req: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("timeout", request=req)

    async with SefazClient(cert, "SC", 2, transport=httpx.MockTransport(refuse)) as c:
        with pytest.raises(SefazNetworkError) as e1:
            await c.status()
    assert e1.value.delivered is False
    async with SefazClient(cert, "SC", 2, transport=httpx.MockTransport(hang)) as c:
        with pytest.raises(SefazNetworkError) as e2:
            await c.authorize(_build(cert).xml)
    assert e2.value.delivered is True


def test_unsupported_uf_is_explicit(cert: A1Certificate) -> None:
    with pytest.raises(PermanentError, match="UF PR"):
        nfce.build_nfce(_doc(), nfce.Emitter(**{**EMITTER.__dict__, "uf": "PR"}), tp_amb=2, series=1, number=1, cnf=2, dh_emi=dt.datetime.now(TZ), cert=cert)
