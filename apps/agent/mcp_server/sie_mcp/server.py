"""Servidor MCP do SIÉ JOY OS (StreamableHTTP) — as ferramentas seguras que o Hermes usa para atender clientes.

Modelo de segurança (plano §1.4):
  • Toda ferramenta recebe `ctx`: o token JWT assinado pelo roteador (10 min). Aqui conferimos assinatura, validade e a permissão da ferramenta;
    a organização, a cliente e a conversa vêm SÓ do token — qualquer id parecido enviado pelo modelo é descartado no banco.
  • A execução é uma única função SQL, `agent.call_tool`, chamada como a role `agent_rpc` (sem acesso a tabelas). Regras de negócio
    (limites de reserva, teto de pedido, confirmação da cliente, janela de envio) são do banco, não deste servidor.
  • Cada chamada fica registrada em `ai.tool_calls` (o próprio banco grava) e o resultado devolvido ao modelo é o mesmo que o validador
    de guardrails usa depois para conferir preços e estoque citados.
  • O endpoint só aceita `Authorization: Bearer <SIE_MCP_KEY>` e deve ficar na rede interna do Docker.
"""
from __future__ import annotations

import hmac
import json
import logging
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated, Any, Literal

import jwt
import psycopg
import uvicorn
from mcp.server.mcpserver import MCPServer
from mcp.server.transport_security import TransportSecuritySettings
from pydantic import BaseModel, Field
from starlette.applications import Starlette
from starlette.routing import Mount
from starlette.types import ASGIApp, Receive, Scope, Send

from sie_agent_contract import BY_NAME, verify_ctx

from .config import Settings, get_settings
from .db import AgentDb

log = logging.getLogger("sie_mcp")

CTX = Annotated[str, Field(description="Token de contexto informado no prompt de sistema desta conversa (copie exatamente, sem alterar)")]


class OrderItem(BaseModel):
    variant_id: str = Field(description="UUID da variante (vem de search_catalog/check_stock_by_size)")
    qty: float = Field(default=1, ge=1, le=5)


def _err(message: str, code: str) -> dict[str, Any]:
    return {"ok": False, "error": message, "code": code}


class Invoker:
    """Confere o token e repassa ao banco. Nunca levanta para o modelo: erro de negócio volta como dado ({ok:false,...})."""

    def __init__(self, settings: Settings, db: AgentDb) -> None:
        self._settings, self._db = settings, db

    async def __call__(self, token: str, tool: str, args: dict[str, Any]) -> dict[str, Any]:
        t0 = time.monotonic()
        try:
            claims = verify_ctx(self._settings.agent_ctx_secret, token)
        except jwt.ExpiredSignatureError:
            return _err("O contexto desta execução expirou; a resposta deve ser encaminhada a uma pessoa.", "CTX_EXPIRED")
        except jwt.InvalidTokenError:
            return _err("Contexto inválido.", "CTX_INVALID")
        if tool not in claims["caps"]:
            return _err(f"A ferramenta {tool} não é permitida neste atendimento.", "FORBIDDEN")
        ctx = {k: claims.get(k) for k in ("org", "conv", "party", "run", "version", "caps")}
        clean = {k: v for k, v in args.items() if v is not None}
        try:
            result = await self._db.call_tool(ctx, tool, clean)
        except psycopg.Error as e:                          # ex.: 42501 — o contexto não confere com a conversa (o banco revalida)
            log.warning("tool=%s conv=%s falhou no banco: %s", tool, claims.get("conv"), getattr(e, "sqlstate", None))
            return _err("O contexto não confere com esta conversa.", getattr(e, "sqlstate", None) or "DB_ERROR")
        log.info(json.dumps({"tool": tool, "conv": claims.get("conv"), "run": claims.get("run"), "ok": bool(result.get("ok")), "ms": int((time.monotonic() - t0) * 1000)}))
        return result


def _desc(name: str) -> str:
    return BY_NAME[name]["function"]["description"]


