"""Cliente do Focus NFe (NFC-e/NF-e). A referência (`ref`) é a chave de idempotência: reenviar a mesma ref não duplica a nota."""
from __future__ import annotations

import base64
from dataclasses import dataclass, field
from typing import Any

import httpx

from .errors import PermanentError, TransientError

# situação do provedor → situação do nosso documento fiscal
STATUS_MAP = {
    "autorizado": "AUTHORIZED", "processando_autorizacao": "PROCESSING", "erro_autorizacao": "REJECTED",
    "cancelado": "CANCELLED", "denegado": "DENIED", "rejeitado": "REJECTED",
}


@dataclass
class FocusResult:
    status: str                                   # PROCESSING | AUTHORIZED | REJECTED | CANCELLED | DENIED
    number: int | None = None
    series: int | None = None
    access_key: str | None = None
    protocol: str | None = None
    xml_path: str | None = None
    danfe_path: str | None = None
    code: str | None = None
    message: str | None = None
    raw: dict[str, Any] = field(default_factory=dict)


def _parse(data: dict[str, Any]) -> FocusResult:
    status = STATUS_MAP.get(str(data.get("status", "")), "PROCESSING")
    to_int = lambda v: int(v) if v not in (None, "") else None  # noqa: E731
    return FocusResult(
        status=status, number=to_int(data.get("numero")), series=to_int(data.get("serie")), access_key=(data.get("chave_nfe") or "").replace("NFe", "") or None,
        protocol=data.get("protocolo"), xml_path=data.get("caminho_xml_nota_fiscal"), danfe_path=data.get("caminho_danfe") or data.get("url_danfe"),
        code=str(data.get("status_sefaz")) if data.get("status_sefaz") else data.get("codigo"), message=data.get("mensagem_sefaz") or data.get("mensagem"), raw=data,
    )


class FocusClient:
    def __init__(self, http: httpx.AsyncClient, base: str, token: str) -> None:
        self._http, self._base = http, base.rstrip("/")
        self._auth = {"Authorization": "Basic " + base64.b64encode(f"{token}:".encode()).decode()}

    async def _request(self, method: str, path: str, **kw: Any) -> httpx.Response:
        try:
            return await self._http.request(method, f"{self._base}{path}", headers=self._auth, timeout=45, **kw)
        except (httpx.TimeoutException, httpx.TransportError) as e:
            raise TransientError(f"rede: {e}") from e

    def _result(self, resp: httpx.Response) -> FocusResult:
        if resp.status_code >= 500 or resp.status_code == 429:
            raise TransientError(f"Focus NFe {resp.status_code}", status=resp.status_code)
        try:
            data = resp.json()
        except ValueError:
            raise PermanentError(f"Focus NFe resposta inválida ({resp.status_code})", status=resp.status_code) from None
        if resp.status_code in (401, 403):
            raise PermanentError("Focus NFe: credencial recusada", status=resp.status_code)
        if resp.status_code == 422 and data.get("codigo") in ("requisicao_invalida", "nfe_autorizada"):
            # 422 "já autorizada" para a mesma ref: consultar em vez de tratar como erro
            if data.get("codigo") == "nfe_autorizada":
                return _parse({**data, "status": "autorizado"})
            return FocusResult(status="REJECTED", code=data.get("codigo"), message=data.get("mensagem"), raw=data)
        if resp.status_code >= 400:
            return FocusResult(status="REJECTED", code=str(data.get("codigo", resp.status_code)), message=data.get("mensagem"), raw=data)
        return _parse(data)

    async def emit_nfce(self, ref: str, document: dict[str, Any]) -> FocusResult:
        return self._result(await self._request("POST", "/v2/nfce", params={"ref": ref}, json=document))

    async def emit_nfe(self, ref: str, document: dict[str, Any]) -> FocusResult:
        return self._result(await self._request("POST", "/v2/nfe", params={"ref": ref}, json=document))

    async def get(self, model: str, ref: str) -> FocusResult:
        return self._result(await self._request("GET", f'/v2/{"nfce" if model == "65" else "nfe"}/{ref}'))

    async def cancel(self, model: str, ref: str, reason: str) -> FocusResult:
        return self._result(await self._request("DELETE", f'/v2/{"nfce" if model == "65" else "nfe"}/{ref}', json={"justificativa": reason}))

    async def ping(self) -> dict[str, Any]:
        """Confere só a credencial: consulta de CNPJ (endpoint auxiliar simples, sem payload). 401/403 = credencial recusada; 200/404 = aceita."""
        resp = await self._request("GET", "/v2/cnpjs/00000000000191")
        if resp.status_code in (401, 403):
            raise PermanentError("Focus NFe: credencial recusada", status=resp.status_code)
        if resp.status_code == 429 or resp.status_code >= 500:
            raise TransientError(f"Focus NFe {resp.status_code}", status=resp.status_code)
        return {"http_status": resp.status_code}
