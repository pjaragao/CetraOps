"""Catálogo interno → catálogo da Meta da franquia (Commerce Manager, ligado à WABA), para os cartões nativos de produto no WhatsApp.

O site da marca é só fonte de dados; quem alimenta o catálogo da Meta é o CetraOps, pela Graph API (`/{catalog_id}/items_batch`).
Um item por produto × cor, com retailer_id estável. Só vai à Meta o que mudou (hash de cada item) e o que saiu do catálogo interno
é apagado lá. A situação de cada item fica em `omni.meta_catalog_items`: o envio só usa cartão de item SYNCED (o resto vai como foto)."""
from __future__ import annotations

import asyncio
import logging
import re
from typing import Any

from ..adapters.errors import PermanentError, TransientError
from ..adapters.meta import MetaClient
from ..db import call_fn, fetch_all, fetch_one
from ..deps import Deps
from ..runner import RetryLater

log = logging.getLogger("centralops_worker.meta_catalog")

BATCH_SIZE = 500                      # a Meta aceita até 5.000 por chamada; lotes menores isolam falhas
STATUS_POLLS = 5                      # leituras do resultado assíncrono de cada lote
STATUS_WAIT_S = 3.0
PERMISSION_CODES = {10, 100, 200, 190}


def plan(feed: list[dict[str, Any]], existing: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """(itens a enviar, itens a apagar). Envia o que é novo, mudou ou não está SYNCED; apaga o que sumiu do catálogo interno."""
    known = {r["retailer_id"]: r for r in existing}
    upserts = [i for i in feed if (k := known.get(i["retailer_id"])) is None or k.get("status") != "SYNCED" or k.get("data_hash") != i["hash"]]
    wanted = {i["retailer_id"] for i in feed}
    deletes = [r for r in existing if r["retailer_id"] not in wanted and r.get("status") != "DELETED"]
    return upserts, deletes


def batch_errors(resp: dict[str, Any], status: dict[str, Any] | None = None) -> dict[str, str]:
    """retailer_id → erro, juntando a validação imediata (resposta do POST) e o resultado assíncrono do lote."""
    out: dict[str, str] = {}
    for v in resp.get("validation_status") or []:
        errs = v.get("errors") or []
        if errs and v.get("retailer_id"):
            out[str(v["retailer_id"])] = "; ".join(str(e.get("message") or e) for e in errs)[:500]
    for e in (status or {}).get("errors") or []:
        rid = e.get("id") or e.get("retailer_id")
        if rid:
            out[str(rid)] = str(e.get("message") or e)[:500]
    return out


async def _wait_batch(meta: MetaClient, catalog_id: str, handle: str) -> dict[str, Any]:
    status: dict[str, Any] = {}
    for _ in range(STATUS_POLLS):
        await asyncio.sleep(STATUS_WAIT_S)
        try:
            status = await meta.catalog_batch_status(catalog_id, handle)
        except TransientError as e:
            log.info("situação do lote %s indisponível agora: %s", handle, e)
            continue
        if str(status.get("status", "")).lower() not in ("", "in_progress", "dispatched", "started"):
            break
    return status


async def sync(deps: Deps, channel_account_id: str) -> dict[str, Any]:
    feed = await call_fn(deps.pool, "omni.meta_catalog_feed", channel_account_id)
    if not feed or not feed.get("found") or feed.get("channel") != "WHATSAPP" or not feed.get("catalog_id"):
        return {"skipped": "canal sem catálogo da Meta"}
    catalog_id = str(feed["catalog_id"])
    secret = await deps.secret(feed.get("connection_id"))
    token = secret.get("token") or secret.get("access_token")
    if not token:
        await call_fn(deps.pool, "omni.meta_catalog_record", channel_account_id, catalog_id, [], {"ok": False, "error": "canal sem credencial configurada"})
        return {"error": "sem credencial"}
    meta = MetaClient(deps.http, deps.settings.graph_api_base, token)
    if not feed.get("public_address") and feed.get("phone_number_id"):
        # o link de cada item abre o WhatsApp da própria loja (nunca o site da marca): precisa do número do canal
        try:
            phone = re.sub(r"\D", "", str((await meta.whatsapp_phone_info(str(feed["phone_number_id"]))).get("display_phone_number") or ""))
        except (PermanentError, TransientError) as e:
            phone = ""
            log.warning("número do canal indisponível: %s", e)
        if phone:
            await fetch_one(deps.pool, "update omni.channel_accounts set public_address = %s where id = %s and coalesce(public_address, '') = '' returning id",
                            (phone, channel_account_id))
            feed = await call_fn(deps.pool, "omni.meta_catalog_feed", channel_account_id)

    try:
        info = await meta.catalog_info(catalog_id)
    except PermanentError as e:
        hint = " (confira se o token tem a permissão catalog_management e acesso a este catálogo)" if e.code in PERMISSION_CODES else ""
        await call_fn(deps.pool, "omni.meta_catalog_record", channel_account_id, catalog_id, [], {"ok": False, "error": f"catálogo inacessível: {e}{hint}"})
        return {"error": str(e)}

    items: list[dict[str, Any]] = feed.get("items") or []
    existing = await fetch_all(deps.pool, "select retailer_id, data_hash, status from omni.meta_catalog_items where channel_account_id = %s and catalog_id = %s",
                               (channel_account_id, catalog_id))
    upserts, deletes = plan(items, existing)
    results: list[dict[str, Any]] = []
    first_error: str | None = None

    requests = [("UPDATE", i) for i in upserts] + [("DELETE", d) for d in deletes]
    for n in range(0, len(requests), BATCH_SIZE):
        chunk = requests[n:n + BATCH_SIZE]
        body = [{"method": "DELETE", "data": {"id": it["retailer_id"]}} if method == "DELETE" else {"method": "UPDATE", "data": {"id": it["retailer_id"], **it["data"]}}
                for method, it in chunk]
        try:
            resp = await meta.catalog_items_batch(catalog_id, body)
        except PermanentError as e:                                      # lote recusado inteiro: os itens ficam com o erro e a próxima rodada tenta de novo
            first_error = first_error or str(e)
            results += [{**_row(it), "status": "ERROR", "error": str(e)[:500]} for _, it in chunk]
            continue
        status: dict[str, Any] = {}
        for handle in resp.get("handles") or []:
            status = await _wait_batch(meta, catalog_id, str(handle))
        errors = batch_errors(resp, status)
        for method, it in chunk:
            err = errors.get(it["retailer_id"])
            ok = "DELETED" if method == "DELETE" else "SYNCED"
            results.append({**_row(it), "status": "ERROR" if err else ok, "error": err})

    summary = {"ok": first_error is None, "catalog_name": info.get("name"), "product_count": info.get("product_count"), "items": len(items),
               "sent": len(upserts), "deleted": sum(1 for r in results if r["status"] == "DELETED"),
               "errors": sum(1 for r in results if r["status"] == "ERROR"), "error": first_error}
    await call_fn(deps.pool, "omni.meta_catalog_record", channel_account_id, catalog_id, results, summary)
    log.info("catálogo da Meta %s: %s", catalog_id, summary)
    return summary


def _row(it: dict[str, Any]) -> dict[str, Any]:
    return {"retailer_id": it["retailer_id"], "product_id": it.get("product_id"), "color_id": it.get("color_id"), "hash": it.get("hash") or it.get("data_hash")}


async def handle(deps: Deps, payload: dict[str, Any], read_ct: int) -> None:
    channels = [payload["channel_account_id"]] if payload.get("channel_account_id") else [
        r["id"] for r in await fetch_all(deps.pool, "select id from omni.channel_accounts where org_id = %s and channel = 'WHATSAPP' and status = 'ACTIVE' and meta_catalog_id is not null",
                                         (payload["org_id"],))]
    for ch in channels:
        try:
            await sync(deps, str(ch))
        except TransientError as e:
            if read_ct < 3:
                raise RetryLater(int(e.retry_after or 600), str(e)) from e
            await call_fn(deps.pool, "omni.meta_catalog_record", str(ch), None, [], {"ok": False, "error": f"temporário: {e}"})
