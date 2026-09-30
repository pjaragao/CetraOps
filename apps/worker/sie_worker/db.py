"""Acesso ao Postgres: pool assíncrono do psycopg 3 com linhas em dict."""
from __future__ import annotations

import json
from typing import Any

from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import AsyncConnectionPool

from .config import Settings


def make_pool(settings: Settings) -> AsyncConnectionPool:
    return AsyncConnectionPool(
        settings.database_url,
        min_size=settings.db_pool_min,
        max_size=settings.db_pool_max,
        kwargs={"row_factory": dict_row, "autocommit": True},
        open=False,
    )


def _dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, default=str)              # UUID, datas e Decimal viram texto em vez de quebrar o envio


def jb(value: Any) -> Jsonb:
    """Envolve um dict/list para parâmetro jsonb."""
    return Jsonb(value, dumps=_dumps)


async def fetch_one(pool: AsyncConnectionPool, sql: str, params: tuple | dict | None = None) -> dict[str, Any] | None:
    async with pool.connection() as conn:
        cur = await conn.execute(sql, params)
        return await cur.fetchone()


async def fetch_all(pool: AsyncConnectionPool, sql: str, params: tuple | dict | None = None) -> list[dict[str, Any]]:
    async with pool.connection() as conn:
        cur = await conn.execute(sql, params)
        return await cur.fetchall()


async def call_fn(pool: AsyncConnectionPool, fn: str, *args: Any) -> Any:
    """Chama uma função SQL (`schema.nome`) e devolve o valor da primeira coluna."""
    placeholders = ", ".join(["%s"] * len(args))
    row = await fetch_one(pool, f"select {fn}({placeholders}) as r", tuple(jb(a) if isinstance(a, (dict, list)) else a for a in args))
    return row["r"] if row else None
