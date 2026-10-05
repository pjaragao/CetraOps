"""Servidor MCP: contrato com o worker, verificação do token, autenticação e a chamada real ao banco como `agent_rpc`."""
from __future__ import annotations

import json
from typing import Any

import httpx
import psycopg
import pytest
from mcp import Client

from centralops_agent_contract import BY_NAME, CONCIERGE_CAPS, COPILOT_CAPS, sign_ctx
from centralops_mcp.config import Settings
from centralops_mcp.db import AgentDb
from centralops_mcp.server import Invoker, build_app, build_server

from .conftest import CTX_SECRET, MCP_KEY, ORG, TxPool


class FakeDb:
    def __init__(self, result: dict[str, Any] | Exception | None = None) -> None:
        self.calls: list[tuple[dict[str, Any], str, dict[str, Any]]] = []
        self.result = result if result is not None else {"ok": True}

    async def call_tool(self, ctx: dict[str, Any], tool: str, args: dict[str, Any]) -> dict[str, Any]:
        self.calls.append((ctx, tool, args))
        if isinstance(self.result, Exception):
            raise self.result
        return self.result

    async def open(self) -> None: ...
    async def close(self) -> None: ...


def token(caps: list[str] | None = None, **kw: Any) -> str:
    base = {"org": "o1", "conv": "c1", "party": "p1", "run": "r1", "version": 4, "caps": caps if caps is not None else CONCIERGE_CAPS}
    return sign_ctx(CTX_SECRET, **{**base, **kw})


def result_of(res: Any) -> dict[str, Any]:
    sc = res.structured_content
    if isinstance(sc, dict):
        return sc.get("result", sc) if set(sc) == {"result"} else sc
    return json.loads(res.content[0].text)


# ---------------------------------------------------------------------------------------------------------------------------------------------
# Contrato: o que o Hermes vê é o mesmo que o Plano B do worker vê
# ---------------------------------------------------------------------------------------------------------------------------------------------
async def test_tools_match_the_shared_contract(settings: Settings) -> None:
    server = build_server(settings, FakeDb())  # type: ignore[arg-type]
    tools = {t.name: t for t in await server.list_tools()}
    assert set(tools) == set(BY_NAME) == set(CONCIERGE_CAPS)
    for name, t in tools.items():
        contract = BY_NAME[name]["function"]
        props, required = set(t.input_schema["properties"]), set(t.input_schema.get("required", []))
        assert "ctx" in props and "ctx" in required, f"{name}: ctx obrigatório"
        assert props - {"ctx"} == set(contract["parameters"]["properties"]), f"{name}: parâmetros divergentes do contrato"
        assert required - {"ctx"} == set(contract["parameters"]["required"]), f"{name}: obrigatórios divergentes do contrato"
        assert t.description == contract["description"]


# ---------------------------------------------------------------------------------------------------------------------------------------------
# Verificação do token e repasse ao banco (sem banco: FakeDb)
# ---------------------------------------------------------------------------------------------------------------------------------------------
async def test_valid_call_forwards_only_token_ids_and_drops_nulls(settings: Settings) -> None:
    db = FakeDb({"ok": True, "products": []})
    async with Client(build_server(settings, db)) as client:  # type: ignore[arg-type]
        res = await client.call_tool("search_catalog", {"ctx": token(), "query": "legging", "color": "preta"})
    assert result_of(res) == {"ok": True, "products": []}
    ctx, tool, args = db.calls[0]
    assert tool == "search_catalog" and args == {"query": "legging", "color": "preta", "in_stock_only": True}      # nulos não seguem
    assert ctx == {"org": "o1", "conv": "c1", "party": "p1", "run": "r1", "version": 4, "caps": CONCIERGE_CAPS}


async def test_model_supplied_party_cannot_override_the_token(settings: Settings) -> None:
    db = FakeDb()
    async with Client(build_server(settings, db)) as client:  # type: ignore[arg-type]
        try:
            await client.call_tool("get_customer_360", {"ctx": token(), "party_id": "OUTRA-CLIENTE"})
        except Exception:                                                     # a validação do MCP pode recusar o parâmetro desconhecido…
            pass
    assert all("party_id" not in args and ctx["party"] == "p1" for ctx, _, args in db.calls)   # …e, se passar, nunca chega ao banco nem vale


@pytest.mark.parametrize("tok,code", [
    ("lixo", "CTX_INVALID"),
    (sign_ctx("segredo-errado-com-pelo-menos-32-bytes!", org="o", conv="c", party="p", run="r", version=1, caps=CONCIERGE_CAPS), "CTX_INVALID"),
    (sign_ctx(CTX_SECRET, org="o", conv="c", party="p", run="r", version=1, caps=CONCIERGE_CAPS, now=1_000_000), "CTX_EXPIRED"),
])
async def test_bad_tokens_never_reach_the_database(settings: Settings, tok: str, code: str) -> None:
    db = FakeDb()
    res = await Invoker(settings, db)(tok, "get_customer_360", {})  # type: ignore[arg-type]
    assert res["ok"] is False and res["code"] == code and db.calls == []


async def test_tool_outside_the_token_capabilities_is_forbidden(settings: Settings) -> None:
    db = FakeDb()
    res = await Invoker(settings, db)(token(COPILOT_CAPS), "create_payment_link", {"order_id": "x"})  # type: ignore[arg-type]
    assert res == {"ok": False, "error": "A ferramenta create_payment_link não é permitida neste atendimento.", "code": "FORBIDDEN"} and db.calls == []


