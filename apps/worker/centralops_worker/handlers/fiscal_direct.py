"""Emissão direta na SEFAZ (provedor SEFAZ na tela de Integrações): NFC-e, cancelamento, inutilização, notas recebidas e teste da conexão.
Regras de segurança da reserva (APIs pagas):
  • a nota só vai para a API quando é CERTO que o pedido não chegou à SEFAZ (conexão recusada) ou a SEFAZ está paralisada (108/109),
    ou quando a emissão direta não está utilizável (certificado vencido, cadastro incompleto). O número reservado volta para a fila;
  • resposta perdida depois do envio (timeout) nunca muda de caminho: a próxima tentativa consulta a chave na SEFAZ antes de reenviar,
    para não existir duas notas da mesma venda."""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal, InvalidOperation
from typing import Any

from ..adapters.errors import PermanentError as ProviderPermanent
from ..db import call_fn, fetch_all, fetch_one
from ..deps import Deps
from ..runner import PermanentError, RetryLater
from ..sefaz import endpoints
from ..sefaz.certificate import A1Certificate
from ..sefaz.client import EVENT_OK, Protocol, SefazClient, SefazNetworkError, nfe_proc, now_br, parse_dfe_doc
from ..sefaz.nfce import Emitter, RespTec, TaxApprox, build_nfce, new_cnf

log = logging.getLogger("centralops_worker.fiscal_direct")

PRODUCTION = ("producao", "production")
PARALYZED = {"108", "109"}
DFE_WAIT = timedelta(hours=1)               # NT 2014.002: sem documento novo (137) ou ultNSU = maxNSU, nova consulta só depois de 1 hora
DFE_MAX_PAGES = 20


class DirectConfigError(ProviderPermanent):
    """A emissão direta não está utilizável (certificado, senha, cadastro do emitente): a nota pode ir pela API reserva."""


@dataclass
class DirectCtx:
    conn_id: str
    entity_id: str
    cert: A1Certificate
    emitter: Emitter
    resp_tec: RespTec
    tp_amb: int
    series: int
    min_next: int
    csc_id: str | None
    csc_token: str | None
    taxes: TaxApprox | None = None

    def client(self, tp_amb: int | None = None) -> SefazClient:
        return SefazClient(self.cert, self.emitter.uf, tp_amb or self.tp_amb)


async def connection(deps: Deps, org_id: str) -> dict[str, Any] | None:
    return await fetch_one(deps.pool, """select id, provider, config from core.integration_connections
                                         where org_id = %s and provider = 'SEFAZ' and status <> 'DISABLED' and secret_ref is not null
                                         order by created_at limit 1""", (org_id,))


def _pct(v: Any) -> Decimal:
    try:
        d = Decimal(str(v or "0").replace(",", ".").replace("%", "").strip() or "0")
    except InvalidOperation:
        return Decimal(0)
    return d if Decimal(0) <= d <= Decimal(100) else Decimal(0)


def _int(v: Any, default: int) -> int:
    try:
        return int(str(v).strip())
    except (TypeError, ValueError):
        return default


