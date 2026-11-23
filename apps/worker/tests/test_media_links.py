"""Links de foto → fotos de verdade no WhatsApp (sem banco)."""
from __future__ import annotations

import asyncio
import io
import json
from types import SimpleNamespace

import httpx
import respx
from PIL import Image

from centralops_worker import runner
from centralops_worker.adapters import media_links
from centralops_worker.adapters.media_links import Part, split
from centralops_worker.adapters.meta import MetaClient
from centralops_worker.handlers import outbound
from centralops_worker.handlers.media import ext_for

STEFAN = "https://cdn.shopify.com/s/files/1/0788/2502/9852/files/BermudaStephanPreta_63acda62.jpg?v=1766436064"
NICO_C = "https://cdn.shopify.com/s/files/1/0788/2502/9852/files/026-0212-Sie8695_1.webp?v=1772139659"
NICO_P = "https://cdn.shopify.com/s/files/1/0788/2502/9852/files/026-0212-Sie7128.webp?v=1772138245"


def test_texto_sem_foto_fica_igual() -> None:
    body = "Oi! Veja no site https://loja.com.br/produtos e me diga."
    assert split(body) == [Part("text", body)]


def test_resposta_real_da_ia_vira_fotos_com_legenda() -> None:
    body = (f"Aqui estão as fotos dos modelos que temos no tamanho M: ✨\n\nBermuda Stefan: {STEFAN}\n\n"
            f"Bermuda Nico (Cinza): {NICO_C} e Nico (Preta): {NICO_P}. Qual delas você prefere?")
    assert split(body) == [
        Part("text", "Aqui estão as fotos dos modelos que temos no tamanho M: ✨"),
        Part("image", "Bermuda Stefan", STEFAN),
        Part("image", "Bermuda Nico (Cinza)", NICO_C),
        Part("image", "Nico (Preta)", NICO_P),
        Part("text", "Qual delas você prefere?"),
    ]


def test_foto_do_bucket_do_catalogo_e_link_comum() -> None:
    assert media_links.is_image_url("https://x.supabase.co/storage/v1/object/public/catalog-media/org/p/1")
    assert media_links.is_image_url("https://site.com/a/b.PNG")
    assert not media_links.is_image_url("https://loja.com.br/produtos/bermuda")
    assert not media_links.is_image_url("https://cdn.shopify.com/s/files/1/0788/2502/9852/t/3/assets/app.js")


def test_limite_de_fotos() -> None:
    body = "\n".join(f"Peça {i}: https://site.com/{i}.jpg" for i in range(8))
    parts = split(body)
    assert sum(p.kind == "image" for p in parts) == media_links.MAX_IMAGES
    assert parts[-1].kind == "text" and "https://site.com/7.jpg" in parts[-1].text


def _png(mode: str = "RGBA", fmt: str = "WEBP") -> bytes:
    out = io.BytesIO()
    Image.new(mode, (40, 30), (200, 10, 10, 128) if mode == "RGBA" else (200, 10, 10)).save(out, fmt)
    return out.getvalue()


def test_webp_vira_jpeg_e_jpeg_passa_direto() -> None:
    data, mime = media_links.to_whatsapp_image(_png(), "image/webp")
    assert mime == "image/jpeg" and data[:3] == b"\xff\xd8\xff"
    jpg = _png("RGB", "JPEG")
    assert media_links.to_whatsapp_image(jpg, "image/jpeg") == (jpg, "image/jpeg")


def test_extensao_do_audio_do_whatsapp() -> None:
    assert ext_for("audio/ogg; codecs=opus") == ".ogg"
    assert ext_for("image/jpeg") == ".jpg"


