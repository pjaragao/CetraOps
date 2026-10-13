"""Fila `catalog_sync`: catálogo do site oficial da marca (FULL, 1×/dia), só preços (PRICES, a cada 6 h) e cópia das fotos (MEDIA).
O worker lê o site e entrega ao banco; as regras (produto por modelo, cor, preço vigente, aviso de mudança em peça com estoque) ficam no SQL.
As fotos do site são copiadas para o bucket público do catálogo, para não depender do CDN da marca."""
from __future__ import annotations

import hashlib
import logging
from typing import Any

import httpx

from .. import queues
from ..adapters import shopify_site as site
from ..adapters.errors import PermanentError, TransientError
from ..db import call_fn, fetch_one
from ..deps import Deps
from ..runner import RetryLater

log = logging.getLogger("centralops_worker.catalog_site")


MEDIA_TYPES = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif"}
MAX_PHOTO_WIDTH = 1600                 # o CDN da Shopify redimensiona pelo parâmetro width; a web pede miniaturas ao imgproxy


def _sized(url: str) -> str:
    if "cdn.shopify.com" not in url or "width=" in url:
        return url
    return f"{url}{'&' if '?' in url else '?'}width={MAX_PHOTO_WIDTH}"


async def mirror_media(deps: Deps, org_id: str, limit: int = 400) -> dict[str, int]:
    """Copia para o Storage as fotos que ainda são só link. Falha em uma foto não para as outras (o link continua valendo)."""
    pending = await call_fn(deps.pool, "catalog.media_to_mirror", org_id, limit) or []
    done = failed = 0
    bucket = deps.settings.catalog_media_bucket
    for m in pending:
        try:
            resp = await deps.http.get(_sized(m["url"]), timeout=60, follow_redirects=True)
            mime = resp.headers.get("content-type", "").split(";")[0].strip().lower()
            if resp.status_code >= 400 or mime not in MEDIA_TYPES:
                raise ValueError(f"download {resp.status_code} {mime or 'sem tipo'}")
            data = resp.content
            digest = hashlib.sha256(data).hexdigest()[:20]
            path = f"{org_id}/{m['reference']}/{m['color_code']}/{digest}.{MEDIA_TYPES[mime]}"
            up = await deps.http.post(f"{deps.settings.supabase_url.rstrip('/')}/storage/v1/object/{bucket}/{path}", content=data, timeout=60,
                                      headers={"Authorization": f"Bearer {deps.settings.supabase_service_key}", "Content-Type": mime,
                                               "x-upsert": "true", "Cache-Control": "max-age=31536000"})
            if up.status_code >= 400:
                raise ValueError(f"Storage {up.status_code}: {up.text[:120]}")
            await call_fn(deps.pool, "catalog.set_media_mirror", m["id"], path, digest, len(data), None)
            done += 1
        except (httpx.HTTPError, ValueError) as e:
            await call_fn(deps.pool, "catalog.set_media_mirror", m["id"], None, None, None, str(e))
            failed += 1
            log.warning("foto %s não copiada: %s", m["id"], e)
    return {"photos_copied": done, "photos_failed": failed, "photos_pending": max(0, len(pending) - done - failed)}


async def handle(deps: Deps, msg: queues.QueueMessage) -> None:
    p = msg.payload
    org_id, kind = p["org_id"], p.get("kind", "FULL")
    if kind in ("FULL", "MEDIA"):
        # leitura do site + cópia das fotos leva minutos: a mensagem não pode voltar à fila no meio (outro worker refaria o trabalho)
        await queues.set_visibility(deps.pool, msg.queue, msg.msg_id, 1800)
    if kind == "MEDIA":
        res = await mirror_media(deps, org_id, int(p.get("limit") or 1000))
        log.info("fotos do catálogo: %s", res)
        return
    cfg_row = await fetch_one(deps.pool, "select value from core.settings where org_id = %s and key = 'catalog_site'", (org_id,))
    cfg = (cfg_row or {}).get("value") or {}
    if not cfg.get("enabled"):
        return
    base, source = str(cfg.get("base_url") or "https://siewear.com"), str(cfg.get("source") or "SIEWEAR")
    run_id = await call_fn(deps.pool, "catalog.start_site_sync", org_id, kind)
    stats: dict[str, Any] = {}
    try:
        products = await site.fetch_products(deps.http, base)
        stats["site_products"] = len(products)
        if kind == "PRICES":
            prices = [{"sku": v["sku"], "price": v["price"], "compare_at": v.get("compare_at_price")}
                      for p in products for v in p.get("variants") or [] if v.get("sku") and v.get("price")]
            res = await call_fn(deps.pool, "catalog.apply_site_prices", org_id, prices, source)
            stats.update(res or {})
            await call_fn(deps.pool, "catalog.finish_site_sync", org_id, run_id, "OK", stats, None, None)
            return

        membership, col_ids = await site.fetch_collections(deps.http, base)
        # guias de tamanho (vêm na página de qualquer produto)
        charts: list[dict[str, Any]] = []
        for prod in products[:: max(1, len(products) // 8)][:8]:          # nem toda página traz a tabela: tenta alguns produtos
            charts = await site.fetch_size_charts(deps.http, base, prod["handle"])
            if charts:
                break
        chart_by_col: dict[str, str] = {}
        for c in charts:
            handle = col_ids.get(c["collection_id"]) if c["collection_id"] else None
            await call_fn(deps.pool, "catalog.upsert_site_size_chart", org_id, c["name"], c["html"], [handle] if handle else [])
            if handle:
                chart_by_col[handle] = c["name"]
        names = {c["name"].lower(): c["name"] for c in charts}

        items = site.build_items(products, base, membership)
        changes = new = 0
        for it in items:
            chart = next((chart_by_col[h] for h in it["collections"] if h in chart_by_col), None) \
                or names.get("masculino" if it["gender"] == "MASC" else "feminino")
            res = await call_fn(deps.pool, "catalog.upsert_site_product", {**it, "org_id": org_id, "source": source, "size_chart": chart or ""})
            changes += int((res or {}).get("price_changes") or 0)
            new += 1 if (res or {}).get("new") else 0
        stats.update({"items": len(items), "new_models": new, "price_changes": changes, "size_charts": len(charts),
                      "models": len({i["model_code"] for i in items})})
        if deps.settings.supabase_service_key:
            stats.update(await mirror_media(deps, org_id, 1000))
        await call_fn(deps.pool, "catalog.finish_site_sync", org_id, run_id, "OK", stats, None, [i["external_id"] for i in items])
    except TransientError as e:
        await call_fn(deps.pool, "catalog.finish_site_sync", org_id, run_id, "ERROR", stats, f"temporário: {e}", None)
        if msg.read_ct < 3:
            raise RetryLater(600, str(e)) from e
    except PermanentError as e:
        await call_fn(deps.pool, "catalog.finish_site_sync", org_id, run_id, "ERROR", stats, str(e), None)
