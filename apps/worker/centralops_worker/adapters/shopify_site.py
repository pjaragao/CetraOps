"""Leitura do catálogo público de uma loja Shopify (o site oficial da SIÉ: siewear.com) — só endpoints públicos, sem login:
- /products.json?limit=250&page=N   produtos, variantes (SKU, preço, disponibilidade), fotos, descrição, tipo e tags
- /collections.json e /collections/<handle>/products.json   em que coleções cada produto está (são ~140 coleções: o handler
  atualiza algumas por rodada, em revezamento, e guarda o resto — ver handlers/catalog_site.py)
- página de um produto: guias de tamanho do app FoxKit (FoxKitPlugins.SizeChart), ligados a coleções

Regras da marca usadas aqui (conferidas nas 834 variantes do site em 12/10/2026):
- cada produto do site é um MODELO numa COR; o SKU é modelo (5 dígitos) + cor (3 dígitos) + tamanho (ex.: 18320004PP);
- o nome do modelo é o título sem a cor; a cor vem da opção "Color" ou do fim do título.
"""
from __future__ import annotations

import asyncio
import html
import json
import re
from collections import defaultdict
from typing import Any

import httpx

from .errors import PermanentError, TransientError

SKU_RE = re.compile(r"^(\d{5})(\d{3})(.+)$")
UA = {"User-Agent": "CentralOps catalog sync (+https://siewear.com)", "Accept": "application/json"}
MAX_ATTEMPTS = 4         # timeout, rede e 5xx
MAX_429 = 2              # 429: espera o Retry-After uma vez; se continuar, desiste e deixa para a próxima janela (insistir prolonga o bloqueio)
BACKOFF_S = 5.0          # 5, 10, 15… segundos
MIN_INTERVAL_S = 4.0     # intervalo mínimo entre dois pedidos ao site (sem pausa o site passa a responder 429; em 05/11/2026 bloqueou o IP)
LINES = ("Activewear", "everyday", "inspiré")
CATEGORY_FIX = {"Shorts": "Short", "Leggings": "Legging", "Tops": "Top", "Calças": "Calça", "Blusas": "Blusa"}

_last_request = 0.0
_lock = asyncio.Lock()


class RateLimited(TransientError):
    """O site respondeu 429 de novo depois de esperar o Retry-After: parar e tentar bem mais tarde."""


async def _pace() -> None:
    global _last_request
    async with _lock:
        loop = asyncio.get_running_loop()
        wait = _last_request + MIN_INTERVAL_S - loop.time()
        if wait > 0:
            await asyncio.sleep(wait)
        _last_request = loop.time()


def _retry_after(r: httpx.Response) -> int:
    try:
        return max(0, int(float(r.headers.get("Retry-After") or 0)))
    except ValueError:
        return 0


async def _get(http: httpx.AsyncClient, url: str, as_json: bool = True) -> Any:
    limited = 0
    for attempt in range(MAX_ATTEMPTS):
        await _pace()
        try:
            # a página HTML muda conforme o Accept: para ela, pede HTML (com application/json a loja omite os apps, como o guia de tamanho)
            r = await http.get(url, headers={**UA, "Accept": "application/json" if as_json else "text/html"}, timeout=40, follow_redirects=True)
        except (httpx.TimeoutException, httpx.TransportError) as e:
            if attempt == MAX_ATTEMPTS - 1:
                raise TransientError(f"site: {e}") from e
            await asyncio.sleep(BACKOFF_S * (attempt + 1))
            continue
        if r.status_code == 429:                                      # o site limita a frequência
            limited += 1
            wait = _retry_after(r)
            if limited >= MAX_429 or wait > 300:
                raise RateLimited("site 429", status=429, retry_after=wait or None)
            await asyncio.sleep(max(wait, 30))
            continue
        if r.status_code >= 500:
            if attempt == MAX_ATTEMPTS - 1:
                raise TransientError(f"site {r.status_code}", status=r.status_code)
            await asyncio.sleep(BACKOFF_S * (attempt + 1))
            continue
        if r.status_code >= 400:
            raise PermanentError(f"site {r.status_code} em {url}", status=r.status_code)
        return r.json() if as_json else r.text
    raise TransientError("site sem resposta")


