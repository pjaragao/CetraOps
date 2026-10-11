"""Cliente da API Notaas (NFC-e e NF-e).
Documentação oficial: https://docs.notaas.com.br/docs e https://docs.notaas.com.br/docs/nfe/endpoints.
Base URL: https://platform.notaas.com.br/api/v1
Autenticação: Header `x-api-key: ntaas_...`
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

import httpx

from .errors import PermanentError, TransientError

log = logging.getLogger("centralops_worker.notaas")

NOTAAS_PRODUCTION_BASE = "https://platform.notaas.com.br/api/v1"

STATUS_MAP = {
    "issued": "AUTHORIZED",
    "autorizado": "AUTHORIZED",
    "autorizada": "AUTHORIZED",
    "queued": "PROCESSING",
    "processing": "PROCESSING",
    "processando": "PROCESSING",
    "error": "REJECTED",
    "rejeitado": "REJECTED",
    "rejeitada": "REJECTED",
    "cancelled": "CANCELLED",
    "cancelado": "CANCELLED",
    "cancelada": "CANCELLED",
    "denied": "DENIED",
    "denegado": "DENIED",
}


@dataclass
class NotaasResult:
    status: str  # PROCESSING | AUTHORIZED | REJECTED | CANCELLED | DENIED
    number: int | None = None
    series: int | None = None
    access_key: str | None = None
    protocol: str | None = None
    xml_path: str | None = None
    danfe_path: str | None = None
    code: str | None = None
    message: str | None = None
    provider_ref: str | None = None
    qr_code: str | None = None
    raw: dict[str, Any] = field(default_factory=dict)


def _to_notaas_payload(model: int, ref: str, document: dict[str, Any]) -> dict[str, Any]:
    """Converte o payload interno do CetraOps para a especificação da API Notaas."""
    natureza = (
        document.get("naturezaOperacao")
        or document.get("natureza_operacao")
        or "VENDA AO CONSUMIDOR"
    )
    presenca = int(
        document.get("presencaComprador")
        or document.get("presenca_comprador")
        or 1
    )

    dest: dict[str, Any] | None = None
    if isinstance(document.get("dest"), dict):
        dest = document["dest"]
    else:
        cpf = "".join(c for c in str(document.get("cpf_destinatario") or "") if c.isdigit())
        cnpj = "".join(c for c in str(document.get("cnpj_destinatario") or "") if c.isdigit())
        nome = document.get("nome_destinatario") or document.get("nome")
        if cpf:
            dest = {"cpf": cpf, "nome": str(nome or "CONSUMIDOR")}
        elif cnpj:
            dest = {"cnpj": cnpj, "nome": str(nome or "EMPRESA")}
        elif model == 55:
            dest = {"nome": str(nome or "CONSUMIDOR")}

    raw_items = document.get("items") or document.get("itens") or []
    items: list[dict[str, Any]] = []
    for it in raw_items:
        codigo = str(it.get("codigo") or it.get("codigo_produto") or it.get("sku") or "ITEM")
        descricao = str(it.get("descricao") or it.get("xProd") or it.get("name") or "Produto")
        ncm = "".join(c for c in str(it.get("ncm") or it.get("codigo_ncm") or "") if c.isdigit())
        cfop = "".join(c for c in str(it.get("cfop") or "") if c.isdigit())
        if len(ncm) != 8 or len(cfop) != 4:
            raise PermanentError(f"Item «{descricao}» sem NCM (8 dígitos) ou CFOP (4 dígitos): a nota não é emitida com dado inventado")
        qty = float(it.get("quantidade") or it.get("quantidade_comercial") or it.get("qty") or 1)
        v_un = float(it.get("valorUnitario") or it.get("valor_unitario") or it.get("valor_unitario_comercial") or it.get("list_price") or 0)
        v_tot = float(it.get("valorTotal") or it.get("valor_total") or it.get("valor_bruto") or it.get("total") or 0)

        if v_tot <= 0 and v_un > 0:
            v_tot = round(v_un * qty, 2)
        if v_un <= 0 and qty > 0:
            v_un = round(v_tot / qty, 2)

        unidade = str(it.get("unidade") or it.get("unidade_comercial") or "UN")
        cst_csosn = str(it.get("csosn") or it.get("cst") or it.get("icms_situacao_tributaria") or "102").strip()
        desconto = float(it.get("desconto") or it.get("valor_desconto") or 0)

        item_dict: dict[str, Any] = {
            "codigo": codigo,
            "descricao": descricao,
            "ncm": ncm,
            "cfop": cfop,
            "quantidade": qty,
            "valorUnitario": v_un,
            "valorTotal": v_tot,
            "unidade": unidade,
        }
        if len(cst_csosn) <= 2:
            item_dict["cst"] = cst_csosn.zfill(2)
        else:
            item_dict["csosn"] = cst_csosn

        if desconto > 0:
            item_dict["desconto"] = desconto

        items.append(item_dict)

    if not items:
        raise PermanentError("Nota sem itens: nada a emitir")
    if any(i["valorTotal"] <= 0 or i["quantidade"] <= 0 for i in items):
        raise PermanentError("Item com valor ou quantidade zerada: confira o pedido")

    raw_pays = document.get("pagamentos") or document.get("formas_pagamento") or []
    pagamentos: list[dict[str, Any]] = []
    for p in raw_pays:
        t_pag = str(p.get("tipoPagamento") or p.get("forma_pagamento") or "01").zfill(2)
        v_pag = float(p.get("valor") or p.get("valor_pagamento") or p.get("amount") or 0)
        pagamentos.append({"tipoPagamento": t_pag, "valor": v_pag})

    if not pagamentos or sum(p["valor"] for p in pagamentos) <= 0:
        raise PermanentError("Nota sem forma de pagamento registrada: nada é presumido (registre o pagamento do pedido)")

    payload: dict[str, Any] = {
        "modelo": model,
        "naturezaOperacao": natureza,
        "presencaComprador": presenca,
        "items": items,
        "pagamentos": pagamentos,
    }
    if dest is not None:
        payload["dest"] = dest

    inf_cpl = document.get("infCpl") or document.get("informacoes_complementares")
    if inf_cpl:
        payload["infCpl"] = str(inf_cpl)

    return payload


def _parse(data: dict[str, Any]) -> NotaasResult:
    """Interpreta a resposta da Notaas (status de emissão, consulta ou evento de webhook)."""
    raw_status = str(data.get("status") or "").lower().strip()
    status = STATUS_MAP.get(raw_status, "PROCESSING")

    to_int = lambda v: int(v) if v not in (None, "") else None  # noqa: E731

    number = to_int(data.get("numero") or data.get("nNf"))
    series = to_int(data.get("serie"))
    raw_key = data.get("chaveAcesso") or data.get("chave_nfe") or ""
    access_key = str(raw_key).replace("NFe", "").strip() or None

    protocol = str(data.get("protocolo") or data.get("nProt") or "") or None
    code = str(data.get("codigoStatus") or data.get("cStat") or "") or None
    msg = str(data.get("motivo") or data.get("xMotivo") or data.get("errorMessage") or "") or None
    danfe = str(data.get("pdfUrl") or "") or None
    xml = str(data.get("xmlUrl") or "") or None
    inv_id = str(data.get("invoiceId") or data.get("id") or "") or None
    qr = str(data.get("qrCode") or "") or None

    return NotaasResult(
        status=status,
        number=number,
        series=series,
        access_key=access_key,
        protocol=protocol,
        xml_path=xml,
        danfe_path=danfe,
        code=code,
        message=msg,
        provider_ref=inv_id,
        qr_code=qr,
        raw=data,
    )


class NotaasClient:
    """Cliente HTTP assíncrono para a API Notaas."""

    def __init__(self, http: httpx.AsyncClient, base: str, token: str) -> None:
        self._http = http
        self._base = (base or NOTAAS_PRODUCTION_BASE).rstrip("/")
        self._token = token.strip()
        self._headers = {
            "x-api-key": self._token,
            "Content-Type": "application/json",
            "Accept": "application/json",
        }

    async def _request(self, method: str, path: str, **kw: Any) -> httpx.Response:
        headers = {**self._headers, **kw.pop("headers", {})}
        try:
            return await self._http.request(method, f"{self._base}{path}", headers=headers, timeout=45, **kw)
        except (httpx.TimeoutException, httpx.TransportError) as e:
            raise TransientError(f"Notaas rede: {e}") from e

    def _result(self, resp: httpx.Response) -> NotaasResult:
        if resp.status_code >= 500 or resp.status_code == 429:
            raise TransientError(f"Notaas {resp.status_code}", status=resp.status_code)

        try:
            data = resp.json()
        except ValueError:
            raise PermanentError(f"Notaas resposta inválida ({resp.status_code})", status=resp.status_code) from None

        if resp.status_code in (401, 403):
            raise PermanentError("Notaas: credencial recusada", status=resp.status_code)

        if resp.status_code == 202:
            # Emissão ou cancelamento enfileirado para processamento assíncrono SEFAZ
            inv_id = data.get("invoiceId") or data.get("id")
            return NotaasResult(status="PROCESSING", provider_ref=str(inv_id) if inv_id else None, raw=data)

        if resp.status_code == 422:
            code = data.get("code") or data.get("codigoStatus") or data.get("cStat")
            msg = data.get("message") or data.get("motivo") or data.get("xMotivo") or data.get("error")
            if "autorizada" in str(msg).lower():
                return _parse({**data, "status": "issued"})
            return NotaasResult(status="REJECTED", code=str(code) if code else None, message=str(msg) if msg else None, raw=data)

        if resp.status_code >= 400:
            code = data.get("code") or data.get("codigoStatus") or resp.status_code
            msg = data.get("message") or data.get("motivo") or data.get("error") or resp.text[:120]
            return NotaasResult(status="REJECTED", code=str(code), message=str(msg), raw=data)

        return _parse(data)

    async def emit_nfce(self, ref: str, document: dict[str, Any]) -> NotaasResult:
        """Envia NFC-e (modelo 65) para emissão assíncrona na SEFAZ via POST /nfe/emitir."""
        payload = _to_notaas_payload(65, ref, document)
        resp = await self._request("POST", "/nfe/emitir", json=payload)
        return self._result(resp)

    async def emit_nfe(self, ref: str, document: dict[str, Any]) -> NotaasResult:
        """Envia NF-e (modelo 55) para emissão assíncrona na SEFAZ via POST /nfe/emitir."""
        payload = _to_notaas_payload(55, ref, document)
        resp = await self._request("POST", "/nfe/emitir", json=payload)
        return self._result(resp)

    async def get(self, model: str, ref: str) -> NotaasResult:
        """Consulta status da nota fiscal (modelo 55 ou 65) via GET /nfe/invoices/{id}/status."""
        resp = await self._request("GET", f"/nfe/invoices/{ref}/status")
        return self._result(resp)

    async def cancel(self, model: str, ref: str, reason: str) -> NotaasResult:
        """Cancela nota autorizada via POST /nfe/cancelar."""
        # A SEFAZ e Notaas exigem motivo com mínimo de 15 caracteres
        clean_reason = reason.strip()
        if len(clean_reason) < 15:
            clean_reason = f"Cancelamento: {clean_reason}".ljust(15)
        clean_reason = clean_reason[:255]

        clean_ref = str(ref).replace("NFe", "").strip()
        body: dict[str, Any] = {"motivo": clean_reason}
        if len(clean_ref) == 44 and clean_ref.isdigit():
            body["chaveAcesso"] = clean_ref
        else:
            body["invoiceId"] = clean_ref

        resp = await self._request("POST", "/nfe/cancelar", json=body)
        res = self._result(resp)
        if resp.status_code == 202:
            # pedido aceito, a SEFAZ ainda vai responder: o worker consulta depois (nunca marca cancelada antes)
            return NotaasResult(status="PROCESSING", provider_ref=ref, message=res.message, raw=res.raw)
        if resp.status_code == 200 and res.status in ("CANCELLED", "PROCESSING"):
            return NotaasResult(status=res.status, provider_ref=ref, message=res.message, protocol=res.protocol, code=res.code, raw=res.raw)
        return res

    async def ping(self) -> dict[str, Any]:
        """Testa credencial junto à Notaas consultando /webhooks/endpoints."""
        resp = await self._request("GET", "/webhooks/endpoints")
        if resp.status_code in (401, 403):
            raise PermanentError("Notaas: credencial recusada", status=resp.status_code)
        if resp.status_code == 429 or resp.status_code >= 500:
            raise TransientError(f"Notaas {resp.status_code}", status=resp.status_code)
        return {"http_status": resp.status_code, "status": "online"}
