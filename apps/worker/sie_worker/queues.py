"""Operações do pgmq (Supabase Queues) usadas pelo worker."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from psycopg_pool import AsyncConnectionPool

from .db import fetch_all, fetch_one, jb

QUEUES = [
    "inbound_events", "conversation_router", "outbound_messages", "media_processing",
    "fiscal_emission", "acquirer_sync", "bank_sync", "ai_tasks", "capi_events", "notifications",
]


@dataclass(frozen=True)
class QueueMessage:
    queue: str
    msg_id: int
    read_ct: int
    payload: dict[str, Any]


async def read(pool: AsyncConnectionPool, queue: str, vt: int, qty: int) -> list[QueueMessage]:
    rows = await fetch_all(pool, "select msg_id, read_ct, message from pgmq.read(%s, %s, %s)", (queue, vt, qty))
    return [QueueMessage(queue, r["msg_id"], r["read_ct"], r["message"]) for r in rows]


async def delete(pool: AsyncConnectionPool, queue: str, msg_id: int) -> None:
    await fetch_one(pool, "select pgmq.delete(%s, %s) as ok", (queue, msg_id))


async def send(pool: AsyncConnectionPool, queue: str, payload: dict[str, Any], delay_s: int = 0) -> int:
    row = await fetch_one(pool, "select pgmq.send(%s, %s, %s) as id", (queue, jb(payload), delay_s))
    return row["id"] if row else 0


async def set_visibility(pool: AsyncConnectionPool, queue: str, msg_id: int, vt: int) -> None:
    await fetch_one(pool, "select msg_id from pgmq.set_vt(%s, %s, %s)", (queue, msg_id, vt))


async def to_dlq(pool: AsyncConnectionPool, msg: QueueMessage, error: str) -> None:
    """Move para a fila `<fila>_dlq` (com o erro) e tira da fila original."""
    await send(pool, f"{msg.queue}_dlq", {"original": msg.payload, "error": error[:1000], "read_ct": msg.read_ct})
    await delete(pool, msg.queue, msg.msg_id)


async def depth(pool: AsyncConnectionPool, queue: str) -> int:
    row = await fetch_one(pool, "select queue_length from pgmq.metrics(%s)", (queue,))
    return int(row["queue_length"]) if row else 0
