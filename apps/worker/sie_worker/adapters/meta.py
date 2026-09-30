"""Cliente da Graph API da Meta: WhatsApp Cloud API e Instagram Messaging. Só HTTP; regra de janela fica no banco."""
from __future__ import annotations

from typing import Any

import httpx

from .errors import PermanentError, TransientError

# Códigos de erro da Meta que significam "muito rápido" (repetir depois)
RATE_LIMIT_CODES = {4, 17, 32, 613, 80007, 130429, 131056}
# Janela de 24h fechada / fora da política de mensagens
WINDOW_CODES = {131047, 131051}


def _raise_for(resp: httpx.Response) -> None:
    if resp.status_code < 400:
        return
    try:
        err = resp.json().get("error", {})
    except ValueError:
        err = {}
    code = err.get("code")
    msg = f'{code}: {err.get("error_user_msg") or err.get("message") or resp.text[:200]}'
    if resp.status_code == 429 or code in RATE_LIMIT_CODES or resp.status_code >= 500:
        raise TransientError(msg, code=code, status=resp.status_code)
    raise PermanentError(msg, code=code, status=resp.status_code)


class MetaClient:
    def __init__(self, http: httpx.AsyncClient, base: str, token: str) -> None:
        self._http, self._base, self._token = http, base.rstrip("/"), token

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._token}"}

    async def _post(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        try:
            resp = await self._http.post(f"{self._base}/{path}", json=body, headers=self._headers(), timeout=20)
        except (httpx.TimeoutException, httpx.TransportError) as e:
            raise TransientError(f"rede: {e}") from e
        _raise_for(resp)
        return resp.json()

    # ---------------- WhatsApp ----------------
    async def send_whatsapp_text(self, phone_number_id: str, to: str, body: str, reply_to: str | None = None) -> str:
        payload: dict[str, Any] = {"messaging_product": "whatsapp", "recipient_type": "individual", "to": to, "type": "text", "text": {"preview_url": False, "body": body}}
        if reply_to:
            payload["context"] = {"message_id": reply_to}
        data = await self._post(f"{phone_number_id}/messages", payload)
        return data["messages"][0]["id"]

    async def send_whatsapp_template(self, phone_number_id: str, to: str, name: str, language: str = "pt_BR", components: list[dict[str, Any]] | None = None) -> str:
        payload = {"messaging_product": "whatsapp", "to": to, "type": "template", "template": {"name": name, "language": {"code": language}, "components": components or []}}
        data = await self._post(f"{phone_number_id}/messages", payload)
        return data["messages"][0]["id"]

    async def mark_read_typing(self, phone_number_id: str, message_id: str) -> None:
        """Marca como lida e mostra 'digitando…' (a Meta encerra o indicador sozinha em até 25 s)."""
        await self._post(f"{phone_number_id}/messages", {"messaging_product": "whatsapp", "status": "read", "message_id": message_id, "typing_indicator": {"type": "text"}})

    # ---------------- Instagram ----------------
    async def send_instagram_text(self, ig_account_id: str, recipient_id: str, text: str, human_agent: bool = False) -> str:
        payload: dict[str, Any] = {"recipient": {"id": recipient_id}, "message": {"text": text}}
        if human_agent:
            payload["messaging_type"] = "MESSAGE_TAG"
            payload["tag"] = "HUMAN_AGENT"            # só humano, entre 24 h e 7 dias
        data = await self._post(f"{ig_account_id}/messages", payload)
        return data.get("message_id") or data["recipient_id"]

    # ---------------- Mídia ----------------
    async def download_media(self, media_id: str) -> tuple[bytes, str]:
        try:
            meta = await self._http.get(f"{self._base}/{media_id}", headers=self._headers(), timeout=20)
            _raise_for(meta)
            info = meta.json()
            blob = await self._http.get(info["url"], headers=self._headers(), timeout=60)
            _raise_for(blob)
        except (httpx.TimeoutException, httpx.TransportError) as e:
            raise TransientError(f"rede: {e}") from e
        return blob.content, info.get("mime_type", blob.headers.get("content-type", "application/octet-stream"))
