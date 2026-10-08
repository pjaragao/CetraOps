"""Públicos da Meta: só sobe quem aceitou anúncios, com hash SHA-256 (nunca contato em claro); semelhante, exclusão e erro de credencial (Graph API simulada com respx)."""
from __future__ import annotations

import hashlib
import json
import uuid
from typing import Any

import httpx
import pytest
import respx

from centralops_worker.adapters.meta import audience_row
from centralops_worker.db import fetch_one
from centralops_worker.handlers import ad_audiences, campaigns
from centralops_worker.queues import QueueMessage

from .conftest import ORG

pytestmark = pytest.mark.db
GRAPH = "https://graph.test/v21.0"
ACCOUNT = "act_777"


def sha(v: str) -> str:
    return hashlib.sha256(v.encode()).hexdigest()


@pytest.fixture
async def ads_connection(pool: Any) -> None:
    secret = f"test-aud-{uuid.uuid4().hex[:8]}"
    await fetch_one(pool, "select vault.create_secret(%s, %s)", (json.dumps({"token": "ADS-TOKEN"}), secret))
    await fetch_one(pool, "insert into core.integration_connections (org_id, provider, capability, secret_ref, status, config) values (%s, 'META_ADS', 'ADS', %s, 'ACTIVE', %s) returning id",
                    (ORG, secret, json.dumps({"ad_account_id": "777"})))


async def person(pool: Any, name: str, tag: str, *, phone: str | None, email: str | None, ads: bool) -> str:
    p = await fetch_one(pool, "insert into crm.parties (org_id, kind, display_name, lifecycle_stage, tags) values (%s, 'PERSON', %s, 'CUSTOMER', %s) returning id", (ORG, name, [tag]))
    assert p
    if phone:
        await fetch_one(pool, "insert into crm.party_contact_points (org_id, party_id, type, value_normalized, value_display, is_primary) values (%s, %s, 'WHATSAPP', %s, %s, true) returning id", (ORG, p["id"], phone, phone))
    if email:
        await fetch_one(pool, "insert into crm.party_contact_points (org_id, party_id, type, value_normalized, value_display, is_primary) values (%s, %s, 'EMAIL', %s, %s, true) returning id", (ORG, p["id"], email, email))
    if ads:
        await fetch_one(pool, "insert into crm.consents (org_id, party_id, purpose, granted, legal_basis) values (%s, %s, 'MARKETING_ADS', true, 'CONSENT') returning id", (ORG, p["id"]))
    return str(p["id"])


def test_rows_are_hashed_and_normalized() -> None:
    assert audience_row({"phone": "+55 (48) 99111-0001", "email": " Ana@Exemplo.COM ", "first_name": "Ana"}) == [sha("5548991110001"), sha("ana@exemplo.com"), sha("ana")]
    assert audience_row({"phone": "123", "email": "sem-arroba", "first_name": ""}) == ["", "", ""]


@respx.mock
async def test_sync_uploads_only_consenting_people_hashed_and_marks_ready(pool: Any, deps: Any, ads_connection: None) -> None:
    tag = f"aud-{uuid.uuid4().hex[:8]}"
    await person(pool, "Ana Aceitou", tag, phone="5548991110001", email=None, ads=True)
    await person(pool, "Bia Email", tag, phone=None, email="bia@exemplo.com", ads=True)
    await person(pool, "Cris Recusou", tag, phone="5548991110003", email=None, ads=False)
    seg = await fetch_one(pool, "insert into mkt.segments (org_id, name, definition) values (%s, %s, %s) returning id", (ORG, f"Público {tag}", json.dumps({"tags": [tag]})))
    aud = await fetch_one(pool, "insert into mkt.ad_audiences (org_id, name, segment_id) values (%s, %s, %s) returning id", (ORG, f"CentralOps · {tag}", seg["id"]))  # type: ignore[index]
    create = respx.post(f"{GRAPH}/{ACCOUNT}/customaudiences").mock(return_value=httpx.Response(200, json={"id": "AUD-1"}))
    replace = respx.post(f"{GRAPH}/AUD-1/usersreplace").mock(return_value=httpx.Response(200, json={"num_received": 2}))
    respx.get(f"{GRAPH}/AUD-1").mock(return_value=httpx.Response(200, json={"approximate_count_lower_bound": 1000}))
    await campaigns.handle(deps, QueueMessage("campaign_tasks", 1, 1, {"action": "AUDIENCE_SYNC", "org_id": ORG, "audience_id": str(aud["id"])}))  # type: ignore[index]
    assert create.called
    body = json.loads(replace.calls[0].request.content)
    assert body["payload"]["schema"] == ["PHONE", "EMAIL", "FN"]
    assert sorted(body["payload"]["data"]) == sorted([[sha("5548991110001"), "", sha("ana")], ["", sha("bia@exemplo.com"), sha("bia")]])
    assert body["session"]["last_batch_flag"] is True and body["session"]["estimated_num_total"] == 2
    raw = replace.calls[0].request.content.decode()
    assert "5548991110001" not in raw and "bia@exemplo.com" not in raw                       # nada em claro
    row = await fetch_one(pool, "select status, meta_audience_id, uploaded, matched_estimate, ad_account from mkt.ad_audiences where id = %s", (aud["id"],))  # type: ignore[index]
    assert row == {"status": "READY", "meta_audience_id": "AUD-1", "uploaded": 2, "matched_estimate": 1000, "ad_account": ACCOUNT}


