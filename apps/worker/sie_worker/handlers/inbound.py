"""Fila `inbound_events`: webhook bruto → eventos normalizados → conversa/mensagem (tudo idempotente, no banco)."""
from __future__ import annotations

import logging

import psycopg

from .. import queues
from ..db import call_fn, fetch_one
from ..deps import Deps
from ..normalizer import normalize
from ..runner import PermanentError

log = logging.getLogger("sie_worker.inbound")


async def handle(deps: Deps, msg: queues.QueueMessage) -> None:
    wid = msg.payload["webhook_event_id"]
    row = await fetch_one(deps.pool, "select provider, payload, processed_at from omni.webhook_events where id = %s", (wid,))
    if row is None:
        raise PermanentError(f"webhook_event {wid} não encontrado")
    if row["processed_at"] is not None:
        return                                                     # reentrega da fila: já tratado
    try:
        events = normalize(row["provider"], row["payload"])
    except (KeyError, ValueError, TypeError) as e:
        await fetch_one(deps.pool, "update omni.webhook_events set error = %s, processed_at = now() where id = %s returning id", (f"payload inesperado: {e}", wid))
        raise PermanentError(f"payload inesperado: {e}") from e

    errors: list[str] = []
    for ev in events:
        if ev.get("kind") == "TEMPLATE":                          # situação/qualidade de template da Meta: não é conversa
            await call_fn(deps.pool, "omni.record_template_status", {k: ev.get(k) for k in ("waba_id", "external_id", "name", "language", "status", "reason", "quality")})
            continue
        try:
            res = await call_fn(deps.pool, "omni.ingest_event", ev)
        except psycopg.Error as e:                                  # canal não cadastrado/evento inválido (P0100/P0101): não adianta repetir
            if e.sqlstate in ("P0100", "P0101"):
                errors.append(str(e).splitlines()[0])
                continue
            raise
        if res.get("kind") in ("MESSAGE",) and not res.get("duplicate"):
            try:                                                   # automações (palavra-chave, anúncio, story, comentário): nunca derrubam a entrada da mensagem
                await call_fn(deps.pool, "omni.run_automations", res["message_id"], ev.get("referral"))
            except psycopg.Error as e:
                log.warning("automações falharam na mensagem %s: %s", res["message_id"], e)
            media = (ev.get("payload") or {}).get("media")
            if media:
                await queues.send(deps.pool, "media_processing", {"message_id": res["message_id"], "provider": row["provider"], "channel": ev["channel"],
                                                                     "provider_account_id": ev["provider_account_id"], "media": media, "type": ev["type"]})
    await fetch_one(deps.pool, "update omni.webhook_events set processed_at = now(), error = %s where id = %s returning id", ("; ".join(errors) or None, wid))