async def context(deps: Deps, conn: dict[str, Any], org_id: str, entity_id: str | None = None) -> DirectCtx:
    cfg = conn["config"] or {}
    secret = await deps.secret(str(conn["id"]))
    pfx = secret.get("certificate_pfx")
    if not pfx:
        raise DirectConfigError("SEFAZ direta sem o certificado A1: envie o arquivo .pfx em Configurações › Integrações")
    try:
        cert = A1Certificate.from_pfx(pfx, str(secret.get("certificate_password") or ""))
    except ProviderPermanent as e:
        raise DirectConfigError(str(e)) from e
    le = await fetch_one(deps.pool, """select id, cnpj, razao_social, nome_fantasia, ie, crt, address, nfce_series from core.legal_entities
                                       where org_id = %s and (%s::uuid is null or id = %s::uuid) and status = 'ACTIVE'
                                       order by (kind = 'OPERATING') desc, created_at limit 1""", (org_id, entity_id, entity_id))
    if le is None:
        raise DirectConfigError("Nenhuma empresa ativa cadastrada para emitir a nota")
    try:
        cert.ensure_valid(le["cnpj"])
    except ProviderPermanent as e:
        raise DirectConfigError(str(e)) from e
    addr = le["address"] or {}
    emitter = Emitter(cnpj=le["cnpj"], razao_social=le["razao_social"] or "", fantasia=le["nome_fantasia"] or "", ie=str(cfg.get("ie") or le["ie"] or ""),
                      crt=int(le["crt"] or 1), street=str(addr.get("street") or ""), number=str(addr.get("number") or ""),
                      complement=str(addr.get("complement") or ""), district=str(addr.get("district") or ""), city=str(addr.get("city") or ""),
                      cmun=str(cfg.get("cmun") or addr.get("ibge") or ""), uf=str(cfg.get("uf") or addr.get("uf") or "").upper(),
                      cep=str(addr.get("cep") or ""), phone=str(cfg.get("phone") or ""))
    try:
        emitter.check()
        endpoints.nfce_qr_base(emitter.uf, 2)
    except ProviderPermanent as e:
        raise DirectConfigError(str(e)) from e
    env = str(cfg.get("environment") or "homologacao").lower()
    return DirectCtx(conn_id=str(conn["id"]), entity_id=str(le["id"]), cert=cert, emitter=emitter,
                     resp_tec=RespTec(cnpj=str(cfg.get("resp_cnpj") or le["cnpj"]), contato=str(cfg.get("resp_contato") or ""),
                                      email=str(cfg.get("resp_email") or ""), fone=str(cfg.get("resp_fone") or cfg.get("phone") or "")),
                     tp_amb=1 if env in PRODUCTION else 2, series=_int(cfg.get("nfce_series") or le["nfce_series"], 1),
                     min_next=_int(cfg.get("nfce_last_number"), 0) + 1, csc_id=str(cfg.get("csc_id") or "").strip() or None,
                     csc_token=str(secret.get("csc_token") or "").strip() or None,
                     taxes=TaxApprox(federal=_pct(cfg.get("trib_federal_pct")), estadual=_pct(cfg.get("trib_estadual_pct")),
                                     municipal=_pct(cfg.get("trib_municipal_pct")), fonte=str(cfg.get("trib_fonte") or "IBPT")))


# ---------------------------------------------------------------------- emissão
async def _record(deps: Deps, **p: Any) -> str:
    return str(await call_fn(deps.pool, "fiscal.record_emission", {"model": "65", "provider": "SEFAZ", **p}))


async def _authorized(deps: Deps, base: dict[str, Any], doc_id: str, nfe_xml: str, prot: Protocol, danfe: dict[str, Any]) -> None:
    await _record(deps, **base, status="AUTHORIZED", protocol=prot.nprot, sefaz_code=prot.cstat, sefaz_msg=prot.xmotivo, xml=nfe_proc(nfe_xml, prot.xml or ""),
                  danfe_path=f"/imprimir/nfce/{doc_id}", totals={"danfe": {**danfe, "protocol": prot.nprot, "dh_recbto": prot.dh_recbto}})


