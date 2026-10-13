"""Cliente SOAP 1.2 dos webservices da SEFAZ (leiaute 4.00), autenticado com o certificado A1 (TLS mútuo).
Cada operação devolve o XML de retorno já interpretado; erro de rede vira TransientError com `delivered` dizendo se o pedido pode ter chegado."""
from __future__ import annotations

import base64
import gzip
import logging
import secrets
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

import httpx
from lxml import etree

from ..adapters.errors import PermanentError, TransientError
from . import endpoints, xmldsig
from .certificate import A1Certificate

log = logging.getLogger("centralops_worker.sefaz")

NFE = "http://www.portalfiscal.inf.br/nfe"
SOAP12 = "http://www.w3.org/2003/05/soap-envelope"
TZ = ZoneInfo("America/Sao_Paulo")
AUTHORIZED = {"100", "150"}
DENIED = {"110", "205", "301", "302", "303"}
EVENT_OK = {"135", "136", "155"}
MANIFEST = {"CIENCIA": ("210210", "Ciencia da Operacao"), "CONFIRMADA": ("210200", "Confirmacao da Operacao"),
            "DESCONHECIDA": ("210220", "Desconhecimento da Operacao"), "NAO_REALIZADA": ("210240", "Operacao nao Realizada")}


class SefazNetworkError(TransientError):
    """Falha de comunicação. delivered=False só quando a conexão nem abriu (o pedido certamente não chegou à SEFAZ)."""

    def __init__(self, message: str, *, delivered: bool, retry_after: int | None = None) -> None:
        super().__init__(message, retry_after=retry_after)
        self.delivered = delivered


def now_br() -> datetime:
    return datetime.now(TZ).replace(microsecond=0)


def _txt(el: etree._Element | None, tag: str) -> str | None:
    if el is None:
        return None
    found = el.find(f".//{{{NFE}}}{tag}")
    return found.text.strip() if found is not None and found.text else None


def _x(tag: str, value: Any = None, **attrs: str) -> etree._Element:
    el = etree.Element(f"{{{NFE}}}{tag}", nsmap={None: NFE}, **attrs)
    if value is not None:
        el.text = str(value)
    return el


def _sub(parent: etree._Element, tag: str, value: Any = None, **attrs: str) -> etree._Element:
    el = etree.SubElement(parent, f"{{{NFE}}}{tag}", **attrs)
    if value is not None:
        el.text = str(value)
    return el


def envelope(svc: endpoints.Service, body_xml: str) -> bytes:
    inner = f'<nfeDadosMsg xmlns="{svc.ns}">{body_xml}</nfeDadosMsg>'
    if svc.wrapper:
        inner = f'<{svc.wrapper} xmlns="{svc.ns}">{inner}</{svc.wrapper}>'
    return (f'<?xml version="1.0" encoding="utf-8"?><soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" '
            f'xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="{SOAP12}"><soap12:Body>{inner}</soap12:Body></soap12:Envelope>').encode()


def lote_id() -> str:
    return f"{secrets.randbelow(10**15):015d}"


@dataclass
class Protocol:
    cstat: str
    xmotivo: str
    access_key: str | None = None
    nprot: str | None = None
    dh_recbto: str | None = None
    xml: str | None = None           # <protNFe> ou <retEvento> para montar o arquivo de distribuição

    @property
    def authorized(self) -> bool:
        return self.cstat in AUTHORIZED

    @property
    def denied(self) -> bool:
        return self.cstat in DENIED


@dataclass
class AuthResult:
    cstat: str                       # do lote (104 processado, 103 recebido, ou rejeição do lote)
    xmotivo: str
    protocol: Protocol | None = None
    raw: str = ""


@dataclass
class ConsultResult:
    cstat: str
    xmotivo: str
    protocol: Protocol | None = None
    cancel: Protocol | None = None
    raw: str = ""


@dataclass
class DistResult:
    cstat: str
    xmotivo: str
    ult_nsu: int
    max_nsu: int
    docs: list[dict[str, Any]] = field(default_factory=list)


def _protocol(el: etree._Element | None) -> Protocol | None:
    if el is None:
        return None
    return Protocol(cstat=_txt(el, "cStat") or "", xmotivo=_txt(el, "xMotivo") or "", access_key=_txt(el, "chNFe"), nprot=_txt(el, "nProt"),
                    dh_recbto=_txt(el, "dhRecbto") or _txt(el, "dhRegEvento"), xml=etree.tostring(el, encoding="unicode"))


