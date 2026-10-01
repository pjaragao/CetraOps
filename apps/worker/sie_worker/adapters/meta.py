"""Cliente da Graph API da Meta: WhatsApp Cloud API e Instagram Messaging. Só HTTP; regra de janela fica no banco."""
from __future__ import annotations

import json
from collections.abc import AsyncIterator
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


LEAD_ACTIONS = ("lead", "onsite_conversion.lead_grouped")
CONVERSATION_ACTIONS = ("onsite_conversion.messaging_conversation_started_7d",)
PURCHASE_ACTIONS = ("purchase", "omni_purchase")


def normalize_insight(item: dict[str, Any]) -> dict[str, Any] | None:
    """Uma linha de insights da Meta → o que o banco guarda. As conversões vêm em `actions` (contagem) e `action_values` (valor)."""
    ad_id, day = item.get("ad_id"), item.get("date_start")
    if not ad_id or not day:
        return None

    def count(names: tuple[str, ...]) -> int:
        return max((int(float(a.get("value") or 0)) for a in item.get("actions") or [] if a.get("action_type") in names), default=0)

    def value(names: tuple[str, ...]) -> float:
        return max((float(a.get("value") or 0) for a in item.get("action_values") or [] if a.get("action_type") in names), default=0.0)

    return {"ad_id": str(ad_id), "ad_name": item.get("ad_name"), "adset_name": item.get("adset_name"), "campaign_id": item.get("campaign_id"), "campaign_name": item.get("campaign_name"),
            "day": day, "spend": float(item.get("spend") or 0), "impressions": int(float(item.get("impressions") or 0)), "reach": int(float(item.get("reach") or 0)),
            "clicks": int(float(item.get("clicks") or 0)), "leads": count(LEAD_ACTIONS), "conversations": count(CONVERSATION_ACTIONS), "purchases": count(PURCHASE_ACTIONS),
            "purchase_value": value(PURCHASE_ACTIONS)}


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

    async def _get(self, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        try:
            resp = await self._http.get(f"{self._base}/{path}", params=params, headers=self._headers(), timeout=20)
        except (httpx.TimeoutException, httpx.TransportError) as e:
            raise TransientError(f"rede: {e}") from e
        _raise_for(resp)
        return resp.json()

    # ---------------- Verificação de credencial ----------------
    async def whatsapp_phone_info(self, phone_number_id: str) -> dict[str, Any]:
        return await self._get(phone_number_id, {"fields": "display_phone_number,verified_name,quality_rating,code_verification_status,name_status"})

    async def dataset_info(self, dataset_id: str) -> dict[str, Any]:
        return await self._get(dataset_id, {"fields": "id,name"})

    async def instagram_me(self) -> dict[str, Any]:
        return await self._get("me", {"fields": "user_id,username,name,account_type"})

    # ---------------- Templates do WhatsApp ----------------
    async def create_template(self, waba_id: str, name: str, language: str, category: str, components: list[dict[str, Any]]) -> dict[str, Any]:
        """Envia o template para aprovação. Devolve {id, status, category}. Erro de validação (nome repetido, texto recusado) chega como PermanentError."""
        return await self._post(f"{waba_id}/message_templates", {"name": name, "language": language, "category": category, "components": components})

    async def list_templates(self, waba_id: str) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        url: str | None = f"{self._base}/{waba_id}/message_templates"
        params: dict[str, Any] | None = {"fields": "id,name,status,category,language,components,quality_score,rejected_reason", "limit": 100}
        for _ in range(20):                                   # paginação: no máximo 2.000 templates
            try:
                resp = await self._http.get(url, params=params, headers=self._headers(), timeout=30)
            except (httpx.TimeoutException, httpx.TransportError) as e:
                raise TransientError(f"rede: {e}") from e
            _raise_for(resp)
            data = resp.json()
            out.extend(data.get("data", []))
            url, params = (data.get("paging") or {}).get("next"), None
            if not url:
                break
        return out

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

    async def send_instagram_private_reply(self, ig_account_id: str, comment_id: str, text: str) -> str:
        """Resposta privada a um comentário (1 por comentário, em até 7 dias): a DM é endereçada ao comentário, não à pessoa."""
        data = await self._post(f"{ig_account_id}/messages", {"recipient": {"comment_id": comment_id}, "message": {"text": text}})
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

    # ---------------- Marketing API (insights de anúncios) ----------------
    async def ad_account_info(self, ad_account: str) -> dict[str, Any]:
        return await self._get(ad_account, {"fields": "name,currency,account_status"})

    async def ad_insights(self, ad_account: str, since: str, until: str) -> AsyncIterator[dict[str, Any]]:
        """Resultados por anúncio e por dia no período (aaaa-mm-dd), já normalizados. Segue a paginação da Meta."""
        params: dict[str, Any] = {
            "level": "ad", "time_increment": 1, "limit": 200, "time_range": json.dumps({"since": since, "until": until}),
            "fields": "ad_id,ad_name,adset_name,campaign_id,campaign_name,spend,impressions,reach,clicks,actions,action_values",
        }
        while True:
            page = await self._get(f"{ad_account}/insights", params)
            for item in page.get("data", []):
                row = normalize_insight(item)
                if row:
                    yield row
            after = ((page.get("paging") or {}).get("cursors") or {}).get("after")
            if not (page.get("paging") or {}).get("next") or not after:
                return
            params = {**params, "after": after}

    # ---------------- Conversions API ----------------
    async def send_capi_events(self, dataset_id: str, events: list[dict[str, Any]], extra: dict[str, Any] | None = None) -> dict[str, Any]:
        """Envia eventos de conversão ao conjunto de dados (pixel). `extra` leva o test_event_code quando a integração está em teste."""
        return await self._post(f"{dataset_id}/events", {"data": events, **(extra or {})})
