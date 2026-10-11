"""Fila `fiscal_emission`: emite a NFC-e da venda (Focus NFe, Brasil NFe ou Notaas), cancela nota autorizada e busca as notas recebidas (MDe).
Devolução e NF-e (B2B) ainda dependem da matriz validada com o contador: geram aviso para revisão em vez de emitir errado.
Provedor: a conexão marcada como principal na tela de Integrações; sem marcação, a editada por último. O ambiente (produção/homologação) escolhido
na tela vale também na emissão. MDe só existe no Focus NFe e na Brasil NFe. As variáveis de ambiente só valem como reserva."""
from __future__ import annotations

import logging
from typing import Any

from .. import queues
from ..adapters.brasilnfe import BRASIL_NFE_PRODUCTION_BASE, BrasilNfeClient
from ..adapters.errors import PermanentError as ProviderPermanent
from ..adapters.errors import TransientError
from ..adapters.focus import PRODUCTION_BASE, FocusClient
from ..adapters.notaas import NOTAAS_PRODUCTION_BASE, NotaasClient
from ..db import call_fn, fetch_one
from ..deps import Deps
from ..runner import PermanentError, RetryLater
from . import dfe

log = logging.getLogger("centralops_worker.fiscal")

Client = FocusClient | BrasilNfeClient | NotaasClient
FISCAL_PROVIDERS = ("NOTAAS", "BRASIL_NFE", "FOCUS_NFE")
DFE_PROVIDERS = ("BRASIL_NFE", "FOCUS_NFE")
NAMES = {"NOTAAS": "Notaas", "BRASIL_NFE": "Brasil NFe", "FOCUS_NFE": "Focus NFe"}
PRODUCTION = ("producao", "production")
CANCEL_CHECK_DELAY_S = 60
CANCEL_CHECK_MAX = 30


async def _connection(deps: Deps, org_id: str, providers: tuple[str, ...]) -> dict[str, Any] | None:
    return await fetch_one(deps.pool, """select id, provider, config from core.integration_connections
                                         where org_id = %s and provider = any(%s) and status <> 'DISABLED' and secret_ref is not null
                                         order by lower(coalesce(config ->> 'primary', '')) in ('1', 'true', 'sim') desc, updated_at desc limit 1""", (org_id, list(providers)))


async def _client_for(deps: Deps, conn: dict[str, Any]) -> tuple[Client | None, str]:
    """Cliente do provedor da conexão. (None, motivo) quando falta credencial ou o ambiente não fecha."""
    provider = conn["provider"]
    name = NAMES.get(provider, provider)
    secret = await deps.secret(str(conn["id"]))
    cfg = conn["config"] or {}
    env = str(cfg.get("environment", "")).lower()
    if provider == "NOTAAS":
        token = secret.get("api_key") or secret.get("token") or ""
        base = str(cfg.get("api_base") or "").strip()
        if not token:
            return None, f"{name} sem credencial"
        if env and env not in PRODUCTION and not base:
            return None, f"{name} em homologação sem o endereço de testes (preencha o campo URL da API na tela de Integrações)"
        return NotaasClient(deps.http, base or deps.settings.notaas_api_base or NOTAAS_PRODUCTION_BASE, token), name
    if provider == "BRASIL_NFE":
        token = secret.get("token") or secret.get("api_key") or ""
        if not token:
            return None, f"{name} sem credencial"
        base = str(cfg.get("api_base") or "").strip() or deps.settings.brasilnfe_api_base or BRASIL_NFE_PRODUCTION_BASE
        user_token = str(secret.get("user_token") or cfg.get("user_token") or "").strip() or None
        return BrasilNfeClient(deps.http, base, token, user_token=user_token, tp_amb=1 if env in PRODUCTION else 2), name
    token = secret.get("token", "")
    if not token:
        return None, f"{name} sem credencial"
    return FocusClient(deps.http, PRODUCTION_BASE if env in PRODUCTION else deps.settings.focus_api_base, token), name