def nfe_proc(nfe_xml: str, prot_xml: str) -> str:
    """Arquivo de distribuição (nfeProc): a NF-e assinada + o protocolo de autorização."""
    return f'<?xml version="1.0" encoding="UTF-8"?><nfeProc xmlns="{NFE}" versao="4.00">{_strip_decl(nfe_xml)}{_strip_decl(prot_xml)}</nfeProc>'


def event_proc(event_xml: str, ret_xml: str) -> str:
    return f'<?xml version="1.0" encoding="UTF-8"?><procEventoNFe xmlns="{NFE}" versao="1.00">{_strip_decl(event_xml)}{_strip_decl(ret_xml)}</procEventoNFe>'


def _strip_decl(x: str) -> str:
    return x.split("?>", 1)[1] if x.lstrip().startswith("<?xml") else x


class SefazClient:
    def __init__(self, cert: A1Certificate, uf: str, tp_amb: int, *, timeout: float = 30.0, transport: httpx.AsyncBaseTransport | None = None) -> None:
        if tp_amb not in (1, 2):
            raise ValueError("tpAmb deve ser 1 (produção) ou 2 (homologação)")
        self.cert = cert
        self.uf = uf.upper()
        self.cuf = endpoints.CUF[self.uf]
        self.tp_amb = tp_amb
        self._timeout = timeout
        self._transport = transport
        self._http: httpx.AsyncClient | None = None

    async def __aenter__(self) -> SefazClient:
        if self._transport is not None:
            self._http = httpx.AsyncClient(transport=self._transport, timeout=self._timeout)
        else:
            self._http = httpx.AsyncClient(verify=self.cert.ssl_context(), timeout=httpx.Timeout(self._timeout, connect=10.0))
        return self

    async def __aexit__(self, *exc: object) -> None:
        if self._http is not None:
            await self._http.aclose()

    async def _call(self, svc: endpoints.Service, body: etree._Element | str) -> etree._Element:
        assert self._http is not None, "use `async with SefazClient(...)`"
        body_xml = body if isinstance(body, str) else etree.tostring(body, encoding="unicode")
        headers = {"Content-Type": f'application/soap+xml; charset=utf-8; action="{svc.ns}/{svc.method}"'}
        try:
            resp = await self._http.post(svc.url, content=envelope(svc, body_xml), headers=headers)
        except (httpx.ConnectError, httpx.ConnectTimeout) as e:
            raise SefazNetworkError(f"SEFAZ fora do ar ou inacessível ({type(e).__name__})", delivered=False) from e
        except httpx.TransportError as e:
            raise SefazNetworkError(f"SEFAZ não respondeu ({type(e).__name__})", delivered=True) from e
        if resp.status_code == 403:
            raise PermanentError("SEFAZ recusou o certificado (HTTP 403): confira se é um e-CNPJ A1 válido", status=403)
        if resp.status_code >= 500 and b"Envelope" not in resp.content[:400]:
            raise SefazNetworkError(f"SEFAZ com erro interno (HTTP {resp.status_code})", delivered=True, retry_after=60)
        try:
            root = etree.fromstring(resp.content)
        except etree.XMLSyntaxError as e:
            raise SefazNetworkError(f"Resposta ilegível da SEFAZ (HTTP {resp.status_code})", delivered=True) from e
        fault = root.find(f".//{{{SOAP12}}}Fault")
        if fault is not None:
            reason = " ".join(t.strip() for t in fault.itertext() if t.strip())[:300]
            raise SefazNetworkError(f"SEFAZ devolveu erro SOAP: {reason}", delivered=True, retry_after=60)
        body_el = root.find(f"{{{SOAP12}}}Body")
        if body_el is None or len(body_el) == 0:
            raise SefazNetworkError("Resposta da SEFAZ sem corpo", delivered=True)
        result = body_el[0]
        while len(result) == 1 and not result.tag.startswith(f"{{{NFE}}}"):   # nfeResultMsg / nfeDistDFeInteresseResponse / ...Result
            result = result[0]
        return result

    # ------------------------------------------------------------------ NFC-e
    async def status(self) -> tuple[str, str]:
        el = _x("consStatServ", versao="4.00")
        _sub(el, "tpAmb", self.tp_amb)
        _sub(el, "cUF", self.cuf)
        _sub(el, "xServ", "STATUS")
        ret = await self._call(endpoints.nfce_service(self.uf, self.tp_amb, "status"), el)
        return _txt(ret, "cStat") or "", _txt(ret, "xMotivo") or ""

    async def authorize(self, nfe_xml: str) -> AuthResult:
        """Envio síncrono (indSinc=1) de uma NFC-e: a resposta já traz o protocolo quando o lote é processado (cStat 104)."""
        body = f'<enviNFe xmlns="{NFE}" versao="4.00"><idLote>{lote_id()}</idLote><indSinc>1</indSinc>{_strip_decl(nfe_xml)}</enviNFe>'
        ret = await self._call(endpoints.nfce_service(self.uf, self.tp_amb, "autorizacao"), body)
        prot = ret.find(f".//{{{NFE}}}protNFe")
        return AuthResult(cstat=_txt(ret, "cStat") or "", xmotivo=_txt(ret, "xMotivo") or "", protocol=_protocol(prot),
                          raw=etree.tostring(ret, encoding="unicode"))

    async def consult(self, key: str) -> ConsultResult:
        el = _x("consSitNFe", versao="4.00")
        _sub(el, "tpAmb", self.tp_amb)
        _sub(el, "xServ", "CONSULTAR")
        _sub(el, "chNFe", key)
        ret = await self._call(endpoints.nfce_service(self.uf, self.tp_amb, "consulta"), el)
        cancel = None
        for ev in ret.findall(f".//{{{NFE}}}retEvento"):
            if _txt(ev, "tpEvento") == "110111" and _txt(ev, "cStat") in EVENT_OK:
                cancel = _protocol(ev)
        status_el = ret.find(f"{{{NFE}}}cStat")
        return ConsultResult(cstat=status_el.text.strip() if status_el is not None and status_el.text else "", xmotivo=(ret.findtext(f"{{{NFE}}}xMotivo") or "").strip(),
                             protocol=_protocol(ret.find(f".//{{{NFE}}}protNFe")), cancel=cancel, raw=etree.tostring(ret, encoding="unicode"))

    def _event(self, *, c_orgao: int, cnpj: str, key: str, tp_evento: str, seq: int, det: dict[str, str]) -> tuple[str, str]:
        ev = _x("evento", versao="1.00")
        ev_id = f"ID{tp_evento}{key}{seq:02d}"
        inf = _sub(ev, "infEvento", Id=ev_id)
        for tag, val in (("cOrgao", c_orgao), ("tpAmb", self.tp_amb), ("CNPJ", cnpj), ("chNFe", key), ("dhEvento", now_br().isoformat()),
                         ("tpEvento", tp_evento), ("nSeqEvento", seq), ("verEvento", "1.00")):
            _sub(inf, tag, val)
        d = _sub(inf, "detEvento", versao="1.00")
        for tag, val in det.items():
            _sub(d, tag, val)
        ev_xml = etree.tostring(xmldsig.sign(ev, ev_id, self.cert), encoding="unicode")
        return ev_xml, f'<envEvento xmlns="{NFE}" versao="1.00"><idLote>{lote_id()}</idLote>{ev_xml}</envEvento>'

    async def cancel(self, cnpj: str, key: str, nprot: str, reason: str) -> tuple[Protocol, str]:
        """Evento 110111. Devolve o retorno do evento e o procEventoNFe (arquivo para guardar)."""
        just = " ".join(reason.split())[:255]
        if len(just) < 15:
            raise PermanentError("Justificativa do cancelamento precisa de pelo menos 15 caracteres")
        ev_xml, body = self._event(c_orgao=self.cuf, cnpj=cnpj, key=key, tp_evento="110111", seq=1,
                                   det={"descEvento": "Cancelamento", "nProt": nprot, "xJust": just})
        ret = await self._call(endpoints.nfce_service(self.uf, self.tp_amb, "evento"), body)
        ev_ret = ret.find(f".//{{{NFE}}}retEvento")
        prot = _protocol(ev_ret) or Protocol(cstat=_txt(ret, "cStat") or "", xmotivo=_txt(ret, "xMotivo") or "")
        return prot, event_proc(ev_xml, prot.xml) if prot.xml else ""

    async def void_numbers(self, cnpj: str, series: int, first: int, last: int, reason: str, model: int = 65) -> Protocol:
        """Inutilização de numeração (faixa que nunca virou nota autorizada)."""
        just = " ".join(reason.split())[:255]
        if len(just) < 15:
            raise PermanentError("Justificativa da inutilização precisa de pelo menos 15 caracteres")
        year = now_br().strftime("%y")
        el = _x("inutNFe", versao="4.00")
        inut_id = f"ID{self.cuf:02d}{year}{cnpj}{model:02d}{series:03d}{first:09d}{last:09d}"
        inf = _sub(el, "infInut", Id=inut_id)
        for tag, val in (("tpAmb", self.tp_amb), ("xServ", "INUTILIZAR"), ("cUF", self.cuf), ("ano", year), ("CNPJ", cnpj), ("mod", model),
                         ("serie", series), ("nNFIni", first), ("nNFFin", last), ("xJust", just)):
            _sub(inf, tag, val)
        ret = await self._call(endpoints.nfce_service(self.uf, self.tp_amb, "inutilizacao"), xmldsig.sign(el, inut_id, self.cert))
        return _protocol(ret.find(f".//{{{NFE}}}infInut")) or Protocol(cstat=_txt(ret, "cStat") or "", xmotivo=_txt(ret, "xMotivo") or "")

    # ------------------------------------------------------------------ Notas recebidas (Ambiente Nacional)
    async def distribution(self, cnpj: str, *, ult_nsu: int | None = None, key: str | None = None) -> DistResult:
        el = _x("distDFeInt", versao="1.01")
        _sub(el, "tpAmb", self.tp_amb)
        _sub(el, "cUFAutor", self.cuf)
        _sub(el, "CNPJ", cnpj)
        if key:
            _sub(_sub(el, "consChNFe"), "chNFe", key)
        else:
            _sub(_sub(el, "distNSU"), "ultNSU", f"{int(ult_nsu or 0):015d}")
        ret = await self._call(endpoints.an_service(self.tp_amb, "distribuicao"), el)
        docs = []
        for dz in ret.findall(f".//{{{NFE}}}docZip"):
            try:
                xml = gzip.decompress(base64.b64decode((dz.text or "").strip())).decode("utf-8")
            except (OSError, ValueError) as e:
                log.warning("docZip ilegível (NSU %s): %s", dz.get("NSU"), e)
                continue
            docs.append({"nsu": int(dz.get("NSU") or 0), "schema": dz.get("schema") or "", "xml": xml})
        to_int = lambda v: int(v) if v and v.isdigit() else 0  # noqa: E731
        return DistResult(cstat=_txt(ret, "cStat") or "", xmotivo=_txt(ret, "xMotivo") or "", ult_nsu=to_int(_txt(ret, "ultNSU")),
                          max_nsu=to_int(_txt(ret, "maxNSU")), docs=docs)

    async def manifest(self, cnpj: str, key: str, kind: str, reason: str | None = None) -> Protocol:
        if kind not in MANIFEST:
            raise PermanentError(f"Manifestação desconhecida: {kind}")
        code, desc = MANIFEST[kind]
        det = {"descEvento": desc}
        if kind == "NAO_REALIZADA":
            just = " ".join((reason or "").split())[:255]
            if len(just) < 15:
                raise PermanentError("Operação não realizada pede justificativa de pelo menos 15 caracteres")
            det["xJust"] = just
        _, body = self._event(c_orgao=91, cnpj=cnpj, key=key, tp_evento=code, seq=1, det=det)
        ret = await self._call(endpoints.an_service(self.tp_amb, "evento"), body)
        return _protocol(ret.find(f".//{{{NFE}}}retEvento")) or Protocol(cstat=_txt(ret, "cStat") or "", xmotivo=_txt(ret, "xMotivo") or "")


