"""Emissão fiscal (NFC-e via Focus NFe): idempotência por ref, situação "processando", rejeição, credencial ausente e o que NÃO emitimos sozinhos."""
from __future__ import annotations

import json
import uuid
from typing import Any

import httpx
import pytest
import pytest_asyncio
import respx

from centralops_worker import queues
from centralops_worker.db import call_fn, fetch_all, fetch_one
from centralops_worker.handlers import fiscal
from centralops_worker.runner import PermanentError, RetryLater

from .conftest import ORG, STORE

pytestmark = pytest.mark.db

LEGAL_ENTITY = "00000000-0000-4000-8000-0000000000e1"
LOCATION = "00000000-0000-4000-8000-0000000000b1"
KEY = "42260911222333000181650010000000121000000121"


@pytest_asyncio.fixture
async def order(pool: Any) -> dict[str, Any]:
    suffix = uuid.uuid4().hex[:8]
    o = await fetch_one(pool, """insert into sales.orders (org_id, legal_entity_id, store_id, location_id, number, channel, status, subtotal, total, paid_total, idempotency_key)
                                 values (%s, %s, %s, %s, %s, 'POS', 'PAID', 678, 678, 678, %s) returning id, number""",
                        (ORG, LEGAL_ENTITY, STORE, LOCATION, f"TST-{suffix}", f"test-{suffix}"))
    assert o
    for sku, qty, price in (("DEMO-LEG01-PRT-M", 1, 429), ("DEMO-TEE01-PRT-G", 1, 249)):
        await fetch_one(pool, """insert into sales.order_items (org_id, order_id, variant_id, qty, list_price, unit_price, total)
                                 select %s, %s, id, %s, %s, %s, %s from catalog.variants where sku = %s returning id""", (ORG, o["id"], qty, price, price, price * qty, sku))
    await fetch_one(pool, "insert into sales.payments (org_id, order_id, method, amount, status) values (%s, %s, 'PIX', 678, 'CAPTURED') returning id", (ORG, o["id"]))
    return {"id": str(o["id"]), "number": o["number"], "ref": f"{o['id']}:SALE"}


def job(order: dict[str, Any], **extra: Any) -> queues.QueueMessage:
    return queues.QueueMessage("fiscal_emission", 1, 1, {"order_id": order["id"], "org_id": ORG, "purpose": "SALE", **extra})


async def document(pool: Any, order: dict[str, Any]) -> dict[str, Any] | None:
    return await fetch_one(pool, "select status, number, series, access_key, protocol, sefaz_code, sefaz_msg, danfe_path, provider_ref from fiscal.documents where order_id = %s", (order["id"],))


AUTHORIZED = {"status": "autorizado", "numero": "12", "serie": "1", "chave_nfe": f"NFe{KEY}", "protocolo": "P-123", "caminho_danfe": "/danfe/12.pdf"}


@respx.mock
async def test_authorized_nfce_is_recorded_once(pool: Any, deps: Any, order: dict[str, Any]) -> None:
    route = respx.post("https://focus.test/v2/nfce").mock(return_value=httpx.Response(201, json=AUTHORIZED))
    await fiscal.handle(deps, job(order))
    doc = await document(pool, order)
    assert doc and doc["status"] == "AUTHORIZED" and doc["number"] == 12 and doc["access_key"] == KEY and doc["protocol"] == "P-123" and doc["danfe_path"] == "/danfe/12.pdf"
    req = route.calls[0].request
    assert req.url.params["ref"] == order["ref"] and req.headers["authorization"].startswith("Basic ")
    body = json.loads(req.content)
    assert body["cnpj_emitente"] == "11222333000181" and body["presenca_comprador"] == 1 and body["finalidade_emissao"] == 1
    assert [(i["codigo_produto"], i["valor_bruto"], i["valor_desconto"]) for i in body["itens"]] == [("DEMO-LEG01-PRT-M", 429.0, 0.0), ("DEMO-TEE01-PRT-G", 249.0, 0.0)]
    assert body["itens"][0]["cfop"] == "5102" and body["itens"][0]["icms_situacao_tributaria"] == "102"
    assert body["formas_pagamento"] == [{"forma_pagamento": "17", "valor_pagamento": 678.0}]
    await fiscal.handle(deps, job(order))                                                                     # reentrega: mesma ref, um único documento
    assert len(await fetch_all(pool, "select 1 from fiscal.documents where order_id = %s", (order["id"],))) == 1


