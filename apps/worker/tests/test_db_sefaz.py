"""Emissão direta na SEFAZ ponta a ponta no banco (worker + funções SQL), com a SEFAZ simulada no formato dos manuais:
autorização, resposta perdida (consulta antes de reenviar), rejeição (mesmo número no reenvio), número já usado (539),
SEFAZ fora do ar com a API reserva, cancelamento, inutilização, notas recebidas com a espera de 1 hora e o teste da integração."""
from __future__ import annotations

import base64
import gzip
import json
import uuid
from typing import Any

import httpx
import pytest
import pytest_asyncio
import respx
from lxml import etree

from centralops_worker import queues
from centralops_worker.db import call_fn, fetch_one
from centralops_worker.handlers import fiscal, fiscal_direct, integrations
from centralops_worker.runner import RetryLater
from centralops_worker.sefaz.client import SefazClient

from .conftest import ORG, STORE
from .test_sefaz import SCHEMAS, _pfx

pytestmark = pytest.mark.db

NFE = "http://www.portalfiscal.inf.br/nfe"
LEGAL_ENTITY = "00000000-0000-4000-8000-0000000000e1"
LOCATION = "00000000-0000-4000-8000-0000000000b1"
CNPJ = "11222333000181"
ENVI = etree.XMLSchema(etree.parse(str(SCHEMAS / "enviNFe_v4.00.xsd")))


def _soap(inner: str) -> httpx.Response:
    return httpx.Response(200, content=(f'<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body><nfeResultMsg xmlns="x">{inner}'
                                        f'</nfeResultMsg></soap:Body></soap:Envelope>').encode())


def prot(key: str, cstat: str = "100", motivo: str = "Autorizado o uso da NF-e", nprot: str = "342260000000001") -> str:
    return (f'<protNFe versao="4.00"><infProt><tpAmb>2</tpAmb><verAplic>SVRS</verAplic><chNFe>{key}</chNFe><dhRecbto>2026-10-13T15:30:05-03:00</dhRecbto>'
            f'{"<nProt>" + nprot + "</nProt>" if cstat in ("100", "150") else ""}<digVal>x=</digVal><cStat>{cstat}</cStat><xMotivo>{motivo}</xMotivo></infProt></protNFe>')


