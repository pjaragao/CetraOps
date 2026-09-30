from __future__ import annotations

import asyncio
import os
import uuid
from collections.abc import AsyncIterator
from typing import Any

import httpx
import psycopg
import pytest
import pytest_asyncio
from psycopg.rows import dict_row

from sie_worker.config import Settings
from sie_worker.db import call_fn, fetch_one
from sie_worker.deps import Deps

ORG = "00000000-0000-4000-8000-000000000001"
STORE = "00000000-0000-4000-8000-0000000000a1"
DB_URL = os.environ.get("SIE_DATABASE_URL", "postgresql://postgres:postgres@127.0.0.1:55322/postgres")
CTX_SECRET = "test-secret-with-at-least-32-bytes!!"


def pytest_asyncio_loop_factories(config: pytest.Config, item: pytest.Item) -> dict[str, Any]:
    # psycopg assíncrono não roda no ProactorEventLoop (padrão do Windows)
    return {"selector": asyncio.SelectorEventLoop}


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


class _Conn:
    """Cada instrução roda dentro de um savepoint: um erro esperado (ex.: RAISE do banco) não aborta a transação do teste."""

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
    """Substitui o pool nos testes: uma única conexão numa transação que NUNCA é confirmada. Tudo que o teste cria (contas, conversas,
    mensagens, filas do pgmq, segredos do Vault) some no rollback, então a base de desenvolvimento não acumula lixo."""

    def __init__(self, conn: psycopg.AsyncConnection[Any]) -> None:
        self.conn = conn
        self.lock = asyncio.Lock()

    def connection(self) -> _Ctx:
        return _Ctx(self)


@pytest.fixture(scope="session")
def settings() -> Settings:
    return Settings(database_url=DB_URL, visibility_timeout_s=30, max_attempts=5, concurrency=1, agent_ctx_secret=CTX_SECRET, focus_token="focus-test-token",
                    focus_api_base="https://focus.test", graph_api_base="https://graph.test/v21.0", telegram_api_base="https://tg.test",
                    supabase_url="https://storage.test", supabase_service_key="svc-test", groq_key="groq-test", groq_base="https://groq.test/v1")


@pytest_asyncio.fixture
async def pool() -> AsyncIterator[TxPool]:
    conn = await psycopg.AsyncConnection.connect(DB_URL, autocommit=False, row_factory=dict_row)
    try:
        yield TxPool(conn)
    finally:
        await conn.rollback()
        await conn.close()


@pytest_asyncio.fixture
async def http() -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient() as client:
        yield client


@pytest_asyncio.fixture
async def deps(pool: TxPool, settings: Settings, http: httpx.AsyncClient) -> Deps:
    return Deps(pool=pool, settings=settings, http=http)  # type: ignore[arg-type]


@pytest_asyncio.fixture
async def channel(pool: TxPool) -> dict[str, str]:
    """Conta de WhatsApp de teste com credencial no Vault (tudo revertido no fim do teste)."""
    suffix = uuid.uuid4().hex[:10]
    secret_name = f"test-wa-{suffix}"
    await fetch_one(pool, "select vault.create_secret(%s, %s)", ('{"token":"WA-TOKEN"}', secret_name))  # type: ignore[arg-type]
    conn = await fetch_one(pool, "insert into core.integration_connections (org_id, provider, capability, secret_ref, status) values (%s, 'META', %s, %s, 'ACTIVE') returning id",
                           (ORG, f"WA_TEST_{suffix}", secret_name))  # type: ignore[arg-type]
    acc = await fetch_one(pool, """insert into omni.channel_accounts (org_id, channel, provider_account_id, display_name, store_id, default_ai_mode, connection_id)
                                   values (%s, 'WHATSAPP', %s, %s, %s, 'AI_COPILOT', %s) returning id""",
                          (ORG, f"PNID-{suffix}", f"WhatsApp teste {suffix}", STORE, conn["id"]))  # type: ignore[arg-type,index]
    return {"account_id": str(acc["id"]), "pnid": f"PNID-{suffix}", "suffix": suffix}  # type: ignore[index]


async def ingest(pool: TxPool, channel: dict[str, str], wa_id: str, body: str, *, mid: str | None = None, name: str = "Cliente Teste", **extra: Any) -> dict[str, Any]:
    ev = {"kind": "MESSAGE", "channel": "WHATSAPP", "provider_account_id": channel["pnid"], "external_id": wa_id, "phone": wa_id, "display_name": name,
          "provider_message_id": mid or f"wamid.{uuid.uuid4().hex}", "type": "TEXT", "body": body, **extra}
    return await call_fn(pool, "omni.ingest_event", ev)  # type: ignore[arg-type]


def unique_phone() -> str:
    return "5548" + str(uuid.uuid4().int)[:9]