@respx.mock
async def test_processing_retries_and_then_polls_by_ref(pool: Any, deps: Any, order: dict[str, Any]) -> None:
    respx.post("https://focus.test/v2/nfce").mock(return_value=httpx.Response(202, json={"status": "processando_autorizacao"}))
    with pytest.raises(RetryLater):
        await fiscal.handle(deps, job(order))
    assert (await document(pool, order))["status"] == "PROCESSING"  # type: ignore[index]
    poll = respx.get(f"https://focus.test/v2/nfce/{order['ref']}").mock(return_value=httpx.Response(200, json=AUTHORIZED))
    await fiscal.handle(deps, job(order))                                                                     # consulta em vez de emitir de novo
    assert poll.called and (await document(pool, order))["status"] == "AUTHORIZED"  # type: ignore[index]


@respx.mock
async def test_rejection_is_recorded_and_alerts_the_fiscal_team(pool: Any, deps: Any, order: dict[str, Any]) -> None:
    respx.post("https://focus.test/v2/nfce").mock(return_value=httpx.Response(422, json={"codigo": "requisicao_invalida", "mensagem": "NCM inválido"}))
    before = (await fetch_one(pool, "select count(*) as n from core.notifications where kind = 'FISCAL_REJECTED'"))["n"]  # type: ignore[index]
    await fiscal.handle(deps, job(order))
    doc = await document(pool, order)
    assert doc and doc["status"] == "REJECTED" and doc["sefaz_msg"] == "NCM inválido"
    assert (await fetch_one(pool, "select count(*) as n from core.notifications where kind = 'FISCAL_REJECTED'"))["n"] > before  # type: ignore[index]


@respx.mock
async def test_provider_outage_retries_without_recording(pool: Any, deps: Any, order: dict[str, Any]) -> None:
    respx.post("https://focus.test/v2/nfce").mock(return_value=httpx.Response(503))
    with pytest.raises(RetryLater):
        await fiscal.handle(deps, job(order))
    assert await document(pool, order) is None


@respx.mock
async def test_missing_credentials_alerts_and_retries(pool: Any, deps: Any, order: dict[str, Any]) -> None:
    import dataclasses
    d = dataclasses.replace(deps, settings=deps.settings.model_copy(update={"focus_token": ""}))
    route = respx.post("https://focus.test/v2/nfce").mock(return_value=httpx.Response(201, json=AUTHORIZED))
    with pytest.raises(RetryLater):
        await fiscal.handle(d, job(order))
    assert not route.called
    row = await fetch_one(pool, "select title from core.notifications where kind = 'INTEGRATION_ERROR' order by created_at desc, id desc limit 1")
    assert row and "Focus NFe" in row["title"]


@respx.mock
async def test_returns_and_b2b_are_flagged_for_review_not_emitted(pool: Any, deps: Any, order: dict[str, Any]) -> None:
    route = respx.post(url__regex=r"https://focus\.test/.*").mock(return_value=httpx.Response(201, json=AUTHORIZED))
    await fiscal.handle(deps, job(order, purpose="RETURN"))
    await fiscal.handle(deps, job(order, model="55"))
    assert not route.called and await document(pool, order) is None
    rows = await fetch_all(pool, "select title from core.notifications where kind = 'FISCAL_REVIEW' order by created_at desc, id desc limit 2")
    assert len(rows) == 2 and all("contador" in r["title"] for r in rows)


async def test_emission_payload_applies_coupon_discount_proportionally(pool: Any, order: dict[str, Any]) -> None:
    coupon = await fetch_one(pool, "insert into sales.coupons (org_id, code, kind, value) values (%s, %s, 'PERCENT', 10) returning id", (ORG, f"T{uuid.uuid4().hex[:6].upper()}"))
    assert coupon
    await fetch_one(pool, "insert into sales.coupon_redemptions (org_id, coupon_id, order_id, amount) values (%s, %s, %s, 67.80) returning id", (ORG, coupon["id"], order["id"]))
    doc = await call_fn(pool, "fiscal.emission_payload", order["id"], "SALE")
    assert [i["valor_desconto"] for i in doc["document"]["itens"]] == [42.9, 24.9]                             # 10% de cada item, somando o cupom de R$ 67,80
    assert doc["ref"] == order["ref"] and doc["model"] == "65"


async def _authorized_document(pool: Any, deps: Any, order: dict[str, Any]) -> str:
    respx.post("https://focus.test/v2/nfce").mock(return_value=httpx.Response(201, json=AUTHORIZED))
    await fiscal.handle(deps, job(order))
    row = await fetch_one(pool, "select id from fiscal.documents where order_id = %s", (order["id"],))
    assert row
    return str(row["id"])


