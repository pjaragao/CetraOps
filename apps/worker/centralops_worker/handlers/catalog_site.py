"""Fila `catalog_sync`: catálogo do site oficial da marca (FULL, 1×/dia), só preços (PRICES, a cada 6 h) e cópia das fotos (MEDIA).
O worker lê o site e entrega ao banco; as regras (produto por modelo, cor, preço vigente, aviso de mudança em peça com estoque) ficam no SQL.
As fotos do site são copiadas para o bucket público do catálogo, para não depender do CDN da marca."""
from __future__ import annotations

import hashlib
import json
import logging
from datetime import UTC, datetime
from typing import Any

import httpx

from .. import queues
from ..adapters import shopify_site as site
from ..adapters.errors import PermanentError, TransientError
from ..db import call_fn, fetch_all, fetch_one
from ..deps import Deps
from ..runner import RetryLater

log = logging.getLogger("centralops_worker.catalog_site")


MEDIA_TYPES = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif"}
COLLECTIONS_PER_RUN = 16               # coleções relidas por rodada completa (4 por dia → as ~140 do site em ~2 dias)
CHARTS_EVERY_S = 20 * 3600             # guias de tamanho mudam pouco: relê no máximo 1× por dia
CHART_PAGES = 3                        # páginas de produto tentadas para achar o guia
COOLDOWN_S = 3600                      # depois de um 429 que não passou, o site fica 1 h sem ser chamado
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


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _older_than(iso: str | None, seconds: int) -> bool:
    try:
        return not iso or (datetime.now(UTC) - datetime.fromisoformat(iso)).total_seconds() > seconds
    except ValueError:
        return True


async def _load_state(deps: Deps, org_id: str) -> dict[str, Any]:
    row = await fetch_one(deps.pool, "select value from core.settings where org_id = %s and key = 'catalog_site_state'", (org_id,))
    return dict((row or {}).get("value") or {})


async def _save_state(deps: Deps, org_id: str, state: dict[str, Any]) -> None:
    await fetch_one(deps.pool, """insert into core.settings (org_id, key, value) values (%s, 'catalog_site_state', %s)
                                  on conflict (org_id, key) do update set value = excluded.value returning key""", (org_id, json.dumps(state)))


async def _membership(deps: Deps, org_id: str, base: str, source: str, products: list[dict[str, Any]],
                      state: dict[str, Any]) -> tuple[dict[int, list[str]], dict[int, str], list[str]]:
    """Coleções de cada produto sem reler as ~140 coleções a cada rodada: relê só as COLLECTIONS_PER_RUN da vez (nunca lidas,
    alteradas no site depois da última leitura, depois as lidas há mais tempo) e completa com o que já está gravado em site_items."""
    cols = await site.fetch_collection_list(deps.http, base)
    seen: dict[str, str] = dict(state.get("collections") or {})
    def priority(c: dict[str, Any]) -> tuple[int, str]:
        last = seen.get(c["handle"])
        if not last:
            return (0, "")
        return (1 if (c["updated_at"] or "") > last else 2, last)
    due = [c["handle"] for c in sorted(cols, key=priority)[:COLLECTIONS_PER_RUN]]
    fresh = await site.fetch_membership(deps.http, base, due)
    rows = await fetch_all(deps.pool, "select external_id, collections from catalog.site_items where org_id = %s and source = %s and removed_at is null",
                           (org_id, source))
    cached = {r["external_id"]: r["collections"] or [] for r in rows}
    exists, due_set = {c["handle"] for c in cols}, set(due)
    membership: dict[int, list[str]] = {}
    for p in products:
        pid = int(p["id"])
        keep = [h for h in cached.get(str(pid), []) if h in exists and h not in due_set]
        membership[pid] = keep + fresh.get(pid, [])
    now = _now()
    state["collections"] = {h: (now if h in due_set else seen.get(h, "")) for h in exists if h in due_set or seen.get(h)}
    return membership, {c["id"]: c["handle"] for c in cols}, due


