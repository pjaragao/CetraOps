"""Cliente do Telegram Bot API (o bot só responde a quem iniciou a conversa)."""
from __future__ import annotations

import httpx

from .errors import PermanentError, TransientError


class TelegramClient:
    def __init__(self, http: httpx.AsyncClient, base: str, token: str) -> None:
        self._http, self._base, self._token = http, base.rstrip("/"), token

    async def send_message(self, chat_id: str, text: str) -> str:
        try:
            resp = await self._http.post(f"{self._base}/bot{self._token}/sendMessage", json={"chat_id": chat_id, "text": text}, timeout=20)
        except (httpx.TimeoutException, httpx.TransportError) as e:
            raise TransientError(f"rede: {e}") from e
        data = resp.json() if resp.content else {}
        if resp.status_code == 429:
            raise TransientError("Telegram: limite de envio", status=429, retry_after=(data.get("parameters") or {}).get("retry_after"))
        if resp.status_code >= 500:
            raise TransientError(f"Telegram {resp.status_code}", status=resp.status_code)
        if resp.status_code >= 400 or not data.get("ok"):
            raise PermanentError(f'Telegram: {data.get("description", resp.text[:200])}', code=data.get("error_code"), status=resp.status_code)
        return f'{chat_id}:{data["result"]["message_id"]}'
