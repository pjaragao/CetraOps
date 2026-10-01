"""Templates do WhatsApp: envio para aprovação, sincronização com a Meta e situação/qualidade vindas por webhook."""
from __future__ import annotations

import json
import uuid
from typing import Any

import httpx
import pytest
import respx

from sie_worker import queues
from sie_worker.db import call_fn, fetch_one
from sie_worker.handlers import inbound, templates
from sie_worker.runner import RetryLater

from .conftest import ORG

pytestmark = pytest.mark.db

COMPONENTS = [{"type": "BODY", "text": "Oi {{1}}! Seu pedido {{2}} está pronto.", "example": {"body_text": [["Ana", "VEN-1"]]}}]


async def with_waba(pool: Any, channel: dict[str, str], waba: str | None = "WABA-T1") -> None:
    cfg = json.dumps({"waba_id": waba} if waba else {})
    await fetch_one(pool, "update core.integration_connections set config = %s::jsonb where id = (select connection_id from omni.channel_accounts where id = %s) returning id", (cfg, channel["account_id"]))


async def make_template(pool: Any, channel: dict[str, str], name: str = "pedido_pronto", status: str = "PENDING", external_id: str | None = None) -> str:
    row = await fetch_one(pool, """insert into omni.templates (org_id, channel_account_id, name, language, category, components, status, submitted_at, external_id)
                                   values (%s, %s, %s, 'pt_BR', 'UTILITY', %s, %s, now(), %s) returning id""", (ORG, channel["account_id"], name, json.dumps(COMPONENTS), status, external_id))
    assert row
    return str(row["id"])


def job(action: str, **kw: Any) -> queues.QueueMessage:
    return queues.QueueMessage("template_tasks", 1, 1, {"action": action, "org_id": ORG, **kw})


async def tpl(pool: Any, tid: str) -> dict[str, Any]:
    row = await fetch_one(pool, "select status, external_id, rejection_reason, quality from omni.templates where id = %s", (tid,))
    assert row
    return row


@respx.mock
async def test_submit_sends_the_template_to_meta_and_keeps_it_pending(pool: Any, deps: Any, channel: dict[str, str]) -> None:
    await with_waba(pool, channel)
    tid = await make_template(pool, channel)
    route = respx.post("https://graph.test/v21.0/WABA-T1/message_templates").mock(return_value=httpx.Response(200, json={"id": "555", "status": "PENDING", "category": "UTILITY"}))
    await templates.handle(deps, job("SUBMIT", template_id=tid))
    req = route.calls[0].request
    assert req.headers["authorization"] == "Bearer WA-TOKEN"
    assert json.loads(req.content) == {"name": "pedido_pronto", "language": "pt_BR", "category": "UTILITY", "components": COMPONENTS}
    t = await tpl(pool, tid)
    assert (t["status"], t["external_id"]) == ("PENDING", "555")
    await templates.handle(deps, job("SUBMIT", template_id=tid))                                      # reentrega: já tem id na Meta, não envia de novo
    assert route.call_count == 1


@respx.mock
async def test_submit_can_come_back_approved_right_away(pool: Any, deps: Any, channel: dict[str, str]) -> None:
    await with_waba(pool, channel)
    tid = await make_template(pool, channel)
    respx.post("https://graph.test/v21.0/WABA-T1/message_templates").mock(return_value=httpx.Response(200, json={"id": "556", "status": "APPROVED", "category": "UTILITY"}))
    await templates.handle(deps, job("SUBMIT", template_id=tid))
    assert (await tpl(pool, tid))["status"] == "APPROVED"


@respx.mock
async def test_meta_refusal_marks_rejected_with_the_reason_and_alerts(pool: Any, deps: Any, channel: dict[str, str]) -> None:
    await with_waba(pool, channel)
    tid = await make_template(pool, channel)
    respx.post("https://graph.test/v21.0/WABA-T1/message_templates").mock(return_value=httpx.Response(400, json={"error": {"code": 100, "error_user_msg": "Já existe um template com esse nome e idioma."}}))
    await templates.handle(deps, job("SUBMIT", template_id=tid))
    t = await tpl(pool, tid)
    assert t["status"] == "REJECTED" and "Já existe um template" in t["rejection_reason"]
    n = await fetch_one(pool, "select count(*) as n from core.notifications where kind = 'TEMPLATE_STATUS' and payload ->> 'template_id' = %s", (tid,))
    assert n and n["n"] >= 1


@respx.mock
async def test_meta_outage_retries_without_changing_the_template(pool: Any, deps: Any, channel: dict[str, str]) -> None:
    await with_waba(pool, channel)
    tid = await make_template(pool, channel)
    respx.post("https://graph.test/v21.0/WABA-T1/message_templates").mock(return_value=httpx.Response(503))
    with pytest.raises(RetryLater):
        await templates.handle(deps, job("SUBMIT", template_id=tid))
    assert (await tpl(pool, tid))["status"] == "PENDING"


