"""Campanhas: o consumidor envia em lotes, respeita o limite diário do número e avisa quando termina."""
from __future__ import annotations

import uuid
from typing import Any

import pytest

from sie_worker import queues
from sie_worker.db import fetch_one
from sie_worker.handlers import campaigns

from .conftest import ORG

pytestmark = pytest.mark.db


async def make_campaign(pool: Any, channel: dict[str, str], daily_limit: int, parties: int = 2) -> str:
    tpl = await fetch_one(pool, """insert into omni.templates (org_id, channel_account_id, name, language, category, components, status)
                                   values (%s, %s, %s, 'pt_BR', 'MARKETING', '[{"type":"BODY","text":"Oi {{1}}! Novidades."}]', 'APPROVED') returning id""", (ORG, channel["account_id"], f"t_{uuid.uuid4().hex[:8]}"))
    assert tpl
    camp = await fetch_one(pool, """insert into mkt.campaigns (org_id, name, channel_account_id, template_id, variables, daily_limit, status, started_at)
                                    values (%s, %s, %s, %s, '[{"source":"FIRST_NAME"}]', %s, 'SENDING', now()) returning id""", (ORG, f"Campanha {uuid.uuid4().hex[:6]}", channel["account_id"], tpl["id"], daily_limit))
    assert camp
    for n in range(parties):
        party = await fetch_one(pool, "insert into crm.parties (org_id, kind, display_name, lifecycle_stage) values (%s, 'PERSON', %s, 'CUSTOMER') returning id", (ORG, f"Cliente{n} Teste"))
        assert party
        phone = "5548" + str(uuid.uuid4().int)[:9]
        await fetch_one(pool, "insert into crm.party_contact_points (org_id, party_id, type, value_normalized, value_display, is_primary) values (%s, %s, 'WHATSAPP', %s, %s, true) returning id", (ORG, party["id"], phone, phone))
        await fetch_one(pool, "insert into crm.consents (org_id, party_id, purpose, granted, legal_basis) values (%s, %s, 'MARKETING_WHATSAPP', true, 'CONSENT') returning id", (ORG, party["id"]))
        await fetch_one(pool, "insert into mkt.campaign_recipients (org_id, campaign_id, party_id) values (%s, %s, %s) returning id", (ORG, camp["id"], party["id"]))
    return str(camp["id"])


def job(cid: str) -> queues.QueueMessage:
    return queues.QueueMessage("campaign_tasks", 1, 1, {"campaign_id": cid, "org_id": ORG})


async def count(pool: Any, cid: str, status: str) -> int:
    row = await fetch_one(pool, "select count(*) as n from mkt.campaign_recipients where campaign_id = %s and status = %s", (cid, status))
    return int(row["n"]) if row else 0


async def test_daily_limit_holds_the_rest_and_the_job_comes_back_later(pool: Any, deps: Any, channel: dict[str, str], monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(campaigns, "PAUSE_S", 0)
    cid = await make_campaign(pool, channel, daily_limit=1)
    before = (await fetch_one(pool, "select queue_length from pgmq.metrics('campaign_tasks')"))["queue_length"]   # type: ignore[index]
    await campaigns.handle(deps, job(cid))
    assert await count(pool, cid, "QUEUED") == 1 and await count(pool, cid, "PENDING") == 1
    assert (await fetch_one(pool, "select queue_length from pgmq.metrics('campaign_tasks')"))["queue_length"] == before + 1      # type: ignore[index]   # volta daqui a 1 h
    assert (await fetch_one(pool, "select message ->> 'campaign_id' as c, vt > now() + interval '50 minutes' as later from pgmq.q_campaign_tasks order by msg_id desc limit 1")) == {"c": cid, "later": True}


async def test_finishes_the_campaign_and_notifies_the_team(pool: Any, deps: Any, channel: dict[str, str], monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(campaigns, "PAUSE_S", 0)
    cid = await make_campaign(pool, channel, daily_limit=10)
    await campaigns.handle(deps, job(cid))
    assert await count(pool, cid, "QUEUED") == 2 and await count(pool, cid, "PENDING") == 0
    assert (await fetch_one(pool, "select status from mkt.campaigns where id = %s", (cid,)))["status"] == "DONE"   # type: ignore[index]
    note = await fetch_one(pool, "select kind, title from core.notifications where kind = 'CAMPAIGN' order by created_at desc limit 1")
    assert note and "concluída" in note["title"]
    sent = await fetch_one(pool, "select count(*) as n from omni.messages where payload ->> 'campaign_id' = %s and type = 'TEMPLATE' and author_type = 'SYSTEM'", (cid,))
    assert sent and sent["n"] == 2
    await campaigns.handle(deps, job(cid))                                                          # reentrega depois de concluída: nada acontece
    assert await count(pool, cid, "QUEUED") == 2


async def test_cancelled_campaign_sends_nothing(pool: Any, deps: Any, channel: dict[str, str]) -> None:
    cid = await make_campaign(pool, channel, daily_limit=10)
    await fetch_one(pool, "update mkt.campaigns set status = 'CANCELLED' where id = %s returning id", (cid,))
    await campaigns.handle(deps, job(cid))
    assert await count(pool, cid, "QUEUED") == 0