async def emit(deps: Deps, conn: dict[str, Any], doc: dict[str, Any], org_id: str, order_id: str, *, has_fallback: bool) -> bool:
    """Emite a NFC-e direto na SEFAZ. True = resolvido (autorizada, rejeitada ou aguardando); False = não chegou à SEFAZ e a API reserva deve emitir."""
    ref = doc["ref"]
    existing = await fetch_one(deps.pool, """select id, status, provider, number, series, access_key, xml, totals from fiscal.documents
                                             where idempotency_key = %s and org_id = %s""", (ref, org_id))
    if existing and existing["status"] == "AUTHORIZED":
        return True
    if existing and existing["status"] == "PROCESSING" and existing["provider"] not in (None, "SEFAZ"):
        return False                                                          # já está com a API reserva: ela acompanha
    ctx = await context(deps, conn, org_id, doc.get("legal_entity_id"))
    base = {"ref": ref, "order_id": order_id}
    mine = existing if existing and existing["provider"] == "SEFAZ" else None

    async with ctx.client() as client:
        # 1) tentativa anterior sem resposta: a SEFAZ diz se a nota existe antes de qualquer reenvio
        if mine and mine["status"] == "PROCESSING" and mine["access_key"]:
            try:
                res = await client.consult(mine["access_key"])
            except SefazNetworkError as e:
                raise RetryLater(int(e.retry_after or 60), str(e)) from e
            if res.protocol and res.protocol.authorized:
                await _authorized(deps, base, str(mine["id"]), _nfe_only(mine["xml"]), res.protocol, (mine["totals"] or {}).get("danfe") or {})
                return True
            if res.protocol and res.protocol.denied:
                await _record(deps, **base, status="DENIED", sefaz_code=res.protocol.cstat, sefaz_msg=res.protocol.xmotivo)
                await _notify_rejected(deps, org_id, doc, order_id, res.protocol.cstat, res.protocol.xmotivo, denied=True)
                return True
            if res.cstat != "217":                                            # 217 = não consta: pode reenviar com o mesmo número
                raise RetryLater(120, f"consulta da NFC-e: {res.cstat} {res.xmotivo}")

        # 2) número: o da tentativa rejeitada/sem resposta (não foi usado na SEFAZ) ou um novo
        if mine and mine["number"] and mine["series"] == ctx.series and mine["status"] in ("PROCESSING", "REJECTED"):
            number = int(mine["number"])
            cnf = int(mine["access_key"][35:43]) if mine["access_key"] else new_cnf(number)
        else:
            number = int(await call_fn(deps.pool, "fiscal.reserve_fiscal_number", ctx.entity_id, "65", ctx.series, ctx.tp_amb, ctx.min_next))
            cnf = new_cnf(number)
        try:
            build = build_nfce(doc["document"], ctx.emitter, tp_amb=ctx.tp_amb, series=ctx.series, number=number, cnf=cnf, dh_emi=now_br(), cert=ctx.cert,
                               resp_tec=ctx.resp_tec, csc_id=ctx.csc_id, csc_token=ctx.csc_token, inf_cpl=f"Pedido {doc.get('order_number')}",
                               taxes=ctx.taxes)
        except ProviderPermanent as e:
            if not mine:
                await call_fn(deps.pool, "fiscal.release_fiscal_number", ctx.entity_id, "65", ctx.series, ctx.tp_amb, number)
            await deps.notify(org_id, "FISCAL_REJECTED", f"NFC-e do pedido {doc.get('order_number')} não emitida: {e}", {"order_id": order_id}, perm="fiscal.write")
            raise PermanentError(str(e)) from e
        doc_id = await _record(deps, **base, status="PROCESSING", series=ctx.series, number=number, access_key=build.access_key, provider_ref=build.access_key,
                               xml=build.xml, totals={"danfe": build.danfe}, event={"type": "SEFAZ_SENT", "number": number, "at": now_br().isoformat()})

        # 3) envio síncrono
        try:
            res = await client.authorize(build.xml)
        except SefazNetworkError as e:
            if not e.delivered and has_fallback:
                await call_fn(deps.pool, "fiscal.reset_direct_attempt", doc_id, str(e))
                return False
            raise RetryLater(int(e.retry_after or 30), str(e)) from e
        except ProviderPermanent as e:                                         # 403: certificado recusado no TLS
            if has_fallback:
                await call_fn(deps.pool, "fiscal.reset_direct_attempt", doc_id, str(e))
                await deps.notify(org_id, "INTEGRATION_ERROR", f"SEFAZ direta: {e}. A nota seguiu pela API reserva.", {"order_id": order_id}, perm="fiscal.write")
                return False
            raise

    prot = res.protocol
    if res.cstat == "104" and prot is not None:
        if prot.authorized:
            await _authorized(deps, base, doc_id, build.xml, prot, build.danfe)
            return True
        if prot.cstat == "204":                                               # duplicidade: a nota desta chave já existe — consulta e grava
            raise RetryLater(5, "duplicidade de NF-e: consultando a autorização")
        if prot.cstat == "539":                                               # número já usado por outra chave (ex.: emitido fora do sistema)
            await call_fn(deps.pool, "fiscal.discard_direct_number", doc_id, f"{prot.cstat} {prot.xmotivo}")
            raise RetryLater(5, "número da NFC-e já usado na SEFAZ: emitindo com o próximo")
        status = "DENIED" if prot.denied else "REJECTED"
        await _record(deps, **base, status=status, sefaz_code=prot.cstat, sefaz_msg=prot.xmotivo)
        await _notify_rejected(deps, org_id, doc, order_id, prot.cstat, prot.xmotivo, denied=prot.denied)
        return True
    if res.cstat == "103":                                                    # lote assíncrono: o resultado sai na consulta pela chave
        raise RetryLater(10, "NFC-e recebida pela SEFAZ, aguardando o processamento")
    if res.cstat in PARALYZED and has_fallback:
        await call_fn(deps.pool, "fiscal.reset_direct_attempt", doc_id, f"SEFAZ {res.cstat} {res.xmotivo}")
        return False
    if res.cstat in PARALYZED or res.cstat == "656":
        raise RetryLater(900 if res.cstat == "656" else 300, f"SEFAZ {res.cstat} {res.xmotivo}")
    await _record(deps, **base, status="REJECTED", sefaz_code=res.cstat, sefaz_msg=res.xmotivo)
    await _notify_rejected(deps, org_id, doc, order_id, res.cstat, res.xmotivo, denied=False)
    return True


