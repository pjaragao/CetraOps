"""Cliente da Brasil NFe (NFC-e/NF-e e MDe).
Compatível com a API REST 2.0 (api.brasilnfe.com.br).
A referência (`ref`) é a chave de idempotência do sistema.
"""
from __future__ import annotations

import base64
from dataclasses import dataclass, field
from typing import Any

import httpx

from .errors import PermanentError, TransientError

BRASIL_NFE_PRODUCTION_BASE = "https://api.brasilnfe.com.br"

# situação do provedor → situação do nosso documento fiscal
STATUS_MAP = {
    "autorizado": "AUTHORIZED",
    "autorizada": "AUTHORIZED",
    "processando_autorizacao": "PROCESSING",
    "processando": "PROCESSING",
    "em_processamento": "PROCESSING",
    "emprocessamento": "PROCESSING",
    "erro_autorizacao": "REJECTED",
    "rejeitado": "REJECTED",
    "rejeitada": "REJECTED",
    "cancelado": "CANCELLED",
    "cancelada": "CANCELLED",
    "denegado": "DENIED",
    "denegada": "DENIED",
}

# manifestação do destinatário: texto do provedor ↔ situação nossa
MANIFEST_FROM_PROVIDER = {
    "ciencia": "CIENCIA",
    "ciência": "CIENCIA",
    "confirmacao": "CONFIRMADA",
    "confirmação": "CONFIRMADA",
    "confirmada": "CONFIRMADA",
    "desconhecimento": "DESCONHECIDA",
    "desconhecida": "DESCONHECIDA",
    "nao_realizada": "NAO_REALIZADA",
    "não_realizada": "NAO_REALIZADA",
    "naorealizada": "NAO_REALIZADA",
}
MANIFEST_TO_PROVIDER = {
    "CIENCIA": "CIENCIA",
    "CONFIRMADA": "CONFIRMADA",
    "DESCONHECIDA": "DESCONHECIDA",
    "NAO_REALIZADA": "NAO_REALIZADA",
}


def normalize_received(item: dict[str, Any]) -> dict[str, Any] | None:
    """Uma NF-e recebida (formato do provedor) → o que o banco guarda."""
    raw_key = (
        item.get("chave_nfe")
        or item.get("chave")
        or item.get("Chave")
        or item.get("ChaveAcesso")
        or item.get("chaveAcesso")
        or ""
    )
    key = str(raw_key).replace("NFe", "").strip()
    if len(key) != 44 or not key.isdigit():
        return None

    def first(*names: str) -> Any:
        return next((item[n] for n in names if item.get(n) not in (None, "")), None)

    amount = first("valor_total", "valor", "valor_nf", "ValorTotal", "Valor", "valorTotal")
    raw_manifest = first(
        "manifestacao_destinatario",
        "tipo_ultima_manifestacao",
        "ManifestacaoDestinatario",
        "Manifestacao",
        "manifestacao",
    )
    manifest_norm = str(raw_manifest or "").lower().strip()

    return {
        "access_key": key,
        "nsu": str(first("versao", "nsu", "Versao", "Nsu") or "") or None,
        "issuer_cnpj": "".join(
            c
            for c in str(
                first("documento_emitente", "cnpj_emitente", "CnpjEmitente", "DocumentoEmitente", "cnpj", "CNPJ") or ""
            )
            if c.isdigit()
        )
        or None,
        "issuer_name": first("nome_emitente", "emitente", "NomeEmitente", "Emitente", "razao_social", "RazaoSocial"),
        "amount": float(amount) if amount is not None else None,
        "issue_at": first("data_emissao", "emissao", "DataEmissao", "Emissao"),
        "manifest_status": MANIFEST_FROM_PROVIDER.get(manifest_norm, "PENDING"),
    }


@dataclass
class BrasilNfeResult:
    status: str  # PROCESSING | AUTHORIZED | REJECTED | CANCELLED | DENIED
    number: int | None = None
    series: int | None = None
    access_key: str | None = None
    protocol: str | None = None
    xml_path: str | None = None
    danfe_path: str | None = None
    code: str | None = None
    message: str | None = None
    raw: dict[str, Any] = field(default_factory=dict)