@respx.mock
async def test_nobody_consented_is_an_error_not_an_empty_upload(pool: Any, deps: Any, ads_connection: None) -> None:
    tag = f"aud-{uuid.uuid4().hex[:8]}"
    await person(pool, "Sem Aceite", tag, phone="5548991119999", email=None, ads=False)
    aud = await fetch_one(pool, "insert into mkt.ad_audiences (org_id, name, definition) values (%s, %s, %s) returning id", (ORG, f"CentralOps · {tag}", json.dumps({"tags": [tag]})))
    create = respx.post(f"{GRAPH}/{ACCOUNT}/customaudiences").mock(return_value=httpx.Response(200, json={"id": "X"}))
    await ad_audiences.sync(deps, ORG, str(aud["id"]))  # type: ignore[index]
    assert not create.called
    row = await fetch_one(pool, "select status, last_error from mkt.ad_audiences where id = %s", (aud["id"],))  # type: ignore[index]
    assert row and row["status"] == "ERROR" and "aceitou" in row["last_error"]
    note = await fetch_one(pool, "select title from core.notifications where kind = 'INTEGRATION_ERROR' order by created_at desc limit 1")
    assert note and "não foi enviado" in note["title"]


@respx.mock
async def test_lookalike_is_created_from_the_ready_source(pool: Any, deps: Any, ads_connection: None) -> None:
    src = await fetch_one(pool, "insert into mkt.ad_audiences (org_id, name, status, meta_audience_id, uploaded, ad_account) values (%s, 'Origem', 'READY', 'AUD-SRC', 500, %s) returning id", (ORG, ACCOUNT))
    look = await fetch_one(pool, "insert into mkt.ad_audiences (org_id, name, kind, source_audience_id, lookalike_ratio, ad_account) values (%s, 'Origem · semelhante 2%%', 'LOOKALIKE', %s, 2, %s) returning id", (ORG, src["id"], ACCOUNT))  # type: ignore[index]
    route = respx.post(f"{GRAPH}/{ACCOUNT}/customaudiences").mock(return_value=httpx.Response(200, json={"id": "LAL-1"}))
    await campaigns.handle(deps, QueueMessage("campaign_tasks", 1, 1, {"action": "LOOKALIKE_CREATE", "org_id": ORG, "audience_id": str(look["id"])}))  # type: ignore[index]
    sent = json.loads(route.calls[0].request.content)
    assert sent["subtype"] == "LOOKALIKE" and sent["origin_audience_id"] == "AUD-SRC" and json.loads(sent["lookalike_spec"]) == {"type": "similarity", "country": "BR", "ratio": 0.02}
    row = await fetch_one(pool, "select status, meta_audience_id from mkt.ad_audiences where id = %s", (look["id"],))  # type: ignore[index]
    assert row == {"status": "READY", "meta_audience_id": "LAL-1"}


@respx.mock
async def test_permanent_error_marks_the_audience_and_notifies(pool: Any, deps: Any, ads_connection: None) -> None:
    tag = f"aud-{uuid.uuid4().hex[:8]}"
    await person(pool, "Ana Aceitou", tag, phone="5548991110008", email=None, ads=True)
    aud = await fetch_one(pool, "insert into mkt.ad_audiences (org_id, name, definition) values (%s, %s, %s) returning id", (ORG, f"CentralOps · {tag}", json.dumps({"tags": [tag]})))
    respx.post(f"{GRAPH}/{ACCOUNT}/customaudiences").mock(return_value=httpx.Response(400, json={"error": {"code": 2655, "message": "Termos do público personalizado não aceitos"}}))
    await ad_audiences.sync(deps, ORG, str(aud["id"]))  # type: ignore[index]
    row = await fetch_one(pool, "select status, last_error from mkt.ad_audiences where id = %s", (aud["id"],))  # type: ignore[index]
    assert row and row["status"] == "ERROR" and "2655" in row["last_error"]


@respx.mock
async def test_delete_removes_the_audience_on_meta(deps: Any, ads_connection: None) -> None:
    route = respx.delete(f"{GRAPH}/AUD-9").mock(return_value=httpx.Response(200, json={"success": True}))
    await campaigns.handle(deps, QueueMessage("campaign_tasks", 1, 1, {"action": "AUDIENCE_DELETE", "org_id": ORG, "meta_audience_id": "AUD-9"}))
    assert route.called
