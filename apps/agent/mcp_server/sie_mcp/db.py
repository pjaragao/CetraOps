"""Acesso ao banco como `agent_rpc`: uma única porta — agent.call_tool(ctx, tool, args)."""
from __future__ import annotations

from typing import Any

from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import AsyncConnectionPool


class AgentDb:
    def __init__(self, pool: Any) -> None:
        self._pool = pool

    @classmethod
    def from_url(cls, url: str, max_size: int = 5) -> AgentDb:
        return cls(AsyncConnectionPool(url, min_size=1, max_size=max_size, kwargs={"row_factory": dict_row, "autocommit": True}, open=False))

    async def open(self) -> None:
        await self._pool.open(wait=True)

    async def close(self) -> None:
        await self._pool.close()

    async def call_tool(self, ctx: dict[str, Any], tool: str, args: dict[str, Any]) -> dict[str, Any]:
        async with self._pool.connection() as conn:
            cur = await conn.execute("select agent.call_tool(%s, %s, %s) as r", (Jsonb(ctx), tool, Jsonb(args)))
            row = await cur.fetchone()
        return row["r"]