def _parse(data: dict[str, Any]) -> BrasilNfeResult:
    def first(*names: str) -> Any:
        return next((data[n] for n in names if data.get(n) not in (None, "")), None)

    raw_status = str(first("status", "Status", "situacao", "Situacao") or "").lower().strip()
    status = STATUS_MAP.get(raw_status, "PROCESSING")

    to_int = lambda v: int(v) if v not in (None, "") else None  # noqa: E731

    raw_key = first("chave_nfe", "chave", "Chave", "ChaveAcesso", "chaveAcesso") or ""
    access_key = str(raw_key).replace("NFe", "").strip() or None

    code = first("status_sefaz", "codigo", "Codigo", "StatusSefaz", "CodigoStatus")
    msg = first("mensagem_sefaz", "mensagem", "Mensagem", "Motivo", "Descricao")
    danfe = first("url_danfe", "caminho_danfe", "Danfe", "UrlDanfe", "CaminhoDanfe", "pdf", "Pdf")
    xml = first("caminho_xml_nota_fiscal", "caminho_xml", "Xml", "UrlXml", "CaminhoXml")

    return BrasilNfeResult(
        status=status,
        number=to_int(first("numero", "Numero")),
        series=to_int(first("serie", "Serie")),
        access_key=access_key,
        protocol=str(first("protocolo", "Protocolo") or "") or None,
        xml_path=str(xml) if xml else None,
        danfe_path=str(danfe) if danfe else None,
        code=str(code) if code else None,
        message=str(msg) if msg else None,
        raw=data,
    )