async def _fiscal_client(deps: Deps, org_id: str, providers: tuple[str, ...] = FISCAL_PROVIDERS) -> tuple[Client | None, str]:
    conn = await _connection(deps, org_id, providers)
    if conn:
        return await _client_for(deps, conn)
    s = deps.settings
    if "NOTAAS" in providers and s.notaas_token:
        return NotaasClient(deps.http, s.notaas_api_base or NOTAAS_PRODUCTION_BASE, s.notaas_token), "Notaas"
    if "BRASIL_NFE" in providers and s.brasilnfe_token:
        return BrasilNfeClient(deps.http, s.brasilnfe_api_base or BRASIL_NFE_PRODUCTION_BASE, s.brasilnfe_token), "Brasil NFe"
    if s.focus_token:
        return FocusClient(deps.http, s.focus_api_base, s.focus_token), "Focus NFe"
    return None, "Provedor fiscal (Focus NFe, Brasil NFe ou Notaas) sem credencial"


async def _cancel(deps: Deps, p: dict[str, Any]) -> None:
    doc = await fetch_one(deps.pool, "select id, org_id, model, provider_ref, idempotency_key, status, number from fiscal.documents where id = %s and org_id = %s", (p["document_id"], p["org_id"]))
    if doc is None or doc["status"] != "AUTHORIZED":
        return                                                          # reentrega da fila ou nota que já mudou: nada a cancelar
    client, provider_name = await _fiscal_client(deps, p["org_id"])
    if client is None:
        await deps.notify(p["org_id"], "INTEGRATION_ERROR", f"Cancelamento fiscal parado: {provider_name}", {"document_id": p["document_id"]}, perm="fiscal.write")
        raise RetryLater(600, provider_name)
    ref = doc["provider_ref"] or doc["idempotency_key"]
    result = None
    error: str | None = None
    try:
        result = await client.cancel(doc["model"], ref, p["reason"])
    except TransientError as e:
        raise RetryLater(int(e.retry_after or 30), str(e)) from e
    except ProviderPermanent as e:
        error = str(e)
    if result is not None and result.status == "CANCELLED":
        await call_fn(deps.pool, "fiscal.record_cancellation", doc["id"], {"protocol": result.protocol, "sefaz_code": result.code, "sefaz_msg": result.message})
        return
    if result is not None and result.status == "PROCESSING":                  # provedor assíncrono (Notaas): confere depois, nunca marca cancelada antes da SEFAZ
        await call_fn(deps.pool, "fiscal.record_document_event", doc["id"], {"type": "CANCEL_REQUESTED", "provider_ref": result.provider_ref or ref})
        await queues.send(deps.pool, "fiscal_emission", {"action": "CANCEL_CHECK", "document_id": str(doc["id"]), "org_id": p["org_id"], "attempt": 1}, CANCEL_CHECK_DELAY_S)
        return
    error = error or (result.message or result.code if result is not None else None) or "cancelamento recusado"
    await call_fn(deps.pool, "fiscal.record_document_event", doc["id"], {"type": "CANCEL_FAILED", "message": error})
    await deps.notify(p["org_id"], "FISCAL_CANCEL_FAILED", f"Não foi possível cancelar a nota {doc['number']}: {error}", {"document_id": str(doc["id"])}, perm="fiscal.write")


