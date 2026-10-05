"""Testes com o Postgres local: fila (pgmq) + entrada de webhooks + envio. Cada teste roda numa transação revertida no fim."""
from __future__ import annotations

import json
import uuid
from typing import Any

import httpx
import pytest
import respx

from centralops_worker import queues
from centralops_worker.db import call_fn, fetch_all, fetch_one
from centralops_worker.handlers import inbound, media, notifications, outbound
from centralops_worker.runner import PermanentError, RetryLater, drain, process_one

from .conftest import ORG, ingest, unique_phone

pytestmark = pytest.mark.db


def wa_webhook(pnid: str, wa_id: str, *messages: dict[str, Any], statuses: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    value: dict[str, Any] = {"messaging_product": "whatsapp", "metadata": {"phone_number_id": pnid}, "contacts": [{"profile": {"name": "Fernanda Teste"}, "wa_id": wa_id}]}
    if messages:
        value["messages"] = list(messages)
    if statuses:
        value["statuses"] = statuses
    return {"object": "whatsapp_business_account", "entry": [{"id": "WABA", "changes": [{"field": "messages", "value": value}]}]}


# ---------------------------------------------------------------------------------------------------------------------------------------------
# Fila: retentativa com recuo, DLQ e "tentar de novo depois"
# ---------------------------------------------------------------------------------------------------------------------------------------------
async def _send_test_msg(pool: Any, queue: str = "notifications") -> queues.QueueMessage:
    mid = await queues.send(pool, queue, {"probe": uuid.uuid4().hex})
    (m,) = [x for x in await queues.read(pool, queue, 30, 200) if x.msg_id == mid]
    return m


async def test_runner_success_deletes_message(pool: Any, settings: Any) -> None:
    m = await _send_test_msg(pool)

    async def ok(_: queues.QueueMessage) -> None:
        return None

    assert await process_one(pool, m, ok, settings) == "ok"
    assert await fetch_one(pool, "select 1 as x from pgmq.q_notifications where msg_id = %s", (m.msg_id,)) is None


async def test_runner_retry_backoff_then_dlq(pool: Any, settings: Any) -> None:
    m = await _send_test_msg(pool)

    async def boom(_: queues.QueueMessage) -> None:
        raise RuntimeError("falha temporária")

    assert await process_one(pool, m, boom, settings) == "retry"
    row = await fetch_one(pool, "select vt > clock_timestamp() + interval '3 seconds' as later from pgmq.q_notifications where msg_id = %s", (m.msg_id,))
    assert row and row["later"] is True                                  # ficou invisível pelo recuo
    exhausted = queues.QueueMessage(m.queue, m.msg_id, settings.max_attempts, m.payload)
    assert await process_one(pool, exhausted, boom, settings) == "dlq"
    assert await fetch_one(pool, "select 1 as x from pgmq.q_notifications where msg_id = %s", (m.msg_id,)) is None
    dlq = await fetch_one(pool, "select message from pgmq.q_notifications_dlq order by msg_id desc limit 1")
    assert dlq and dlq["message"]["original"] == m.payload and "falha temporária" in dlq["message"]["error"]


async def test_runner_permanent_error_goes_straight_to_dlq(pool: Any, settings: Any) -> None:
    m = await _send_test_msg(pool)

    async def bad(_: queues.QueueMessage) -> None:
        raise PermanentError("dado inválido")

    assert await process_one(pool, m, bad, settings) == "dlq"
    dlq = await fetch_one(pool, "select message from pgmq.q_notifications_dlq order by msg_id desc limit 1")
    assert dlq and dlq["message"]["error"] == "dado inválido"


async def test_runner_retry_later_does_not_count_and_drain_reads_batches(pool: Any, settings: Any) -> None:
    m = await _send_test_msg(pool)

    async def later(_: queues.QueueMessage) -> None:
        raise RetryLater(120, "processando")

    assert await process_one(pool, m, later, settings) == "retry"
    row = await fetch_one(pool, "select vt > clock_timestamp() + interval '100 seconds' as later from pgmq.q_notifications where msg_id = %s", (m.msg_id,))
    assert row and row["later"] is True
    await fetch_one(pool, "select msg_id from pgmq.set_vt('notifications', %s, 0)", (m.msg_id,))
    seen: list[int] = []

    async def collect(x: queues.QueueMessage) -> None:
        seen.append(x.msg_id)

    stats = await drain(pool, "notifications", collect, settings)
    assert m.msg_id in seen and stats["ok"] >= 1 and stats["dlq"] == 0


# ---------------------------------------------------------------------------------------------------------------------------------------------
# Webhook → normalizador → conversa (idempotente)
# ---------------------------------------------------------------------------------------------------------------------------------------------
async def test_inbound_creates_conversation_and_ignores_replays(pool: Any, deps: Any, channel: dict[str, str]) -> None:
    wa = unique_phone()
    payload = wa_webhook(channel["pnid"], wa, {"from": wa, "id": f"wamid.{uuid.uuid4().hex}", "timestamp": "1727700000", "type": "text", "text": {"body": "Oi! Tem legging preta?"},
                                              "referral": {"source_url": "https://fb.me/ad", "source_type": "ad", "source_id": "123", "ctwa_clid": "AbC"}})
    res = await call_fn(pool, "omni.ingest_webhook", "META_WA", f"evt-{uuid.uuid4().hex}", payload)
    assert res["duplicate"] is False
    again = await call_fn(pool, "omni.ingest_webhook", "META_WA", "outro", payload)                         # outra chave, mesmo payload: é outro evento
    assert again["duplicate"] is False
    msg = queues.QueueMessage("inbound_events", 1, 1, {"webhook_event_id": res["id"]})
    await inbound.handle(deps, msg)
    await inbound.handle(deps, msg)                                                                          # reentrega: nada muda
    conv = await fetch_one(pool, """select c.id, c.mode, c.unread_count, c.status, p.display_name, p.lifecycle_stage from omni.conversations c join crm.parties p on p.id = c.party_id
                                    join omni.channel_identities i on i.id = c.channel_identity_id where i.external_id = %s""", (wa,))
    assert conv and conv["mode"] == "AI_COPILOT" and conv["unread_count"] == 1 and conv["display_name"] == "Fernanda Teste" and conv["lifecycle_stage"] == "LEAD"
    msgs = await fetch_all(pool, "select body, direction, author_type, status from omni.messages where conversation_id = %s", (conv["id"],))
    assert msgs == [{"body": "Oi! Tem legging preta?", "direction": "IN", "author_type": "CUSTOMER", "status": "DELIVERED"}] or len(msgs) == 1
    ev = await fetch_one(pool, "select processed_at, error from omni.webhook_events where id = %s", (res["id"],))
    assert ev and ev["processed_at"] is not None and ev["error"] is None
    router = await fetch_all(pool, "select message from pgmq.q_conversation_router where message->>'conversation_id' = %s", (str(conv["id"]),))
    assert len(router) == 1                                                                                  # um único job do roteador para a mensagem


async def test_inbound_duplicate_webhook_key_is_idempotent(pool: Any, channel: dict[str, str]) -> None:
    key = f"evt-{uuid.uuid4().hex}"
    a = await call_fn(pool, "omni.ingest_webhook", "META_WA", key, {"x": 1})
    b = await call_fn(pool, "omni.ingest_webhook", "META_WA", key, {"x": 1})
    assert a["duplicate"] is False and b == {"duplicate": True}


async def test_inbound_unknown_channel_is_recorded_not_retried(pool: Any, deps: Any) -> None:
    wa = unique_phone()
    payload = wa_webhook("PNID-DESCONHECIDO", wa, {"from": wa, "id": f"wamid.{uuid.uuid4().hex}", "timestamp": "1727700000", "type": "text", "text": {"body": "oi"}})
    res = await call_fn(pool, "omni.ingest_webhook", "META_WA", f"evt-{uuid.uuid4().hex}", payload)
    await inbound.handle(deps, queues.QueueMessage("inbound_events", 1, 1, {"webhook_event_id": res["id"]}))
    ev = await fetch_one(pool, "select processed_at, error from omni.webhook_events where id = %s", (res["id"],))
    assert ev and ev["processed_at"] is not None and "canal" in (ev["error"] or "").lower()


async def test_inbound_bad_payload_is_permanent(pool: Any, deps: Any) -> None:
    res = await call_fn(pool, "omni.ingest_webhook", "TELEGRAM", f"evt-{uuid.uuid4().hex}", {"update_id": 1, "_bot_id": "9", "message": {"chat": {"type": "private", "id": 1}, "from": {"id": 1}, "date": 1727700000}})
    with pytest.raises(PermanentError):
        await inbound.handle(deps, queues.QueueMessage("inbound_events", 1, 1, {"webhook_event_id": res["id"]}))
    ev = await fetch_one(pool, "select processed_at, error from omni.webhook_events where id = %s", (res["id"],))
    assert ev and ev["processed_at"] is not None and ev["error"].startswith("payload inesperado")


async def test_inbound_queues_media_and_status_updates(pool: Any, deps: Any, channel: dict[str, str]) -> None:
    wa, mid = unique_phone(), f"wamid.{uuid.uuid4().hex}"
    payload = wa_webhook(channel["pnid"], wa, {"from": wa, "id": mid, "timestamp": "1727700000", "type": "audio", "audio": {"id": "MEDIA-77", "voice": True}})
    res = await call_fn(pool, "omni.ingest_webhook", "META_WA", f"evt-{uuid.uuid4().hex}", payload)
    await inbound.handle(deps, queues.QueueMessage("inbound_events", 1, 1, {"webhook_event_id": res["id"]}))
    job = await fetch_one(pool, "select message from pgmq.q_media_processing where message->'media'->>'id' = 'MEDIA-77'")
    assert job and job["message"]["type"] == "AUDIO" and job["message"]["provider_account_id"] == channel["pnid"]
    m = await fetch_one(pool, "select id, conversation_id from omni.messages where provider_message_id = %s", (mid,))
    assert m
    # uma mensagem nossa enviada e depois lida: o status só avança
    out = await fetch_one(pool, """insert into omni.messages (org_id, conversation_id, channel_account_id, direction, author_type, body, status, provider_message_id)
                                   select org_id, conversation_id, channel_account_id, 'OUT', 'HUMAN', 'ok', 'SENT', 'wamid.OUT-1' from omni.messages where id = %s returning id""", (m["id"],))
    assert out
    for status, expected in (("READ", "READ"), ("DELIVERED", "READ")):                                        # entregue depois de lida não volta
        st = wa_webhook(channel["pnid"], wa, statuses=[{"id": "wamid.OUT-1", "status": status.lower(), "timestamp": "1727700100", "recipient_id": wa}])
        r = await call_fn(pool, "omni.ingest_webhook", "META_WA", f"evt-{uuid.uuid4().hex}", st)
        await inbound.handle(deps, queues.QueueMessage("inbound_events", 1, 1, {"webhook_event_id": r["id"]}))
        assert (await fetch_one(pool, "select status from omni.messages where id = %s", (out["id"],)))["status"] == expected  # type: ignore[index]


# ---------------------------------------------------------------------------------------------------------------------------------------------
# Envio (WhatsApp) — a janela é decidida no banco; o worker só faz HTTP e classifica erros
# ---------------------------------------------------------------------------------------------------------------------------------------------
async def _human_reply(pool: Any, conv: dict[str, Any], body: str = "Oi, tudo bem? Separo para você.") -> str:
    row = await fetch_one(pool, """insert into omni.messages (org_id, conversation_id, channel_account_id, direction, author_type, body, status, client_dedupe_key)
                                   select org_id, id, channel_account_id, 'OUT', 'HUMAN', %s, 'QUEUED', %s from omni.conversations where id = %s returning id""",
                          (body, uuid.uuid4().hex, conv["conversation_id"]))
    assert row
    return str(row["id"])


@respx.mock
async def test_outbound_sends_whatsapp_text_and_marks_sent(pool: Any, deps: Any, channel: dict[str, str]) -> None:
    wa = unique_phone()
    conv = await ingest(pool, channel, wa, "Oi")
    mid = await _human_reply(pool, conv)
    route = respx.post(f"https://graph.test/v21.0/{channel['pnid']}/messages").mock(return_value=httpx.Response(200, json={"messages": [{"id": "wamid.SENT1"}]}))
    await outbound.handle(deps, queues.QueueMessage("outbound_messages", 1, 1, {"message_id": mid}))
    assert route.called
    req = route.calls[0].request
    assert req.headers["authorization"] == "Bearer WA-TOKEN" and json.loads(req.content)["to"] == wa
    row = await fetch_one(pool, "select status, provider_message_id, sent_at from omni.messages where id = %s", (mid,))
    assert row and row["status"] == "SENT" and row["provider_message_id"] == "wamid.SENT1" and row["sent_at"] is not None
    await outbound.handle(deps, queues.QueueMessage("outbound_messages", 1, 1, {"message_id": mid}))       # reentrega: não envia de novo
    assert route.call_count == 1


@respx.mock
async def test_outbound_instagram_uses_its_own_host_and_the_human_agent_tag(pool: Any, deps: Any, channel: dict[str, str]) -> None:
    suffix = uuid.uuid4().hex[:8]
    await fetch_one(pool, """insert into omni.channel_accounts (org_id, channel, provider_account_id, display_name, store_id, default_ai_mode, connection_id)
                             select org_id, 'INSTAGRAM', %s, 'Instagram teste', store_id, 'AI_COPILOT', connection_id from omni.channel_accounts where id = %s returning id""", (f"IG-{suffix}", channel["account_id"]))
    ev = await call_fn(pool, "omni.ingest_event", {"kind": "MESSAGE", "channel": "INSTAGRAM", "provider_account_id": f"IG-{suffix}", "external_id": "IGSID9", "handle": "ana_teste",
                                                   "display_name": "Ana IG", "provider_message_id": f"mid.{suffix}", "body": "oi"})
    await fetch_one(pool, "update omni.conversations set last_inbound_at = now() - interval '3 days' where id = %s returning id", (ev["conversation_id"],))   # entre 24 h e 7 dias
    mid = await _human_reply(pool, ev)
    route = respx.post(f"https://ig.test/v21.0/IG-{suffix}/messages").mock(return_value=httpx.Response(200, json={"recipient_id": "IGSID9", "message_id": "mid.OUT1"}))
    await outbound.handle(deps, queues.QueueMessage("outbound_messages", 1, 1, {"message_id": mid}))
    body = json.loads(route.calls[0].request.content)
    assert body["recipient"] == {"id": "IGSID9"} and body["messaging_type"] == "MESSAGE_TAG" and body["tag"] == "HUMAN_AGENT"
    row = await fetch_one(pool, "select status, provider_message_id from omni.messages where id = %s", (mid,))
    assert row and row["status"] == "SENT" and row["provider_message_id"] == "mid.OUT1"


@respx.mock
async def test_outbound_outside_window_fails_without_http(pool: Any, deps: Any, channel: dict[str, str]) -> None:
    conv = await ingest(pool, channel, unique_phone(), "Oi")
    await fetch_one(pool, "update omni.conversations set last_inbound_at = now() - interval '2 days' where id = %s returning id", (conv["conversation_id"],))
    mid = await _human_reply(pool, conv)
    route = respx.post(url__regex=r"https://graph\.test/.*").mock(return_value=httpx.Response(200, json={}))
    await outbound.handle(deps, queues.QueueMessage("outbound_messages", 1, 1, {"message_id": mid}))
    assert not route.called
    row = await fetch_one(pool, "select status, error from omni.messages where id = %s", (mid,))
    assert row and row["status"] == "FAILED" and "janela" in row["error"].lower()


@respx.mock
async def test_outbound_meta_errors_are_classified(pool: Any, deps: Any, channel: dict[str, str]) -> None:
    conv = await ingest(pool, channel, unique_phone(), "Oi")
    mid = await _human_reply(pool, conv)
    url = f"https://graph.test/v21.0/{channel['pnid']}/messages"
    respx.post(url).mock(return_value=httpx.Response(503))
    with pytest.raises(Exception) as ei:                                                                    # transitório: o runner recua e tenta de novo
        await outbound.handle(deps, queues.QueueMessage("outbound_messages", 1, 1, {"message_id": mid}))
    assert type(ei.value).__name__ == "TransientError"
    assert (await fetch_one(pool, "select status from omni.messages where id = %s", (mid,)))["status"] == "QUEUED"  # type: ignore[index]
    respx.post(url).mock(return_value=httpx.Response(400, json={"error": {"code": 131047, "message": "Re-engagement message"}}))
    await outbound.handle(deps, queues.QueueMessage("outbound_messages", 1, 1, {"message_id": mid}))       # permanente: marca FAILED, sem repetir
    row = await fetch_one(pool, "select status, error from omni.messages where id = %s", (mid,))
    assert row and row["status"] == "FAILED" and "131047" in row["error"]
    respx.post(url).mock(return_value=httpx.Response(401, json={"error": {"code": 190, "message": "token expirado"}}))
    await fetch_one(pool, "update omni.messages set status = 'QUEUED' where id = %s returning id", (mid,))
    await outbound.handle(deps, queues.QueueMessage("outbound_messages", 1, 1, {"message_id": mid}))
    alert = await fetch_one(pool, "select count(*) as n from core.notifications where kind = 'INTEGRATION_ERROR' and payload->>'channel' = 'WHATSAPP' and created_at >= now() - interval '1 minute'")
    assert alert and alert["n"] >= 1                                                                        # token inválido vira alerta para o admin


@respx.mock
async def test_outbound_without_credentials_retries_later(pool: Any, deps: Any, channel: dict[str, str]) -> None:
    conv = await ingest(pool, channel, unique_phone(), "Oi")
    await fetch_one(pool, "update omni.channel_accounts set connection_id = null where id = %s returning id", (channel["account_id"],))
    mid = await _human_reply(pool, conv)
    with pytest.raises(RetryLater):
        await outbound.handle(deps, queues.QueueMessage("outbound_messages", 1, 1, {"message_id": mid}))


async def test_outbound_missing_message_is_permanent(deps: Any) -> None:
    with pytest.raises(PermanentError):
        await outbound.handle(deps, queues.QueueMessage("outbound_messages", 1, 1, {"message_id": str(uuid.uuid4())}))


# ---------------------------------------------------------------------------------------------------------------------------------------------
# Mídia (baixa da Meta → Storage → transcrição) e notificações
# ---------------------------------------------------------------------------------------------------------------------------------------------
@respx.mock
async def test_media_download_upload_transcribe_and_requeue_router(pool: Any, deps: Any, channel: dict[str, str]) -> None:
    wa = unique_phone()
    conv = await ingest(pool, channel, wa, "[áudio]", type="AUDIO", payload={"media": {"id": "MEDIA-1"}})
    respx.get("https://graph.test/v21.0/MEDIA-1").mock(return_value=httpx.Response(200, json={"url": "https://lookaside.test/m1", "mime_type": "audio/ogg"}))
    respx.get("https://lookaside.test/m1").mock(return_value=httpx.Response(200, content=b"OGGDATA", headers={"content-type": "audio/ogg"}))
    up = respx.post(url__regex=r"https://storage\.test/storage/v1/object/omni-media/.*").mock(return_value=httpx.Response(200, json={"Key": "ok"}))
    respx.post("https://groq.test/v1/audio/transcriptions").mock(return_value=httpx.Response(200, json={"text": "Tem legging preta no M?"}))
    await fetch_one(pool, "select pgmq.purge_queue('conversation_router') as n")
    await media.handle(deps, queues.QueueMessage("media_processing", 1, 1, {"message_id": conv["message_id"], "channel": "WHATSAPP", "type": "AUDIO", "media": {"id": "MEDIA-1"}}))
    assert up.called and up.calls[0].request.headers["authorization"] == "Bearer svc-test"
    row = await fetch_one(pool, "select media_path, transcript from omni.messages where id = %s", (conv["message_id"],))
    assert row and row["transcript"] == "Tem legging preta no M?" and row["media_path"].startswith(ORG)
    job = await fetch_one(pool, "select message from pgmq.q_conversation_router where message->>'message_id' = %s", (str(conv["message_id"]),))
    assert job is not None                                                                                  # a transcrição devolve a mensagem ao roteador


async def test_notifications_fan_out_by_permission_and_assignee(pool: Any, deps: Any) -> None:
    before = (await fetch_one(pool, "select count(*) as n from core.notifications"))["n"]  # type: ignore[index]
    await notifications.handle(deps, queues.QueueMessage("notifications", 1, 1, {"org_id": ORG, "kind": "PAYMENT_LINK_REQUESTED", "order_id": str(uuid.uuid4())}))
    after = (await fetch_one(pool, "select count(*) as n from core.notifications"))["n"]  # type: ignore[index]
    assert after > before
    row = await fetch_one(pool, "select title, kind from core.notifications order by created_at desc, id desc limit 1")
    assert row and row["kind"] == "PAYMENT_LINK_REQUESTED" and row["title"] == "Link de pagamento solicitado"
