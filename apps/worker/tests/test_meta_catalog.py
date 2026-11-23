"""Catálogo nativo do WhatsApp: cartões de produto, volta ao envio direto, sincronização com a Meta e carrinho (sem banco)."""
from __future__ import annotations

import io
import json
from types import SimpleNamespace
from typing import Any

import httpx
import respx
from PIL import Image

from centralops_worker.adapters.meta import MetaClient
from centralops_worker.handlers import meta_catalog, outbound
from centralops_worker.normalizer.meta import describe_order, normalize_whatsapp

STEFAN = "https://cdn.shopify.com/s/files/1/0788/2502/9852/files/BermudaStephanPreta_63acda62.jpg?v=1766436064"
NICO_C = "https://cdn.shopify.com/s/files/1/0788/2502/9852/files/026-0212-Sie8695_1.webp?v=1772139659"
NICO_P = "https://cdn.shopify.com/s/files/1/0788/2502/9852/files/026-0212-Sie7128.webp?v=1772138245"
BODY = (f"Aqui estão as fotos dos modelos que temos no tamanho M: ✨\n\nBermuda Stefan: {STEFAN}\n\n"
        f"Bermuda Nico (Cinza): {NICO_C} e Nico (Preta): {NICO_P}. Qual delas você prefere?")
SENDS = "https://graph.test/PN/messages"


def _jpeg() -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (40, 30), (200, 10, 10)).save(out, "JPEG")
    return out.getvalue()


def _mock_sends() -> respx.Route:
    route = respx.post(SENDS)
    route.side_effect = lambda req: httpx.Response(200, json={"messages": [{"id": f"wamid.{route.call_count}"}]})
    return route


def _payloads(route: respx.Route) -> list[dict[str, Any]]:
    return [json.loads(c.request.content) for c in route.calls]


@respx.mock
async def test_fotos_do_catalogo_viram_lista_de_produtos_e_o_resto_segue_direto() -> None:
    """Stefan e Nico Cinza estão no catálogo da Meta → um product_list; Nico Preta não está → foto direta, como antes."""
    respx.get(NICO_P).mock(return_value=httpx.Response(200, content=_jpeg(), headers={"content-type": "image/jpeg"}))
    upload = respx.post("https://graph.test/PN/media").mock(return_value=httpx.Response(200, json={"id": "MID"}))
    sends = _mock_sends()
    async with httpx.AsyncClient() as http:
        pid = await outbound._send_whatsapp_native(SimpleNamespace(http=http), MetaClient(http, "https://graph.test", "tok"), "PN", "5511999", BODY,  # type: ignore[arg-type]
                                                   "CAT1", {STEFAN: "17853-004", NICO_C: "17767-121"}, reply_to="wamid.Q")
    p = _payloads(sends)
    assert [x["type"] for x in p] == ["text", "interactive", "image", "text"]
    assert p[0]["context"] == {"message_id": "wamid.Q"} and all("context" not in x for x in p[1:])
    lst = p[1]["interactive"]
    assert lst["type"] == "product_list" and lst["action"]["catalog_id"] == "CAT1"
    assert [i["product_retailer_id"] for i in lst["action"]["sections"][0]["product_items"]] == ["17853-004", "17767-121"]
    assert lst["header"] == {"type": "text", "text": outbound.PRODUCT_LIST_HEADER}
    assert lst["body"]["text"] == "Bermuda Stefan · Bermuda Nico (Cinza)"
    assert p[2]["image"]["caption"] == "Nico (Preta)" and upload.call_count == 1
    assert p[3]["text"]["body"] == "Qual delas você prefere?"
    assert pid == "wamid.3"                                                # id da última mensagem enviada


@respx.mock
async def test_um_produto_so_vira_cartao_de_produto() -> None:
    sends = _mock_sends()
    async with httpx.AsyncClient() as http:
        await outbound._send_whatsapp_native(SimpleNamespace(http=http), MetaClient(http, "https://graph.test", "tok"), "PN", "5511999",  # type: ignore[arg-type]
                                             f"Olha ela:\nBermuda Stefan: {STEFAN}", "CAT1", {STEFAN: "17853-004"})
    p = _payloads(sends)
    assert [x["type"] for x in p] == ["text", "interactive"]
    assert p[1]["interactive"] == {"type": "product", "body": {"text": "Bermuda Stefan"}, "action": {"catalog_id": "CAT1", "product_retailer_id": "17853-004"}}


