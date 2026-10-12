"""Cliente da Brasil NFe (NFC-e/NF-e e MDe), escrito a partir do SDK oficial (github.com/BrasilNFe/brasilnfe-php-sdk):
- endereço: https://api.brasilnfe.com.br/services/<Metodo>, sempre POST com JSON (nomes dos campos como no SDK, em camelCase);
- cabeçalhos: Token (obrigatório) e UserToken (opcional);
- o retorno de erro vem no campo `error` (e `avisos`).
A referência do sistema vai em `identificadorInterno`; depois de autorizada, a nota é tratada pela chave de acesso.
"""
from __future__ import annotations

import base64
import json
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx

from .errors import PermanentError, TransientError

BRASIL_NFE_PRODUCTION_BASE = "https://api.brasilnfe.com.br/services"

# manifestação: situação nossa → tipoManifestacao do SDK
MANIFEST_TO_PROVIDER = {"CONFIRMADA": 1, "CIENCIA": 2, "DESCONHECIDA": 3, "NAO_REALIZADA": 4}
AUTHORIZED_CODES = {100, 150}
PROCESSING_CODES = {103, 104, 105}
DENIED_CODES = {110, 205, 301, 302, 303}
CANCELLED_CODES = {101, 135, 151, 155}


def normalize_base(base: str | None) -> str:
    """Aceita o endereço com ou sem /services (configurações antigas não tinham)."""
    b = (base or BRASIL_NFE_PRODUCTION_BASE).strip().rstrip("/")
    return b if b.endswith("/services") else f"{b}/services"


def _ci(data: Any) -> dict[str, Any]:
    """Dicionário com chaves em minúsculas (a API pode responder em PascalCase ou camelCase)."""
    return {str(k).lower(): v for k, v in data.items()} if isinstance(data, dict) else {}


def _digits(v: Any) -> str:
    return "".join(c for c in str(v or "") if c.isdigit())


