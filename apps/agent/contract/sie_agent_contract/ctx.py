"""Token de contexto do agente: JWT HS256 assinado pelo roteador (10 min). O servidor MCP e o banco só confiam no que está aqui —
IDs de cliente/conversa vindos do modelo são ignorados."""
from __future__ import annotations

import time
from typing import Any

import jwt

ALGORITHM = "HS256"
TTL_SECONDS = 600

# Ferramentas liberadas por perfil (o perfil 'concierge' atende clientes; nenhuma ferramenta financeira)
CONCIERGE_CAPS = [
    "search_catalog", "check_stock_by_size", "get_customer_360", "get_order_status", "get_policies", "search_knowledge", "apply_coupon", "create_reservation", "schedule_locker",
    "create_order_draft", "confirm_order_draft", "create_payment_link", "register_consent", "update_customer_profile", "remember_customer_fact",
    "request_handoff", "propose_reply",
]
# Rascunho/copiloto não cria pedido nem link sozinho: só consulta e propõe (a vendedora executa a partir do rascunho)
COPILOT_CAPS = [c for c in CONCIERGE_CAPS if c not in {"create_order_draft", "confirm_order_draft", "create_payment_link", "create_reservation", "schedule_locker"}]


def sign_ctx(secret: str, *, org: str, conv: str, party: str, run: str, version: int, caps: list[str], persona_version: str | None = None,
             mode: str = "AI_COPILOT", now: float | None = None) -> str:
    iat = int(now if now is not None else time.time())
    payload: dict[str, Any] = {
        "org": org, "conv": conv, "party": party, "run": run, "version": version, "caps": caps, "mode": mode,
        "persona_version": persona_version, "iat": iat, "exp": iat + TTL_SECONDS,
    }
    return jwt.encode(payload, secret, algorithm=ALGORITHM)


def verify_ctx(secret: str, token: str) -> dict[str, Any]:
    """Levanta jwt.InvalidTokenError se a assinatura ou a validade não conferem."""
    return jwt.decode(token, secret, algorithms=[ALGORITHM], options={"require": ["exp", "org", "conv", "party", "caps"]})
