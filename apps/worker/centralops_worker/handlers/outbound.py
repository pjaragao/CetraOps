"""Fila `outbound_messages`: envia pelo canal certo. A janela de 24 h/7 dias já foi decidida no banco; aqui só há HTTP e classificação de erro."""
from __future__ import annotations

import logging

import httpx
import psycopg

from .. import queues
from ..adapters import media_links
from ..adapters.errors import PermanentError as SendPermanent
from ..adapters.errors import TransientError
from ..adapters.meta import MetaClient
from ..adapters.telegram import TelegramClient
from ..db import call_fn, fetch_one
from ..deps import Deps
from ..runner import PermanentError, RetryLater

log = logging.getLogger("centralops_worker.outbound")

NATIVE_MAX_ITEMS = 30                       # limite da Meta para product_list
PRODUCT_LIST_HEADER = "Separei pra você"
PRODUCT_LIST_BODY = "Toque em cada peça para ver foto, preço e detalhes."


async def _fail(deps: Deps, message_id: str, reason: str) -> None:
    await call_fn(deps.pool, "omni.mark_outbound", message_id, "FAILED", None, reason)


async def _fetch_image(deps: Deps, url: str) -> tuple[bytes, str] | None:
    """Baixa a foto do link (catálogo/Shopify). Falhou → None, e o link segue no texto como antes."""
    try:
        resp = await deps.http.get(url, timeout=20, follow_redirects=True)
    except (httpx.TimeoutException, httpx.TransportError) as e:
        log.warning("não consegui baixar a foto %s: %s", url, e)
        return None
    mime = resp.headers.get("content-type", "")
    if resp.status_code >= 400 or not mime.startswith("image/"):
        log.warning("link de foto inválido %s (%s, %s)", url, resp.status_code, mime)
        return None
    try:
        return media_links.to_whatsapp_image(resp.content, mime)
    except Exception as e:                                       # imagem corrompida/formato desconhecido
        log.warning("não consegui converter a foto %s: %s", url, e)
        return None


async def _send_image_or_link(deps: Deps, meta: MetaClient, account: str, to: str, part: media_links.Part, ctx: str | None) -> str:
    """Envio direto de uma foto (baixada, convertida e subida para a Meta). Sem a foto, manda o link (como antes)."""
    img = await _fetch_image(deps, part.url)
    if img is not None:
        media_id = await meta.upload_whatsapp_media(account, img[0], img[1], "foto.jpg" if img[1] == "image/jpeg" else "foto.png")
        return await meta.send_whatsapp_image(account, to, media_id, part.text or None, ctx)
    return await meta.send_whatsapp_text(account, to, f"{part.text}: {part.url}" if part.text else part.url, ctx)


async def _send_whatsapp_rich(deps: Deps, meta: MetaClient, account: str, to: str, body: str, reply_to: str | None = None) -> str:
    """Texto com links de foto sai como fotos de verdade (com legenda) + o texto restante, na ordem. Devolve o id da última mensagem.
    `reply_to` (id da Meta da mensagem citada) vai só na primeira parte: é ela que aparece "respondendo" no WhatsApp."""
    parts = media_links.split(body)
    if len(parts) == 1 and parts[0].kind == "text":
        return await meta.send_whatsapp_text(account, to, body, reply_to)
    pid = ""
    for i, part in enumerate(parts):
        ctx = reply_to if i == 0 else None
        if part.kind == "image":
            pid = await _send_image_or_link(deps, meta, account, to, part, ctx)
        else:
            pid = await meta.send_whatsapp_text(account, to, part.text, ctx)
    return pid


async def _send_cards(meta: MetaClient, account: str, to: str, catalog_id: str, images: list[media_links.Part], retailer: dict[str, str], ctx: str | None) -> str:
    """Cartões nativos: 1 produto → `product`; vários → `product_list` (sem repetir o mesmo item)."""
    ids: list[str] = []
    for img in images:
        rid = retailer[img.url]
        if rid not in ids:
            ids.append(rid)
    captions = [img.text for img in images if img.text]
    if len(ids) == 1:
        return await meta.send_whatsapp_product(account, to, catalog_id, ids[0], captions[0] if captions else None, ctx)
    body = " · ".join(dict.fromkeys(captions)) or PRODUCT_LIST_BODY
    return await meta.send_whatsapp_product_list(account, to, catalog_id, ids, PRODUCT_LIST_HEADER, body, reply_to=ctx)


async def _send_whatsapp_native(deps: Deps, meta: MetaClient, account: str, to: str, body: str, catalog_id: str, retailer: dict[str, str],
                                reply_to: str | None = None) -> str:
    """Modo "Catálogo nativo": as fotos de produtos que estão no catálogo da Meta viram cartões (foto, nome e preço da Meta), enviados
    no lugar da primeira foto; o texto segue na ordem. Foto sem item no catálogo vai direto, como antes. Se a Meta recusar o cartão
    (catálogo não ligado ao número, item reprovado…), as mesmas fotos saem pelo envio direto: a cliente nunca fica sem resposta."""
    parts = media_links.split(body, NATIVE_MAX_ITEMS)
    native = [p for p in parts if p.kind == "image" and p.url in retailer]
    if not native:
        return await _send_whatsapp_rich(deps, meta, account, to, body, reply_to)
    pid, first, cards_done, direct = "", True, False, 0
    for part in parts:
        ctx = reply_to if first else None
        first = False
        if part.kind == "text":
            pid = await meta.send_whatsapp_text(account, to, part.text, ctx)
        elif part.url in retailer:
            if cards_done:
                continue
            cards_done = True
            try:
                pid = await _send_cards(meta, account, to, catalog_id, native, retailer, ctx)
            except SendPermanent as e:
                log.warning("cartão do catálogo recusado pela Meta (%s): enviando as fotos direto", e)
                for img in native:
                    pid = await _send_direct_capped(deps, meta, account, to, img, ctx, direct)
                    direct, ctx = direct + 1, None
        else:
            pid = await _send_direct_capped(deps, meta, account, to, part, ctx, direct)
            direct += 1
    return pid


