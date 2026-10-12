"""Catálogo do site da marca: interpretação (SKU modelo+cor+tamanho, textos, guia) e gravação no banco (produto por modelo, preço, aviso)."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx
import respx

from centralops_worker import queues
from centralops_worker.adapters import shopify_site as site
from centralops_worker.db import fetch_one
from centralops_worker.handlers import catalog_site

ORG = "00000000-0000-4000-8000-000000000001"
BASE = "https://loja.test"
FIX = Path(__file__).parent / "fixtures"
PRODUCTS = json.loads((FIX / "siewear_products.json").read_text())["products"]
CHART_HTML = (FIX / "siewear_sizechart.html").read_text()


def test_build_items_groups_by_model_and_reads_texts() -> None:
    items = site.build_items(PRODUCTS, BASE, {PRODUCTS[3]["id"]: ["camiseta-masculino"]})
    liora = [i for i in items if i["model_code"] == "18320"]
    assert len(liora) == 2 and {i["model_name"] for i in liora} == {"Casaqueto Liora"}
    assert {i["color_code"] for i in liora} == {"020", "004"}
    pink = next(i for i in liora if i["color_code"] == "020")
    assert pink["color_name"] == "Rosa"                                         # vem da opção "Color"
    assert pink["composition"] == "96% Viscose / 4% Elastano"
    assert "Composição" not in pink["description"] and pink["description"].startswith("Nosso best seller")
    assert [v["size"] for v in pink["variants"]] == ["PP", "P", "M", "G"] and pink["variants"][0]["sku"] == "18320020PP"
    assert pink["images"] and pink["url"] == f"{BASE}/products/{PRODUCTS[0]['handle']}"
    men = next(i for i in items if i["external_id"] == str(PRODUCTS[3]["id"]))
    assert men["gender"] == "MASC"


def test_split_body_sections() -> None:
    s = site.split_body("<p>Texto bonito.<br><strong>Composição:</strong> 90% Poliamida / 10% Elastano<br><strong>Cuidados:</strong> Lavar à mão</p>")
    assert s == {"description": "Texto bonito.", "composition": "90% Poliamida / 10% Elastano", "care": "Lavar à mão"}


def test_parse_size_charts_reads_the_embedded_json() -> None:
    charts = site.parse_size_charts(CHART_HTML)
    assert [c["name"] for c in charts] == ["Feminino", "Masculino"] and all(c["collection_id"] for c in charts)
    assert "TABELA DE MEDIDAS" in charts[0]["html"]


def _mock_site(products: list[dict[str, Any]]) -> None:
    respx.get(url__regex=rf"{BASE}/products\.json.*").mock(return_value=httpx.Response(200, json={"products": products}))
    respx.get(url__regex=rf"{BASE}/collections\.json.*").mock(return_value=httpx.Response(200, json={"collections": [
        {"id": 460125077724, "handle": "feminino", "title": "Feminino"}, {"id": 460125012188, "handle": "masculino", "title": "Masculino"}]}))
    respx.get(url__regex=rf"{BASE}/collections/feminino/products\.json.*").mock(return_value=httpx.Response(200, json={"products": [{"id": p["id"]} for p in products[:3]]}))
    respx.get(url__regex=rf"{BASE}/collections/masculino/products\.json.*").mock(return_value=httpx.Response(200, json={"products": [{"id": products[3]["id"]}]}))
    respx.get(url__regex=rf"{BASE}/products/[^.]+$").mock(return_value=httpx.Response(200, text=CHART_HTML))


@respx.mock
async def test_full_sync_then_price_change_alerts_only_stocked_items(pool: Any, deps: Any) -> None:
    await fetch_one(pool, """insert into core.settings (org_id, key, value) values (%s, 'catalog_site', %s)
                             on conflict (org_id, key) do update set value = excluded.value returning key""",
                    (ORG, json.dumps({"enabled": True, "base_url": BASE, "source": "TESTSITE"})))
    _mock_site(PRODUCTS)
    await catalog_site.handle(deps, queues.QueueMessage("catalog_sync", 1, 1, {"org_id": ORG, "kind": "FULL"}))
    run = await fetch_one(pool, "select status, stats from catalog.site_sync_runs order by id desc limit 1")
    assert run["status"] == "OK" and run["stats"]["items"] == 4 and run["stats"]["size_charts"] == 2 and run["stats"]["price_changes"] == 0
    prod = await fetch_one(pool, """select p.id, p.name, p.composition, s.name as chart, (select count(distinct color_id) from catalog.variants v where v.product_id = p.id) as colors,
                                           (select count(*) from catalog.product_media m where m.product_id = p.id) as photos
                                    from catalog.products p left join catalog.size_charts s on s.id = p.size_chart_id where p.reference_code = '18320'""")
    assert prod["name"] == "Casaqueto Liora" and prod["colors"] == 2 and prod["photos"] >= 2 and prod["chart"] == "Site: Feminino"
    assert prod["composition"] == "96% Viscose / 4% Elastano"
    sku = PRODUCTS[0]["variants"][0]["sku"]
    v = await fetch_one(pool, "select id from catalog.variants where sku = %s", (sku,))
    assert float(await _price(pool, v["id"])) == float(PRODUCTS[0]["variants"][0]["price"])

    # peça em estoque; o site sobe o preço → a rotina de preço muda e avisa
    await fetch_one(pool, """insert into inv.movements (org_id, variant_id, location_id, qty, movement_type)
                             values (%s, %s, (select id from inv.locations where kind = 'SALES_FLOOR' and org_id = %s order by created_at limit 1), 3, 'INITIAL_BALANCE') returning id""",
                    (ORG, v["id"], ORG))
    changed = json.loads(json.dumps(PRODUCTS))
    for var in changed[0]["variants"]:
        var["price"] = "418.00"
    respx.get(url__regex=rf"{BASE}/products\.json.*").mock(return_value=httpx.Response(200, json={"products": changed}))
    await catalog_site.handle(deps, queues.QueueMessage("catalog_sync", 2, 1, {"org_id": ORG, "kind": "PRICES"}))
    assert float(await _price(pool, v["id"])) == 418.0
    ch = await fetch_one(pool, "select count(*) as n, max(in_stock) as stock, bool_and(notified) as notified from catalog.price_changes where variant_id = %s", (v["id"],))
    assert ch["n"] == 1 and float(ch["stock"]) == 3 and ch["notified"]
    other = await fetch_one(pool, "select count(*) as n from catalog.price_changes pc join catalog.variants vv on vv.id = pc.variant_id where vv.sku = %s",
                            (PRODUCTS[0]["variants"][1]["sku"],))
    assert other["n"] == 1                                                              # sem estoque: registra, mas o aviso é só das que têm estoque
    note = await fetch_one(pool, "select title from core.notifications where kind = 'PRICE_CHANGED' order by created_at desc limit 1")
    assert note and "Casaqueto Liora" in note["title"] and "418" in note["title"]


async def _price(pool: Any, variant_id: Any) -> Any:
    return (await fetch_one(pool, "select catalog.current_price(%s) as p", (variant_id,)))["p"]


@respx.mock
async def test_disabled_routine_does_nothing(pool: Any, deps: Any) -> None:
    await fetch_one(pool, """insert into core.settings (org_id, key, value) values (%s, 'catalog_site', '{"enabled": false}')
                             on conflict (org_id, key) do update set value = excluded.value returning key""", (ORG,))
    calls = respx.route(url__regex=r".*").mock(return_value=httpx.Response(200, json={}))
    await catalog_site.handle(deps, queues.QueueMessage("catalog_sync", 1, 1, {"org_id": ORG, "kind": "FULL"}))
    assert not calls.called