async def test_missing_waba_sends_the_template_back_to_draft_with_the_reason(pool: Any, deps: Any, channel: dict[str, str]) -> None:
    await with_waba(pool, channel, waba=None)
    tid = await make_template(pool, channel)
    await templates.handle(deps, job("SUBMIT", template_id=tid))                                      # nenhuma chamada HTTP (respx não está ativo)
    t = await tpl(pool, tid)
    assert t["status"] == "DRAFT" and "WABA" in t["rejection_reason"]


@respx.mock
async def test_sync_upserts_remote_templates_across_pages(pool: Any, deps: Any, channel: dict[str, str]) -> None:
    await with_waba(pool, channel)
    local = await make_template(pool, channel, name="pedido_pronto", status="PENDING")
    page2 = "https://graph.test/v21.0/WABA-T1/message_templates?after=CURSOR2"
    respx.get("https://graph.test/v21.0/WABA-T1/message_templates", params={"limit": "100"}).mock(return_value=httpx.Response(200, json={
        "data": [{"id": "900", "name": "pedido_pronto", "language": "pt_BR", "category": "UTILITY", "status": "APPROVED", "components": COMPONENTS, "quality_score": {"score": "GREEN"}}],
        "paging": {"next": page2}}))
    respx.get(page2).mock(return_value=httpx.Response(200, json={"data": [
        {"id": "901", "name": "novidades", "language": "pt_BR", "category": "MARKETING", "status": "REJECTED", "components": [{"type": "BODY", "text": "Novidades!"}], "rejected_reason": "INVALID_FORMAT"}]}))
    await templates.handle(deps, job("SYNC", channel_account_id=channel["account_id"]))
    t = await tpl(pool, local)
    assert (t["status"], t["external_id"], t["quality"]) == ("APPROVED", "900", "GREEN")             # o local virou o aprovado da Meta
    new = await fetch_one(pool, "select status, category, rejection_reason from omni.templates where external_id = '901'")
    assert new == {"status": "REJECTED", "category": "MARKETING", "rejection_reason": "INVALID_FORMAT"}


async def test_sync_without_credentials_alerts_instead_of_failing(pool: Any, deps: Any, channel: dict[str, str]) -> None:
    await with_waba(pool, channel, waba=None)
    await templates.handle(deps, job("SYNC", channel_account_id=channel["account_id"]))
    n = await fetch_one(pool, "select count(*) as n from core.notifications where kind = 'INTEGRATION_ERROR' and title like 'Sincronização de templates parada%'")
    assert n and n["n"] >= 1


async def _webhook(pool: Any, deps: Any, waba: str, change: dict[str, Any]) -> None:
    payload = {"object": "whatsapp_business_account", "entry": [{"id": waba, "changes": [change]}]}
    res = await call_fn(pool, "omni.ingest_webhook", "META_WA", f"tpl-{uuid.uuid4().hex}", payload)
    await inbound.handle(deps, queues.QueueMessage("inbound_events", 1, 1, {"webhook_event_id": res["id"]}))


async def test_webhook_status_and_quality_updates_reach_the_template(pool: Any, deps: Any, channel: dict[str, str]) -> None:
    await with_waba(pool, channel)
    tid = await make_template(pool, channel, external_id="555")
    await _webhook(pool, deps, "WABA-T1", {"field": "message_template_status_update", "value": {
        "event": "REJECTED", "message_template_id": 555, "message_template_name": "pedido_pronto", "message_template_language": "pt_BR", "reason": "INVALID_FORMAT"}})
    t = await tpl(pool, tid)
    assert (t["status"], t["rejection_reason"]) == ("REJECTED", "INVALID_FORMAT")
    await _webhook(pool, deps, "WABA-T1", {"field": "message_template_status_update", "value": {
        "event": "APPROVED", "message_template_id": 555, "message_template_name": "pedido_pronto", "message_template_language": "pt_BR", "reason": "NONE"}})
    t = await tpl(pool, tid)
    assert (t["status"], t["rejection_reason"]) == ("APPROVED", None)
    await _webhook(pool, deps, "WABA-T1", {"field": "message_template_quality_update", "value": {
        "previous_quality_score": "GREEN", "new_quality_score": "YELLOW", "message_template_id": 555, "message_template_name": "pedido_pronto", "message_template_language": "pt_BR"}})
    t = await tpl(pool, tid)
    assert (t["status"], t["quality"]) == ("APPROVED", "YELLOW")
    ev = await fetch_one(pool, "select count(*) as n from omni.webhook_events where error is not null and event_key like 'tpl-%' and processed_at > now() - interval '5 minutes'")
    assert ev and ev["n"] == 0                                                                        # o webhook foi processado sem erro
