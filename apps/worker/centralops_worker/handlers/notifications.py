"""Fila `notifications`: eventos de outras partes do sistema viram avisos para quem tem a permissão (sino do app, Realtime)."""
from __future__ import annotations

from .. import queues
from ..db import call_fn, fetch_one
from ..deps import Deps

TITLES = {
    "PAYMENT_LINK_REQUESTED": ("Link de pagamento solicitado", "sales.write"),
    "NEW_MESSAGE": ("Nova mensagem de cliente", "omni.write"),
    "DRAFT_READY": ("Rascunho da IA pronto para revisar", "omni.write"),
    "HANDOFF": ("Cliente aguardando atendimento humano", "omni.write"),
}


async def handle(deps: Deps, msg: queues.QueueMessage) -> None:
    p = dict(msg.payload)
    org_id, kind = p.pop("org_id"), p.pop("kind")
    title, perm = TITLES.get(kind, (p.pop("title", kind), None))
    member = p.pop("member_id", None)
    if kind in ("NEW_MESSAGE", "DRAFT_READY", "HANDOFF") and p.get("conversation_id") and not member:
        row = await fetch_one(deps.pool, "select assignee_member_id from omni.conversations where id = %s", (p["conversation_id"],))
        member = row["assignee_member_id"] if row else None
    await call_fn(deps.pool, "core.notify", org_id, kind, title, p, None if member else perm, member)
