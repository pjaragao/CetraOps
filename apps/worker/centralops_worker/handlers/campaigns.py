"""Fila `campaign_tasks`: envio dos disparos de campanhas de marketing (template do WhatsApp) em lotes, resultados de anúncios e públicos da Meta.
O banco decide quem pode receber (consentimento, intervalo, número) e respeita o limite diário do número (faixa da Meta); aqui só se dá o ritmo:
lotes de 50, uma pausa entre eles e, quando o limite do dia acaba, o job volta daqui a 1 hora (o limite é uma janela móvel de 24 h)."""
from __future__ import annotations

import asyncio
import logging

from .. import queues
from ..db import call_fn, fetch_one
from ..deps import Deps
from . import ad_audiences, ad_insights

log = logging.getLogger("centralops_worker.campaigns")

BATCH = 50
PAUSE_S = 1.0
RECHECK_S = 3600


async def handle(deps: Deps, msg: queues.QueueMessage) -> None:
    action = msg.payload.get("action")
    if action == "AD_INSIGHTS_SYNC":
        await ad_insights.sync(deps, str(msg.payload["org_id"]))
        return
    if action == "AUDIENCE_SYNC":
        await ad_audiences.sync(deps, str(msg.payload["org_id"]), str(msg.payload["audience_id"]))
        return
    if action == "LOOKALIKE_CREATE":
        await ad_audiences.lookalike(deps, str(msg.payload["org_id"]), str(msg.payload["audience_id"]))
        return
    if action == "AUDIENCE_DELETE":
        await ad_audiences.delete(deps, str(msg.payload["org_id"]), str(msg.payload["meta_audience_id"]))
        return
    # `dispatch_id` (campanhas novas); `campaign_id` sozinho = disparo de campanha antiga (o disparo herdou o id da campanha)
    did, org = str(msg.payload.get("dispatch_id") or msg.payload["campaign_id"]), str(msg.payload["org_id"])
    stalled = 0
    while True:
        out = await call_fn(deps.pool, "mkt.dispatch_send_batch", did, BATCH)
        if out["done"]:
            row = await fetch_one(deps.pool, """select c.id, c.name, d.status, coalesce(d.label, case when d.seq = 1 then 'principal' else 'lembrete ' || (d.seq - 1) end) as label
                                                from mkt.campaign_dispatches d join mkt.campaigns c on c.id = d.campaign_id where d.id = %s""", (did,))
            if row and row["status"] == "DONE":
                await deps.notify(org, "CAMPAIGN", f"Campanha «{row['name']}»: disparo {row['label']} concluído", {"campaign_id": str(row["id"]), "dispatch_id": did}, perm="crm.write")
            return
        if out["blocked_by_daily_limit"]:
            log.info("disparo %s: limite diário do número atingido, volta em %ss (%s pendentes)", did, RECHECK_S, out["pending"])
            await queues.send(deps.pool, "campaign_tasks", dict(msg.payload), RECHECK_S)
            return
        stalled = stalled + 1 if out["sent"] == 0 else 0
        if stalled >= 3:                                            # nada andou em 3 rodadas: não trava o consumidor, reavalia depois
            await queues.send(deps.pool, "campaign_tasks", dict(msg.payload), 300)
            return
        await asyncio.sleep(PAUSE_S)