def cancel_job(order: dict[str, Any], doc_id: str, reason: str = "Venda cancelada a pedido da cliente") -> queues.QueueMessage:
    return queues.QueueMessage("fiscal_emission", 1, 1, {"org_id": ORG, "document_id": doc_id, "order_id": order["id"], "action": "CANCEL", "reason": reason, "model": "65"})


@respx.mock
async def test_cancellation_marks_the_document_cancelled_once(pool: Any, deps: Any, order: dict[str, Any]) -> None:
    doc_id = await _authorized_document(pool, deps, order)
    route = respx.delete(f"https://focus.test/v2/nfce/{order['ref']}").mock(return_value=httpx.Response(
        200, json={"status": "cancelado", "status_sefaz": "135", "mensagem_sefaz": "Evento registrado e vinculado a NFC-e", "protocolo": "P-C1"}))
    await fiscal.handle(deps, cancel_job(order, doc_id))
    assert json.loads(route.calls[0].request.content) == {"justificativa": "Venda cancelada a pedido da cliente"}
    doc = await document(pool, order)
    assert doc and doc["status"] == "CANCELLED" and doc["sefaz_code"] == "135"
    events = (await fetch_one(pool, "select events from fiscal.documents where id = %s", (doc_id,)))["events"]  # type: ignore[index]
    assert events[-1]["type"] == "CANCELLED" and events[-1]["protocol"] == "P-C1"
    await fiscal.handle(deps, cancel_job(order, doc_id))                                                      # reentrega: a nota já está cancelada, nada a fazer
    assert route.call_count == 1


@respx.mock
async def test_refused_cancellation_keeps_the_document_and_alerts(pool: Any, deps: Any, order: dict[str, Any]) -> None:
    doc_id = await _authorized_document(pool, deps, order)
    respx.delete(f"https://focus.test/v2/nfce/{order['ref']}").mock(return_value=httpx.Response(422, json={"codigo": "requisicao_invalida", "mensagem": "Prazo de cancelamento expirado"}))
    await fiscal.handle(deps, cancel_job(order, doc_id))
    doc = await document(pool, order)
    assert doc and doc["status"] == "AUTHORIZED"                                                              # continua válida: ninguém perdeu a nota
    events = (await fetch_one(pool, "select events from fiscal.documents where id = %s", (doc_id,)))["events"]  # type: ignore[index]
    assert events[-1] == {**events[-1], "type": "CANCEL_FAILED", "message": "Prazo de cancelamento expirado"}
    n = await fetch_one(pool, "select count(*) as n from core.notifications where kind = 'FISCAL_CANCEL_FAILED'")
    assert n and n["n"] >= 1


@respx.mock
async def test_cancellation_outage_retries_and_non_authorized_is_ignored(pool: Any, deps: Any, order: dict[str, Any]) -> None:
    doc_id = await _authorized_document(pool, deps, order)
    respx.delete(f"https://focus.test/v2/nfce/{order['ref']}").mock(return_value=httpx.Response(503))
    with pytest.raises(RetryLater):
        await fiscal.handle(deps, cancel_job(order, doc_id))
    assert (await document(pool, order))["status"] == "AUTHORIZED"  # type: ignore[index]
    await fetch_one(pool, "update fiscal.documents set status = 'REJECTED' where id = %s returning id", (doc_id,))
    ignored = respx.delete(url__regex=r"https://focus\.test/.*").mock(return_value=httpx.Response(200, json={"status": "cancelado"}))
    await fiscal.handle(deps, cancel_job(order, doc_id))                                                      # só nota AUTORIZADA se cancela
    assert not ignored.called


@respx.mock
async def test_connection_from_the_integrations_screen_wins_over_environment(pool: Any, deps: Any, order: dict[str, Any]) -> None:
    import base64
    import dataclasses
    suffix = uuid.uuid4().hex[:8]
    await fetch_one(pool, "select vault.create_secret(%s, %s)", ('{"token":"TOKEN-DA-TELA"}', f"integ/test/FOCUS_NFE/{suffix}"))
    await fetch_one(pool, "insert into core.integration_connections (org_id, provider, capability, config, secret_ref, status) values (%s, 'FOCUS_NFE', %s, %s, %s, 'ACTIVE') returning id",
                    (ORG, f"T_{suffix}", json.dumps({"environment": "producao"}), f"integ/test/FOCUS_NFE/{suffix}"))
    d = dataclasses.replace(deps, settings=deps.settings.model_copy(update={"focus_token": ""}))             # sem variável de ambiente: só a conexão
    route = respx.post("https://api.focusnfe.com.br/v2/nfce").mock(return_value=httpx.Response(201, json=AUTHORIZED))
    await fiscal.handle(d, job(order))
    assert route.called and route.calls[0].request.headers["authorization"] == "Basic " + base64.b64encode(b"TOKEN-DA-TELA:").decode()
    assert (await document(pool, order))["status"] == "AUTHORIZED"  # type: ignore[index]