def build_server(settings: Settings, db: AgentDb) -> MCPServer:
    mcp = MCPServer(
        "sie", instructions="Ferramentas do atendimento da SIÉ JOY. Toda chamada exige o parâmetro ctx (token do prompt de sistema). Termine sempre com propose_reply.",
        log_level=settings.log_level,  # type: ignore[arg-type]
    )
    call = Invoker(settings, db)

    @mcp.tool(description=_desc("search_catalog"))
    async def search_catalog(ctx: CTX, query: str, category: str | None = None, color: str | None = None, price_max: float | None = None, in_stock_only: bool = True) -> dict[str, Any]:
        return await call(ctx, "search_catalog", {"query": query, "category": category, "color": color, "price_max": price_max, "in_stock_only": in_stock_only})

    @mcp.tool(description=_desc("check_stock_by_size"))
    async def check_stock_by_size(ctx: CTX, product_id: str | None = None, variant_id: str | None = None, sku: str | None = None, color: str | None = None) -> dict[str, Any]:
        return await call(ctx, "check_stock_by_size", {"product_id": product_id, "variant_id": variant_id, "sku": sku, "color": color})

    @mcp.tool(description=_desc("get_customer_360"))
    async def get_customer_360(ctx: CTX) -> dict[str, Any]:
        return await call(ctx, "get_customer_360", {})

    @mcp.tool(description=_desc("get_order_status"))
    async def get_order_status(ctx: CTX, number: str | None = None) -> dict[str, Any]:
        return await call(ctx, "get_order_status", {"number": number})

    @mcp.tool(description=_desc("get_policies"))
    async def get_policies(ctx: CTX, topic: str | None = None) -> dict[str, Any]:
        return await call(ctx, "get_policies", {"topic": topic})

    @mcp.tool(description=_desc("apply_coupon"))
    async def apply_coupon(ctx: CTX, code: str, subtotal: float) -> dict[str, Any]:
        return await call(ctx, "apply_coupon", {"code": code, "subtotal": subtotal})

    @mcp.tool(description=_desc("create_reservation"))
    async def create_reservation(ctx: CTX, variant_id: str, qty: float | None = None, hold_hours: int | None = None) -> dict[str, Any]:
        return await call(ctx, "create_reservation", {"variant_id": variant_id, "qty": qty, "hold_hours": hold_hours})

    @mcp.tool(description=_desc("schedule_locker"))
    async def schedule_locker(ctx: CTX, items: Annotated[list[OrderItem], Field(min_length=1, max_length=5)], when: str | None = None, notes: str | None = None) -> dict[str, Any]:
        return await call(ctx, "schedule_locker", {"items": [i.model_dump() for i in items], "when": when, "notes": notes})

    @mcp.tool(description=_desc("create_order_draft"))
    async def create_order_draft(ctx: CTX, items: Annotated[list[OrderItem], Field(min_length=1, max_length=5)], coupon_code: str | None = None,
                                 fulfillment_type: Literal["MOTOBOY", "CARRIER", "STORE_PICKUP", "LOCKER_PICKUP"] | None = None, shipping_total: float | None = None) -> dict[str, Any]:
        return await call(ctx, "create_order_draft", {"items": [i.model_dump() for i in items], "coupon_code": coupon_code, "fulfillment_type": fulfillment_type, "shipping_total": shipping_total})

    @mcp.tool(description=_desc("confirm_order_draft"))
    async def confirm_order_draft(ctx: CTX, order_id: str, customer_message_id: str) -> dict[str, Any]:
        return await call(ctx, "confirm_order_draft", {"order_id": order_id, "customer_message_id": customer_message_id})

    @mcp.tool(description=_desc("create_payment_link"))
    async def create_payment_link(ctx: CTX, order_id: str, max_installments: int | None = None) -> dict[str, Any]:
        return await call(ctx, "create_payment_link", {"order_id": order_id, "max_installments": max_installments})

    @mcp.tool(description=_desc("register_consent"))
    async def register_consent(ctx: CTX, purpose: Literal["MARKETING_WHATSAPP", "MARKETING_EMAIL", "MARKETING_IG", "AI_PROFILING"], granted: bool, message_id: str | None = None) -> dict[str, Any]:
        return await call(ctx, "register_consent", {"purpose": purpose, "granted": granted, "message_id": message_id})

    @mcp.tool(description=_desc("update_customer_profile"))
    async def update_customer_profile(ctx: CTX, sizes: dict[str, Any] | None = None, preferences: dict[str, Any] | None = None, birth_date: str | None = None, city: str | None = None) -> dict[str, Any]:
        return await call(ctx, "update_customer_profile", {"sizes": sizes, "preferences": preferences, "birth_date": birth_date, "city": city})

    @mcp.tool(description=_desc("remember_customer_fact"))
    async def remember_customer_fact(ctx: CTX, fact: str, category: str | None = None, message_id: str | None = None) -> dict[str, Any]:
        return await call(ctx, "remember_customer_fact", {"fact": fact, "category": category, "message_id": message_id})

    @mcp.tool(description=_desc("request_handoff"))
    async def request_handoff(ctx: CTX, reason_code: Literal["COMPLAINT", "PRICE_NEGOTIATION", "DEFECT", "B2B", "PAYMENT_PROBLEM", "PRESS_PARTNERSHIP", "HIGH_VALUE", "OUT_OF_SCOPE", "OTHER"],
                              summary: str, urgency: Literal["NORMAL", "HIGH"] = "NORMAL") -> dict[str, Any]:
        return await call(ctx, "request_handoff", {"reason_code": reason_code, "summary": summary, "urgency": urgency})

    @mcp.tool(description=_desc("propose_reply"))
    async def propose_reply(ctx: CTX, messages: Annotated[list[Annotated[str, Field(max_length=600)]], Field(min_length=1, max_length=3)],
                            confidence: Annotated[float, Field(ge=0, le=1)], intent: str | None = None, stage: str | None = None,
                            needs_human: bool = False, reason: str | None = None) -> dict[str, Any]:
        return await call(ctx, "propose_reply", {"messages": messages, "confidence": confidence, "intent": intent, "stage": stage, "needs_human": needs_human, "reason": reason})

    return mcp


