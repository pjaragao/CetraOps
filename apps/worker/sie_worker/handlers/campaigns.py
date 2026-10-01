"""Fila `campaign_tasks`: envio de campanhas de marketing (template do WhatsApp) em lotes.
O banco decide quem pode receber (consentimento, intervalo, número) e respeita o limite diário do número (faixa da Meta); aqui só se dá o ritmo:
lotes de 50, uma pausa entre eles e, quando o limite do dia acaba, o job volta daqui a 1 hora (o limite é uma janela móvel de 24 h)."""
from __future__ import annotations

import asyncio
import logging

from .. import queues
from ..db import call_fn, fetch_one
from ..deps import Deps
from . import ad_insights

log = logging.getLogger("sie_worker.campaigns")

BATCH = 50
PAUSE_S = 1.0
RECHECK_S = 3600


async def handle(deps: Deps, msg: queues.QueueMessage) -> None:
    if msg.payload.get("action") == "AD_INSIGHTS_SYNC":
        await ad_insights.sync(deps, str(msg.payload["org_id"]))
        return
    cid, org = str(msg.payload["campaign_id"]), str(msg.payload["org_id"])
    stalled = 0
    while True:
        out = await call_fn(deps.pool, "mkt.campaign_send_batch", cid, BATCH)
        if out["done"]:
            row = await fetch_one(deps.pool, "select name, status from mkt.campaigns where id = %s", (cid,))
            if row and row["status"] == "DONE":
                await deps.notify(org, "CAMPAIGN", f"Campanha «{row['name']}» concluída", {"campaign_id": cid}, perm="crm.write")
            return
        if out["blocked_by_daily_limit"]:
            log.info("campanha %s: limite diário do número atingido, volta em %ss (%s pendentes)", cid, RECHECK_S, out["pending"])
            await queues.send(deps.pool, "campaign_tasks", dict(msg.payload), RECHECK_S)
            return
        stalled = stalled + 1 if out["sent"] == 0 else 0
        if stalled >= 3:                                            # nada andou em 3 rodadas: não trava o consumidor, reavalia depois
            await queues.send(deps.pool, "campaign_tasks", dict(msg.payload), 300)
            return
        await asyncio.sleep(PAUSE_S)