async def _send_direct_capped(deps: Deps, meta: MetaClient, account: str, to: str, part: media_links.Part, ctx: str | None, sent: int) -> str:
    if sent >= media_links.MAX_IMAGES:                               # como no envio direto: depois de 6 fotos, o resto vai como link
        return await meta.send_whatsapp_text(account, to, f"{part.text}: {part.url}" if part.text else part.url, ctx)
    return await _send_image_or_link(deps, meta, account, to, part, ctx)


async def _native_catalog(deps: Deps, message_id: str, body: str) -> tuple[str, dict[str, str]] | None:
    """(catalog_id, link da foto → retailer_id) quando o canal está no modo nativo e algum produto do texto está no catálogo da Meta.
    Qualquer falha aqui volta None: o envio segue pelo caminho direto."""
    if not any(p.kind == "image" for p in media_links.split(body, NATIVE_MAX_ITEMS)):
        return None
    try:
        info = await call_fn(deps.pool, "omni.message_products", message_id)
    except psycopg.Error as e:
        log.warning("produtos da mensagem %s indisponíveis (%s): envio direto", message_id, e)
        return None
    if not info or info.get("mode") != "NATIVE_CATALOG" or not info.get("catalog_id"):
        return None
    retailer = {p["url"]: p["retailer_id"] for p in info.get("products") or [] if p.get("retailer_id")}
    return (str(info["catalog_id"]), retailer) if retailer else None


async def handle(deps: Deps, msg: queues.QueueMessage) -> None:
    message_id = msg.payload["message_id"]
    ctx = await call_fn(deps.pool, "omni.outbound_context", message_id)
    if not ctx or not ctx.get("found"):
        raise PermanentError(f"mensagem {message_id} não encontrada")
    m = ctx["message"]
    if m["status"] not in ("QUEUED", "FAILED"):
        return                                                     # já enviada (reentrega): idempotente
    template = m.get("template_name")
    if not ctx["window_allowed"] and not template:
        await _fail(deps, message_id, ctx.get("window_reason") or "fora da janela de envio: use um template aprovado")
        return

    row = await fetch_one(deps.pool, "select ca.connection_id from omni.channel_accounts ca join omni.conversations c on c.channel_account_id = ca.id where c.id = %s", (ctx["conversation_id"],))
    secret = await deps.secret(row["connection_id"] if row else None)
    token = secret.get("token") or secret.get("access_token")
    if not token:
        await deps.notify(ctx["org_id"], "INTEGRATION_ERROR", "Canal sem credencial: mensagem não enviada", {"message_id": message_id, "channel": ctx["channel"]}, perm="core.admin")
        raise RetryLater(300, "canal sem credencial configurada")

    channel, to, account = ctx["channel"], ctx["external_id"], ctx["provider_account_id"]
    reply_to = (m.get("payload") or {}).get("reply_to")              # resposta citando uma mensagem (botão "Responder" da inbox)
    reply_to = str(reply_to) if reply_to else None
    try:
        if channel == "WHATSAPP":
            meta = MetaClient(deps.http, deps.settings.graph_api_base, token)
            if template:
                pid = await meta.send_whatsapp_template(account, to, template, (m.get("payload") or {}).get("language", "pt_BR"), (m.get("payload") or {}).get("components"))
            elif native := await _native_catalog(deps, message_id, m["body"]):
                pid = await _send_whatsapp_native(deps, meta, account, to, m["body"], native[0], native[1], reply_to)
            else:
                pid = await _send_whatsapp_rich(deps, meta, account, to, m["body"], reply_to)
        elif channel == "INSTAGRAM":
            meta = MetaClient(deps.http, deps.settings.instagram_api_base, token)
            comment_id = (m.get("payload") or {}).get("reply_to_comment_id")
            if comment_id:                                          # resposta privada a comentário (automação)
                pid = await meta.send_instagram_private_reply(account, str(comment_id), m["body"])
            else:
                pid = await meta.send_instagram_text(account, to, m["body"], human_agent=ctx.get("window_mode") == "HUMAN_AGENT_TAG", reply_to=reply_to)
        elif channel == "TELEGRAM":
            pid = await TelegramClient(deps.http, deps.settings.telegram_api_base, token).send_message(to, m["body"], reply_to)
        else:
            await _fail(deps, message_id, f"canal {channel} indisponível")
            return
    except TransientError as e:
        if msg.read_ct >= deps.settings.max_attempts:
            await _fail(deps, message_id, f"esgotou as tentativas: {e}")
            raise PermanentError(str(e)) from e
        if e.retry_after:
            raise RetryLater(int(e.retry_after), str(e)) from e
        raise
    except SendPermanent as e:
        await _fail(deps, message_id, str(e))
        if e.code in (190, 102):                                    # token da Meta inválido/expirado: alerta operacional
            await deps.notify(ctx["org_id"], "INTEGRATION_ERROR", "Token do canal inválido ou expirado", {"channel": channel, "code": e.code}, perm="core.admin")
        return
    await call_fn(deps.pool, "omni.mark_outbound", message_id, "SENT", pid, None)
