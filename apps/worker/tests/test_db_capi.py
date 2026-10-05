"""Conversions API da Meta: o que sai, com que proteção de dados, e o que só é registrado."""
from __future__ import annotations

import hashlib
import json
import uuid
from typing import Any

import httpx
import pytest
import respx

from centralops_worker import queues
from centralops_worker.db import fetch_one
from centralops_worker.handlers import capi
from centralops_worker.runner import RetryLater

from .conftest import ORG

pytestmark = pytest.mark.db

DATASET = "DS-123"
URL = f"https://graph.test/v21.0/{DATASET}/events"


def sha(v: str) -> str:
    return hashlib.sha256(v.encode()).hexdigest()


def job(order_id: str) -> queues.QueueMessage:
    return queues.QueueMessage("capi_events", 1, 1, {"order_id": order_id, "org_id": ORG, "event": "Purchase"})


async def setup_connection(pool: Any, config: dict[str, Any] | None = None) -> None:
    name = f"capi-{uuid.uuid4().hex[:8]}"
    await fetch_one(pool, "select vault.create_secret(%s, %s)", ('{"token":"CAPI-TOKEN"}', name))  # type: ignore[arg-type]
    await fetch_one(pool, "insert into core.integration_connections (org_id, provider, capability, config, secret_ref, status) values (%s, 'META_CAPI', %s, %s::jsonb, %s, 'ACTIVE') returning id",
                    (ORG, f"CAPI_{uuid.uuid4().hex[:6]}", json.dumps(config or {"dataset_id": DATASET, "waba_id": "WABA-9"}), name))  # type: ignore[arg-type]


async def make_order(pool: Any, *, status: str = "PAID", attribution: dict[str, Any] | None = None, consent: bool = True, phone: bool = True, email: bool = True) -> str:
    party = await fetch_one(pool, "insert into crm.parties (org_id, kind, display_name, lifecycle_stage) values (%s, 'PERSON', 'Cliente Capi', 'CUSTOMER') returning id", (ORG,))
    assert party
    if phone:
        num = str(uuid.uuid4().int)[:8]
        await fetch_one(pool, "insert into crm.party_contact_points (org_id, party_id, type, value_normalized, value_display, is_primary) values (%s, %s, 'WHATSAPP', %s, %s, true) returning id", (ORG, party["id"], "55489" + num, f"+55 48 9{num}"))
    if email:
        mail = f"Ana.{uuid.uuid4().hex[:8]}@Exemplo.com"
        await fetch_one(pool, "insert into crm.party_contact_points (org_id, party_id, type, value_normalized, value_display, is_primary) values (%s, %s, 'EMAIL', %s, %s, false) returning id", (ORG, party["id"], mail, mail))
    if consent:
        await fetch_one(pool, "insert into crm.consents (org_id, party_id, purpose, granted, legal_basis) values (%s, %s, 'MARKETING_WHATSAPP', true, 'CONSENT') returning id", (ORG, party["id"]))
    row = await fetch_one(pool, """insert into sales.orders (org_id, legal_entity_id, store_id, location_id, number, channel, status, party_id, attribution, subtotal, total, idempotency_key)
                                   values (%s, (select id from core.legal_entities limit 1), '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1', %s, 'POS', %s, %s, %s::jsonb, 350, 350, %s) returning id""",
                          (ORG, f"CAPI-{uuid.uuid4().hex[:8]}", status, party["id"], json.dumps(attribution or {}), uuid.uuid4().hex))
    assert row
    return str(row["id"])


async def logged(pool: Any, order: str) -> dict[str, Any]:
    row = await fetch_one(pool, "select status, reason, response from mkt.capi_events where order_id = %s", (order,))
    assert row
    return row


def test_build_event_hashes_identifiers_and_needs_consent() -> None:
    d = {"order_id": "o1", "party_id": "p1", "total": 350, "currency": "BRL", "event_time": 1700000000, "phones": ["5548977771234"], "emails": ["ana@exemplo.com"], "consents": {"MARKETING_WHATSAPP": True}}
    ev, why = capi.build_event(d, {})
    assert why is None and ev is not None
    assert ev["action_source"] == "physical_store" and ev["event_id"] == "o1" and ev["custom_data"] == {"currency": "BRL", "value": 350.0}
    assert ev["user_data"]["ph"] == [sha("5548977771234")] and ev["user_data"]["em"] == [sha("ana@exemplo.com")] and "5548977771234" not in json.dumps(ev)
    assert capi.build_event({**d, "consents": {}}, {}) == (None, "NO_CONSENT")
    assert capi.build_event({**d, "consents": {"MARKETING_WHATSAPP": False}}, {}) == (None, "NO_CONSENT")
    assert capi.build_event({**d, "phones": [], "emails": []}, {}) == (None, "NO_IDENTIFIERS")
    ad, why = capi.build_event({**d, "ctwa_clid": "CLID", "consents": {}}, {"waba_id": "W1"})      # vinda de anúncio no WhatsApp: sem dado pessoal, sem precisar de consentimento de marketing
    assert why is None and ad is not None and ad["action_source"] == "business_messaging" and ad["user_data"] == {"whatsapp_business_account_id": "W1", "ctwa_clid": "CLID"}
    assert "ph" not in json.dumps(ad)


