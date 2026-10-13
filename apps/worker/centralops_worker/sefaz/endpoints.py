"""Endereços oficiais dos webservices (leiaute 4.00).
NFC-e de SC: autorizada pela SVRS — FAQ "Webservice da NFC-e, URL do QR Code e da consulta em SC" (sef.sc.gov.br) e
dfe-portal.svrs.rs.gov.br/Nfce/Servicos. Distribuição de DF-e e eventos do destinatário: Ambiente Nacional (NT 2014.002)."""
from __future__ import annotations

from dataclasses import dataclass

from ..adapters.errors import PermanentError

CUF = {"RO": 11, "AC": 12, "AM": 13, "RR": 14, "PA": 15, "AP": 16, "TO": 17, "MA": 21, "PI": 22, "CE": 23, "RN": 24, "PB": 25, "PE": 26, "AL": 27,
       "SE": 28, "BA": 29, "MG": 31, "ES": 32, "RJ": 33, "SP": 35, "PR": 41, "SC": 42, "RS": 43, "MS": 50, "MT": 51, "GO": 52, "DF": 53}

WSDL = "http://www.portalfiscal.inf.br/nfe/wsdl"


@dataclass(frozen=True)
class Service:
    url: str
    ns: str          # namespace do nfeDadosMsg
    method: str      # operação SOAP (vai no action)
    wrapper: str | None = None   # elemento que envolve o nfeDadosMsg (só o NFeDistribuicaoDFe usa)


_SVRS_NFCE = {
    1: "https://nfce.svrs.rs.gov.br/ws",
    2: "https://nfce-homologacao.svrs.rs.gov.br/ws",
}
# UF -> (base por ambiente, URL do QR Code e da consulta pela chave por ambiente)
_NFCE_UF = {
    "SC": (_SVRS_NFCE, {1: "https://sat.sef.sc.gov.br/nfce/consulta", 2: "https://hom.sat.sef.sc.gov.br/nfce/consulta"}),
}


def nfce_supported(uf: str) -> bool:
    return uf.upper() in _NFCE_UF


def _nfce(uf: str, tp_amb: int) -> tuple[str, str]:
    try:
        bases, consulta = _NFCE_UF[uf.upper()]
    except KeyError:
        raise PermanentError(f"Emissão direta de NFC-e ainda não configurada para a UF {uf}: use um provedor (Notaas, Focus NFe ou Brasil NFe)") from None
    return bases[tp_amb], consulta[tp_amb]


def nfce_service(uf: str, tp_amb: int, name: str) -> Service:
    base, _ = _nfce(uf, tp_amb)
    paths = {
        "autorizacao": ("NfeAutorizacao/NFeAutorizacao4.asmx", "NFeAutorizacao4", "nfeAutorizacaoLote"),
        "ret_autorizacao": ("NfeRetAutorizacao/NFeRetAutorizacao4.asmx", "NFeRetAutorizacao4", "nfeRetAutorizacaoLote"),
        "inutilizacao": ("nfeinutilizacao/nfeinutilizacao4.asmx", "NFeInutilizacao4", "nfeInutilizacaoNF"),
        "consulta": ("NfeConsulta/NfeConsulta4.asmx", "NFeConsultaProtocolo4", "nfeConsultaNF"),
        "status": ("NfeStatusServico/NfeStatusServico4.asmx", "NFeStatusServico4", "nfeStatusServicoNF"),
        "evento": ("recepcaoevento/recepcaoevento4.asmx", "NFeRecepcaoEvento4", "nfeRecepcaoEvento"),
    }
    path, op, method = paths[name]
    return Service(f"{base}/{path}", f"{WSDL}/{op}", method)


def nfce_qr_base(uf: str, tp_amb: int) -> str:
    return _nfce(uf, tp_amb)[1]


def an_service(tp_amb: int, name: str) -> Service:
    if name == "distribuicao":
        url = {1: "https://www1.nfe.fazenda.gov.br", 2: "https://hom1.nfe.fazenda.gov.br"}[tp_amb] + "/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx"
        return Service(url, f"{WSDL}/NFeDistribuicaoDFe", "nfeDistDFeInteresse", wrapper="nfeDistDFeInteresse")
    if name == "evento":
        url = {1: "https://www.nfe.fazenda.gov.br", 2: "https://hom1.nfe.fazenda.gov.br"}[tp_amb] + "/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx"
        return Service(url, f"{WSDL}/NFeRecepcaoEvento4", "nfeRecepcaoEvento")
    raise ValueError(name)
