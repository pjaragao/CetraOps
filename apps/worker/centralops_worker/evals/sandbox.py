"""Sandbox das avaliações: uma única conexão numa transação que NUNCA é confirmada. O roteador e as ferramentas da IA rodam de verdade
(conversa, rascunho, handoff, reserva, pedido…), mas nada sobrevive: nem cliente, nem mensagem, nem aviso para a equipe."""
from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import psycopg
from psycopg.rows import dict_row


class _Conn:
    def __init__(self, pool: SandboxPool) -> None:
        self._pool = pool

    async def execute(self, sql: str, params: Any = None) -> Any:
        async with self._pool.lock:
            c = self._pool.conn
            await c.execute("savepoint ev_stmt")                     # um erro de SQL não derruba a transação inteira
            try:
                cur = await c.execute(sql, params)
            except BaseException:
                await c.execute("rollback to savepoint ev_stmt")
                await c.execute("release savepoint ev_stmt")
                raise
            await c.execute("release savepoint ev_stmt")
            return cur


class _Ctx:
    def __init__(self, pool: SandboxPool) -> None:
        self._pool = pool

    async def __aenter__(self) -> _Conn:
        return _Conn(self._pool)

    async def __aexit__(self, *exc: object) -> bool:
        return False


class SandboxPool:
    """Faz o papel de AsyncConnectionPool (só `.connection()`), sobre a conexão do sandbox."""

    def __init__(self, conn: psycopg.AsyncConnection[Any]) -> None:
        self.conn = conn
        self.lock = asyncio.Lock()

    def connection(self) -> _Ctx:
        return _Ctx(self)


@asynccontextmanager
async def sandbox(database_url: str) -> AsyncIterator[SandboxPool]:
    conn = await psycopg.AsyncConnection.connect(database_url, autocommit=False, row_factory=dict_row)
    try:
        yield SandboxPool(conn)
    finally:
        await conn.rollback()
        await conn.close()