@respx.mock
async def test_envio_manda_fotos_e_texto_na_ordem() -> None:
    respx.get(STEFAN).mock(return_value=httpx.Response(200, content=_png("RGB", "JPEG"), headers={"content-type": "image/jpeg"}))
    respx.get(NICO_C).mock(return_value=httpx.Response(200, content=_png(), headers={"content-type": "image/webp"}))
    respx.get(NICO_P).mock(return_value=httpx.Response(404))                    # foto quebrada: vai como link
    upload = respx.post("https://graph.test/PN/media").mock(return_value=httpx.Response(200, json={"id": "MID"}))
    sends = respx.post("https://graph.test/PN/messages").mock(side_effect=lambda req: httpx.Response(200, json={"messages": [{"id": f"wamid.{len(sends.calls)}"}]}))
    body = f"Olha só:\nBermuda Stefan: {STEFAN}\nNico (Cinza): {NICO_C} e Nico (Preta): {NICO_P}. Gostou?"
    async with httpx.AsyncClient() as http:
        deps = SimpleNamespace(http=http)
        pid = await outbound._send_whatsapp_rich(deps, MetaClient(http, "https://graph.test", "tok"), "PN", "5511999", body)  # type: ignore[arg-type]
    assert upload.call_count == 2
    payloads = [json.loads(c.request.content) for c in sends.calls]
    assert [p["type"] for p in payloads] == ["text", "image", "image", "text", "text"]
    assert payloads[0]["text"]["body"] == "Olha só:"
    assert payloads[1]["image"] == {"id": "MID", "caption": "Bermuda Stefan"}
    assert payloads[2]["image"]["caption"] == "Nico (Cinza)"
    assert payloads[3]["text"]["body"] == f"Nico (Preta): {NICO_P}"
    assert payloads[4]["text"]["body"] == "Gostou?"
    assert pid == "wamid.4"
    assert b"image/jpeg" in upload.calls[1].request.content                    # o webp subiu convertido


async def test_job_longo_renova_a_visibilidade() -> None:
    """Sem renovar, a mensagem reaparece na fila no meio do job e roda de novo em paralelo (copiloto lento)."""
    calls: list[int] = []

    async def fake_set_vt(pool: object, queue: str, msg_id: int, vt: int) -> None:
        calls.append(vt)

    async def fake_delete(pool: object, queue: str, msg_id: int) -> None:
        return None

    original = (runner.queues.set_visibility, runner.queues.delete)
    runner.queues.set_visibility, runner.queues.delete = fake_set_vt, fake_delete  # type: ignore[assignment]
    try:
        async def slow(_: object) -> None:
            await asyncio.sleep(2.3)

        settings = SimpleNamespace(visibility_timeout_s=2, max_attempts=5)
        msg = runner.queues.QueueMessage("conversation_router", 1, 1, {})
        assert await runner.process_one(None, msg, slow, settings) == "ok"  # type: ignore[arg-type]
    finally:
        runner.queues.set_visibility, runner.queues.delete = original
    assert calls == [2, 2]


@respx.mock
async def test_reply_vai_so_na_primeira_parte() -> None:
    """Responder citando a mensagem da cliente: a Meta recebe `context.message_id` na primeira bolha (é ela que aparece "respondendo")."""
    respx.get(STEFAN).mock(return_value=httpx.Response(200, content=_png("RGB", "JPEG"), headers={"content-type": "image/jpeg"}))
    respx.post("https://graph.test/PN/media").mock(return_value=httpx.Response(200, json={"id": "MID"}))
    sends = respx.post("https://graph.test/PN/messages").mock(return_value=httpx.Response(200, json={"messages": [{"id": "wamid.x"}]}))
    async with httpx.AsyncClient() as http:
        meta = MetaClient(http, "https://graph.test", "tok")
        deps = SimpleNamespace(http=http)
        await outbound._send_whatsapp_rich(deps, meta, "PN", "5511999", f"Bermuda Stefan: {STEFAN}\nGostou?", "wamid.CLIENTE")  # type: ignore[arg-type]
        await outbound._send_whatsapp_rich(deps, meta, "PN", "5511999", "Tem sim!", "wamid.CLIENTE")  # type: ignore[arg-type]
    payloads = [json.loads(c.request.content) for c in sends.calls]
    assert payloads[0]["type"] == "image" and payloads[0]["context"] == {"message_id": "wamid.CLIENTE"}
    assert "context" not in payloads[1]
    assert payloads[2]["text"]["body"] == "Tem sim!" and payloads[2]["context"] == {"message_id": "wamid.CLIENTE"}


@respx.mock
async def test_reply_no_instagram_e_telegram() -> None:
    from centralops_worker.adapters.telegram import TelegramClient
    ig = respx.post("https://ig.test/IG/messages").mock(return_value=httpx.Response(200, json={"message_id": "mid.1"}))
    tg = respx.post(url__regex=r"https://tg\.test/bot.*/sendMessage").mock(return_value=httpx.Response(200, json={"ok": True, "result": {"message_id": 9}}))
    async with httpx.AsyncClient() as http:
        await MetaClient(http, "https://ig.test", "tok").send_instagram_text("IG", "123", "Oi", reply_to="mid.CLIENTE")
        await TelegramClient(http, "https://tg.test", "tok").send_message("555", "Oi", "555:42")
    assert json.loads(ig.calls[0].request.content)["message"]["reply_to"] == {"mid": "mid.CLIENTE"}
    assert json.loads(tg.calls[0].request.content)["reply_parameters"]["message_id"] == 42
