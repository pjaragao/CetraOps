from __future__ import annotations

import asyncio
import os
import uuid
from collections.abc import AsyncIterator
from typing import Any

import psycopg
import pytest
import pytest_asyncio
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from sie_agent_contract import CONCIERGE_CAPS, sign_ctx
from sie_mcp.config import Settings
from sie_mcp.db import AgentDb

ORG = "00000000-0000-4000-8000-000000000001"
STORE = "00000000-0000-4000-8000-0000000000a1"
DB_URL = os.environ.get("SIE_DATABASE_URL", "postgresql://postgres:postgres@127.0.0.1:55322/postgres")
CTX_SECRET = "mcp-test-ctx-secret-with-32-bytes!!"
MCP_KEY = "mcp-test-key-0123456789abcdef"


def pytest_asyncio_loop_factories(config: pytest.Config, item: pytest.Item) -> dict[str, Any]:
    return {"selector": asyncio.SelectorEventLoop}          # psycopg assíncrono não roda no ProactorEventLoop (Windows)


def _db_up() -> bool:
    try:
        with psycopg.connect(DB_URL, connect_timeout=2):
            return True
    except psycopg.OperationalError:
        return False


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    if _db_up():
        return
    skip = pytest.mark.skip(reason="Postgres local do Supabase não está no ar (supabase start)")
    for item in items:
        if "db" in item.keywords:
            item.add_marker(skip)


@pytest.fixture
def settings() -> Settings:
    return Settings(agent_ctx_secret=CTX_SECRET, mcp_key=MCP_KEY, mcp_host="127.0.0.1")


class _Conn:
    """Cada instrução roda num savepoint: um erro esperado do banco não aborta a transação do teste."""

    def __init__(self, pool: TxPool) -> None:
        self._pool = pool

    async def execute(self, sql: str, params: Any = None) -> Any:
        async with self._pool.lock:
            c = self._pool.conn
            await c.execute("savepoint t_stmt")
            try:
                cur = await c.execute(sql, params)
            except BaseException:
                await c.execute("rollback to savepoint t_stmt")
                await c.execute("release savepoint t_stmt")
                raise
            await c.execute("release savepoint t_stmt")
            return cur


class _Ctx:
    def __init__(self, pool: TxPool) -> None:
        self._pool = pool

    async def __aenter__(self) -> _Conn:
        return _Conn(self._pool)

    async def __aexit__(self, *exc: object) -> bool:
        return False


class TxPool:
    """Uma conexão numa transação que nunca é confirmada: o que o teste cria some no rollback."""

    def __init__(self, conn: psycopg.AsyncConnection[Any]) -> None:
        self.conn, self.lock = conn, asyncio.Lock()

    def connection(self) -> _Ctx:
        return _Ctx(self)

    async def open(self, wait: bool = True) -> None:
        return None

    async def close(self) -> None:
        return None

    async def sql(self, sql: str, params: Any = None) -> dict[str, Any] | None:
        async with self.connection() as c:
            cur = await c.execute(sql, params)
            return await cur.fetchone() if cur.description else None


@pytest_asyncio.fixture
async def txpool() -> AsyncIterator[TxPool]:
    conn = await psycopg.AsyncConnection.connect(DB_URL, autocommit=False, row_factory=dict_row)
    try:
        yield TxPool(conn)
    finally:
        await conn.rollback()
        await conn.close()


@pytest_asyncio.fixture
async def scenario(txpool: TxPool) -> dict[str, Any]:
    """Cliente + conversa + execução de IA prontas (feitas como dono do banco); depois a sessão passa a ser a role `agent_rpc`."""
    suffix = uuid.uuid4().hex[:10]
    await txpool.sql("insert into omni.channel_accounts (org_id, channel, provider_account_id, display_name, store_id, default_ai_mode) values (%s, 'WHATSAPP', %s, 'WhatsApp teste MCP', %s, 'AI_AUTOPILOT')",
                     (ORG, f"PNID-{suffix}", STORE))
    wa = "5548" + str(uuid.uuid4().int)[:9]
    ev = await txpool.sql("select omni.ingest_event(%s) as r", (Jsonb({"kind": "MESSAGE", "channel": "WHATSAPP", "provider_account_id": f"PNID-{suffix}", "external_id": wa, "phone": wa,
                                                                     "display_name": "Cliente MCP (teste)", "provider_message_id": f"wamid.{suffix}", "body": "Oi! Tem legging preta M?"}),))
    assert ev
    conv = ev["r"]
    run = await txpool.sql("insert into ai.runs (org_id, route_task, conversation_id, party_id) values (%s, 'conversation', %s, %s) returning id", (ORG, conv["conversation_id"], conv["party_id"]))
    assert run
    ids: dict[str, Any] = {"org": ORG, "conv": str(conv["conversation_id"]), "party": str(conv["party_id"]), "run": str(run["id"]), "version": conv["version"], "message_id": str(conv["message_id"])}
    ids["token"] = sign_ctx(CTX_SECRET, org=ids["org"], conv=ids["conv"], party=ids["party"], run=ids["run"], version=ids["version"], caps=CONCIERGE_CAPS, mode="AI_AUTOPILOT")
    await txpool.sql("set local role agent_rpc")                                   # a partir daqui, só o que a role do MCP pode fazer
    return ids


@pytest.fixture
def db(txpool: TxPool) -> AgentDb:
    return AgentDb(txpool)