async def handle(deps: Deps, msg: queues.QueueMessage) -> None:
    p = msg.payload
    org_id, kind = p["org_id"], p.get("kind", "FULL")
    # leitura do site leva minutos (e mais ainda esperando o site liberar): a mensagem não pode voltar à fila no meio, senão outra
    # cópia começa a cada minuto e o site nunca sai do 429 (foi o que aconteceu com PRICES em 05/11/2026)
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
    # o site bloqueou há pouco: não bate de novo (cada pedido durante o bloqueio o prolonga); a próxima janela agendada tenta
    blocked = await fetch_one(deps.pool, "select finished_at from catalog.site_sync_runs where org_id = %s and status = 'ERROR' and error like '%%429%%'"
                              " and finished_at > now() - make_interval(secs => %s) order by finished_at desc limit 1", (org_id, COOLDOWN_S))
    if blocked:
        log.info("site em 429 desde %s: %s pulado até o fim da pausa", blocked["finished_at"], kind)
        return
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

        state = await _load_state(deps, org_id)
        membership, col_ids, refreshed = await _membership(deps, org_id, base, source, products, state)
        stats["collections_refreshed"] = len(refreshed)
        # guias de tamanho: no máximo 1× por dia; nas outras rodadas usa o que foi lido da última vez
        if _older_than(state.get("charts_at"), CHARTS_EVERY_S):
            charts: list[dict[str, Any]] = []
            for prod in products[:: max(1, len(products) // CHART_PAGES)][:CHART_PAGES]:   # nem toda página traz a tabela
                charts = await site.fetch_size_charts(deps.http, base, prod["handle"])
                if charts:
                    break
            for c in charts:
                handle = col_ids.get(c["collection_id"]) if c["collection_id"] else None
                await call_fn(deps.pool, "catalog.upsert_site_size_chart", org_id, c["name"], c["html"], [handle] if handle else [])
                c["collection"] = handle
            if charts:
                state["charts"] = [{"name": c["name"], "collection": c["collection"]} for c in charts]
                state["charts_at"] = _now()
        chart_list = state.get("charts") or []
        chart_by_col = {c["collection"]: c["name"] for c in chart_list if c.get("collection")}
        names = {c["name"].lower(): c["name"] for c in chart_list}
        stats["size_charts"] = len(chart_list)

        items = site.build_items(products, base, membership)
        changes = new = 0
        for it in items:
            chart = next((chart_by_col[h] for h in it["collections"] if h in chart_by_col), None) \
                or names.get("masculino" if it["gender"] == "MASC" else "feminino")
            res = await call_fn(deps.pool, "catalog.upsert_site_product", {**it, "org_id": org_id, "source": source, "size_chart": chart or ""})
            changes += int((res or {}).get("price_changes") or 0)
            new += 1 if (res or {}).get("new") else 0
        stats.update({"items": len(items), "new_models": new, "price_changes": changes, "models": len({i["model_code"] for i in items})})
        if deps.settings.supabase_service_key:
            stats.update(await mirror_media(deps, org_id, 1000))
        await call_fn(deps.pool, "catalog.finish_site_sync", org_id, run_id, "OK", stats, None, [i["external_id"] for i in items])
        await _save_state(deps, org_id, state)
    except site.RateLimited as e:
        # bloqueio do site: uma nova tentativa só depois da pausa (a mensagem some; FULL e PRICES voltam pelo agendamento)
        await call_fn(deps.pool, "catalog.finish_site_sync", org_id, run_id, "ERROR", stats, f"temporário: {e} (pausa de {COOLDOWN_S // 60} min)", None)
        if msg.read_ct < 2:
            raise RetryLater(COOLDOWN_S + 60, str(e)) from e
    except TransientError as e:
        await call_fn(deps.pool, "catalog.finish_site_sync", org_id, run_id, "ERROR", stats, f"temporário: {e}", None)
        if msg.read_ct < 3:
            raise RetryLater(600, str(e)) from e
    except PermanentError as e:
        await call_fn(deps.pool, "catalog.finish_site_sync", org_id, run_id, "ERROR", stats, str(e), None)