def _nfe_only(xml: str | None) -> str:
    """XML guardado durante o processamento é a NFe assinada; se já for nfeProc, recorta a NFe."""
    x = xml or ""
    i, j = x.find("<NFe"), x.rfind("</NFe>")
    return x[i:j + 6] if i >= 0 and j > i else x


async def _notify_rejected(deps: Deps, org_id: str, doc: dict[str, Any], order_id: str, code: str, msg: str, *, denied: bool) -> None:
    what = "denegada" if denied else "rejeitada"
    await deps.notify(org_id, "FISCAL_REJECTED", f"NFC-e do pedido {doc.get('order_number')} {what} pela SEFAZ: {code} {msg}",
                      {"order_id": order_id, "code": code, "message": msg}, perm="fiscal.write")


# ---------------------------------------------------------------------- cancelamento e inutilização
def _doc_tp_amb(xml: str | None, default: int) -> int:
    i = (xml or "").find("<tpAmb>")
    return int(xml[i + 7]) if i >= 0 and xml[i + 7] in "12" else default    # type: ignore[index]


async def cancel(deps: Deps, conn: dict[str, Any], d: dict[str, Any], org_id: str, reason: str) -> None:
    ctx = await context(deps, conn, org_id, str(d["legal_entity_id"]))
    if not d["protocol"] or not d["access_key"]:
        raise PermanentError("Nota sem protocolo/chave: não há o que cancelar na SEFAZ")
    async with ctx.client(_doc_tp_amb(d["xml"], ctx.tp_amb)) as client:
        try:
            prot, proc = await client.cancel(ctx.emitter.cnpj, d["access_key"], d["protocol"], reason)
        except SefazNetworkError as e:
            raise RetryLater(int(e.retry_after or 60), str(e)) from e
        if prot.cstat == "573":                                                # evento já registrado: confirma pela consulta
            res = await client.consult(d["access_key"])
            if res.cancel is not None:
                prot, proc = res.cancel, ""
    if prot.cstat in EVENT_OK or prot.cstat == "573":
        await call_fn(deps.pool, "fiscal.record_cancellation", d["id"], {"protocol": prot.nprot, "sefaz_code": prot.cstat, "sefaz_msg": prot.xmotivo})
        if proc:
            await call_fn(deps.pool, "fiscal.record_document_event", d["id"], {"type": "CANCEL_XML", "xml": proc})
        return
    error = f"{prot.cstat} {prot.xmotivo}".strip()
    await call_fn(deps.pool, "fiscal.record_document_event", d["id"], {"type": "CANCEL_FAILED", "message": error})
    await deps.notify(org_id, "FISCAL_CANCEL_FAILED", f"Não foi possível cancelar a nota {d['number']}: {error}", {"document_id": str(d["id"])}, perm="fiscal.write")