@respx.mock
async def test_meta_recusa_o_cartao_e_as_fotos_saem_direto() -> None:
    """Catálogo não ligado ao número / item reprovado: a cliente recebe as fotos do mesmo jeito."""
    for url in (STEFAN, NICO_C, NICO_P):
        respx.get(url).mock(return_value=httpx.Response(200, content=_jpeg(), headers={"content-type": "image/jpeg"}))
    respx.post("https://graph.test/PN/media").mock(return_value=httpx.Response(200, json={"id": "MID"}))
    calls: list[dict[str, Any]] = []

    def reply(req: httpx.Request) -> httpx.Response:
        body = json.loads(req.content)
        calls.append(body)
        if body["type"] == "interactive":
            return httpx.Response(400, json={"error": {"code": 131009, "message": "Parameter value is not valid: catalog not linked"}})
        return httpx.Response(200, json={"messages": [{"id": f"wamid.{len(calls)}"}]})

    respx.post(SENDS).mock(side_effect=reply)
    async with httpx.AsyncClient() as http:
        await outbound._send_whatsapp_native(SimpleNamespace(http=http), MetaClient(http, "https://graph.test", "tok"), "PN", "5511999", BODY,  # type: ignore[arg-type]
                                             "CAT1", {STEFAN: "A", NICO_C: "B", NICO_P: "C"})
    assert [x["type"] for x in calls] == ["text", "interactive", "image", "image", "image", "text"]
    assert [x["image"]["caption"] for x in calls if x["type"] == "image"] == ["Bermuda Stefan", "Bermuda Nico (Cinza)", "Nico (Preta)"]


@respx.mock
async def test_sem_produto_do_catalogo_e_o_envio_direto_de_sempre() -> None:
    sends = _mock_sends()
    async with httpx.AsyncClient() as http:
        await outbound._send_whatsapp_native(SimpleNamespace(http=http), MetaClient(http, "https://graph.test", "tok"), "PN", "5511999",  # type: ignore[arg-type]
                                             "Oi! Tudo bem?", "CAT1", {})
    assert [x["type"] for x in _payloads(sends)] == ["text"]


async def test_modo_nativo_so_quando_configurado_e_com_item_sincronizado(monkeypatch: Any) -> None:
    answers: list[dict[str, Any]] = []

    async def fake_call(pool: Any, fn: str, *args: Any) -> Any:
        assert fn == "omni.message_products"
        return answers.pop(0)

    monkeypatch.setattr(outbound, "call_fn", fake_call)
    deps = SimpleNamespace(pool=None)
    assert await outbound._native_catalog(deps, "m1", "sem foto nenhuma") is None            # type: ignore[arg-type]  (nem consulta o banco)
    answers.append({"mode": "DIRECT", "catalog_id": "CAT1", "products": [{"url": STEFAN, "retailer_id": "A"}]})
    assert await outbound._native_catalog(deps, "m1", BODY) is None                          # type: ignore[arg-type]
    answers.append({"mode": "NATIVE_CATALOG", "catalog_id": None, "products": [{"url": STEFAN, "retailer_id": "A"}]})
    assert await outbound._native_catalog(deps, "m1", BODY) is None                          # type: ignore[arg-type]
    answers.append({"mode": "NATIVE_CATALOG", "catalog_id": "CAT1", "products": [{"url": STEFAN}]})
    assert await outbound._native_catalog(deps, "m1", BODY) is None                          # type: ignore[arg-type]
    answers.append({"mode": "NATIVE_CATALOG", "catalog_id": "CAT1", "products": [{"url": STEFAN, "retailer_id": "A"}, {"url": NICO_C}]})
    assert await outbound._native_catalog(deps, "m1", BODY) == ("CAT1", {STEFAN: "A"})      # type: ignore[arg-type]


def test_plano_envia_o_que_mudou_e_apaga_o_que_sumiu() -> None:
    feed = [{"retailer_id": "A", "hash": "1"}, {"retailer_id": "B", "hash": "2"}, {"retailer_id": "C", "hash": "3"}, {"retailer_id": "D", "hash": "4"}]
    existing = [{"retailer_id": "A", "data_hash": "1", "status": "SYNCED"},     # igual: fica
                {"retailer_id": "B", "data_hash": "x", "status": "SYNCED"},     # preço/estoque mudou
                {"retailer_id": "C", "data_hash": "3", "status": "ERROR"},      # falhou da última vez
                {"retailer_id": "Z", "data_hash": "9", "status": "SYNCED"},     # saiu do catálogo interno
                {"retailer_id": "Y", "data_hash": "9", "status": "DELETED"}]    # já apagado
    up, down = meta_catalog.plan(feed, existing)
    assert [i["retailer_id"] for i in up] == ["B", "C", "D"]
    assert [i["retailer_id"] for i in down] == ["Z"]


def test_erros_do_lote_por_retailer_id() -> None:
    resp = {"handles": ["h"], "validation_status": [{"retailer_id": "A", "errors": [{"message": "image_link inválido"}]}, {"retailer_id": "B", "errors": []}]}
    assert meta_catalog.batch_errors(resp, {"status": "finished", "errors": [{"id": "C", "message": "price"}]}) == {"A": "image_link inválido", "C": "price"}


