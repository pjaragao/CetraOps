"""O contrato é a fonte única: perfis, esquemas e as funções do banco precisam falar das mesmas ferramentas."""
from __future__ import annotations

import re
from pathlib import Path

import jwt
import pytest

from sie_agent_contract import BY_NAME, CONCIERGE_CAPS, COPILOT_CAPS, TOOLS, schemas_for, sign_ctx, verify_ctx

SECRET = "contract-secret-with-at-least-32-bytes"
MIGRATION = Path(__file__).resolve().parents[4] / "supabase" / "migrations" / "20260930002300_agent_rpcs.sql"


def test_every_capability_has_a_schema_and_vice_versa() -> None:
    assert sorted(CONCIERGE_CAPS) == sorted(BY_NAME) and len(TOOLS) == len(BY_NAME) == len(CONCIERGE_CAPS)
    assert set(COPILOT_CAPS) < set(CONCIERGE_CAPS) and "propose_reply" in COPILOT_CAPS
    for name, t in BY_NAME.items():
        fn = t["function"]
        assert fn["name"] == name and fn["description"] and fn["parameters"]["additionalProperties"] is False
        assert set(fn["parameters"]["required"]) <= set(fn["parameters"]["properties"])


def test_copilot_cannot_write_orders_reservations_or_links() -> None:
    assert not {"create_order_draft", "confirm_order_draft", "create_payment_link", "create_reservation", "schedule_locker"} & set(COPILOT_CAPS)


def test_database_dispatch_matches_the_contract() -> None:
    sql = MIGRATION.read_text(encoding="utf-8")
    dispatched = set(re.findall(r"when '(\w+)' then agent\.t_", sql))
    assert dispatched == set(CONCIERGE_CAPS)


def test_schemas_for_filters_by_capability() -> None:
    assert [t["function"]["name"] for t in schemas_for(["propose_reply", "nao_existe", "search_catalog"])] == ["propose_reply", "search_catalog"]


def test_token_roundtrip_expiry_and_required_claims() -> None:
    tok = sign_ctx(SECRET, org="o", conv="c", party="p", run="r", version=3, caps=COPILOT_CAPS, mode="AI_COPILOT")
    data = verify_ctx(SECRET, tok)
    assert (data["org"], data["conv"], data["party"], data["run"], data["version"]) == ("o", "c", "p", "r", 3) and data["exp"] - data["iat"] == 600
    with pytest.raises(jwt.ExpiredSignatureError):
        verify_ctx(SECRET, sign_ctx(SECRET, org="o", conv="c", party="p", run="r", version=1, caps=[], now=1_000_000))
    with pytest.raises(jwt.InvalidTokenError):
        verify_ctx("another-secret-with-at-least-32-bytes!!", tok)
    with pytest.raises(jwt.InvalidTokenError):                                            # sem os campos exigidos
        verify_ctx(SECRET, jwt.encode({"exp": 9_999_999_999}, SECRET, algorithm="HS256"))
    with pytest.raises(jwt.InvalidTokenError):                                            # algoritmo "none" nunca é aceito
        verify_ctx(SECRET, jwt.encode({"org": "o", "conv": "c", "party": "p", "caps": [], "exp": 9_999_999_999}, None, algorithm="none"))