async def test_database_privilege_error_is_returned_as_data(settings: Settings) -> None:
    db = FakeDb(psycopg.errors.InsufficientPrivilege("contexto inválido"))
    res = await Invoker(settings, db)(token(), "get_customer_360", {})  # type: ignore[arg-type]
    assert res["ok"] is False and res["code"] == "42501"


async def test_nested_items_are_validated_and_forwarded(settings: Settings) -> None:
    db = FakeDb({"ok": True})
    async with Client(build_server(settings, db)) as client:  # type: ignore[arg-type]
        await client.call_tool("create_order_draft", {"ctx": token(), "items": [{"variant_id": "v1", "qty": 2}], "fulfillment_type": "MOTOBOY"})
        for bad in ({"items": [{"variant_id": "v1", "qty": 99}]}, {"items": [{"variant_id": "v1"}], "fulfillment_type": "DRONE"}):
            try:
                await client.call_tool("create_order_draft", {"ctx": token(), **bad})
            except Exception:
                pass
    assert len(db.calls) == 1 and db.calls[0][2]["items"] == [{"variant_id": "v1", "qty": 2.0}]      # os inválidos não chegam ao banco


# ---------------------------------------------------------------------------------------------------------------------------------------------
# Autenticação HTTP e configuração
# ---------------------------------------------------------------------------------------------------------------------------------------------
async def test_http_requires_the_bearer_key(settings: Settings) -> None:
    app = build_app(settings, FakeDb())  # type: ignore[arg-type]
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://centralops-mcp:8000") as http:
            assert (await http.get("/healthz")).status_code == 200
            for headers in ({}, {"Authorization": "Bearer errada"}, {"Authorization": MCP_KEY}):
                r = await http.post("/mcp", json={}, headers=headers)
                assert r.status_code == 401 and r.headers["www-authenticate"] == "Bearer"
            ok = await http.post("/mcp", json={}, headers={"Authorization": f"Bearer {MCP_KEY}", "Accept": "application/json, text/event-stream"})
            assert ok.status_code != 401                                        # passou pela autenticação (o corpo vazio é que não é MCP válido)


def test_startup_refuses_weak_or_missing_secrets() -> None:
    with pytest.raises(SystemExit):
        Settings(agent_ctx_secret="", mcp_key="").require_secrets()
    with pytest.raises(SystemExit):
        Settings(agent_ctx_secret="x" * 32, mcp_key="curta").require_secrets()
    Settings(agent_ctx_secret="x" * 32, mcp_key="k" * 16).require_secrets()


# ---------------------------------------------------------------------------------------------------------------------------------------------
# Banco de verdade, como a role `agent_rpc` (sem acesso a tabelas)
# ---------------------------------------------------------------------------------------------------------------------------------------------
@pytest.mark.db
async def test_real_database_round_trip_as_agent_rpc(txpool: TxPool, db: AgentDb, settings: Settings, scenario: dict[str, Any]) -> None:
    async with Client(build_server(settings, db)) as client:
        who = result_of(await client.call_tool("get_customer_360", {"ctx": scenario["token"]}))
        assert who["ok"] is True and "cpf" not in json.dumps(who).lower()
        found = result_of(await client.call_tool("search_catalog", {"ctx": scenario["token"], "query": "legging"}))
        assert found["ok"] is True and found["products"] and found["products"][0]["price"] > 0
        proposed = result_of(await client.call_tool("propose_reply", {"ctx": scenario["token"], "messages": ["Oi! Já te mostro as opções.", "Qual tamanho você usa?"], "confidence": 0.8, "intent": "STOCK"}))
        assert proposed == {"ok": True, "accepted": True, "messages": 2}
        bad = result_of(await client.call_tool("apply_coupon", {"ctx": scenario["token"], "code": "NAO-EXISTE", "subtotal": 100}))
        assert bad["ok"] is False and bad["code"]                                            # regra de negócio volta como dado, não como exceção
    await txpool.sql("reset role")
    rows = await txpool.sql("select array_agg(tool order by id) as tools, bool_and(ok) filter (where tool <> 'apply_coupon') as good from ai.tool_calls where run_id = %s", (scenario["run"],))
    assert rows and rows["tools"] == ["get_customer_360", "search_catalog", "propose_reply", "apply_coupon"] and rows["good"] is True   # tudo auditado


@pytest.mark.db
async def test_real_database_rejects_a_token_for_someone_elses_conversation(txpool: TxPool, db: AgentDb, settings: Settings, scenario: dict[str, Any]) -> None:
    await txpool.sql("reset role")
    row = await txpool.sql("select crm.resolve_identity(%s, 'WHATSAPP', %s, 'Outra Cliente (teste)', 'TEST') as id", (ORG, "5548911110000"))
    await txpool.sql("set local role agent_rpc")
    assert row
    forged = sign_ctx(CTX_SECRET, org=scenario["org"], conv=scenario["conv"], party=str(row["id"]), run=scenario["run"], version=scenario["version"], caps=CONCIERGE_CAPS)
    res = await Invoker(settings, db)(forged, "get_customer_360", {})
    assert res["ok"] is False and res["code"] == "42501"                                     # a cliente do token não é a da conversa


@pytest.mark.db
async def test_agent_role_has_no_direct_table_access(txpool: TxPool, scenario: dict[str, Any]) -> None:
    for sql in ("select count(*) from crm.parties", "select * from ai.tool_calls", "select * from omni.messages", "select * from sales.orders"):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            await txpool.sql(sql)