@respx.mock
async def test_sincronizacao_manda_lote_e_registra_situacao(monkeypatch: Any) -> None:
    monkeypatch.setattr(meta_catalog, "STATUS_WAIT_S", 0)
    feed = {"found": True, "channel": "WHATSAPP", "catalog_id": "CAT1", "connection_id": "conn",
            "items": [{"retailer_id": "A", "product_id": "p1", "color_id": "c1", "hash": "h1", "data": {"title": "Bermuda Stefan Preto", "price": "479.00 BRL"}},
                      {"retailer_id": "B", "product_id": "p2", "color_id": "c2", "hash": "h2", "data": {"title": "Nico Cinza", "price": "598.00 BRL"}}]}
    recorded: list[tuple[Any, ...]] = []

    async def fake_call(pool: Any, fn: str, *args: Any) -> Any:
        if fn == "omni.meta_catalog_feed":
            return feed
        recorded.append((fn, *args))
        return None

    async def fake_all(pool: Any, sql: str, params: Any = None) -> list[dict[str, Any]]:
        return [{"retailer_id": "A", "data_hash": "h1", "status": "SYNCED"}, {"retailer_id": "OLD", "data_hash": "h", "status": "SYNCED"}]

    async def secret(_: Any) -> dict[str, str]:
        return {"token": "tok"}

    monkeypatch.setattr(meta_catalog, "call_fn", fake_call)
    monkeypatch.setattr(meta_catalog, "fetch_all", fake_all)
    respx.get("https://graph.test/CAT1").mock(return_value=httpx.Response(200, json={"id": "CAT1", "name": "SIÉ JOY", "product_count": 1}))
    batch = respx.post("https://graph.test/CAT1/items_batch").mock(return_value=httpx.Response(200, json={"handles": ["H1"], "validation_status": []}))
    respx.get("https://graph.test/CAT1/check_batch_request_status").mock(
        return_value=httpx.Response(200, json={"data": [{"status": "finished", "errors": [{"id": "B", "message": "image_link não abriu"}]}]}))
    async with httpx.AsyncClient() as http:
        deps = SimpleNamespace(pool=None, http=http, settings=SimpleNamespace(graph_api_base="https://graph.test"), secret=secret)
        summary = await meta_catalog.sync(deps, "ch1")  # type: ignore[arg-type]
    sent = json.loads(batch.calls[0].request.content)
    assert sent["item_type"] == "PRODUCT_ITEM"
    assert sent["requests"] == [{"method": "UPDATE", "data": {"id": "B", "title": "Nico Cinza", "price": "598.00 BRL"}}, {"method": "DELETE", "data": {"id": "OLD"}}]
    fn, ch, cat, rows, summ = recorded[-1]
    assert (fn, ch, cat) == ("omni.meta_catalog_record", "ch1", "CAT1")
    assert {r["retailer_id"]: r["status"] for r in rows} == {"B": "ERROR", "OLD": "DELETED"}
    assert summ["errors"] == 1 and summ["deleted"] == 1 and summ["catalog_name"] == "SIÉ JOY" and summary["ok"] is True


@respx.mock
async def test_sem_permissao_no_catalogo_fica_registrado(monkeypatch: Any) -> None:
    recorded: list[tuple[Any, ...]] = []

    async def fake_call(pool: Any, fn: str, *args: Any) -> Any:
        if fn == "omni.meta_catalog_feed":
            return {"found": True, "channel": "WHATSAPP", "catalog_id": "CAT1", "connection_id": "conn", "items": []}
        recorded.append((fn, *args))

    async def secret(_: Any) -> dict[str, str]:
        return {"token": "tok"}

    monkeypatch.setattr(meta_catalog, "call_fn", fake_call)
    respx.get("https://graph.test/CAT1").mock(return_value=httpx.Response(400, json={"error": {"code": 200, "message": "Permissions error"}}))
    async with httpx.AsyncClient() as http:
        deps = SimpleNamespace(pool=None, http=http, settings=SimpleNamespace(graph_api_base="https://graph.test"), secret=secret)
        await meta_catalog.sync(deps, "ch1")  # type: ignore[arg-type]
    assert recorded[-1][-1]["ok"] is False and "catalog_management" in recorded[-1][-1]["error"]


def test_carrinho_do_catalogo_chega_legivel() -> None:
    payload = {"entry": [{"changes": [{"field": "messages", "value": {"metadata": {"phone_number_id": "PN"}, "contacts": [{"wa_id": "5511", "profile": {"name": "Ana"}}],
               "messages": [{"from": "5511", "id": "wamid.O", "timestamp": "1700000000", "type": "order",
                             "order": {"catalog_id": "CAT1", "text": "pode separar?", "product_items": [
                                 {"product_retailer_id": "17853-004", "quantity": "2", "item_price": 479, "currency": "BRL"},
                                 {"product_retailer_id": "17767-121", "quantity": 1, "item_price": 598.5, "currency": "BRL"}]}}]}}]}]}
    ev = normalize_whatsapp(payload)[0]
    assert ev["type"] == "INTERACTIVE" and ev["payload"]["order"]["catalog_id"] == "CAT1"
    assert ev["body"] == ("🛒 Carrinho enviado pelo catálogo do WhatsApp:\n• 2× 17853-004 — R$ 479,00\n• 1× 17767-121 — R$ 598,50\n"
                          "Total: R$ 1.556,50\npode separar?")
    assert describe_order({"product_items": [{"product_retailer_id": "A"}]}, {"A": "Bermuda Stefan (Preto)"}) == \
        "🛒 Carrinho enviado pelo catálogo do WhatsApp:\n• 1× Bermuda Stefan (Preto)"