class FakeSefaz:
    """Responde por operação; `auth` é uma lista de respostas para os envios (str = cStat do protocolo, exceção = falha de rede)."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, etree._Element]] = []
        self.auth: list[Any] = ["100"]
        self.consult: str = "217"
        self.event: str = "135"
        self.inut: str = "102"
        self.dist: list[str] = []

    def keys(self) -> list[str]:
        return [el.find(f".//{{{NFE}}}infNFe").get("Id")[3:] for op, el in self.calls if op == "enviNFe"]

    def __call__(self, req: httpx.Request) -> httpx.Response:
        body = etree.fromstring(req.content).find(".//{*}nfeDadosMsg")[0]
        op = etree.QName(body).localname
        self.calls.append((op, body))
        if op == "enviNFe":
            ENVI.assertValid(body)
            key = body.find(f".//{{{NFE}}}infNFe").get("Id")[3:]
            r = self.auth.pop(0) if self.auth else "100"
            if isinstance(r, Exception):
                raise r
            motivo = {"100": "Autorizado o uso da NF-e", "539": "Duplicidade de NF-e com diferenca na Chave de Acesso", "778": "Informado NCM inexistente"}.get(r, "x")
            return _soap(f'<retEnviNFe xmlns="{NFE}" versao="4.00"><tpAmb>2</tpAmb><verAplic>SVRS</verAplic><cStat>104</cStat><xMotivo>Lote processado</xMotivo>'
                         f'<cUF>42</cUF><dhRecbto>2026-10-13T15:30:05-03:00</dhRecbto>{prot(key, r, motivo)}</retEnviNFe>')
        if op == "consSitNFe":
            key = body.findtext(f"{{{NFE}}}chNFe")
            p = prot(key) if self.consult == "100" else ""
            motivo = "Autorizado o uso da NF-e" if self.consult == "100" else "NF-e nao consta na base de dados da SEFAZ"
            return _soap(f'<retConsSitNFe xmlns="{NFE}" versao="4.00"><tpAmb>2</tpAmb><verAplic>X</verAplic><cStat>{self.consult}</cStat><xMotivo>{motivo}</xMotivo>'
                         f'<cUF>42</cUF><dhRecbto>2026-10-13T15:31:00-03:00</dhRecbto><chNFe>{key}</chNFe>{p}</retConsSitNFe>')
        if op == "envEvento":
            ev = body.find(f"{{{NFE}}}evento/{{{NFE}}}infEvento")
            return _soap(f'<retEnvEvento xmlns="{NFE}" versao="1.00"><idLote>1</idLote><tpAmb>2</tpAmb><verAplic>X</verAplic><cOrgao>42</cOrgao><cStat>128</cStat><xMotivo>Lote processado</xMotivo>'
                         f'<retEvento versao="1.00"><infEvento><tpAmb>2</tpAmb><verAplic>X</verAplic><cOrgao>42</cOrgao><cStat>{self.event}</cStat><xMotivo>Evento registrado e vinculado a NF-e</xMotivo>'
                         f'<chNFe>{ev.findtext(f"{{{NFE}}}chNFe")}</chNFe><tpEvento>{ev.findtext(f"{{{NFE}}}tpEvento")}</tpEvento><nSeqEvento>1</nSeqEvento>'
                         f'<dhRegEvento>2026-10-13T15:40:00-03:00</dhRegEvento><nProt>342260000000009</nProt></infEvento></retEvento></retEnvEvento>')
        if op == "inutNFe":
            return _soap(f'<retInutNFe xmlns="{NFE}" versao="4.00"><infInut><tpAmb>2</tpAmb><verAplic>X</verAplic><cStat>{self.inut}</cStat><xMotivo>Inutilizacao de numero homologado</xMotivo>'
                         f'<cUF>42</cUF><dhRecbto>2026-10-13T15:00:00-03:00</dhRecbto><nProt>342260000000010</nProt></infInut></retInutNFe>')
        if op == "consStatServ":
            return _soap(f'<retConsStatServ xmlns="{NFE}" versao="4.00"><tpAmb>2</tpAmb><verAplic>SVRS</verAplic><cStat>107</cStat><xMotivo>Servico em Operacao</xMotivo>'
                         f'<cUF>42</cUF><dhRecbto>2026-10-13T15:00:00-03:00</dhRecbto></retConsStatServ>')
        if op == "distDFeInt":
            cstat = self.dist.pop(0) if self.dist else "137"
            ult = int(body.findtext(f".//{{{NFE}}}ultNSU") or 0)
            lote = ""
            if cstat == "138":
                key = "42261099888777000166550010000004561000004561"
                res = gzip.compress((f'<resNFe xmlns="{NFE}" versao="1.01"><chNFe>{key}</chNFe><CNPJ>99888777000166</CNPJ><xNome>FORNECEDOR TESTE</xNome><IE>1</IE>'
                                     f'<dhEmi>2026-10-10T10:00:00-03:00</dhEmi><tpNF>1</tpNF><vNF>980.50</vNF><digVal>x=</digVal><dhRecbto>2026-10-10T10:00:05-03:00</dhRecbto>'
                                     f'<nProt>1</nProt><cSitNFe>1</cSitNFe></resNFe>').encode())
                lote = f'<loteDistDFeInt><docZip NSU="{ult + 1:015d}" schema="resNFe_v1.01.xsd">{base64.b64encode(res).decode()}</docZip></loteDistDFeInt>'
                ult += 1
            return _soap(f'<retDistDFeInt xmlns="{NFE}" versao="1.01"><tpAmb>2</tpAmb><verAplic>1.4.0</verAplic><cStat>{cstat}</cStat><xMotivo>ok</xMotivo>'
                         f'<dhResp>2026-10-13T15:00:00-03:00</dhResp><ultNSU>{ult:015d}</ultNSU><maxNSU>{ult:015d}</maxNSU>{lote}</retDistDFeInt>')
        raise AssertionError(op)


@pytest.fixture
def sefaz(monkeypatch: pytest.MonkeyPatch) -> FakeSefaz:
    fake = FakeSefaz()

    def client(self: fiscal_direct.DirectCtx, tp_amb: int | None = None) -> SefazClient:
        return SefazClient(self.cert, self.emitter.uf, tp_amb or self.tp_amb, transport=httpx.MockTransport(fake))

    monkeypatch.setattr(fiscal_direct.DirectCtx, "client", client)
    return fake


@pytest_asyncio.fixture
async def direct(pool: Any, deps: Any) -> dict[str, Any]:
    """Empresa de teste pronta para NFC-e + conexão SEFAZ com o certificado no cofre (tudo revertido no fim)."""
    deps.settings = deps.settings.model_copy(update={"focus_token": ""})        # sem API reserva, salvo quando o teste conecta uma
    await fetch_one(pool, """update core.legal_entities set cnpj = %s, razao_social = 'EMPRESA TESTE LTDA', crt = 1, ie = null,
                             address = '{"street":"Rua Madalena Barbi","number":"160","district":"Centro","city":"Florianópolis","uf":"SC","cep":"88015190"}'
                             where id = %s returning id""", (CNPJ, LEGAL_ENTITY))
    secret = {"certificate_pfx": base64.b64encode(_pfx(CNPJ)).decode(), "certificate_password": "senha123"}
    name = f"integ/test/SEFAZ/{uuid.uuid4()}"
    await fetch_one(pool, "select vault.create_secret(%s, %s) as id", (json.dumps(secret), name))
    conn = await fetch_one(pool, """insert into core.integration_connections (org_id, provider, capability, status, config, secret_ref)
                                    values (%s, 'SEFAZ', 'FISCAL', 'ACTIVE', %s, %s) returning id""",
                           (ORG, json.dumps({"environment": "homologacao", "uf": "SC", "ie": "261234567", "cmun": "4205407", "nfce_series": "7",
                                             "resp_email": "ti@example.com", "resp_fone": "48999998888"}), name))
    await fetch_one(pool, "delete from fiscal.numbering where legal_entity_id = %s returning 1", (LEGAL_ENTITY,))
    return {"conn_id": str(conn["id"])}


@pytest_asyncio.fixture
async def order(pool: Any) -> dict[str, Any]:
    suffix = uuid.uuid4().hex[:8]
    await fetch_one(pool, "update catalog.products set ncm = '61124100' where id in (select product_id from catalog.variants where sku in ('DEMO-LEG01-PRT-M','DEMO-TEE01-PRT-G')) returning 1")
    o = await fetch_one(pool, """insert into sales.orders (org_id, legal_entity_id, store_id, location_id, number, channel, status, subtotal, total, paid_total, idempotency_key)
                                 values (%s, %s, %s, %s, %s, 'POS', 'PAID', 678, 678, 678, %s) returning id, number""",
                        (ORG, LEGAL_ENTITY, STORE, LOCATION, f"TST-{suffix}", f"test-{suffix}"))
    for sku, price in (("DEMO-LEG01-PRT-M", 429), ("DEMO-TEE01-PRT-G", 249)):
        await fetch_one(pool, """insert into sales.order_items (org_id, order_id, variant_id, qty, list_price, unit_price, total)
                                 select %s, %s, id, 1, %s, %s, %s from catalog.variants where sku = %s returning id""", (ORG, o["id"], price, price, price, sku))
    await fetch_one(pool, "insert into sales.payments (org_id, order_id, method, amount, status) values (%s, %s, 'PIX', 678, 'CAPTURED') returning id", (ORG, o["id"]))
    return {"id": str(o["id"]), "number": o["number"]}


def job(order: dict[str, Any], **extra: Any) -> queues.QueueMessage:
    return queues.QueueMessage("fiscal_emission", 1, 1, {"order_id": order["id"], "org_id": ORG, "purpose": "SALE", **extra})


async def doc(pool: Any, order: dict[str, Any]) -> dict[str, Any]:
    d = await fetch_one(pool, """select id, status, provider, number, series, access_key, protocol, sefaz_code, danfe_path, xml, totals, events
                                 from fiscal.documents where order_id = %s""", (order["id"],))
    assert d
    return d


async def test_authorized_directly_with_own_numbering(pool: Any, deps: Any, direct: dict, sefaz: FakeSefaz, order: dict) -> None:
    await fiscal.handle(deps, job(order))
    d = await doc(pool, order)
    assert d["status"] == "AUTHORIZED" and d["provider"] == "SEFAZ" and (d["series"], d["number"]) == (7, 1) and d["protocol"] == "342260000000001"
    assert d["access_key"] == sefaz.keys()[0] and d["danfe_path"] == f"/imprimir/nfce/{d['id']}"
    proc = etree.fromstring(d["xml"].encode())
    assert etree.QName(proc).localname == "nfeProc" and proc.find(f".//{{{NFE}}}protNFe") is not None
    danfe = d["totals"]["danfe"]
    assert danfe["vNF"] == "678.00" and danfe["protocol"] == "342260000000001" and danfe["qr_url"].endswith(f"{d['access_key']}|3|2")
    await fiscal.handle(deps, job(order))                                          # reentrega da fila: nada é reenviado
    assert len(sefaz.keys()) == 1


async def test_lost_answer_is_checked_before_resending(pool: Any, deps: Any, direct: dict, sefaz: FakeSefaz, order: dict) -> None:
    sefaz.auth = [httpx.ReadTimeout("sem resposta")]
    with pytest.raises(RetryLater):
        await fiscal.handle(deps, job(order))
    assert (await doc(pool, order))["status"] == "PROCESSING"
    sefaz.consult = "100"                                                          # a SEFAZ tinha autorizado
    await fiscal.handle(deps, job(order))
    d = await doc(pool, order)
    assert d["status"] == "AUTHORIZED" and len(sefaz.keys()) == 1 and [op for op, _ in sefaz.calls] == ["enviNFe", "consSitNFe"]
    assert etree.QName(etree.fromstring(d["xml"].encode())).localname == "nfeProc"


async def test_lost_answer_not_in_sefaz_resends_same_number(pool: Any, deps: Any, direct: dict, sefaz: FakeSefaz, order: dict) -> None:
    sefaz.auth = [httpx.ReadTimeout("sem resposta"), "100"]
    with pytest.raises(RetryLater):
        await fiscal.handle(deps, job(order))
    await fiscal.handle(deps, job(order))                                          # consulta: 217 (não consta) -> reenvia
    d = await doc(pool, order)
    assert d["status"] == "AUTHORIZED" and d["number"] == 1 and len(set(sefaz.keys())) == 1


async def test_rejection_keeps_number_for_the_resend(pool: Any, deps: Any, direct: dict, sefaz: FakeSefaz, order: dict) -> None:
    sefaz.auth = ["778", "100"]
    await fiscal.handle(deps, job(order))
    d = await doc(pool, order)
    assert d["status"] == "REJECTED" and d["sefaz_code"] == "778" and d["number"] == 1
    notes = await fetch_one(pool, "select count(*) as n from core.notifications where org_id = %s and kind = 'FISCAL_REJECTED' and title like %s", (ORG, f"%{order['number']}%"))
    assert notes["n"] >= 1
    await fiscal.handle(deps, job(order, manual=True))                             # reenviar (depois de corrigir o cadastro)
    d = await doc(pool, order)
    assert d["status"] == "AUTHORIZED" and d["number"] == 1


async def test_number_used_elsewhere_moves_to_next(pool: Any, deps: Any, direct: dict, sefaz: FakeSefaz, order: dict) -> None:
    sefaz.auth = ["539", "100"]
    with pytest.raises(RetryLater):
        await fiscal.handle(deps, job(order))
    await fiscal.handle(deps, job(order))
    d = await doc(pool, order)
    assert d["status"] == "AUTHORIZED" and d["number"] == 2


@respx.mock
async def test_sefaz_unreachable_goes_to_paid_api_and_number_returns(pool: Any, deps: Any, direct: dict, sefaz: FakeSefaz, order: dict) -> None:
    await fetch_one(pool, """insert into core.integration_connections (org_id, provider, capability, status, config, secret_ref)
                             values (%s, 'FOCUS_NFE', 'FISCAL', 'ACTIVE', '{"environment":"homologacao"}', 'integ/test/focus') returning id""", (ORG,))
    await fetch_one(pool, "select vault.create_secret('{\"token\":\"focus-test\"}', 'integ/test/focus') as id")
    deps.settings = deps.settings.model_copy(update={"focus_api_base": "https://focus.test"})
    key = "42261011222333000181650010000000991000000991"
    focus = respx.post(url__regex=r"https://.*/v2/nfce").mock(return_value=httpx.Response(201, json={
        "status": "autorizado", "numero": "99", "serie": "1", "chave_nfe": f"NFe{key}", "protocolo": "P-99", "caminho_danfe": "/danfe/99.pdf"}))
    sefaz.auth = [httpx.ConnectError("recusada")]
    await fiscal.handle(deps, job(order))
    d = await doc(pool, order)
    assert focus.called and d["status"] == "AUTHORIZED" and d["provider"] == "FOCUS_NFE" and d["number"] == 99 and d["access_key"] == key
    assert any(e.get("type") == "SEFAZ_FALLBACK" for e in d["events"])
    n = await call_fn(pool, "fiscal.reserve_fiscal_number", LEGAL_ENTITY, "65", 7, 2, 1)
    assert n == 1                                                                  # o número que não chegou à SEFAZ volta para a fila


async def test_cancel_and_void_directly(pool: Any, deps: Any, direct: dict, sefaz: FakeSefaz, order: dict) -> None:
    await fiscal.handle(deps, job(order))
    d = await doc(pool, order)
    await fiscal.handle(deps, queues.QueueMessage("fiscal_emission", 2, 1, {"action": "CANCEL", "org_id": ORG, "document_id": str(d["id"]), "reason": "Cliente desistiu da compra no caixa"}))
    d = await doc(pool, order)
    assert d["status"] == "CANCELLED" and any(e.get("type") == "CANCEL_XML" for e in d["events"])
    ev = next(el for op, el in sefaz.calls if op == "envEvento")
    assert ev.findtext(f".//{{{NFE}}}tpEvento") == "110111" and ev.findtext(f".//{{{NFE}}}nProt") == "342260000000001"


async def test_void_rejected_number(pool: Any, deps: Any, direct: dict, sefaz: FakeSefaz, order: dict) -> None:
    sefaz.auth = ["778"]
    await fiscal.handle(deps, job(order))
    d = await doc(pool, order)
    await fiscal.handle(deps, queues.QueueMessage("fiscal_emission", 3, 1, {"action": "VOID_NUMBER", "org_id": ORG, "document_id": str(d["id"]), "reason": "Venda refeita em outra nota fiscal"}))
    d = await doc(pool, order)
    assert d["status"] == "NUMBER_VOIDED"
    inut = next(el for op, el in sefaz.calls if op == "inutNFe")
    assert inut.findtext(f".//{{{NFE}}}nNFIni") == "1" and inut.findtext(f".//{{{NFE}}}serie") == "7"


async def test_received_notes_respect_the_one_hour_rule(pool: Any, deps: Any, direct: dict, sefaz: FakeSefaz) -> None:
    await fetch_one(pool, "delete from fiscal.dfe_sync_state where legal_entity_id = %s returning 1", (LEGAL_ENTITY,))
    sefaz.dist = ["138"]
    await fiscal.handle(deps, queues.QueueMessage("fiscal_emission", 4, 1, {"action": "DFE_SYNC", "org_id": ORG}))
    row = await fetch_one(pool, "select issuer_name, amount from fiscal.inbound_dfe where access_key = '42261099888777000166550010000004561000004561'")
    assert row and row["issuer_name"] == "FORNECEDOR TESTE" and float(row["amount"]) == 980.50
    st = await fetch_one(pool, "select last_version, next_allowed_at from fiscal.dfe_sync_state where legal_entity_id = %s", (LEGAL_ENTITY,))
    assert st["last_version"] == 1 and st["next_allowed_at"] is not None
    calls = len(sefaz.calls)
    await fiscal.handle(deps, queues.QueueMessage("fiscal_emission", 5, 1, {"action": "DFE_SYNC", "org_id": ORG}))
    assert len(sefaz.calls) == calls                                               # dentro da hora: não consulta (evita o bloqueio 656)


async def test_integration_check_reports_certificate_and_service(pool: Any, deps: Any, direct: dict, sefaz: FakeSefaz) -> None:
    await integrations.handle(deps, queues.QueueMessage("integration_checks", 6, 1, {"connection_id": direct["conn_id"], "org_id": ORG, "action": "CHECK"}))
    c = await fetch_one(pool, "select status, config, last_error from core.integration_connections where id = %s", (direct["conn_id"],))
    assert c["status"] == "ACTIVE", c["last_error"]
    detail = c["config"]["health"]["detail"]
    assert detail["sefaz"] == "107 Servico em Operacao" and detail["certificate_cnpj"] == CNPJ and detail["qr_code"] == "v3 (sem CSC)"
    le = await fetch_one(pool, "select cert_expires_at from core.legal_entities where id = %s", (LEGAL_ENTITY,))
    assert le["cert_expires_at"] is not None


async def test_wrong_password_is_reported(pool: Any, deps: Any, direct: dict, sefaz: FakeSefaz) -> None:
    name = (await fetch_one(pool, "select secret_ref from core.integration_connections where id = %s", (direct["conn_id"],)))["secret_ref"]
    await fetch_one(pool, "update vault.secrets set secret = %s where name = %s returning 1",
                    (json.dumps({"certificate_pfx": base64.b64encode(_pfx(CNPJ)).decode(), "certificate_password": "errada"}), name))
    await integrations.handle(deps, queues.QueueMessage("integration_checks", 7, 1, {"connection_id": direct["conn_id"], "org_id": ORG, "action": "CHECK"}))
    c = await fetch_one(pool, "select status, last_error from core.integration_connections where id = %s", (direct["conn_id"],))
    assert c["status"] == "ERROR" and "senha" in c["last_error"]