def normalize_received(item: dict[str, Any]) -> dict[str, Any] | None:
    """Uma nota recebida (BuscarNotaFiscalRetornoInfo) → o que o banco guarda."""
    d = _ci(item)
    key = _digits(d.get("chave"))
    if len(key) != 44:
        return None
    amount = d.get("valor")
    return {
        "access_key": key,
        "nsu": None,                                                    # a Brasil NFe busca por período, não por NSU
        "issuer_cnpj": _digits(d.get("cnpjemissor")) or None,
        "issuer_name": d.get("nomeemissor"),
        "amount": float(amount) if amount not in (None, "") else None,
        "issue_at": d.get("dtemissao"),
        "manifest_status": "PENDING",
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
    provider_ref: str | None = None
    raw: dict[str, Any] = field(default_factory=dict)


def _status_from_code(code: int | None, ok: bool | None, error: str | None) -> str:
    if code in AUTHORIZED_CODES or (ok and code is None and not error):
        return "AUTHORIZED"
    if code in PROCESSING_CODES:
        return "PROCESSING"
    if code in DENIED_CODES:
        return "DENIED"
    if code in CANCELLED_CODES:
        return "CANCELLED"
    return "REJECTED"


def _to_int(v: Any) -> int | None:
    try:
        return int(v) if v not in (None, "") else None
    except (TypeError, ValueError):
        return None


def parse_emission(data: Any) -> BrasilNfeResult:
    """NotaFiscalRetorno → resultado."""
    d = _ci(data)
    info = _ci(d.get("returnnf"))
    error = str(d.get("error") or "").strip() or None
    avisos = d.get("avisos") or []
    code = _to_int(info.get("codstatusrespostasefaz"))
    status = _status_from_code(code, info.get("ok"), error)
    key = _digits(info.get("chavenf")) or None
    msg = info.get("dsstatusrespostasefaz") or error or ("; ".join(map(str, avisos)) if avisos else None)
    return BrasilNfeResult(status=status, number=_to_int(info.get("numero")), series=_to_int(info.get("serie")), access_key=key,
                           protocol=str(info.get("numeroprotocolo") or "") or None, code=str(code) if code is not None else None,
                           message=str(msg) if msg else None, provider_ref=key, raw={k: v for k, v in d.items() if k not in ("base64xml", "base64file")})


def to_brasilnfe_payload(model: int, ref: str, document: dict[str, Any], tp_amb: int) -> dict[str, Any]:
    """Documento interno do CentralOps (formato do fiscal.emission_payload) → NotaFiscalEnvio do SDK. Nada é inventado: sem NCM/CFOP, erro."""
    produtos: list[dict[str, Any]] = []
    for it in document.get("itens") or document.get("items") or []:
        desc = str(it.get("descricao") or "Produto")
        ncm, cfop = _digits(it.get("codigo_ncm") or it.get("ncm")), _digits(it.get("cfop"))
        if len(ncm) != 8 or len(cfop) != 4:
            raise PermanentError(f"Item «{desc}» sem NCM (8 dígitos) ou CFOP (4 dígitos): a nota não é emitida com dado inventado")
        qty = float(it.get("quantidade_comercial") or it.get("quantidade") or 0)
        unit = float(it.get("valor_unitario_comercial") or it.get("valor_unitario") or 0)
        gross = float(it.get("valor_bruto") or round(unit * qty, 2))
        if qty <= 0 or gross <= 0:
            raise PermanentError("Item com valor ou quantidade zerada: confira o pedido")
        produtos.append({
            "nmProduto": desc[:120], "codProdutoServico": str(it.get("codigo_produto") or "ITEM")[:60], "ncm": ncm, "cfop": int(cfop),
            "quantidade": qty, "unidadeComercial": str(it.get("unidade_comercial") or "UN"), "valorUnitario": unit, "valorTotal": gross,
            "valorDesconto": float(it.get("valor_desconto") or 0), "origemProduto": int(it.get("icms_origem") or 0),
            "imposto": {
                "icms": {"codSituacaoTributaria": str(it.get("icms_situacao_tributaria") or "102")},
                "pis": {"codSituacaoTributaria": str(it.get("pis_situacao_tributaria") or "49")},
                "cofins": {"codSituacaoTributaria": str(it.get("cofins_situacao_tributaria") or "49")},
            },
        })
    if not produtos:
        raise PermanentError("Nota sem itens: nada a emitir")
    pagamentos = [{"indicadorPagamento": 0, "formaPagamento": str(p.get("forma_pagamento") or "").zfill(2), "vlPago": float(p.get("valor_pagamento") or 0)}
                  for p in document.get("formas_pagamento") or [] if float(p.get("valor_pagamento") or 0) > 0]
    if not pagamentos:
        raise PermanentError("Nota sem forma de pagamento registrada: nada é presumido (registre o pagamento do pedido)")
    payload: dict[str, Any] = {
        "modeloDocumento": model, "tipoAmbiente": tp_amb, "finalidade": int(document.get("finalidade_emissao") or 1),
        "naturezaOperacao": str(document.get("natureza_operacao") or "VENDA AO CONSUMIDOR"),
        "indicadorPresenca": int(document.get("presenca_comprador") or 1), "consumidorFinal": True,
        "identificadorInterno": ref, "produtos": produtos, "pagamentos": pagamentos,
        "transporte": {"modalidadeFrete": int(document.get("modalidade_frete") if document.get("modalidade_frete") is not None else 9)},
    }
    cpf = _digits(document.get("cpf_destinatario"))
    cnpj = _digits(document.get("cnpj_destinatario"))
    if cpf or cnpj:
        payload["cliente"] = {"cpfCnpj": cpf or cnpj, "nmCliente": document.get("nome_destinatario") or None, "indicadorIe": 9}
    if document.get("informacoes_complementares"):
        payload["observacao"] = str(document["informacoes_complementares"])
    return payload


class BrasilNfeClient:
    def __init__(self, http: httpx.AsyncClient, base: str, token: str, user_token: str | None = None, tp_amb: int = 2) -> None:
        self._http, self._base = http, normalize_base(base)
        self._tp_amb = 1 if tp_amb == 1 else 2                       # 1 = produção, 2 = homologação (padrão seguro: testes)
        self._headers = {"Token": token.strip(), "Content-Type": "application/json", "Accept": "application/json"}
        if user_token and user_token.strip():
            self._headers["UserToken"] = user_token.strip()

    async def _post(self, method: str, body: dict[str, Any]) -> httpx.Response:
        try:
            resp = await self._http.post(f"{self._base}/{method}", headers=self._headers, content=json.dumps(body, default=str), timeout=60)
        except (httpx.TimeoutException, httpx.TransportError) as e:
            raise TransientError(f"rede: {e}") from e
        if resp.status_code >= 500 or resp.status_code == 429:
            raise TransientError(f"Brasil NFe {resp.status_code}", status=resp.status_code)
        if resp.status_code in (401, 403):
            raise PermanentError("Brasil NFe: credencial recusada (confira o Token)", status=resp.status_code)
        if resp.status_code == 404:
            raise PermanentError(f"Brasil NFe: serviço {method} não encontrado (confira o endereço da API)", status=404)
        return resp

    @staticmethod
    def _json(resp: httpx.Response) -> Any:
        try:
            return resp.json()
        except ValueError:
            raise PermanentError(f"Brasil NFe: resposta inválida ({resp.status_code})", status=resp.status_code) from None

    def _raise_error(self, resp: httpx.Response, data: Any) -> None:
        err = str(_ci(data).get("error") or "").strip()
        if resp.status_code >= 400 or err:
            raise PermanentError(f"Brasil NFe: {err or resp.text[:160]}", status=resp.status_code)

    async def _emit(self, model: int, ref: str, document: dict[str, Any]) -> BrasilNfeResult:
        resp = await self._post("EnviarNotaFiscal", to_brasilnfe_payload(model, ref, document, self._tp_amb))
        data = self._json(resp)
        r = parse_emission(data)
        if resp.status_code >= 400 and r.status == "AUTHORIZED":
            r.status = "REJECTED"
        return r

    async def emit_nfce(self, ref: str, document: dict[str, Any]) -> BrasilNfeResult:
        return await self._emit(65, ref, document)

    async def emit_nfe(self, ref: str, document: dict[str, Any]) -> BrasilNfeResult:
        return await self._emit(55, ref, document)

    async def _search(self, kind: int, days: int, ref: str | None = None) -> list[dict[str, Any]]:
        now = datetime.now(UTC)
        body: dict[str, Any] = {"tipoDocumentoFiscal": kind, "dtInicio": (now - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%S"),
                                "dtFim": (now + timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%S")}
        if ref:
            body["indentificadorInterno"] = ref                     # grafia do SDK
            body["identificadorInterno"] = ref
        resp = await self._post("ObterNotasFiscais", body)
        data = self._json(resp)
        self._raise_error(resp, data)
        notas = _ci(data).get("notas") if isinstance(data, dict) else data
        return [n for n in (notas or []) if isinstance(n, dict)]

    async def get(self, model: str, ref: str) -> BrasilNfeResult:
        """Situação de uma nota emitida: procura pela referência (ou pela chave) nas saídas dos últimos 10 dias."""
        for n in await self._search(1, 10, None if len(_digits(ref)) == 44 else ref):
            d = _ci(n)
            key = _digits(d.get("chave"))
            if d.get("identificadorinterno") == ref or key == _digits(ref):
                st = {1: "AUTHORIZED", 2: "CANCELLED", 3: "DENIED"}.get(_to_int(d.get("status")) or 1, "AUTHORIZED")
                return BrasilNfeResult(status=st, number=_to_int(d.get("numero")), access_key=key or None,
                                       protocol=str(d.get("numeroprotocolo") or "") or None, provider_ref=key or None, raw=d)
        return BrasilNfeResult(status="PROCESSING", message="nota ainda não aparece na consulta")

    async def cancel(self, model: str, ref: str, reason: str) -> BrasilNfeResult:
        key = _digits(ref)
        if len(key) != 44:
            found = await self.get(model, ref)
            key = found.access_key or ""
        if len(key) != 44:
            raise PermanentError("Brasil NFe: chave de acesso da nota não encontrada para cancelar")
        resp = await self._post("CancelarNotaFiscal", {"chaveNF": key, "justificativa": reason, "tipoAmbiente": self._tp_amb, "tipoDocumento": 0})
        data = self._json(resp)
        d = _ci(data)
        err = str(d.get("error") or "").strip()
        code, st = _to_int(d.get("codstatusrespostasefaz")), _to_int(d.get("status"))
        if st == 2:
            return BrasilNfeResult(status="PROCESSING", access_key=key, provider_ref=key, raw=d)
        if not err and (code in CANCELLED_CODES or (st == 1 and code is None)):
            return BrasilNfeResult(status="CANCELLED", access_key=key, protocol=str(d.get("nuprotocolo") or "") or None, code=str(code) if code else None, raw=d)
        return BrasilNfeResult(status="REJECTED", access_key=key, code=str(code) if code else None, message=err or str(d.get("dsmotivo") or "cancelamento recusado"), raw=d)

    async def ping(self, uf: str = "SC", tp_amb: int = 2) -> dict[str, Any]:
        """Confere a credencial consultando o status da SEFAZ."""
        resp = await self._post("ConsultarStatusSefaz", {"uf": uf, "tipoAmbiente": tp_amb, "modeloDocumento": 65})
        return {"http_status": resp.status_code, "status": "online"}

    # --- NF-e recebidas (MDe) ---
    async def list_received(self, cnpj: str, version: int = 0) -> list[dict[str, Any]]:
        """Notas de entrada dos últimos 30 dias (a API busca por período; o banco ignora as já gravadas)."""
        return [n for n in (normalize_received(i) for i in await self._search(0, 30)) if n]

    async def manifest(self, access_key: str, kind: str, reason: str | None = None) -> None:
        if kind not in MANIFEST_TO_PROVIDER:
            raise PermanentError(f"Manifestação desconhecida: {kind}")
        body: dict[str, Any] = {"chave": access_key, "tipoAmbiente": self._tp_amb, "tipoManifestacao": MANIFEST_TO_PROVIDER[kind]}
        if reason:
            body["justificativa"] = reason
        resp = await self._post("ManifestarNotaFiscal", body)
        data = self._json(resp)
        self._raise_error(resp, data)
        if _to_int(_ci(data).get("status")) == 3:
            raise PermanentError(f"Brasil NFe: manifestação recusada — {_ci(data).get('dsmotivo') or 'erro no evento'}")

    async def received_xml(self, access_key: str) -> str | None:
        """XML da nota recebida (o serviço devolve o arquivo em base64)."""
        try:
            resp = await self._post("ObterArquivoNotaFiscal", {"chaveNF": access_key, "chaves": [access_key], "fileType": 1, "tipoDocumentoFiscal": 0})
        except PermanentError as e:
            if e.status == 404:
                return None
            raise
        if resp.status_code in (400, 412, 422):
            return None
        text = resp.text.strip()
        if text.startswith("<"):
            return text
        try:
            raw = json.loads(text)
        except ValueError:
            raw = text
        if isinstance(raw, dict):
            raw = _ci(raw).get("base64file") or _ci(raw).get("arquivo") or _ci(raw).get("xml")
        if not isinstance(raw, str) or not raw.strip():
            return None
        raw = raw.strip()
        if raw.startswith("<"):
            return raw
        try:
            decoded = base64.b64decode(raw).decode("utf-8", errors="replace").strip()
        except (ValueError, TypeError):
            return None
        return decoded if decoded.startswith("<") else None
