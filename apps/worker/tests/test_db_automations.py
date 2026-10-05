"""Automações no worker: disparo ao receber a mensagem, resposta privada do Instagram e a IA calada quando a automação já respondeu."""
from __future__ import annotations

import dataclasses
import json
import time
import uuid
from typing import Any

import httpx
import pytest
import respx

from centralops_worker import queues
from centralops_worker.db import call_fn, fetch_one
from centralops_worker.handlers import inbound, outbound, router

from .conftest import ORG, ingest, unique_phone
from .test_db_pipeline import wa_webhook

pytestmark = pytest.mark.db


async def make_rule(pool: Any, trigger: str, conditions: dict[str, Any], actions: list[dict[str, Any]], channel_account: str | None = None) -> str:
    row = await fetch_one(pool, """insert into omni.automations (org_id, name, trigger, channel_account_id, conditions, actions, cooldown_days, active)
                                   values (%s, %s, %s, %s, %s::jsonb, %s::jsonb, 0, true) returning id""", (ORG, f"Regra {uuid.uuid4().hex[:6]}", trigger, channel_account, json.dumps(conditions), json.dumps(actions)))
    assert row
    return str(row["id"])


async def webhook(pool: Any, deps: Any, pnid: str, wa: str, body: str, referral: dict[str, Any] | None = None) -> str:
    msg: dict[str, Any] = {"from": wa, "id": f"wamid.{uuid.uuid4().hex}", "timestamp": str(int(time.time())), "type": "text", "text": {"body": body}}
    if referral:
        msg["referral"] = referral
    res = await call_fn(pool, "omni.ingest_webhook", "META_WA", f"evt-{uuid.uuid4().hex}", wa_webhook(pnid, wa, msg))
    await inbound.handle(deps, queues.QueueMessage("inbound_events", 1, 1, {"webhook_event_id": res["id"]}))
    row = await fetch_one(pool, "select id from omni.messages where provider_message_id = %s", (msg["id"],))
    assert row
    return str(row["id"])


async def test_keyword_rule_replies_when_the_message_arrives_and_marks_it(pool: Any, deps: Any, channel: dict[str, str]) -> None:
    await make_rule(pool, "KEYWORD", {"keywords": ["horário"]}, [{"type": "SEND_TEXT", "text": "Oi {nome}! Abrimos às 7h."}])
    mid = await webhook(pool, deps, channel["pnid"], unique_phone(), "Que horário vocês abrem?")
    out = await fetch_one(pool, "select body, author_type, status from omni.messages where conversation_id = (select conversation_id from omni.messages where id = %s) and direction = 'OUT'", (mid,))
    assert out and out["author_type"] == "SYSTEM" and out["status"] == "QUEUED" and out["body"].startswith("Oi ") and "Abrimos às 7h." in out["body"]
    assert (await fetch_one(pool, "select payload ->> 'automation_handled' as h from omni.messages where id = %s", (mid,)))["h"] == "true"   # type: ignore[index]


async def test_click_to_whatsapp_referral_reaches_the_rule(pool: Any, deps: Any, channel: dict[str, str]) -> None:
    rule = await make_rule(pool, "CTWA_REFERRAL", {}, [{"type": "ADD_TAG", "tag": "veio-do-anuncio"}])
    mid = await webhook(pool, deps, channel["pnid"], unique_phone(), "Oi, vim pelo anúncio", referral={"source_url": "https://fb.me/ad", "source_type": "ad", "source_id": "123", "ctwa_clid": "AbC"})
    run = await fetch_one(pool, "select status from omni.automation_runs where automation_id = %s and message_id = %s", (rule, mid))
    assert run and run["status"] == "DONE"
    plain = await webhook(pool, deps, channel["pnid"], unique_phone(), "Oi, tudo bem?")
    assert await fetch_one(pool, "select 1 as x from omni.automation_runs where message_id = %s", (plain,)) is None


