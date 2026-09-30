"""Fila `fiscal_emission`: emite a NFC-e da venda no Focus NFe (síncrona no balcão; assíncrona pode ficar 'processando') e cancela nota autorizada.
Devolução e NF-e (B2B) ainda dependem da matriz validada com o contador: geram aviso para revisão em vez de emitir errado.
A credencial vem da conexão FOCUS_NFE (Vault, com o ambiente escolhido na tela de Integrações); as variáveis de ambiente só valem como reserva."""
from __future__ import annotations

import logging
from typing import Any

from .. import queues
from ..adapters.errors import PermanentError as ProviderPermanent
from ..adapters.errors import TransientError
from ..adapters.focus import PRODUCTION_BASE, FocusClient
from ..db import call_fn, fetch_one
from ..deps import Deps
from ..runner import PermanentError, RetryLater

log = logging.getLogger("sie_worker.fiscal")


async def _focus(deps: Deps, org_id: str) -> FocusClient | None:
    conn = await fetch_one(deps.pool, """select id, config from core.integration_connections
                                         where org_id = %s and provider = 'FOCUS_NFE' and status <> 'DISABLED' and secret_ref is not null order by updated_at desc limit 1""", (org_id,))
    if conn:
        token = (await deps.secret(str(conn["id"]))).get("token", "")
        if token:
            env = str((conn["config"] or {}).get("environment", "")).lower()
            return FocusClient(deps.http, PRODUCTION_BASE if env in ("producao", "production") else deps.settings.focus_api_base, token)
    if deps.settings.focus_token:
        return FocusClient(deps.http, deps.settings.focus_api_base, deps.settings.focus_token)
    return None


async def _cancel(deps: Deps, p: dict[str, Any]) -> None:
    doc = await fetch_one(deps.pool, "select id, org_id, model, provider_ref, idempotency_key, status, number from fiscal.documents where id = %s and org_id = %s", (p["document_id"], p["org_id"]))
    if doc is None or doc["status"] != "AUTHORIZED":
        return                                                          # reentrega da fila ou nota que já mudou: nada a cancelar
    focus = await _focus(deps, p["org_id"])
    if focus is None:
        await deps.notify(p["org_id"], "INTEGRATION_ERROR", "Cancelamento fiscal parado: Focus NFe sem credencial", {"document_id": p["document_id"]}, perm="fiscal.write")
        raise RetryLater(600, "Focus NFe não configurado")
    ref = doc["provider_ref"] or doc["idempotency_key"]
    result = None
    error: str | None = None
    try:
        result = await focus.cancel(doc["model"], ref, p["reason"])
    except TransientError as e:
        raise RetryLater(int(e.retry_after or 30), str(e)) from e
    except ProviderPermanent as e:
        error = str(e)
    if result is not None and result.status == "CANCELLED":
        await call_fn(deps.pool, "fiscal.record_cancellation", doc["id"], {"protocol": result.protocol, "sefaz_code": result.code, "sefaz_msg": result.message})
        return
    error = error or (result.message or result.code if result is not None else None) or "cancelamento recusado"
    await call_fn(deps.pool, "fiscal.record_document_event", doc["id"], {"type": "CANCEL_FAILED", "message": error})
    await deps.notify(p["org_id"], "FISCAL_CANCEL_FAILED", f"Não foi possível cancelar a nota {doc['number']}: {error}", {"document_id": str(doc["id"])}, perm="fiscal.write")


async def handle(deps: Deps, msg: queues.QueueMessage) -> None:
    p = msg.payload
    if p.get("action") == "CANCEL":
        await _cancel(deps, p)
        return
    order_id, org_id, purpose = p["order_id"], p["org_id"], p.get("purpose", "SALE")
    if purpose != "SALE" or p.get("model") == "55":
        what = "Devolução" if purpose != "SALE" else "Venda B2B (NF-e)"
        order = await fetch_one(deps.pool, "select number from sales.orders where id = %s", (order_id,))
        await deps.notify(org_id, "FISCAL_REVIEW", f"{what} do pedido {order['number'] if order else order_id}: definir o documento fiscal com o contador",
                          {"order_id": order_id, "purpose": purpose}, perm="fiscal.write")
        return

    doc = await call_fn(deps.pool, "fiscal.emission_payload", order_id, "SALE")
    ref = doc["ref"]
    focus = await _focus(deps, org_id)
    if focus is None:
        await deps.notify(org_id, "INTEGRATION_ERROR", "Emissão fiscal parada: Focus NFe sem credencial", {"order_id": order_id}, perm="fiscal.write")
        raise RetryLater(600, "Focus NFe não configurado")

    existing = await fetch_one(deps.pool, "select status from fiscal.documents where idempotency_key = %s and org_id = %s", (ref, org_id))
    try:
        result = await (focus.get("65", ref) if existing and existing["status"] == "PROCESSING" else focus.emit_nfce(ref, doc["document"]))
    except TransientError as e:
        raise RetryLater(int(e.retry_after or 30), str(e)) from e
    except ProviderPermanent as e:
        await deps.notify(org_id, "FISCAL_REJECTED", f"Focus NFe recusou o pedido: {e}", {"order_id": order_id}, perm="fiscal.write")
        raise PermanentError(str(e)) from e

    await call_fn(deps.pool, "fiscal.record_emission", {
        "ref": ref, "order_id": order_id, "model": "65", "status": result.status, "series": result.series or doc.get("series"), "number": result.number,
        "access_key": result.access_key, "protocol": result.protocol, "sefaz_code": result.code, "sefaz_msg": result.message, "provider_ref": ref,
        "xml_path": result.xml_path, "danfe_path": result.danfe_path,
    })
    if result.status == "PROCESSING":
        raise RetryLater(15, "NFC-e ainda em processamento na SEFAZ")
    if result.status in ("REJECTED", "DENIED"):
        await deps.notify(org_id, "FISCAL_REJECTED", f"NFC-e do pedido {doc['order_number']} rejeitada: {result.message or result.code}",
                          {"order_id": order_id, "code": result.code, "message": result.message}, perm="fiscal.write")
