"""NF-e recebidas (MDe) pelo Focus NFe: varredura, manifestação do destinatário e XML (provedor simulado com respx)."""
from __future__ import annotations

from typing import Any

import httpx
import pytest
import respx

from centralops_worker.adapters.focus import normalize_received
from centralops_worker.db import fetch_all, fetch_one
from centralops_worker.handlers import fiscal
from centralops_worker.queues import QueueMessage

from .conftest import ORG

pytestmark = pytest.mark.db
FOCUS = "https://focus.test"
KEY1 = "35260912345678000190550010000001231000001234"
KEY2 = "35260912345678000190550010000001241000001240"


def raw(key: str, version: int, **extra: Any) -> dict[str, Any]:
    return {"chave_nfe": key, "versao": version, "nome_emitente": "Fornecedor Teste Ltda", "documento_emitente": "12.345.678/0001-90", "valor_total": "1520.50",
            "data_emissao": "2026-09-10T10:00:00-03:00", "manifestacao_destinatario": None, **extra}


def job(action: str, **payload: Any) -> QueueMessage:
    return QueueMessage("fiscal_emission", 1, 1, {"action": action, "org_id": ORG, **payload})


def test_normalize_received_is_tolerant_and_drops_invalid_keys() -> None:
    n = normalize_received(raw(KEY1, 7, manifestacao_destinatario="ciencia"))
    assert n and n["access_key"] == KEY1 and n["issuer_cnpj"] == "12345678000190" and n["amount"] == 1520.5 and n["nsu"] == "7" and n["manifest_status"] == "CIENCIA"
    assert normalize_received({"chave_nfe": "123"}) is None
    assert normalize_received({"chave": "NFe" + KEY2, "nsu": 3, "valor": 10})["access_key"] == KEY2  # type: ignore[index]
    assert normalize_received({"chave_nfe": KEY1})["manifest_status"] == "PENDING"                   # type: ignore[index]


@respx.mock
async def test_sync_stores_new_notes_moves_the_cursor_and_does_not_duplicate(pool: Any, deps: Any) -> None:
    ent = await fetch_one(pool, "select id, cnpj from core.legal_entities where org_id = %s order by cnpj limit 1", (ORG,))
    await fetch_one(pool, "delete from fiscal.inbound_dfe where org_id = %s returning id", (ORG,))
    route = respx.get(f"{FOCUS}/v2/nfes_recebidas").mock(side_effect=[httpx.Response(200, json=[raw(KEY1, 10), raw(KEY2, 11)]), httpx.Response(200, json=[])])
    await fiscal.handle(deps, job("DFE_SYNC"))
    assert route.calls[0].request.url.params["cnpj"] == ent["cnpj"] and route.calls[0].request.url.params["versao"] == "0"      # type: ignore[index]
    assert route.calls[1].request.url.params["versao"] == "11"                                                                    # pede só o que é novo
    rows = await fetch_all(pool, "select access_key, issuer_name, amount, manifest_status from fiscal.inbound_dfe where org_id = %s order by access_key", (ORG,))
    assert [(r["access_key"], r["issuer_name"], float(r["amount"]), r["manifest_status"]) for r in rows] == [(KEY1, "Fornecedor Teste Ltda", 1520.5, "PENDING"), (KEY2, "Fornecedor Teste Ltda", 1520.5, "PENDING")]
    state = await fetch_one(pool, "select last_version, last_found, last_error from fiscal.dfe_sync_state where legal_entity_id = %s", (ent["id"],))  # type: ignore[index]
    assert state == {"last_version": 11, "last_found": 2, "last_error": None}
    note = await fetch_one(pool, "select title from core.notifications where kind = 'DFE' order by created_at desc limit 1")
    assert note and note["title"].startswith("2 nota(s) nova(s)")

    respx.get(f"{FOCUS}/v2/nfes_recebidas").mock(side_effect=[httpx.Response(200, json=[raw(KEY1, 10, manifestacao_destinatario="ciencia")]), httpx.Response(200, json=[])])
    await fiscal.handle(deps, job("DFE_SYNC"))                                                                                    # reencontrar a mesma nota não duplica
    assert (await fetch_one(pool, "select count(*) as n from fiscal.inbound_dfe where org_id = %s", (ORG,)))["n"] == 2            # type: ignore[index]
    assert (await fetch_one(pool, "select manifest_status from fiscal.inbound_dfe where access_key = %s", (KEY1,)))["manifest_status"] == "CIENCIA"  # type: ignore[index]