async def void_number(deps: Deps, conn: dict[str, Any], p: dict[str, Any]) -> None:
    d = await fetch_one(deps.pool, "select id, legal_entity_id, number, series, model, status, provider, xml from fiscal.documents where id = %s and org_id = %s",
                        (p["document_id"], p["org_id"]))
    if d is None or d["status"] != "REJECTED" or d["provider"] != "SEFAZ" or not d["number"]:
        return
    ctx = await context(deps, conn, p["org_id"], str(d["legal_entity_id"]))
    async with ctx.client(_doc_tp_amb(d["xml"], ctx.tp_amb)) as client:
        try:
            prot = await client.void_numbers(ctx.emitter.cnpj, int(d["series"]), int(d["number"]), int(d["number"]), p["reason"], int(d["model"]))
        except SefazNetworkError as e:
            raise RetryLater(int(e.retry_after or 60), str(e)) from e
    if prot.cstat == "102":
        await call_fn(deps.pool, "fiscal.record_number_void", d["id"], {"protocol": prot.nprot, "sefaz_code": prot.cstat, "sefaz_msg": prot.xmotivo})
        return
    error = f"{prot.cstat} {prot.xmotivo}".strip()
    await call_fn(deps.pool, "fiscal.record_document_event", d["id"], {"type": "VOID_FAILED", "message": error})
    await deps.notify(p["org_id"], "FISCAL_CANCEL_FAILED", f"Não foi possível inutilizar o número {d['number']}: {error}", {"document_id": str(d["id"])}, perm="fiscal.write")


# ---------------------------------------------------------------------- notas recebidas (Ambiente Nacional)
async def dfe_sync(deps: Deps, conn: dict[str, Any], org_id: str) -> None:
    ctx = await context(deps, conn, org_id)
    cnpj = ctx.emitter.cnpj
    state = await fetch_one(deps.pool, "select last_version, next_allowed_at from fiscal.dfe_sync_state where legal_entity_id = %s", (ctx.entity_id,))
    now = datetime.now(UTC)
    if state and state["next_allowed_at"] and state["next_allowed_at"] > now:
        log.info("distribuição de DF-e: aguardando %s (regra de 1 hora da SEFAZ)", state["next_allowed_at"])
        return
    ult = int(state["last_version"]) if state else 0
    found = 0
    error: str | None = None
    async with ctx.client() as client:
        for _ in range(DFE_MAX_PAGES):
            try:
                res = await client.distribution(cnpj, ult_nsu=ult)
            except SefazNetworkError as e:
                error = str(e)
                break
            if res.cstat in ("137", "656"):
                ult = max(ult, res.ult_nsu)
                await call_fn(deps.pool, "fiscal.dfe_set_wait", org_id, ctx.entity_id, now + DFE_WAIT)
                if res.cstat == "656":
                    error = f"{res.cstat} {res.xmotivo}"
                break
            if res.cstat != "138":
                error = f"{res.cstat} {res.xmotivo}"
                break
            rows = [r for r in (parse_dfe_doc(d) for d in res.docs) if r and r.get("access_key")]
            if rows:
                found += int(await call_fn(deps.pool, "fiscal.dfe_upsert", org_id, ctx.entity_id, [{k: v for k, v in r.items() if k not in ("xml", "cancelled")} for r in rows]) or 0)
                for r in rows:
                    if r.get("xml"):
                        await call_fn(deps.pool, "fiscal.dfe_attach_xml", org_id, r["access_key"], r["xml"])
            ult = max(ult, res.ult_nsu)
            if res.ult_nsu >= res.max_nsu:
                await call_fn(deps.pool, "fiscal.dfe_set_wait", org_id, ctx.entity_id, now + DFE_WAIT)
                break
    await call_fn(deps.pool, "fiscal.dfe_set_state", org_id, ctx.entity_id, ult, found, error)
    if error:
        await deps.notify(org_id, "INTEGRATION_ERROR", f"Busca de notas recebidas na SEFAZ: {error}", {"legal_entity_id": ctx.entity_id}, perm="fiscal.write")


async def dfe_by_key(deps: Deps, conn: dict[str, Any], p: dict[str, Any]) -> None:
    """Uma nota recebida pela chave (consChNFe): resumo, ou a NF-e completa se a manifestação já foi feita."""
    ctx = await context(deps, conn, p["org_id"])
    key = str(p["key"])
    async with ctx.client() as client:
        try:
            res = await client.distribution(ctx.emitter.cnpj, key=key)
        except SefazNetworkError as e:
            raise RetryLater(int(e.retry_after or 60), str(e)) from e
    rows = [r for r in (parse_dfe_doc(d) for d in res.docs) if r and r.get("access_key")]
    if res.cstat == "138" and rows:
        await call_fn(deps.pool, "fiscal.dfe_upsert", p["org_id"], ctx.entity_id, [{k: v for k, v in r.items() if k not in ("xml", "cancelled", "nsu")} for r in rows])
        for r in rows:
            if r.get("xml"):
                await call_fn(deps.pool, "fiscal.dfe_attach_xml", p["org_id"], r["access_key"], r["xml"])
        return
    msg = f"{res.cstat} {res.xmotivo}".strip() if res.cstat != "138" else "a SEFAZ não devolveu o resumo da nota"
    await deps.notify(p["org_id"], "INTEGRATION_ERROR", f"Consulta da nota {key[25:34].lstrip('0')} pela chave: {msg}", {"access_key": key},
                      perm="fiscal.write", member=p.get("by"))