async def test_not_configured_or_not_paid_is_only_recorded(pool: Any, deps: Any) -> None:
    order = await make_order(pool)
    await capi.handle(deps, job(order))
    assert (await logged(pool, order))["reason"] == "NOT_CONFIGURED"
    await setup_connection(pool)
    cancelled = await make_order(pool, status="CANCELLED")
    await capi.handle(deps, job(cancelled))
    assert (await logged(pool, cancelled))["reason"] == "NOT_PAID"
    await capi.handle(deps, job(str(uuid.uuid4())))                                                  # venda inexistente: nada acontece


@respx.mock
async def test_sends_the_purchase_hashed_and_records_the_result(pool: Any, deps: Any) -> None:
    await setup_connection(pool, {"dataset_id": DATASET, "test_event_code": "TEST123"})
    order = await make_order(pool)
    route = respx.post(URL).mock(return_value=httpx.Response(200, json={"events_received": 1, "fbtrace_id": "TRACE1"}))
    await capi.handle(deps, job(order))
    req = route.calls[0].request
    body = json.loads(req.content)
    assert req.headers["authorization"] == "Bearer CAPI-TOKEN" and body["test_event_code"] == "TEST123"
    ev = body["data"][0]
    pay = await fetch_one(pool, "select mkt.capi_payload(%s) as d", (order,))
    phone, mail = pay["d"]["phones"][0], pay["d"]["emails"][0]   # type: ignore[index]
    assert ev["event_name"] == "Purchase" and ev["event_id"] == order and ev["user_data"]["ph"] == [sha(phone)] and ev["user_data"]["em"] == [sha(mail)]
    assert phone not in req.content.decode() and "exemplo.com" not in req.content.decode()
    rec = await logged(pool, order)
    assert rec["status"] == "SENT" and rec["response"]["events_received"] == 1


@respx.mock
async def test_ad_sale_goes_without_personal_data_and_unconsented_sale_is_held_back(pool: Any, deps: Any) -> None:
    await setup_connection(pool)
    ad = await make_order(pool, attribution={"referral": {"ctwa_clid": "CLID-1"}}, consent=False)
    route = respx.post(URL).mock(return_value=httpx.Response(200, json={"events_received": 1}))
    await capi.handle(deps, job(ad))
    sent = json.loads(route.calls[0].request.content)["data"][0]
    assert sent["action_source"] == "business_messaging" and sent["user_data"] == {"whatsapp_business_account_id": "WABA-9", "ctwa_clid": "CLID-1"}
    plain = await make_order(pool, consent=False)
    await capi.handle(deps, job(plain))
    assert route.call_count == 1 and (await logged(pool, plain))["reason"] == "NO_CONSENT"
    nobody = await make_order(pool, phone=False, email=False)
    await capi.handle(deps, job(nobody))
    assert (await logged(pool, nobody))["reason"] == "NO_IDENTIFIERS"


@respx.mock
async def test_meta_errors_retry_or_fail_with_a_warning(pool: Any, deps: Any) -> None:
    await setup_connection(pool)
    order = await make_order(pool)
    respx.post(URL).mock(return_value=httpx.Response(500, json={"error": {"message": "instável", "code": 2}}))
    with pytest.raises(RetryLater):
        await capi.handle(deps, job(order))
    respx.post(URL).mock(return_value=httpx.Response(400, json={"error": {"message": "Token inválido", "code": 190}}))
    await capi.handle(deps, job(order))
    rec = await logged(pool, order)
    assert rec["status"] == "FAILED" and "Token inválido" in rec["reason"]
    note = await fetch_one(pool, "select title from core.notifications where kind = 'INTEGRATION_ERROR' order by created_at desc limit 1")
    assert note and "Conversões da Meta recusadas" in note["title"]