async def connection(pool: Any, provider: str, secret: dict[str, Any], config: dict[str, Any]) -> None:
    suffix = uuid.uuid4().hex[:8]
    name = f"integ/test/{provider}/{suffix}"
    await fetch_one(pool, "select vault.create_secret(%s, %s)", (json.dumps(secret), name))
    await fetch_one(pool, "insert into core.integration_connections (org_id, provider, capability, config, secret_ref, status) values (%s, %s, %s, %s, %s, 'ACTIVE') returning id",
                    (ORG, provider, f"T_{suffix}", json.dumps(config), name))


@respx.mock
async def test_custom_item_goes_into_the_note_and_without_ncm_nothing_is_emitted(pool: Any, deps: Any, order: dict[str, Any]) -> None:
    await fetch_one(pool, "insert into sales.order_items (org_id, order_id, description, qty, list_price, unit_price, total) values (%s, %s, 'Ajuste de barra', 1, 30, 30, 30) returning id", (ORG, order["id"]))
    route = respx.post("https://focus.test/v2/nfce").mock(return_value=httpx.Response(201, json=AUTHORIZED))
    doc = await call_fn(pool, "fiscal.emission_payload", order["id"], "SALE")
    assert [i["descricao"] for i in doc["document"]["itens"]][-1] == "Ajuste de barra"                       # antes o item avulso sumia da nota
    with pytest.raises(PermanentError):
        await fiscal.handle(deps, job(order))                                                                  # sem NCM: não emite nota com dado inventado
    assert not route.called
    row = await fetch_one(pool, "select title from core.notifications where kind = 'FISCAL_REJECTED' order by created_at desc, id desc limit 1")
    assert row and "sem NCM" in row["title"] and "Ajuste de barra" in row["title"]


@respx.mock
async def test_primary_connection_wins_and_brasil_nfe_homologation_is_sent_as_test(pool: Any, deps: Any, order: dict[str, Any]) -> None:
    import dataclasses
    d = dataclasses.replace(deps, settings=deps.settings.model_copy(update={"focus_token": "", "brasilnfe_api_base": "https://bnfe.test"}))
    await connection(pool, "BRASIL_NFE", {"token": "BNFE"}, {"environment": "homologacao", "primary": "true"})
    await connection(pool, "FOCUS_NFE", {"token": "FOCUS"}, {"environment": "producao"})                       # editada por último, mas não é a principal
    route = respx.post("https://bnfe.test/services/EnviarNotaFiscal").mock(return_value=httpx.Response(200, json={"returnNF": {"numero": 7, "chaveNf": KEY, "codStatusRespostaSefaz": 100, "ok": True}}))
    focus = respx.post(url__regex=r"https://api\.focusnfe\.com\.br/.*").mock(return_value=httpx.Response(201, json=AUTHORIZED))
    await fiscal.handle(d, job(order))
    assert route.called and not focus.called
    assert json.loads(route.calls[0].request.content)["tipoAmbiente"] == 2                                  # homologação na tela = homologação na emissão


@respx.mock
async def test_notaas_in_homologation_without_test_url_does_not_emit(pool: Any, deps: Any, order: dict[str, Any]) -> None:
    import dataclasses
    d = dataclasses.replace(deps, settings=deps.settings.model_copy(update={"focus_token": ""}))
    await connection(pool, "NOTAAS", {"api_key": "ntaas_x"}, {"environment": "homologacao", "primary": "true"})
    route = respx.post(url__regex=r"https://platform\.notaas\.com\.br/.*").mock(return_value=httpx.Response(202, json={"invoiceId": "x"}))
    with pytest.raises(RetryLater):
        await fiscal.handle(d, job(order))
    assert not route.called                                                                                    # nunca emite nota real achando que é teste
    row = await fetch_one(pool, "select title from core.notifications where kind = 'INTEGRATION_ERROR' order by created_at desc, id desc limit 1")
    assert row and "homologação" in row["title"]


@respx.mock
async def test_dfe_sync_ignores_notaas_which_has_no_mde(pool: Any, deps: Any) -> None:
    import dataclasses
    d = dataclasses.replace(deps, settings=deps.settings.model_copy(update={"focus_token": ""}))
    await connection(pool, "NOTAAS", {"api_key": "ntaas_x"}, {"environment": "producao", "primary": "true"})
    calls = respx.route(url__regex=r".*").mock(return_value=httpx.Response(200, json={}))
    await fiscal.handle(d, queues.QueueMessage("fiscal_emission", 1, 1, {"action": "DFE_SYNC", "org_id": ORG}))   # antes: AttributeError a cada 2 h
    assert not calls.called