class BrasilNfeClient:
    def __init__(self, http: httpx.AsyncClient, base: str, token: str, user_token: str | None = None, tp_amb: int = 2) -> None:
        self._http, self._base = http, base.rstrip("/")
        self._tp_amb = 1 if tp_amb == 1 else 2                       # 1 = produção, 2 = homologação (padrão seguro: testes)
        self._token = token.strip()
        self._user_token = (user_token or token).strip()
        self._headers = {
            "Token": self._token,
            "UserToken": self._user_token,
            "Authorization": f"Bearer {self._token}",
            "Content-Type": "application/json",
        }

    async def _request(self, method: str, path: str, **kw: Any) -> httpx.Response:
        headers = {**self._headers, **kw.pop("headers", {})}
        try:
            return await self._http.request(method, f"{self._base}{path}", headers=headers, timeout=45, **kw)
        except (httpx.TimeoutException, httpx.TransportError) as e:
            raise TransientError(f"rede: {e}") from e

    def _result(self, resp: httpx.Response) -> BrasilNfeResult:
        if resp.status_code >= 500 or resp.status_code == 429:
            raise TransientError(f"Brasil NFe {resp.status_code}", status=resp.status_code)
        try:
            data = resp.json()
        except ValueError:
            raise PermanentError(f"Brasil NFe resposta inválida ({resp.status_code})", status=resp.status_code) from None

        if resp.status_code in (401, 403):
            raise PermanentError("Brasil NFe: credencial recusada", status=resp.status_code)

        if resp.status_code == 422:
            code = data.get("codigo") or data.get("Codigo")
            msg = data.get("mensagem") or data.get("Mensagem") or data.get("Motivo")
            if code in ("nfe_autorizada", "ja_autorizada", "Duplicidade"):
                return _parse({**data, "status": "autorizado"})
            return BrasilNfeResult(status="REJECTED", code=str(code), message=str(msg), raw=data)

        if resp.status_code >= 400:
            code = data.get("codigo") or data.get("Codigo") or resp.status_code
            msg = data.get("mensagem") or data.get("Mensagem") or resp.text[:120]
            return BrasilNfeResult(status="REJECTED", code=str(code), message=str(msg), raw=data)

        return _parse(data)

    async def emit_nfce(self, ref: str, document: dict[str, Any]) -> BrasilNfeResult:
        """Emite NFC-e (modelo 65)."""
        payload = {**document, "ModeloDocumento": 65, "TipoAmbiente": self._tp_amb, "Identificador": ref, "ref": ref}
        return self._result(await self._request("POST", "/EnviarNotaFiscal", json=payload))

    async def emit_nfe(self, ref: str, document: dict[str, Any]) -> BrasilNfeResult:
        """Emite NF-e (modelo 55)."""
        payload = {**document, "ModeloDocumento": 55, "TipoAmbiente": self._tp_amb, "Identificador": ref, "ref": ref}
        return self._result(await self._request("POST", "/EnviarNotaFiscal", json=payload))

    async def get(self, model: str, ref: str) -> BrasilNfeResult:
        """Consulta status da nota emitida por ref/chave."""
        payload = {"Identificador": ref, "Chave": ref, "ModeloDocumento": int(model) if model.isdigit() else 65}
        return self._result(await self._request("POST", "/ConsultarNotaFiscal", json=payload))

    async def cancel(self, model: str, ref: str, reason: str) -> BrasilNfeResult:
        """Cancela nota autorizada."""
        payload = {
            "Identificador": ref,
            "Chave": ref,
            "ModeloDocumento": int(model) if model.isdigit() else 65,
            "Justificativa": reason,
        }
        return self._result(await self._request("POST", "/CancelarNotaFiscal", json=payload))

    async def ping(self, uf: str = "SC", tp_amb: int = 2) -> dict[str, Any]:
        """Testa credencial junto à Brasil NFe."""
        resp = await self._request("POST", "/ConsultarStatusSefaz", json={"Uf": uf, "TipoAmbiente": tp_amb})
        if resp.status_code in (401, 403):
            raise PermanentError("Brasil NFe: credencial recusada", status=resp.status_code)
        if resp.status_code == 429 or resp.status_code >= 500:
            raise TransientError(f"Brasil NFe {resp.status_code}", status=resp.status_code)
        return {"http_status": resp.status_code, "status": "online"}

    # --- NF-e recebidas (MDe) ---
    async def list_received(self, cnpj: str, version: int = 0) -> list[dict[str, Any]]:
        """Notas recebidas emitidas contra o CNPJ (MDe)."""
        payload = {"Cnpj": cnpj, "Tipo": "Entrada", "Versao": version, "versao": version}
        resp = await self._request("POST", "/ObterNotasFiscais", json=payload)
        self._check(resp)
        data = resp.json()
        items = (
            data
            if isinstance(data, list)
            else (data.get("notas") or data.get("Notas") or data.get("documentos") or data.get("nfes") or [])
        )
        return [n for n in (normalize_received(i) for i in items) if n]

    async def manifest(self, access_key: str, kind: str, reason: str | None = None) -> None:
        """Registra a manifestação do destinatário na SEFAZ."""
        payload: dict[str, Any] = {
            "Chave": access_key,
            "ChaveAcesso": access_key,
            "Tipo": MANIFEST_TO_PROVIDER.get(kind, kind),
        }
        if reason:
            payload["Justificativa"] = reason
        resp = await self._request("POST", "/ManifestarNotaFiscal", json=payload)
        self._check(resp)

    async def received_xml(self, access_key: str) -> str | None:
        """Baixa o XML autorizado da nota recebida."""
        payload = {"Chave": access_key, "ChaveAcesso": access_key, "TipoArquivo": 1, "Formato": "XML"}
        resp = await self._request("POST", "/ObterArquivoNotaFiscal", json=payload)
        if resp.status_code in (404, 412, 422):
            return None
        self._check(resp)
        # Se for XML direto no corpo da resposta
        text = resp.text.strip()
        if text.startswith("<") or text.startswith("<?xml"):
            return text

        # Se for JSON com XML em Base64 ou campo de texto
        try:
            data = resp.json()
            raw = (
                data.get("Arquivo")
                or data.get("Xml")
                or data.get("Conteudo")
                or data.get("arquivo")
                or data.get("xml")
                or data.get("conteudo")
            )
            if raw and isinstance(raw, str):
                raw_str = raw.strip()
                if raw_str.startswith("<"):
                    return raw_str
                try:
                    decoded = base64.b64decode(raw_str).decode("utf-8", errors="replace").strip()
                    if "<" in decoded:
                        return decoded
                except Exception:
                    return raw_str
        except ValueError:
            pass

        return None

    def _check(self, resp: httpx.Response) -> None:
        if resp.status_code >= 500 or resp.status_code == 429:
            raise TransientError(f"Brasil NFe {resp.status_code}", status=resp.status_code)
        if resp.status_code in (401, 403):
            raise PermanentError("Brasil NFe: credencial recusada", status=resp.status_code)
        if resp.status_code >= 400:
            try:
                data = resp.json()
                msg = data.get("mensagem") or data.get("Mensagem") or data.get("Motivo")
            except ValueError:
                msg = None
            raise PermanentError(f"Brasil NFe {resp.status_code}: {msg or resp.text[:120]}", status=resp.status_code)
