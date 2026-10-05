"""Resultados dos anúncios (Meta Marketing API › insights por anúncio e por dia). Roda todo dia às 06:00 (Brasília) e sob demanda.
A Meta revisa os números dos últimos dias, então cada rodada relê uma janela de 3 dias para trás; reler o mesmo dia atualiza, nunca duplica."""
from __future__ import annotations

import logging
from datetime import date, timedelta
from typing import Any

from .. import queues
from ..adapters.errors import PermanentError as ProviderPermanent
from ..adapters.errors import TransientError
from ..adapters.meta import MetaClient
from ..db import call_fn, fetch_one
from ..deps import Deps
from ..runner import RetryLater

log = logging.getLogger("centralops_worker.ad_insights")

INITIAL_DAYS = 30
OVERLAP_DAYS = 3
CHUNK = 200


def _today_sp() -> date:
    from datetime import datetime
    from zoneinfo import ZoneInfo

    return datetime.now(ZoneInfo("America/Sao_Paulo")).date()


async def sync(deps: Deps, org_id: str) -> None:
    conn = await fetch_one(deps.pool, "select id, config from core.integration_connections where org_id = %s and provider = 'META_ADS' and status <> 'DISABLED' and secret_ref is not null order by created_at limit 1", (org_id,))
    if conn is None:
        return
    token = (await deps.secret(str(conn["id"]))).get("token")
    account = str((conn["config"] or {}).get("ad_account_id") or "").strip()
    if not token or not account:
        return
    if not account.startswith("act_"):
        account = f"act_{account}"
    state = await fetch_one(deps.pool, "select last_day from mkt.ad_sync_state where org_id = %s and ad_account = %s", (org_id, account))
    today = _today_sp()
    since = (state["last_day"] - timedelta(days=OVERLAP_DAYS)) if state and state["last_day"] else today - timedelta(days=INITIAL_DAYS)
    client = MetaClient(deps.http, deps.settings.graph_api_base, str(token))
    total = 0
    last_day: date | None = None
    try:
        rows: list[dict[str, Any]] = []
        async for row in client.ad_insights(account, since.isoformat(), today.isoformat()):
            rows.append(row)
            last_day = max(last_day, date.fromisoformat(row["day"])) if last_day else date.fromisoformat(row["day"])
            if len(rows) >= CHUNK:
                total += await call_fn(deps.pool, "mkt.ad_insights_upsert", org_id, account, rows)
                rows = []
        if rows:
            total += await call_fn(deps.pool, "mkt.ad_insights_upsert", org_id, account, rows)
    except TransientError as e:
        raise RetryLater(int(e.retry_after or 120), str(e)) from e
    except ProviderPermanent as e:
        await call_fn(deps.pool, "mkt.ad_sync_set", org_id, account, None, 0, str(e)[:300])
        await deps.notify(org_id, "INTEGRATION_ERROR", f"Resultados dos anúncios parados: {e}", {"ad_account": account}, perm="crm.write")
        return
    await call_fn(deps.pool, "mkt.ad_sync_set", org_id, account, last_day, total, None)


async def handle(deps: Deps, msg: queues.QueueMessage) -> None:
    await sync(deps, str(msg.payload["org_id"]))
