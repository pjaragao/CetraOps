"""Fila `integration_checks`: confere a credencial de uma integração (e registra o webhook do Telegram).
Só o worker enxerga o segredo (Vault); o resultado volta ao banco por core.record_integration_health e aparece em Configurações › Integrações."""
from __future__ import annotations

import logging
from typing import Any

from .. import queues
from ..adapters.errors import PermanentError, TransientError
from ..adapters.focus import PRODUCTION_BASE, FocusClient
from ..adapters.meta import MetaClient
from ..adapters.telegram import TelegramClient
from ..db import call_fn, fetch_one
from ..deps import Deps
from ..runner import RetryLater

log = logging.getLogger("sie_worker.integrations")


async def _record(deps: Deps, conn_id: Any, ok: bool, detail: dict[str, Any], error: str | None) -> None:
    await call_fn(deps.pool, "core.record_integration_health", conn_id, ok, detail, error)


async def _check(deps: Deps, conn: dict[str, Any], token: str, action: str) -> dict[str, Any]:
    """Devolve os detalhes da verificação; levanta PermanentError quando a integração NÃO está utilizável."""
    provider, cfg, s = conn["provider"], conn["config"] or {}, deps.settings
    if provider == "META_WA":
        phone_id = str(cfg.get("phone_number_id") or "").strip()
        if not phone_id:
            raise PermanentError("Informe o ID do número de telefone (phone_number_id) do WhatsApp")
        info = await MetaClient(deps.http, s.graph_api_base, token).whatsapp_phone_info(phone_id)
        return {k: info.get(k) for k in ("display_phone_number", "verified_name", "quality_rating", "name_status", "code_verification_status")}
    if provider == "META_IG":
        info = await MetaClient(deps.http, s.instagram_api_base, token).instagram_me()
        return {k: info.get(k) for k in ("user_id", "username", "name", "account_type")}
    if provider == "TELEGRAM":
        tg = TelegramClient(deps.http, s.telegram_api_base, token)
        me = await tg.get_me()
        if action == "TELEGRAM_WEBHOOK":
            if not s.telegram_webhook_secret:
                raise PermanentError("O worker não tem SIE_TELEGRAM_WEBHOOK_SECRET (o mesmo segredo das Edge Functions)")
            await tg.set_webhook(f"{s.supabase_url.rstrip('/')}/functions/v1/webhooks-telegram/{me['id']}", s.telegram_webhook_secret)
        info = await tg.get_webhook_info()
        detail = {"bot_id": str(me["id"]), "username": me.get("username"), "webhook_url": info.get("url") or None,
                  "pending_update_count": info.get("pending_update_count"), "last_error_message": info.get("last_error_message")}
        if not detail["webhook_url"]:
            raise PermanentError("Bot válido, mas o webhook ainda não foi registrado: use “Registrar webhook”")
        return detail
    if provider == "FOCUS_NFE":
        base = PRODUCTION_BASE if str(cfg.get("environment", "")).lower() in ("producao", "production") else s.focus_api_base
        return {**await FocusClient(deps.http, base, token).ping(), "environment": "producao" if base == PRODUCTION_BASE else "homologacao"}
    raise PermanentError(f"Provedor {provider} ainda não tem verificação automática")


async def handle(deps: Deps, msg: queues.QueueMessage) -> None:
    p = msg.payload
    conn = await fetch_one(deps.pool, "select id, org_id, provider, capability, status, config from core.integration_connections where id = %s", (p["connection_id"],))
    if conn is None or conn["status"] == "DISABLED":
        return
    secret = await deps.secret(str(conn["id"]))
    token = secret.get("token") or secret.get("access_token") or secret.get("api_key")
    if not token:
        await _record(deps, conn["id"], False, {}, "credencial não encontrada no cofre")
        return
    try:
        detail = await _check(deps, conn, str(token), p.get("action", "CHECK"))
    except TransientError as e:
        if msg.read_ct >= 3:                                        # três tentativas seguidas: registra a falha para a equipe ver
            await _record(deps, conn["id"], False, {"transient": True}, str(e))
            return
        raise RetryLater(int(e.retry_after or 20 * msg.read_ct), str(e)) from e
    except PermanentError as e:
        await _record(deps, conn["id"], False, {"code": e.code}, str(e))
        return
    await _record(deps, conn["id"], True, detail, None)