async def fetch_products(http: httpx.AsyncClient, base: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for page in range(1, 41):
        data = await _get(http, f"{base.rstrip('/')}/products.json?limit=250&page={page}")
        items = data.get("products") or []
        out += items
        if len(items) < 250:
            break
    return out


async def fetch_collection_list(http: httpx.AsyncClient, base: str) -> list[dict[str, Any]]:
    """Coleções do site (um pedido para até 250): [{id, handle, updated_at}]."""
    cols: list[dict[str, Any]] = []
    for page in range(1, 11):
        data = await _get(http, f"{base.rstrip('/')}/collections.json?limit=250&page={page}")
        items = data.get("collections") or []
        cols += [{"id": int(c["id"]), "handle": c["handle"], "updated_at": c.get("updated_at") or ""} for c in items]
        if len(items) < 250:
            break
    return cols


async def fetch_membership(http: httpx.AsyncClient, base: str, handles: list[str]) -> dict[int, list[str]]:
    """{id do produto: [coleções]} só das coleções pedidas (um pedido por coleção de até 250 produtos)."""
    membership: dict[int, list[str]] = defaultdict(list)
    for h in handles:
        for page in range(1, 11):
            data = await _get(http, f"{base.rstrip('/')}/collections/{h}/products.json?limit=250&page={page}")
            items = data.get("products") or []
            for p in items:
                membership[int(p["id"])].append(h)
            if len(items) < 250:
                break
    return dict(membership)


def parse_size_charts(page_html: str) -> list[dict[str, Any]]:
    """Guias do app FoxKit embutidos na página: [{name, html, collection_id}]."""
    m = re.search(r"FoxKitPlugins\.SizeChart\s*=\s*Object\.values\(", page_html)
    if not m:
        return []
    try:                                                              # o JSON tem HTML dentro: lê o objeto inteiro, sem regex
        data, _ = json.JSONDecoder().raw_decode(page_html, m.end())
    except ValueError:
        return []
    if not isinstance(data, dict):
        return []
    out = []
    for c in data.values():
        if not c.get("active", True) or c.get("deleted"):
            continue
        gid = str(c.get("target_collection") or "")
        out.append({"name": str(c.get("title") or "Guia"), "html": c.get("chart_content") or "",
                    "collection_id": int(gid.rsplit("/", 1)[-1]) if gid.rsplit("/", 1)[-1].isdigit() else None})
    return out


async def fetch_size_charts(http: httpx.AsyncClient, base: str, handle: str) -> list[dict[str, Any]]:
    return parse_size_charts(await _get(http, f"{base.rstrip('/')}/products/{handle}", as_json=False))


def _text(fragment: str) -> str:
    t = re.sub(r"<br\s*/?>", "\n", fragment, flags=re.I)
    t = re.sub(r"</p>|</li>", "\n", t, flags=re.I)
    t = html.unescape(re.sub(r"<[^>]+>", "", t))
    return re.sub(r"[ \t ]+", " ", re.sub(r"\n\s*\n+", "\n", t)).strip()


def split_body(body_html: str) -> dict[str, str]:
    """Descrição do site → descrição, composição, cuidados e modelagem (seções marcadas em negrito, como "Composição:")."""
    body = body_html or ""
    marks = list(re.finditer(r"<strong>\s*([^<:]{2,40}?)\s*:?\s*</strong>\s*:?", body, re.I))
    sections: dict[str, str] = {}
    first = marks[0].start() if marks else len(body)
    sections["description"] = _text(body[:first])
    for i, m in enumerate(marks):
        end = marks[i + 1].start() if i + 1 < len(marks) else len(body)
        key = m.group(1).strip().lower()
        val = _text(body[m.end():end]).lstrip(": ").strip()
        if key.startswith("composi"):
            sections["composition"] = val
        elif key.startswith("cuidado") or key.startswith("lavagem"):
            sections["care"] = val
        elif key in ("fit", "modelagem", "caimento"):
            sections["fit"] = val
        elif val:
            sections["description"] = (sections["description"] + f"\n{m.group(1).strip()}: {val}").strip()
    return {k: v for k, v in sections.items() if v}


def _common_words(titles: list[str]) -> str:
    words = [t.split() for t in titles if t]
    if not words:
        return ""
    common: list[str] = []
    for i in range(min(len(w) for w in words)):
        col = {w[i].lower() for w in words}
        if len(col) != 1:
            break
        common.append(words[0][i])
    return " ".join(common)


def build_items(products: list[dict[str, Any]], base: str, membership: dict[int, list[str]] | None = None) -> list[dict[str, Any]]:
    """Produtos do site → itens prontos para catalog.upsert_site_product (um por produto do site = modelo + cor)."""
    membership = membership or {}
    by_model: dict[str, list[str]] = defaultdict(list)
    for p in products:
        for v in p.get("variants") or []:
            m = SKU_RE.match(v.get("sku") or "")
            if m:
                by_model[m.group(1)].append(p["title"])
                break
    model_name: dict[str, str] = {}
    for code, titles in by_model.items():
        uniq = sorted(set(titles))
        name = _common_words(uniq) if len(uniq) > 1 else " ".join(uniq[0].split()[:-1]) or uniq[0]
        model_name[code] = name or uniq[0]

    items = []
    for p in products:
        opts = [o.get("name") for o in p.get("options") or []]
        has_color = bool(opts) and opts[0] in ("Color", "Cor", "Cores")
        variants = []
        model = color = None
        for v in p.get("variants") or []:
            m = SKU_RE.match((v.get("sku") or "").strip())
            if not m:
                continue
            model, color = model or m.group(1), color or m.group(2)
            variants.append({"external_id": str(v["id"]), "sku": v["sku"].strip().upper(), "size": m.group(3).upper(),
                             "price": v.get("price"), "compare_at": v.get("compare_at_price"), "available": bool(v.get("available"))})
        if not model or not variants:
            continue
        name = model_name.get(model) or p["title"]
        color_name = ((p["variants"][0].get("option1") or "") if has_color else "") or p["title"][len(name):].strip() or p["title"].split()[-1]
        tags = [t.strip() for t in p.get("tags") or [] if t.strip()]
        cols = membership.get(int(p["id"]), [])
        gender = "MASC" if any(t.lower() == "men" for t in tags) or any("masculino" in c for c in cols) else "FEM"
        ptype = (p.get("product_type") or "").strip() or name.split()[0]
        sections = split_body(p.get("body_html") or "")
        prices = [float(v["price"]) for v in variants if v.get("price")]
        items.append({
            "external_id": str(p["id"]), "handle": p["handle"], "url": f"{base.rstrip('/')}/products/{p['handle']}", "title": p["title"],
            "model_code": model, "model_name": name, "color_code": color, "color_name": color_name.strip().title() if color_name.isupper() else color_name.strip(),
            "product_type": p.get("product_type") or "", "category": CATEGORY_FIX.get(ptype, ptype), "tags": tags, "collections": cols,
            "line": next((t for t in tags if t in LINES), ""), "gender": gender,
            "description": sections.get("description", ""), "composition": sections.get("composition", ""), "care": sections.get("care", ""), "fit": sections.get("fit", ""),
            "images": [i["src"] for i in sorted(p.get("images") or [], key=lambda i: i.get("position") or 0)],
            "available": any(v["available"] for v in variants), "price": min(prices) if prices else None,
            "compare_at": next((v["compare_at"] for v in variants if v.get("compare_at")), None),
            "site_updated_at": p.get("updated_at"), "variants": variants,
        })
    return items