@respx.mock
async def test_sync_credential_refusal_is_recorded_and_the_team_is_warned(pool: Any, deps: Any) -> None:
    ent = await fetch_one(pool, "select id from core.legal_entities where org_id = %s order by cnpj limit 1", (ORG,))
    respx.get(f"{FOCUS}/v2/nfes_recebidas").mock(return_value=httpx.Response(403, json={"codigo": "permissao_negada"}))
    await fiscal.handle(deps, job("DFE_SYNC"))                                                                                    # não levanta: repetir não resolve credencial recusada
    state = await fetch_one(pool, "select last_error from fiscal.dfe_sync_state where legal_entity_id = %s", (ent["id"],))  # type: ignore[index]
    assert state and "credencial recusada" in state["last_error"]
    assert (await fetch_one(pool, "select count(*) as n from core.notifications where kind = 'INTEGRATION_ERROR' and title like 'Busca de notas recebidas parou%'"))["n"] >= 1  # type: ignore[index]


async def _dfe(pool: Any, key: str, requested: str, reason: str | None = None) -> str:
    ent = await fetch_one(pool, "select id from core.legal_entities where org_id = %s order by cnpj limit 1", (ORG,))
    row = await fetch_one(pool, """insert into fiscal.inbound_dfe (org_id, legal_entity_id, access_key, issuer_name, amount, manifest_requested, manifest_reason)
                                   values (%s, %s, %s, 'Fornecedor', 100, %s, %s) returning id""", (ORG, ent["id"], key, requested, reason))  # type: ignore[index]
    return str(row["id"])  # type: ignore[index]


@respx.mock
async def test_manifest_sends_the_request_and_downloads_the_xml_after_awareness(pool: Any, deps: Any) -> None:
    dfe_id = await _dfe(pool, KEY1, "CIENCIA")
    manifest = respx.post(f"{FOCUS}/v2/nfes_recebidas/{KEY1}/manifesto").mock(return_value=httpx.Response(200, json={"status": "ok"}))
    respx.get(f"{FOCUS}/v2/nfes_recebidas/{KEY1}.xml").mock(return_value=httpx.Response(200, text="<nfeProc>xml</nfeProc>"))
    await fiscal.handle(deps, job("DFE_MANIFEST", dfe_id=dfe_id))
    assert manifest.calls[0].request.content == b'{"tipo":"ciencia"}'
    row = await fetch_one(pool, "select manifest_status, xml, xml_downloaded, last_error from fiscal.inbound_dfe where id = %s", (dfe_id,))
    assert row == {"manifest_status": "CIENCIA", "xml": "<nfeProc>xml</nfeProc>", "xml_downloaded": True, "last_error": None}
    await fiscal.handle(deps, job("DFE_MANIFEST", dfe_id=dfe_id))                                                                 # reentrega: já atendido, não manifesta de novo
    assert manifest.call_count == 1


@respx.mock
async def test_unknown_operation_sends_the_justification_and_keeps_going_without_xml(pool: Any, deps: Any) -> None:
    dfe_id = await _dfe(pool, KEY2, "DESCONHECIDA", "Não reconhecemos esta compra neste CNPJ")
    manifest = respx.post(f"{FOCUS}/v2/nfes_recebidas/{KEY2}/manifesto").mock(return_value=httpx.Response(200, json={}))
    await fiscal.handle(deps, job("DFE_MANIFEST", dfe_id=dfe_id))
    assert b"justificativa" in manifest.calls[0].request.content and b"desconhecimento" in manifest.calls[0].request.content
    row = await fetch_one(pool, "select manifest_status, xml_downloaded from fiscal.inbound_dfe where id = %s", (dfe_id,))
    assert row == {"manifest_status": "DESCONHECIDA", "xml_downloaded": False}                                                    # sem XML para quem desconhece a nota


@respx.mock
async def test_manifest_refused_by_the_provider_is_shown_on_the_note(pool: Any, deps: Any) -> None:
    dfe_id = await _dfe(pool, KEY1, "CONFIRMADA")
    respx.post(f"{FOCUS}/v2/nfes_recebidas/{KEY1}/manifesto").mock(return_value=httpx.Response(422, json={"mensagem": "Prazo de manifestação encerrado"}))
    await fiscal.handle(deps, job("DFE_MANIFEST", dfe_id=dfe_id))
    row = await fetch_one(pool, "select manifest_status, last_error from fiscal.inbound_dfe where id = %s", (dfe_id,))
    assert row and row["manifest_status"] == "PENDING" and "Prazo de manifestação encerrado" in row["last_error"]
