"""Fila `capi_events`: envia a venda concluída para a Meta (Conversions API, evento Purchase).
Privacidade: venda de anúncio no WhatsApp (ctwa_clid) vai sem dado pessoal; venda sem anúncio só com consentimento de marketing, e telefone/e-mail
saem com hash SHA-256 (nunca em claro). Sem a integração configurada, a venda é só registrada como "não enviada" (a fila não acumula)."""
from __future__ import annotations

import hashlib
import logging
from typing import Any

from .. import queues
from ..adapters.errors import PermanentError, TransientError
from ..adapters.meta import MetaClient
from ..db import call_fn, fetch_one
from ..deps import Deps
from ..runner import RetryLater

log = logging.getLogger("sie_worker.capi")

PAID = {"PAID", "COMPLETED", "FULFILLING", "READY_FOR_PICKUP", "SHIPPED", "PARTIALLY_RETURNED"}
MARKETING_CONSENTS = ("MARKETING_WHATSAPP", "MARKETING_IG", "MARKETING_EMAIL")


def sha256(value: str) -> str:
    return hashlib.sha256(value.strip().lower().encode()).hexdigest()


def build_event(d: dict[str, Any], cfg: dict[str, Any]) -> tuple[dict[str, Any] | None, str | None]:
    """(evento, motivo para não enviar). Não faz rede."""
    custom = {"currency": d.get("currency") or "BRL", "value": float(d["total"])}
    base = {"event_name": "Purchase", "event_time": int(d["event_time"]), "event_id": str(d["order_id"]), "custom_data": custom}
    ctwa = d.get("ctwa_clid") or d.get("ctwa_clid_alt")
    if ctwa and cfg.get("waba_id"):
        return {**base, "action_source": "business_messaging", "messaging_channel": "whatsapp", "user_data": {"whatsapp_business_account_id": str(cfg["waba_id"]), "ctwa_clid": str(ctwa)}}, None
    consents = d.get("consents") or {}
    if not any(consents.get(c) for c in MARKETING_CONSENTS):
        return None, "NO_CONSENT"
    user: dict[str, Any] = {}
    if d.get("phones"):
        user["ph"] = [sha256(p) for p in d["phones"]]
    if d.get("emails"):
        user["em"] = [sha256(e) for e in d["emails"]]
    if not user:
        return None, "NO_IDENTIFIERS"
    user["external_id"] = [sha256(str(d["party_id"]))]
    return {**base, "action_source": "physical_store", "user_data": user}, None


async def _record(deps: Deps, order_id: str, org_id: str, status: str, reason: str | None = None, response: dict[str, Any] | None = None) -> None:
    await call_fn(deps.pool, "mkt.capi_record", {"order_id": order_id, "org_id": org_id, "status": status, "reason": reason, "response": response})


async def handle(deps: Deps, msg: queues.QueueMessage) -> None:
    order_id, org = str(msg.payload["order_id"]), str(msg.payload["org_id"])
    d = await call_fn(deps.pool, "mkt.capi_payload", order_id)
    if d is None:
        return                                                      # venda removida
    if d["status"] not in PAID:
        await _record(deps, order_id, org, "SKIPPED", "NOT_PAID")
        return
    conn = await fetch_one(deps.pool, "select id, config from core.integration_connections where org_id = %s and provider = 'META_CAPI' and status <> 'DISABLED' order by created_at limit 1", (org,))
    token = (await deps.secret(str(conn["id"]))).get("token") if conn else None
    dataset = str(((conn or {}).get("config") or {}).get("dataset_id") or "").strip()
    if not conn or not token or not dataset:
        await _record(deps, order_id, org, "SKIPPED", "NOT_CONFIGURED")
        return
    cfg = conn["config"] or {}
    event, why = build_event(d, cfg)
    if event is None:
        await _record(deps, order_id, org, "SKIPPED", why)
        return
    body_extra = {"test_event_code": cfg["test_event_code"]} if cfg.get("test_event_code") else {}
    try:
        resp = await MetaClient(deps.http, deps.settings.graph_api_base, str(token)).send_capi_events(dataset, [event], body_extra)
    except TransientError as e:
        raise RetryLater(int(e.retry_after or 60), str(e)) from e
    except PermanentError as e:
        await _record(deps, order_id, org, "FAILED", str(e))
        await deps.notify(org, "INTEGRATION_ERROR", f"Conversões da Meta recusadas: {e}", {"order_id": order_id}, perm="core.admin")
        return
    await _record(deps, order_id, org, "SENT", None, {"events_received": resp.get("events_received"), "fbtrace_id": resp.get("fbtrace_id")})