async def test_a_failing_rule_never_breaks_message_ingestion(pool: Any, deps: Any, channel: dict[str, str]) -> None:
    await make_rule(pool, "KEYWORD", {"keywords": ["oi"]}, [{"type": "CREATE_TASK", "title": "x" * 10, "due_in_hours": "abc"}])        # prazo que não é número: a ação estoura dentro do banco
    mid = await webhook(pool, deps, channel["pnid"], unique_phone(), "oi, tudo bem?")
    assert await fetch_one(pool, "select 1 as x from omni.messages where id = %s", (mid,))                                                 # a mensagem entrou mesmo assim
    run = await fetch_one(pool, "select status from omni.automation_runs where message_id = %s", (mid,))
    assert run and run["status"] == "FAILED"


class Boom:
    async def run(self, *_: Any) -> Any:
        raise AssertionError("a IA não deveria ser chamada")


async def test_router_leaves_messages_already_answered_by_an_automation(pool: Any, deps: Any, channel: dict[str, str]) -> None:
    ev = await ingest(pool, channel, unique_phone(), "Qual o horário?")
    await fetch_one(pool, "update omni.messages set payload = payload || '{\"automation_handled\": true}' where id = %s returning id", (ev["message_id"],))
    await fetch_one(pool, "update omni.conversations set mode = 'AI_AUTOPILOT' where id = %s returning id", (ev["conversation_id"],))
    msg = queues.QueueMessage("conversation_router", 1, 1, {"conversation_id": str(ev["conversation_id"]), "message_id": str(ev["message_id"])})
    await router.handle(dataclasses.replace(deps, agent=Boom()), msg)                      # se chamasse a IA, o teste quebraria


@respx.mock
async def test_instagram_private_reply_goes_to_the_comment_not_the_person(pool: Any, deps: Any, channel: dict[str, str]) -> None:
    conn = await fetch_one(pool, "select connection_id from omni.channel_accounts where id = %s", (channel["account_id"],))
    assert conn
    ig = f"IG-{uuid.uuid4().hex[:8]}"
    acc = await fetch_one(pool, """insert into omni.channel_accounts (org_id, channel, provider_account_id, display_name, store_id, default_ai_mode, connection_id)
                                   values (%s, 'INSTAGRAM', %s, 'Instagram teste', '00000000-0000-4000-8000-0000000000a1', 'AI_COPILOT', %s) returning id""", (ORG, ig, conn["connection_id"]))
    assert acc
    await make_rule(pool, "COMMENT_KEYWORD", {"keywords": ["quero"]}, [{"type": "PRIVATE_REPLY", "text": "Oi {nome}! Te mandei os detalhes por aqui."}], channel_account=str(acc["id"]))
    ev = await call_fn(pool, "omni.ingest_event", {"kind": "MESSAGE", "channel": "INSTAGRAM", "provider_account_id": ig, "external_id": f"igsid-{uuid.uuid4().hex[:8]}", "handle": "cliente.teste", "display_name": "Cliente Insta",
                                                  "provider_message_id": f"comment:{uuid.uuid4().hex}", "type": "COMMENT", "body": "Quero esse look!", "payload": {"comment_id": "17900099", "media_id": "555"}})
    await call_fn(pool, "omni.run_automations", ev["message_id"], None)
    out = await fetch_one(pool, "select id, status, payload from omni.messages where conversation_id = %s and direction = 'OUT'", (ev["conversation_id"],))
    assert out and out["payload"]["reply_to_comment_id"] == "17900099"
    route = respx.post(f"https://ig.test/v21.0/{ig}/messages").mock(return_value=httpx.Response(200, json={"message_id": "mid.PR1", "recipient_id": "x"}))
    await outbound.handle(deps, queues.QueueMessage("outbound_messages", 1, 1, {"message_id": str(out["id"]), "org_id": ORG}))
    body = json.loads(route.calls[0].request.content)
    assert body == {"recipient": {"comment_id": "17900099"}, "message": {"text": "Oi Cliente! Te mandei os detalhes por aqui."}}
    done = await fetch_one(pool, "select status, provider_message_id from omni.messages where id = %s", (out["id"],))
    assert done and (done["status"], done["provider_message_id"]) == ("SENT", "mid.PR1")
