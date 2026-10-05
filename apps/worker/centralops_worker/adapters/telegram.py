"""Cliente do Telegram Bot API (o bot só responde a quem iniciou a conversa)."""
from __future__ import annotations

from typing import Any

import httpx

from .errors import PermanentError, TransientError


class TelegramClient:
    def __init__(self, http: httpx.AsyncClient, base: str, token: str) -> None:
        self._http, self._base, self._token = http, base.rstrip("/"), token

    async def _call(self, method: str, payload: dict[str, Any] | None = None) -> Any:
        try:
            resp = await self._http.post(f"{self._base}/bot{self._token}/{method}", json=payload or {}, timeout=20)
        except (httpx.TimeoutException, httpx.TransportError) as e:
            raise TransientError(f"rede: {e}") from e
        data = resp.json() if resp.content else {}
        if resp.status_code == 429:
            raise TransientError("Telegram: limite de envio", status=429, retry_after=(data.get("parameters") or {}).get("retry_after"))
        if resp.status_code >= 500:
            raise TransientError(f"Telegram {resp.status_code}", status=resp.status_code)
        if resp.status_code >= 400 or not data.get("ok"):
            raise PermanentError(f'Telegram: {data.get("description", resp.text[:200])}', code=data.get("error_code"), status=resp.status_code)
        return data["result"]

    async def send_message(self, chat_id: str, text: str) -> str:
        result = await self._call("sendMessage", {"chat_id": chat_id, "text": text})
        return f'{chat_id}:{result["message_id"]}'

    async def get_me(self) -> dict[str, Any]:
        return await self._call("getMe")

    async def get_webhook_info(self) -> dict[str, Any]:
        return await self._call("getWebhookInfo")

    async def set_webhook(self, url: str, secret_token: str) -> None:
        """Registra o webhook com `secret_token` (o Telegram devolve no cabeçalho X-Telegram-Bot-Api-Secret-Token a cada update)."""
        await self._call("setWebhook", {"url": url, "secret_token": secret_token, "allowed_updates": ["message", "edited_message"], "drop_pending_updates": False})