class BearerAuth:
    """ASGI: exige `Authorization: Bearer <chave>` (comparação em tempo constante); `/healthz` é público (só informa que está de pé)."""

    def __init__(self, app: ASGIApp, key: str) -> None:
        self._app, self._expected = app, f"Bearer {key}".encode()

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http":
            if scope["path"] == "/healthz":
                await _respond(send, 200, b'{"status":"ok"}')
                return
            got = dict(scope["headers"]).get(b"authorization", b"")
            if not hmac.compare_digest(got, self._expected):
                await _respond(send, 401, b'{"error":"unauthorized"}', [(b"www-authenticate", b"Bearer")])
                return
        await self._app(scope, receive, send)


async def _respond(send: Send, status: int, body: bytes, extra: list[tuple[bytes, bytes]] | None = None) -> None:
    await send({"type": "http.response.start", "status": status, "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode()), *(extra or [])]})
    await send({"type": "http.response.body", "body": body})


def build_app(settings: Settings, db: AgentDb) -> Starlette:
    """App ASGI completo: autenticação Bearer na frente do endpoint MCP; o ciclo de vida abre/fecha o pool do banco e o gerenciador de sessões."""
    server = build_server(settings, db)
    security = TransportSecuritySettings(enable_dns_rebinding_protection=bool(settings.mcp_allowed_hosts), allowed_hosts=settings.mcp_allowed_hosts)
    inner = server.streamable_http_app(streamable_http_path=settings.mcp_path, transport_security=security, host=settings.mcp_host)

    @asynccontextmanager
    async def lifespan(_: Starlette) -> AsyncIterator[None]:
        await db.open()
        try:
            async with inner.router.lifespan_context(inner):
                yield
        finally:
            await db.close()

    return Starlette(routes=[Mount("/", app=BearerAuth(inner, settings.mcp_key))], lifespan=lifespan)


def main() -> None:
    settings = get_settings()
    settings.require_secrets()
    logging.basicConfig(level=settings.log_level, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    app = build_app(settings, AgentDb.from_url(settings.agent_database_url, settings.db_pool_max))
    uvicorn.run(app, host=settings.mcp_host, port=settings.mcp_port, log_level=settings.log_level.lower())


if __name__ == "__main__":
    main()