async def handle(deps: Deps, msg: queues.QueueMessage) -> None:
    p = msg.payload
    if p.get("action") == "CANCEL":
        await _cancel(deps, p)
        return
    if p.get("action") == "CANCEL_CHECK":
        await _cancel_check(deps, p)
        return
    if p.get("action") in ("DFE_SYNC", "DFE_MANIFEST"):
        client, _ = await _fiscal_client(deps, p["org_id"], DFE_PROVIDERS)
        if client is None or isinstance(client, NotaasClient):
            return                                                      # MDe só no Focus NFe e na Brasil NFe; sem credencial a tela de Integrações já mostra o estado
        await (dfe.sync(deps, client, p["org_id"]) if p["action"] == "DFE_SYNC" else dfe.manifest(deps, client, p))
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
    items = (doc.get("document") or {}).get("itens") or []
    missing = [str(i.get("descricao") or i.get("codigo_produto")) for i in items if not i.get("codigo_ncm")]
    if not items or missing:
        why = "pedido sem itens" if not items else f"item sem NCM: {', '.join(missing[:3])} (cadastre o NCM no produto ou o NCM padrão na matriz fiscal)"
        await deps.notify(org_id, "FISCAL_REJECTED", f"NFC-e do pedido {doc.get('order_number')} não emitida: {why}", {"order_id": order_id}, perm="fiscal.write")
        raise PermanentError(why)
    client, provider_name = await _fiscal_client(deps, org_id)
    if client is None:
        await deps.notify(org_id, "INTEGRATION_ERROR", f"Emissão fiscal parada: {provider_name}", {"order_id": order_id}, perm="fiscal.write")
        raise RetryLater(600, provider_name)

    existing = await fetch_one(deps.pool, "select status, provider_ref from fiscal.documents where idempotency_key = %s and org_id = %s", (ref, org_id))
    try:
        ref_to_query = (existing.get("provider_ref") if existing else None) or ref
        result = await (client.get("65", ref_to_query) if existing and existing["status"] == "PROCESSING" else client.emit_nfce(ref, doc["document"]))
    except TransientError as e:
        raise RetryLater(int(e.retry_after or 30), str(e)) from e
    except ProviderPermanent as e:
        await deps.notify(org_id, "FISCAL_REJECTED", f"{provider_name} recusou o pedido: {e}", {"order_id": order_id}, perm="fiscal.write")
        raise PermanentError(str(e)) from e

    await call_fn(deps.pool, "fiscal.record_emission", {
        "ref": ref, "order_id": order_id, "model": "65", "status": result.status, "series": result.series or doc.get("series"), "number": result.number,
        "access_key": result.access_key, "protocol": result.protocol, "sefaz_code": result.code, "sefaz_msg": result.message, "provider_ref": getattr(result, "provider_ref", None) or ref,
        "xml_path": result.xml_path, "danfe_path": result.danfe_path,
    })
    if result.status == "PROCESSING":
        raise RetryLater(15, "NFC-e ainda em processamento na SEFAZ")
    if result.status in ("REJECTED", "DENIED"):
        await deps.notify(org_id, "FISCAL_REJECTED", f"NFC-e do pedido {doc['order_number']} rejeitada: {result.message or result.code}",
                          {"order_id": order_id, "code": result.code, "message": result.message}, perm="fiscal.write")


async def _cancel_check(deps: Deps, p: dict[str, Any]) -> None:
    """Cancelamento assíncrono: consulta o provedor até a SEFAZ responder (ou desiste e avisa)."""
    doc = await fetch_one(deps.pool, "select id, model, provider_ref, idempotency_key, status, number from fiscal.documents where id = %s and org_id = %s", (p["document_id"], p["org_id"]))
    if doc is None or doc["status"] != "AUTHORIZED":
        return
    client, provider_name = await _fiscal_client(deps, p["org_id"])
    if client is None:
        raise RetryLater(600, provider_name)
    try:
        result = await client.get(doc["model"], doc["provider_ref"] or doc["idempotency_key"])
    except TransientError as e:
        raise RetryLater(int(e.retry_after or 60), str(e)) from e
    except ProviderPermanent as e:
        result = None
        log.warning("consulta do cancelamento da nota %s falhou: %s", doc["number"], e)
    if result is not None and result.status == "CANCELLED":
        await call_fn(deps.pool, "fiscal.record_cancellation", doc["id"], {"protocol": result.protocol, "sefaz_code": result.code, "sefaz_msg": result.message})
        return
    attempt = int(p.get("attempt") or 1)
    if attempt < CANCEL_CHECK_MAX and (result is None or result.status in ("AUTHORIZED", "PROCESSING")):
        await queues.send(deps.pool, "fiscal_emission", {**p, "attempt": attempt + 1}, min(CANCEL_CHECK_DELAY_S * attempt, 1800))
        return
    error = (result.message or result.code if result is not None else None) or "a SEFAZ não confirmou o cancelamento"
    await call_fn(deps.pool, "fiscal.record_document_event", doc["id"], {"type": "CANCEL_FAILED", "message": error})
    await deps.notify(p["org_id"], "FISCAL_CANCEL_FAILED", f"Não foi possível cancelar a nota {doc['number']}: {error}", {"document_id": str(doc["id"])}, perm="fiscal.write")
