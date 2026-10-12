"""Fila `catalog_sync`: catálogo do site oficial da marca (FULL, 1×/dia) e só preços (PRICES, a cada 6 h).
O worker lê o site e entrega ao banco; as regras (produto por modelo, cor, preço vigente, aviso de mudança em peça com estoque) ficam no SQL."""
from __future__ import annotations

import logging
from typing import Any

from .. import queues
from ..adapters import shopify_site as site
from ..adapters.errors import PermanentError, TransientError
from ..db import call_fn, fetch_one
from ..deps import Deps
from ..runner import RetryLater

log = logging.getLogger("centralops_worker.catalog_site")


async def handle(deps: Deps, msg: queues.QueueMessage) -> None:
    p = msg.payload
    org_id, kind = p["org_id"], p.get("kind", "FULL")
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
        await call_fn(deps.pool, "catalog.finish_site_sync", org_id, run_id, "OK", stats, None, [i["external_id"] for i in items])
    except TransientError as e:
        await call_fn(deps.pool, "catalog.finish_site_sync", org_id, run_id, "ERROR", stats, f"temporário: {e}", None)
        if msg.read_ct < 3:
            raise RetryLater(600, str(e)) from e
    except PermanentError as e:
        await call_fn(deps.pool, "catalog.finish_site_sync", org_id, run_id, "ERROR", stats, str(e), None)
