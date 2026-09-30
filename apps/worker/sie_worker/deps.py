"""Dependências compartilhadas pelos handlers (facilita testar com fakes)."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import httpx
from psycopg_pool import AsyncConnectionPool

from .ai.agent import AgentClient
from .config import Settings
from .db import call_fn


@dataclass
class Deps:
    pool: AsyncConnectionPool
    settings: Settings
    http: httpx.AsyncClient
    agent: AgentClient | None = None

    async def secret(self, connection_id: str | None) -> dict[str, Any]:
        """Segredo da integração (Vault). Vazio quando a conexão não foi configurada."""
        if not connection_id:
            return {}
        return (await call_fn(self.pool, "core.integration_secret", connection_id)) or {}

    async def notify(self, org_id: str, kind: str, title: str, payload: dict[str, Any] | None = None, perm: str | None = None, member: str | None = None) -> int:
        return int(await call_fn(self.pool, "core.notify", org_id, kind, title, payload or {}, perm, member) or 0)