async def dfe_manifest(deps: Deps, conn: dict[str, Any], p: dict[str, Any]) -> None:
    d = await fetch_one(deps.pool, "select id, legal_entity_id, access_key, manifest_status, manifest_requested, manifest_reason from fiscal.inbound_dfe where id = %s and org_id = %s",
                        (p["dfe_id"], p["org_id"]))
    if d is None or not d["manifest_requested"] or d["manifest_status"] == d["manifest_requested"]:
        return
    ctx = await context(deps, conn, p["org_id"], str(d["legal_entity_id"]))
    kind = d["manifest_requested"]
    key = str(d["access_key"])
    xml = None
    async with ctx.client() as client:
        try:
            prot = await client.manifest(ctx.emitter.cnpj, key, kind, d["manifest_reason"])
        except SefazNetworkError as e:
            raise RetryLater(int(e.retry_after or 60), str(e)) from e
        except ProviderPermanent as e:
            await call_fn(deps.pool, "fiscal.dfe_mark", d["id"], None, str(e)[:300], None)
            return
        if prot.cstat not in EVENT_OK and prot.cstat != "573":                 # 573 = manifestação já registrada antes
            await call_fn(deps.pool, "fiscal.dfe_mark", d["id"], None, f"{prot.cstat} {prot.xmotivo}"[:300], None)
            return
        if kind in ("CIENCIA", "CONFIRMADA"):                                  # o XML completo fica disponível depois da manifestação
            try:
                res = await client.distribution(ctx.emitter.cnpj, key=key)
                xml = next((doc["xml"] for doc in res.docs if doc["schema"].startswith("procNFe")), None)
            except (SefazNetworkError, ProviderPermanent) as e:
                log.info("XML da nota %s ainda indisponível: %s", key, e)       # chega depois pela varredura (distNSU)
    await call_fn(deps.pool, "fiscal.dfe_mark", d["id"], kind, None, xml)


# ---------------------------------------------------------------------- teste da integração
async def check(deps: Deps, conn: dict[str, Any]) -> dict[str, Any]:
    """Certificado (senha, validade, CNPJ), cadastro do emitente e o serviço da SEFAZ (NFeStatusServico, que também prova o TLS com o certificado)."""
    org = await fetch_one(deps.pool, "select org_id from core.integration_connections where id = %s", (conn["id"],))
    ctx = await context(deps, conn, str(org["org_id"]))
    await call_fn(deps.pool, "fiscal.set_certificate_info", ctx.entity_id, ctx.cert.not_after)
    async with ctx.client() as client:
        cstat, xmotivo = await client.status()                                 # rede: TransientError, o teste repete e registra a falha
    if cstat != "107":
        raise ProviderPermanent(f"SEFAZ respondeu {cstat} {xmotivo}")
    rows = await fetch_all(deps.pool, "select provider from core.integration_connections where org_id = %s and provider in ('NOTAAS','FOCUS_NFE','BRASIL_NFE') and status <> 'DISABLED' and secret_ref is not null",
                           (org["org_id"],))
    return {"sefaz": f"{cstat} {xmotivo}", "environment": "producao" if ctx.tp_amb == 1 else "homologacao", "uf": ctx.emitter.uf,
            "certificate": ctx.cert.subject_cn, "certificate_cnpj": ctx.cert.cnpj, "valid_until": ctx.cert.not_after.date().isoformat(),
            "days_left": ctx.cert.days_left(), "series": ctx.series, "qr_code": "v2 (CSC)" if ctx.csc_id and ctx.csc_token else "v3 (sem CSC)",
            "tributos": f"{ctx.taxes.total_pct}% ({ctx.taxes.fonte})" if ctx.taxes and ctx.taxes.total_pct > 0 else "não informado",
            "fallback": [r["provider"] for r in rows]}