@respx.mock
async def test_async_cancellation_is_confirmed_later(pool: Any, deps: Any, order: dict[str, Any]) -> None:
    import dataclasses
    doc_id = await _authorized_document(pool, deps, order)
    await fetch_one(pool, "update fiscal.documents set provider_ref = 'inv_9' where id = %s returning id", (doc_id,))
    d = dataclasses.replace(deps, settings=deps.settings.model_copy(update={"focus_token": ""}))
    await connection(pool, "NOTAAS", {"api_key": "ntaas_x"}, {"environment": "producao", "primary": "true"})
    respx.post("https://platform.notaas.com.br/api/v1/nfe/cancelar").mock(return_value=httpx.Response(202, json={"status": "queued"}))
    await fiscal.handle(d, cancel_job(order, doc_id))
    assert (await document(pool, order))["status"] == "AUTHORIZED"  # type: ignore[index]                  # aceito não é cancelado
    check = await fetch_one(pool, "select message from pgmq.q_fiscal_emission where message ->> 'action' = 'CANCEL_CHECK' order by msg_id desc limit 1")
    assert check and check["message"]["document_id"] == doc_id
    respx.get("https://platform.notaas.com.br/api/v1/nfe/invoices/inv_9/status").mock(return_value=httpx.Response(200, json={"status": "cancelled", "protocolo": "P-C9"}))
    await fiscal.handle(d, queues.QueueMessage("fiscal_emission", 1, 1, check["message"]))
    assert (await document(pool, order))["status"] == "CANCELLED"  # type: ignore[index]


@respx.mock
async def test_unconfigured_providers_are_ignored_without_warnings(pool: Any, deps: Any, order: dict[str, Any]) -> None:
    """Só um provedor configurado: os outros (sem credencial, pendentes ou desativados) não são escolhidos nem geram aviso."""
    import dataclasses
    d = dataclasses.replace(deps, settings=deps.settings.model_copy(update={"focus_token": "", "brasilnfe_api_base": "https://bnfe.test"}))
    await fetch_one(pool, "insert into core.integration_connections (org_id, provider, capability, config, status) values (%s, 'NOTAAS', 'FISCAL_X1', '{}', 'PENDING') returning id", (ORG,))
    await fetch_one(pool, "insert into core.integration_connections (org_id, provider, capability, config, status) values (%s, 'FOCUS_NFE', 'FISCAL_X2', '{}', 'DISABLED') returning id", (ORG,))
    await connection(pool, "BRASIL_NFE", {"token": "BNFE"}, {"environment": "homologacao"})
    before = await fetch_one(pool, "select count(*) as n from core.notifications where kind = 'INTEGRATION_ERROR'")
    route = respx.post("https://bnfe.test/services/EnviarNotaFiscal").mock(return_value=httpx.Response(200, json={"returnNF": {"numero": 8, "chaveNf": KEY, "codStatusRespostaSefaz": 100, "ok": True}}))
    other = respx.route(url__regex=r"https://(api\.focusnfe|platform\.notaas).*").mock(return_value=httpx.Response(500))
    await fiscal.handle(d, job(order))
    assert route.called and not other.called
    after = await fetch_one(pool, "select count(*) as n from core.notifications where kind = 'INTEGRATION_ERROR'")
    assert after["n"] == before["n"]


@respx.mock
async def test_dfe_sync_with_brasil_nfe_uses_the_services_endpoint(pool: Any, deps: Any) -> None:
    import dataclasses
    d = dataclasses.replace(deps, settings=deps.settings.model_copy(update={"focus_token": "", "brasilnfe_api_base": "https://bnfe.test"}))
    await connection(pool, "BRASIL_NFE", {"token": "BNFE"}, {"environment": "producao", "primary": "true"})
    route = respx.post("https://bnfe.test/services/ObterNotasFiscais").mock(return_value=httpx.Response(200, json={"notas": [
        {"chave": "42261011222333000181550010000000501000000501", "cnpjEmissor": "11222333000181", "nomeEmissor": "Fornecedor", "valor": 900.5, "status": 1}]}))
    await fiscal.handle(d, queues.QueueMessage("fiscal_emission", 1, 1, {"action": "DFE_SYNC", "org_id": ORG}))
    assert route.called
    row = await fetch_one(pool, "select issuer_name from fiscal.inbound_dfe where access_key = '42261011222333000181550010000000501000000501'")
    assert row and row["issuer_name"] == "Fornecedor"
