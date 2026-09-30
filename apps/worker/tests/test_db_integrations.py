"""Verificação de credenciais das integrações (Meta, Telegram, Focus NFe): o worker lê o segredo do Vault, chama o provedor e grava o resultado."""
from __future__ import annotations

import json
import uuid
from typing import Any

import httpx
import pytest
import respx

from sie_worker import queues
from sie_worker.db import fetch_one
from sie_worker.handlers import integrations
from sie_worker.runner import RetryLater

from .conftest import ORG

pytestmark = pytest.mark.db


async def make_connection(pool: Any, provider: str, config: dict[str, Any], secret: dict[str, str] | None = None, status: str = "PENDING") -> str:
    suffix = uuid.uuid4().hex[:8]
    ref = None
    if secret is not None:
        ref = f"integ/test/{provider}/{suffix}"
        await fetch_one(pool, "select vault.create_secret(%s, %s)", (json.dumps(secret), ref))
    row = await fetch_one(pool, "insert into core.integration_connections (org_id, provider, capability, config, secret_ref, status) values (%s, %s, %s, %s, %s, %s) returning id",
                          (ORG, provider, f"T_{suffix.upper()}", json.dumps(config), ref, status))
    assert row
    return str(row["id"])


def job(conn_id: str, action: str = "CHECK", read_ct: int = 1) -> queues.QueueMessage:
    return queues.QueueMessage("integration_checks", 1, read_ct, {"connection_id": conn_id, "org_id": ORG, "action": action})


async def state(pool: Any, conn_id: str) -> dict[str, Any]:
    row = await fetch_one(pool, "select status, last_error, last_sync_at, config -> 'health' as health from core.integration_connections where id = %s", (conn_id,))
    assert row
    return row


@respx.mock
async def test_whatsapp_ok_records_number_details(pool: Any, deps: Any) -> None:
    cid = await make_connection(pool, "META_WA", {"phone_number_id": "PN42"}, {"token": "WA-T"})
    route = respx.get("https://graph.test/v21.0/PN42").mock(return_value=httpx.Response(200, json={
        "id": "PN42", "display_phone_number": "+55 48 99999-0000", "verified_name": "SIÉ Wear", "quality_rating": "GREEN", "name_status": "APPROVED", "extra": "ignorado"}))
    await integrations.handle(deps, job(cid))
    assert route.calls[0].request.headers["authorization"] == "Bearer WA-T" and "verified_name" in route.calls[0].request.url.params["fields"]
    st = await state(pool, cid)
    assert st["status"] == "ACTIVE" and st["last_error"] is None and st["last_sync_at"] is not None
    assert st["health"]["ok"] is True and st["health"]["detail"]["verified_name"] == "SIÉ Wear" and "extra" not in st["health"]["detail"]


@respx.mock
async def test_whatsapp_invalid_token_marks_error_and_alerts_admins(pool: Any, deps: Any) -> None:
    cid = await make_connection(pool, "META_WA", {"phone_number_id": "PN42"}, {"token": "VENCIDO"}, status="ACTIVE")
    respx.get("https://graph.test/v21.0/PN42").mock(return_value=httpx.Response(401, json={"error": {"code": 190, "message": "Invalid OAuth access token"}}))
    await integrations.handle(deps, job(cid))
    st = await state(pool, cid)
    assert st["status"] == "ERROR" and "190" in st["last_error"] and st["health"]["ok"] is False and st["health"]["detail"]["code"] == 190
    n = await fetch_one(pool, "select count(*) as n from core.notifications where kind = 'INTEGRATION_ERROR' and payload ->> 'connection_id' = %s", (cid,))
    assert n and n["n"] >= 1


async def test_whatsapp_without_phone_number_id_explains_what_is_missing(pool: Any, deps: Any) -> None:
    cid = await make_connection(pool, "META_WA", {}, {"token": "WA-T"})
    await integrations.handle(deps, job(cid))
    assert "phone_number_id" in (await state(pool, cid))["last_error"]


@respx.mock
async def test_transient_failure_retries_then_records_after_three_attempts(pool: Any, deps: Any) -> None:
    cid = await make_connection(pool, "META_WA", {"phone_number_id": "PN42"}, {"token": "WA-T"})
    respx.get("https://graph.test/v21.0/PN42").mock(return_value=httpx.Response(503))
    with pytest.raises(RetryLater):
        await integrations.handle(deps, job(cid, read_ct=1))
    assert (await state(pool, cid))["status"] == "PENDING"                      # uma oscilação não vira alerta
    await integrations.handle(deps, job(cid, read_ct=3))
    st = await state(pool, cid)
    assert st["status"] == "ERROR" and st["health"]["detail"]["transient"] is True


@respx.mock
async def test_instagram_uses_its_own_api_host(pool: Any, deps: Any) -> None:
    cid = await make_connection(pool, "META_IG", {}, {"access_token": "IG-T"})
    respx.get("https://ig.test/v21.0/me").mock(return_value=httpx.Response(200, json={"user_id": "1784", "username": "sie.wear", "account_type": "BUSINESS"}))
    await integrations.handle(deps, job(cid))
    st = await state(pool, cid)
    assert st["status"] == "ACTIVE" and st["health"]["detail"]["username"] == "sie.wear"


