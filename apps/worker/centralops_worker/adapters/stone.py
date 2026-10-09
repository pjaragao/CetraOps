"""Cliente Stone / Pagar.me Connect 2.0 (Smart POS).
Referência: https://connect-stone.stone.com.br/
Permite criar pedidos diretos para a maquininha física (POI), consultar status e cancelar cobrança.
"""
from __future__ import annotations

import base64
from typing import Any

import httpx

from .errors import PermanentError, TransientError

STONE_API_BASE = "https://api.pagar.me"


class StoneClient:
    def __init__(self, http: httpx.AsyncClient, secret_key: str, api_base: str = STONE_API_BASE) -> None:
        self._http = http
        self._base = api_base.rstrip("/")
        self._key = secret_key.strip()
        auth_bytes = f"{self._key}:".encode()
        self._auth_header = f"Basic {base64.b64encode(auth_bytes).decode('utf-8')}"
        self._headers = {
            "Authorization": self._auth_header,
            "Content-Type": "application/json",
            "Accept": "application/json",
        }

    async def _request(self, method: str, path: str, **kw: Any) -> httpx.Response:
        headers = {**self._headers, **kw.pop("headers", {})}
        try:
            return await self._http.request(method, f"{self._base}{path}", headers=headers, timeout=30, **kw)
        except (httpx.TimeoutException, httpx.TransportError) as e:
            raise TransientError(f"rede: {e}") from e

    def _check(self, resp: httpx.Response) -> None:
        if resp.status_code >= 500 or resp.status_code == 429:
            raise TransientError(f"Stone {resp.status_code}", status=resp.status_code)
        if resp.status_code in (401, 403):
            raise PermanentError("Stone/Pagar.me: credencial recusada (verifique a Secret Key)", status=resp.status_code)
        if resp.status_code >= 400:
            try:
                data = resp.json()
                msg = data.get("message") or (data.get("errors") and str(data.get("errors"))) or resp.text[:120]
            except Exception:
                msg = resp.text[:120]
            raise PermanentError(f"Stone {resp.status_code}: {msg}", status=resp.status_code)

    async def create_pos_order(
        self,
        code: str,
        amount_cents: int,
        terminal_serial: str,
        display_name: str,
        method: str = "credit",
        installments: int = 1,
        customer: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Cria pedido direto para a maquininha Smart POS (POI)."""
        method_norm = method.lower()
        payment_type = "debit" if "deb" in method_norm else "pix" if "pix" in method_norm else "credit"

        poi_settings: dict[str, Any] = {
            "visible": True,
            "print_order_receipt": False,
            "devices_serial_number": [terminal_serial.strip()],
            "display_name": display_name[:50],
        }

        # Setup direto: direciona a maquininha para a forma de pagamento e parcelas
        payment_setup: dict[str, Any] = {
            "type": payment_type,
        }
        if payment_type == "credit":
            payment_setup["installments"] = max(1, min(12, int(installments)))
            payment_setup["installment_type"] = "merchant"
        elif payment_type == "debit":
            payment_setup["installments"] = 1
            payment_setup["installment_type"] = "merchant"

        poi_settings["payment_setup"] = payment_setup

        payload: dict[str, Any] = {
            "code": code,
            "closed": False,
            "items": [
                {
                    "amount": int(amount_cents),
                    "description": display_name[:60],
                    "quantity": 1,
                }
            ],
            "poi_payment_settings": poi_settings,
        }
        if customer:
            payload["customer"] = {k: v for k, v in customer.items() if v}

        resp = await self._request("POST", "/core/v5/orders", json=payload)
        self._check(resp)
        return resp.json()

    async def get_order(self, order_id: str) -> dict[str, Any]:
        """Obtém status do pedido no Pagar.me / Stone."""
        resp = await self._request("GET", f"/core/v5/orders/{order_id}")
        self._check(resp)
        return resp.json()

    async def cancel_pos_order(self, order_id: str) -> dict[str, Any]:
        """Cancela/fecha pedido em aberto na maquininha."""
        resp = await self._request("DELETE", f"/core/v5/orders/{order_id}/closed")
        if resp.status_code == 404:
            return {"status": "canceled"}
        self._check(resp)
        try:
            return resp.json()
        except Exception:
            return {"status": "canceled"}

    async def ping(self) -> dict[str, Any]:
        """Verifica se a Secret Key é válida consultando a API."""
        resp = await self._request("GET", "/core/v5/orders", params={"page": 1, "size": 1})
        self._check(resp)
        return {"http_status": resp.status_code, "status": "online"}