def parse_dfe_doc(doc: dict[str, Any]) -> dict[str, Any] | None:
    """Resumo (resNFe) ou NF-e completa (procNFe) vindos da distribuição -> linha de fiscal.inbound_dfe. Eventos são ignorados."""
    schema = doc["schema"]
    try:
        root = etree.fromstring(doc["xml"].encode())
    except etree.XMLSyntaxError:
        return None
    if schema.startswith("resNFe"):
        return {"access_key": _txt(root, "chNFe"), "nsu": str(doc["nsu"]), "issuer_cnpj": _txt(root, "CNPJ") or _txt(root, "CPF"),
                "issuer_name": _txt(root, "xNome"), "amount": _txt(root, "vNF"), "issue_at": _txt(root, "dhEmi"), "xml": None,
                "cancelled": _txt(root, "cSitNFe") == "3"}
    if schema.startswith("procNFe"):
        inf = root.find(f".//{{{NFE}}}infNFe")
        emit = root.find(f".//{{{NFE}}}emit")
        key = _txt(root, "chNFe") or ((inf.get("Id") or "")[3:] if inf is not None else None)
        return {"access_key": key, "nsu": str(doc["nsu"]), "issuer_cnpj": _txt(emit, "CNPJ") or _txt(emit, "CPF"), "issuer_name": _txt(emit, "xNome"),
                "amount": _txt(root.find(f".//{{{NFE}}}ICMSTot"), "vNF"), "issue_at": _txt(root, "dhEmi"), "xml": doc["xml"], "cancelled": False}
    return None
