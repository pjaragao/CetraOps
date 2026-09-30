"""Fila `media_processing`: baixa a mídia da Meta (a URL expira), guarda no Storage e transcreve áudio (Whisper)."""
from __future__ import annotations

import logging
import mimetypes

import httpx

from .. import queues
from ..adapters.errors import PermanentError as ProviderPermanent
from ..adapters.errors import TransientError
from ..adapters.meta import MetaClient
from ..db import call_fn, fetch_one
from ..deps import Deps
from ..runner import PermanentError, RetryLater

log = logging.getLogger("sie_worker.media")


async def _upload(deps: Deps, path: str, data: bytes, mime: str) -> None:
    url = f"{deps.settings.supabase_url.rstrip('/')}/storage/v1/object/{deps.settings.media_bucket}/{path}"
    try:
        resp = await deps.http.post(url, content=data, headers={"Authorization": f"Bearer {deps.settings.supabase_service_key}", "Content-Type": mime, "x-upsert": "true"}, timeout=60)
    except (httpx.TimeoutException, httpx.TransportError) as e:
        raise TransientError(f"rede: {e}") from e
    if resp.status_code >= 500:
        raise TransientError(f"Storage {resp.status_code}")
    if resp.status_code >= 400:
        raise ProviderPermanent(f"Storage {resp.status_code}: {resp.text[:200]}")


async def _transcribe(deps: Deps, data: bytes, mime: str) -> str | None:
    if not deps.settings.groq_key:
        return None
    ext = mimetypes.guess_extension(mime.split(";")[0]) or ".ogg"
    try:
        resp = await deps.http.post(f"{deps.settings.groq_base.rstrip('/')}/audio/transcriptions", headers={"Authorization": f"Bearer {deps.settings.groq_key}"},
                                    data={"model": "whisper-large-v3-turbo", "language": "pt", "response_format": "json"}, files={"file": (f"audio{ext}", data, mime)}, timeout=90)
    except (httpx.TimeoutException, httpx.TransportError) as e:
        raise TransientError(f"rede: {e}") from e
    if resp.status_code == 429 or resp.status_code >= 500:
        raise TransientError(f"Whisper {resp.status_code}")
    if resp.status_code >= 400:
        return None                                                  # sem transcrição: a IA cai para rascunho/humano
    return (resp.json().get("text") or "").strip() or None


async def handle(deps: Deps, msg: queues.QueueMessage) -> None:
    p = msg.payload
    if p.get("channel") != "WHATSAPP":
        return                                                       # Instagram entrega URL pública temporária: tratada quando o canal estiver ativo
    media = p.get("media") or {}
    if not media.get("id"):
        return
    row = await fetch_one(deps.pool, "select m.org_id, m.conversation_id, ca.connection_id from omni.messages m join omni.channel_accounts ca on ca.id = m.channel_account_id where m.id = %s", (p["message_id"],))
    if row is None:
        raise PermanentError("mensagem não encontrada")
    token = (await deps.secret(row["connection_id"])).get("token")
    if not token:
        raise RetryLater(600, "canal sem credencial")
    try:
        data, mime = await MetaClient(deps.http, deps.settings.graph_api_base, token).download_media(media["id"])
        ext = mimetypes.guess_extension(mime.split(";")[0]) or ""
        path = f'{row["org_id"]}/{row["conversation_id"]}/{p["message_id"]}{ext}'
        await _upload(deps, path, data, mime)
        transcript = await _transcribe(deps, data, mime) if p.get("type") == "AUDIO" else None
    except TransientError as e:
        raise RetryLater(int(e.retry_after or 20), str(e)) from e
    except ProviderPermanent as e:
        raise PermanentError(str(e)) from e
    await call_fn(deps.pool, "omni.attach_media", p["message_id"], path, transcript)
