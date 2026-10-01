"""Resultados dos anúncios da Meta: leitura paginada, normalização das conversões, janela de releitura e erro de credencial (Graph API simulada com respx)."""
from __future__ import annotations

import json
import uuid
from datetime import timedelta
from typing import Any

import httpx
import pytest
import respx

from sie_worker.adapters.meta import normalize_insight
from sie_worker.db import fetch_all, fetch_one
from sie_worker.handlers import ad_insights, campaigns
from sie_worker.queues import QueueMessage

from .conftest import ORG

pytestmark = pytest.mark.db
GRAPH = "https://graph.test/v21.0"
ACCOUNT = "act_555"


def item(ad: str, day: str, spend: str = "12.50", **extra: Any) -> dict[str, Any]:
    return {"ad_id": ad, "ad_name": f"Anúncio {ad}", "adset_name": "Conjunto A", "campaign_id": "C1", "campaign_name": "Drop 01", "date_start": day, "date_stop": day,
            "spend": spend, "impressions": "1000", "reach": "800", "clicks": "40", "actions": [{"action_type": "onsite_conversion.messaging_conversation_started_7d", "value": "6"}, {"action_type": "lead", "value": "2"}],
            "action_values": [{"action_type": "purchase", "value": "430.00"}], **extra}


@pytest.fixture
async def ads_connection(pool: Any) -> None:
    secret = f"test-ads-{uuid.uuid4().hex[:8]}"
    await fetch_one(pool, "select vault.create_secret(%s, %s)", (json.dumps({"token": "ADS-TOKEN"}), secret))
    await fetch_one(pool, "insert into core.integration_connections (org_id, provider, capability, secret_ref, status, config) values (%s, 'META_ADS', 'ADS', %s, 'ACTIVE', %s) returning id",
                    (ORG, secret, json.dumps({"ad_account_id": "555"})))


def test_normalize_insight_reads_conversions_from_actions_and_values() -> None:
    n = normalize_insight(item("A1", "2026-09-30", purchase_x=1))
    assert n and n["conversations"] == 6 and n["leads"] == 2 and n["purchases"] == 0 and n["purchase_value"] == 430.0 and n["spend"] == 12.5 and n["impressions"] == 1000
    assert normalize_insight({"ad_id": "A", "actions": [{"action_type": "purchase", "value": "3"}], "date_start": "2026-09-30"})["purchases"] == 3  # type: ignore[index]
    assert normalize_insight({"date_start": "2026-09-30"}) is None and normalize_insight({"ad_id": "A"}) is None


@respx.mock
async def test_sync_follows_pagination_and_rereading_a_day_updates_instead_of_duplicating(pool: Any, deps: Any, ads_connection: None) -> None:
    await fetch_one(pool, "delete from mkt.ad_insights_daily where org_id = %s returning id", (ORG,))
    route = respx.get(f"{GRAPH}/{ACCOUNT}/insights").mock(side_effect=[
        httpx.Response(200, json={"data": [item("A1", "2026-09-29"), item("A2", "2026-09-29", "30.00")], "paging": {"cursors": {"after": "CUR1"}, "next": "https://x"}}),
        httpx.Response(200, json={"data": [item("A1", "2026-09-30")], "paging": {"cursors": {"after": "CUR2"}}}),
    ])
    await ad_insights.sync(deps, ORG)
    assert route.call_count == 2 and route.calls[1].request.url.params["after"] == "CUR1"
    assert json.loads(route.calls[0].request.url.params["time_range"])["until"] and route.calls[0].request.url.params["level"] == "ad"
    rows = await fetch_all(pool, "select ad_id, day, spend, conversations, leads, purchase_value from mkt.ad_insights_daily where org_id = %s order by ad_id, day", (ORG,))
    assert [(r["ad_id"], str(r["day"]), float(r["spend"]), r["conversations"]) for r in rows] == [("A1", "2026-09-29", 12.5, 6), ("A1", "2026-09-30", 12.5, 6), ("A2", "2026-09-29", 30.0, 6)]
    state = await fetch_one(pool, "select last_day, last_rows, last_error from mkt.ad_sync_state where org_id = %s and ad_account = %s", (ORG, ACCOUNT))
    assert state and str(state["last_day"]) == "2026-09-30" and state["last_rows"] == 3 and state["last_error"] is None

    # a Meta revisou o gasto de ontem: a nova rodada relê 3 dias para trás e atualiza o valor
    route2 = respx.get(f"{GRAPH}/{ACCOUNT}/insights").mock(return_value=httpx.Response(200, json={"data": [item("A1", "2026-09-30", "99.00")]}))
    await ad_insights.sync(deps, ORG)
    since = json.loads(route2.calls.last.request.url.params["time_range"])["since"]
    assert since == str(state["last_day"] - timedelta(days=3))
    assert (await fetch_one(pool, "select count(*) as n from mkt.ad_insights_daily where org_id = %s", (ORG,)))["n"] == 3                                   # type: ignore[index]
    assert float((await fetch_one(pool, "select spend from mkt.ad_insights_daily where ad_id = 'A1' and day = '2026-09-30' and org_id = %s", (ORG,)))["spend"]) == 99.0  # type: ignore[index]


@respx.mock
async def test_refused_credential_is_recorded_and_warns_the_team_without_retrying(pool: Any, deps: Any, ads_connection: None) -> None:
    respx.get(f"{GRAPH}/{ACCOUNT}/insights").mock(return_value=httpx.Response(400, json={"error": {"code": 190, "message": "Invalid OAuth access token"}}))
    await ad_insights.sync(deps, ORG)                                                          # não levanta: repetir não resolve token inválido
    state = await fetch_one(pool, "select last_error from mkt.ad_sync_state where org_id = %s and ad_account = %s", (ORG, ACCOUNT))
    assert state and "Invalid OAuth access token" in state["last_error"]
    assert (await fetch_one(pool, "select count(*) as n from core.notifications where kind = 'INTEGRATION_ERROR' and title like 'Resultados dos anúncios parados%'"))["n"] >= 1  # type: ignore[index]


@respx.mock
async def test_rate_limit_is_retried_later(pool: Any, deps: Any, ads_connection: None) -> None:
    from sie_worker.runner import RetryLater

    respx.get(f"{GRAPH}/{ACCOUNT}/insights").mock(return_value=httpx.Response(400, json={"error": {"code": 17, "message": "User request limit reached"}}))
    with pytest.raises(RetryLater):
        await ad_insights.sync(deps, ORG)


async def test_sync_without_connection_does_nothing(pool: Any, deps: Any) -> None:
    await fetch_one(pool, "delete from core.integration_connections where org_id = %s and provider = 'META_ADS' returning id", (ORG,))
    await ad_insights.sync(deps, ORG)                                                            # sem integração configurada: sem erro, sem chamada
    assert (await fetch_one(pool, "select count(*) as n from mkt.ad_sync_state where org_id = %s", (ORG,)))["n"] == 0                         # type: ignore[index]


@respx.mock
async def test_campaign_queue_routes_the_ads_task(pool: Any, deps: Any, ads_connection: None) -> None:
    route = respx.get(f"{GRAPH}/{ACCOUNT}/insights").mock(return_value=httpx.Response(200, json={"data": []}))
    await campaigns.handle(deps, QueueMessage("campaign_tasks", 1, 1, {"action": "AD_INSIGHTS_SYNC", "org_id": ORG}))
    assert route.call_count == 1
