"""Fila `fiscal_emission`: emite a NFC-e da venda no Focus NFe (síncrona no balcão; assíncrona pode ficar 'processando').
Devolução e NF-e (B2B) ainda dependem da matriz validada com o contador: geram aviso para revisão em vez de emitir errado."""
from __future__ import annotations

import logging

from .. import queues
from ..adapters.errors import PermanentError as ProviderPermanent
from ..adapters.errors import TransientError
from ..adapters.focus import FocusClient
from ..db import call_fn, fetch_one
from ..deps import Deps
from ..runner import PermanentError, RetryLater

log = logging.getLogger("sie_worker.fiscal")


async def handle(deps: Deps, msg: queues.QueueMessage) -> None:
    p = msg.payload
    order_id, org_id, purpose = p["order_id"], p["org_id"], p.get("purpose", "SALE")
    if purpose != "SALE" or p.get("model") == "55":
        what = "Devolução" if purpose != "SALE" else "Venda B2B (NF-e)"
        order = await fetch_one(deps.pool, "select number from sales.orders where id = %s", (order_id,))
        await deps.notify(org_id, "FISCAL_REVIEW", f"{what} do pedido {order['number'] if order else order_id}: definir o documento fiscal com o contador",
                          {"order_id": order_id, "purpose": purpose}, perm="fiscal.write")
        return

    doc = await call_fn(deps.pool, "fiscal.emission_payload", order_id, "SALE")
    ref = doc["ref"]
    token = deps.settings.focus_token
    if not token:
        conn = await fetch_one(deps.pool, "select id from core.integration_connections where org_id = %s and provider = 'FOCUS_NFE' and status <> 'DISABLED' limit 1", (org_id,))
        token = (await deps.secret(conn["id"] if conn else None)).get("token", "")
    if not token:
        await deps.notify(org_id, "INTEGRATION_ERROR", "Emissão fiscal parada: Focus NFe sem credencial", {"order_id": order_id}, perm="fiscal.write")
        raise RetryLater(600, "Focus NFe não configurado")

    focus = FocusClient(deps.http, deps.settings.focus_api_base, token)
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