@respx.mock
async def test_telegram_check_and_webhook_registration(pool: Any, deps: Any) -> None:
    cid = await make_connection(pool, "TELEGRAM", {}, {"token": "123:ABC"})
    respx.post("https://tg.test/bot123:ABC/getMe").mock(return_value=httpx.Response(200, json={"ok": True, "result": {"id": 987654, "username": "sie_bot"}}))
    info = respx.post("https://tg.test/bot123:ABC/getWebhookInfo").mock(return_value=httpx.Response(200, json={"ok": True, "result": {"url": "", "pending_update_count": 0}}))
    await integrations.handle(deps, job(cid))                                         # bot válido, mas sem webhook: não está "no ar"
    st = await state(pool, cid)
    assert st["status"] == "ERROR" and "Registrar webhook" in st["last_error"]

    setter = respx.post("https://tg.test/bot123:ABC/setWebhook").mock(return_value=httpx.Response(200, json={"ok": True, "result": True}))
    info.mock(return_value=httpx.Response(200, json={"ok": True, "result": {"url": "https://storage.test/functions/v1/webhooks-telegram/987654", "pending_update_count": 2}}))
    await integrations.handle(deps, job(cid, "TELEGRAM_WEBHOOK"))
    body = json.loads(setter.calls[0].request.content)
    assert body["url"] == "https://storage.test/functions/v1/webhooks-telegram/987654" and body["secret_token"] == "tg-secret-test" and body["allowed_updates"] == ["message", "edited_message"]
    st = await state(pool, cid)
    assert st["status"] == "ACTIVE" and st["health"]["detail"] == {"bot_id": "987654", "username": "sie_bot", "webhook_url": "https://storage.test/functions/v1/webhooks-telegram/987654",
                                                                   "pending_update_count": 2, "last_error_message": None}


@respx.mock
async def test_telegram_webhook_registration_requires_the_shared_secret(pool: Any, deps: Any) -> None:
    import dataclasses
    d = dataclasses.replace(deps, settings=deps.settings.model_copy(update={"telegram_webhook_secret": ""}))
    cid = await make_connection(pool, "TELEGRAM", {}, {"token": "123:ABC"})
    respx.post("https://tg.test/bot123:ABC/getMe").mock(return_value=httpx.Response(200, json={"ok": True, "result": {"id": 1}}))
    setter = respx.post("https://tg.test/bot123:ABC/setWebhook").mock(return_value=httpx.Response(200, json={"ok": True, "result": True}))
    await integrations.handle(d, job(cid, "TELEGRAM_WEBHOOK"))
    assert not setter.called and "SIE_TELEGRAM_WEBHOOK_SECRET" in (await state(pool, cid))["last_error"]


@respx.mock
async def test_telegram_invalid_token(pool: Any, deps: Any) -> None:
    cid = await make_connection(pool, "TELEGRAM", {}, {"token": "ruim"})
    respx.post("https://tg.test/botruim/getMe").mock(return_value=httpx.Response(401, json={"ok": False, "error_code": 401, "description": "Unauthorized"}))
    await integrations.handle(deps, job(cid))
    st = await state(pool, cid)
    assert st["status"] == "ERROR" and "Unauthorized" in st["last_error"]


@respx.mock
async def test_focus_accepts_404_and_rejects_401_and_honors_environment(pool: Any, deps: Any) -> None:
    hml = await make_connection(pool, "FOCUS_NFE", {"environment": "homologacao"}, {"token": "FOCUS-T"})
    route = respx.get("https://focus.test/v2/cnpjs/00000000000191").mock(return_value=httpx.Response(404, json={"codigo": "nao_encontrado"}))
    await integrations.handle(deps, job(hml))
    assert route.calls[0].request.headers["authorization"].startswith("Basic ")
    st = await state(pool, hml)
    assert st["status"] == "ACTIVE" and st["health"]["detail"] == {"http_status": 404, "environment": "homologacao"}

    prod = await make_connection(pool, "FOCUS_NFE", {"environment": "producao"}, {"token": "FOCUS-P"})
    respx.get("https://api.focusnfe.com.br/v2/cnpjs/00000000000191").mock(return_value=httpx.Response(401, json={"codigo": "permissao_negada"}))
    await integrations.handle(deps, job(prod))
    st = await state(pool, prod)
    assert st["status"] == "ERROR" and "recusada" in st["last_error"]


async def test_missing_secret_and_disabled_connection(pool: Any, deps: Any) -> None:
    no_secret = await make_connection(pool, "FOCUS_NFE", {}, None)
    await integrations.handle(deps, job(no_secret))
    assert "cofre" in (await state(pool, no_secret))["last_error"]
    disabled = await make_connection(pool, "FOCUS_NFE", {}, {"token": "x"}, status="DISABLED")
    await integrations.handle(deps, job(disabled))                                    # desativada: ninguém chama o provedor nem muda a situação
    assert (await state(pool, disabled))["status"] == "DISABLED"
    await integrations.handle(deps, job(str(uuid.uuid4())))                          # conexão removida: ignora


async def test_unknown_provider_has_no_automatic_check_yet(pool: Any, deps: Any) -> None:
    cid = await make_connection(pool, "PLUGGY", {}, {"token": "x"})
    await integrations.handle(deps, job(cid))
    assert "ainda não tem verificação" in (await state(pool, cid))["last_error"]
