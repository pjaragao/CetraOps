"""Fila `outbound_messages`: envia pelo canal certo. A janela de 24 h/7 dias já foi decidida no banco; aqui só há HTTP e classificação de erro."""
from __future__ import annotations

import logging

from .. import queues
from ..adapters.errors import PermanentError as SendPermanent
from ..adapters.errors import TransientError
from ..adapters.meta import MetaClient
from ..adapters.telegram import TelegramClient
from ..db import call_fn, fetch_one
from ..deps import Deps
from ..runner import PermanentError, RetryLater

log = logging.getLogger("centralops_worker.outbound")


async def _fail(deps: Deps, message_id: str, reason: str) -> None:
    await call_fn(deps.pool, "omni.mark_outbound", message_id, "FAILED", None, reason)


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
    try:
        if channel == "WHATSAPP":
            meta = MetaClient(deps.http, deps.settings.graph_api_base, token)
            if template:
                pid = await meta.send_whatsapp_template(account, to, template, (m.get("payload") or {}).get("language", "pt_BR"), (m.get("payload") or {}).get("components"))
            else:
                pid = await meta.send_whatsapp_text(account, to, m["body"])
        elif channel == "INSTAGRAM":
            meta = MetaClient(deps.http, deps.settings.instagram_api_base, token)
            comment_id = (m.get("payload") or {}).get("reply_to_comment_id")
            if comment_id:                                          # resposta privada a comentário (automação)
                pid = await meta.send_instagram_private_reply(account, str(comment_id), m["body"])
            else:
                pid = await meta.send_instagram_text(account, to, m["body"], human_agent=ctx.get("window_mode") == "HUMAN_AGENT_TAG")
        elif channel == "TELEGRAM":
            pid = await TelegramClient(deps.http, deps.settings.telegram_api_base, token).send_message(to, m["body"])
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
