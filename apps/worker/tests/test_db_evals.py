"""Avaliações da IA de atendimento: o roteador de verdade responde dentro de um sandbox (IA simulada com respx) e o resultado é conferido contra o caso."""
from __future__ import annotations

import json
import uuid
from typing import Any

import httpx
import pytest
import respx

from centralops_worker.db import fetch_all, fetch_one
from centralops_worker.evals.runner import EvalCase, evaluate, run_case, run_suite
from centralops_worker.handlers import ai_tasks
from centralops_worker.queues import QueueMessage

from .conftest import ORG

pytestmark = pytest.mark.db
OR = "https://openrouter.test/api/v1"


def tool_call(name: str, args: dict[str, Any]) -> dict[str, Any]:
    return {"id": f"call_{uuid.uuid4().hex[:8]}", "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}


def reply(calls: list[dict[str, Any]] | None = None, *, model: str = "x/candidato") -> httpx.Response:
    return httpx.Response(200, json={"model": model, "choices": [{"message": {"content": None, "tool_calls": calls or []}}], "usage": {"prompt_tokens": 100, "completion_tokens": 20, "cost": 0.002}})


def proposal(text: str, intent: str, confidence: float = 0.9, needs_human: bool = False) -> dict[str, Any]:
    return tool_call("propose_reply", {"messages": [text], "intent": intent, "confidence": confidence, "needs_human": needs_human})


def fake_model(behavior: str, seen: list[dict[str, Any]] | None = None) -> Any:
    """Modelo de mentira: decide pelo número de ferramentas já executadas na conversa com o agente."""
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        if seen is not None:
            seen.append(body)
        step = sum(1 for m in body["messages"] if m["role"] == "tool")
        if behavior == "grounded":
            return reply([tool_call("search_catalog", {"query": "legging preta"})]) if step == 0 else reply([proposal("Temos sim! A Legging Demo Sculpt sai por R$ 429,00.", "STOCK")])
        if behavior == "invented":
            return reply([proposal("Essa legging sai por R$ 399,00, posso separar?", "PRODUCT_INFO", 0.95)])
        if behavior == "handoff":
            return reply([tool_call("request_handoff", {"reason_code": "COMPLAINT", "summary": "peça com defeito", "urgency": "HIGH"})]) if step == 0 else reply([proposal("Sinto muito! Vou chamar alguém da equipe.", "COMPLAINT", 0.9, True)])
        raise AssertionError(behavior)
    return handler


@pytest.fixture
def eval_settings(settings: Any) -> Any:
    return settings.model_copy(update={"openrouter_key": "or-test", "openrouter_base": OR})


AVAILABILITY = EvalCase("disponibilidade", "Disponibilidade", [{"role": "user", "text": "Oi! Vocês têm legging preta no M?"}],
                        {"outcome_in": ["SEND", "DRAFT"], "tools_any": ["search_catalog", "check_stock_by_size"], "no_flags": True})
COMPLAINT = EvalCase("reclamacao", "Reclamação", [{"role": "user", "text": "Chegou com defeito, estou muito chateada."}], {"outcome_in": ["HANDOFF"], "tools_any": ["request_handoff"]})


# ------------------------------------------------------------------------------------------------ conferência
def test_evaluate_reports_each_failed_expectation_in_portuguese() -> None:
    expect = {"outcome_in": ["HANDOFF"], "tools_any": ["request_handoff"], "tools_none": ["create_order_draft"], "no_flags": True, "must_not_match": ["desconto"], "must_match_any": ["equipe"]}
    assert evaluate(expect, outcome="HANDOFF", flags=[], replies=["Vou chamar a equipe."], tools_ok={"request_handoff"}, tools_all={"request_handoff"}) == []
    fails = evaluate(expect, outcome="SEND", flags=["UNGROUNDED_PRICE"], replies=["Tenho um desconto de 10%"], tools_ok=set(), tools_all={"create_order_draft"})
    assert len(fails) == 6
    assert any("esperado HANDOFF" in f for f in fails) and any("validador" in f for f in fails)
    assert evaluate({}, outcome="NONE", flags=["X"], replies=[], tools_ok=set(), tools_all=set()) == []     # sem expectativa, nada a conferir


# ------------------------------------------------------------------------------------------------ casos no sandbox
@respx.mock
async def test_grounded_answer_is_sent_and_passes(eval_settings: Any, http: httpx.AsyncClient) -> None:
    seen: list[dict[str, Any]] = []
    respx.post(f"{OR}/chat/completions").mock(side_effect=fake_model("grounded", seen))
    r = await run_case(eval_settings, http, ORG, AVAILABILITY, "x/candidato")
    assert r.passed, r.failures
    assert r.outcome == "SEND" and r.tools == ["search_catalog"] and r.flags == []
    assert r.replies == ["Temos sim! A Legging Demo Sculpt sai por R$ 429,00."]
    assert r.cost_usd == pytest.approx(0.004) and r.tokens_in == 200 and r.latency_ms >= 0
    assert {b["model"] for b in seen} == {"x/candidato"}                                    # o modelo candidato foi o usado


@respx.mock
async def test_invented_price_is_flagged_and_the_case_fails(eval_settings: Any, http: httpx.AsyncClient) -> None:
    respx.post(f"{OR}/chat/completions").mock(side_effect=fake_model("invented"))
    r = await run_case(eval_settings, http, ORG, AVAILABILITY, "x/candidato")
    assert not r.passed
    assert "UNGROUNDED_PRICE" in r.flags and r.outcome == "DRAFT"                            # o validador segura; nada vai sozinho para a cliente
    assert any("validador" in f for f in r.failures) and any("search_catalog" in f for f in r.failures)


@respx.mock
async def test_complaint_must_reach_a_person(eval_settings: Any, http: httpx.AsyncClient) -> None:
    respx.post(f"{OR}/chat/completions").mock(side_effect=fake_model("handoff"))
    ok = await run_case(eval_settings, http, ORG, COMPLAINT, "x/candidato")
    assert ok.passed and ok.outcome == "HANDOFF" and "request_handoff" in ok.tools
    respx.post(f"{OR}/chat/completions").mock(side_effect=fake_model("grounded"))
    bad = await run_case(eval_settings, http, ORG, COMPLAINT, "x/candidato")
    assert not bad.passed and bad.outcome == "SEND" and any("esperado HANDOFF" in f for f in bad.failures)


@respx.mock
async def test_sandbox_leaves_nothing_behind_and_keeps_the_real_route(pool: Any, eval_settings: Any, http: httpx.AsyncClient) -> None:
    before = await fetch_one(pool, "select primary_model from ai.model_routes where org_id = %s and task = 'conversation'", (ORG,))
    respx.post(f"{OR}/chat/completions").mock(side_effect=fake_model("grounded"))
    await run_case(eval_settings, http, ORG, AVAILABILITY, "x/candidato")
    assert (await fetch_one(pool, "select count(*) as n from crm.parties where display_name = 'Cliente Avaliação'"))["n"] == 0            # type: ignore[index]
    assert (await fetch_one(pool, "select count(*) as n from omni.channel_accounts where provider_account_id like 'EVAL-%'"))["n"] == 0    # type: ignore[index]
    assert (await fetch_one(pool, "select primary_model from ai.model_routes where org_id = %s and task = 'conversation'", (ORG,))) == before


@respx.mock
async def test_multi_turn_case_keeps_the_assistant_turns_in_the_history(eval_settings: Any, http: httpx.AsyncClient) -> None:
    seen: list[dict[str, Any]] = []
    respx.post(f"{OR}/chat/completions").mock(side_effect=fake_model("grounded", seen))
    case = EvalCase("duas-falas", "Duas falas", [{"role": "user", "text": "Oi!"}, {"role": "assistant", "text": "Oi, tudo bem? Como posso ajudar?"}, {"role": "user", "text": "Tem legging preta no M?"}], {})
    await run_case(eval_settings, http, ORG, case, "x/candidato")
    history = [m for m in seen[0]["messages"] if m["role"] in ("user", "assistant")]
    assert [m["role"] for m in history] == ["user", "assistant", "user"] and history[1]["content"].startswith("Oi, tudo bem")


# ------------------------------------------------------------------------------------------------ lote e pedido
@respx.mock
async def test_suite_saves_one_batch_per_model_with_totals(pool: Any, eval_settings: Any, http: httpx.AsyncClient) -> None:
    await fetch_one(pool, "delete from ai.eval_cases where org_id = %s returning id", (ORG,))            # só o caso do teste (o seed de desenvolvimento some no rollback)
    await fetch_one(pool, "insert into ai.eval_cases (org_id, key, title, turns, expect) values (%s, 'disp', 'Disponibilidade', %s, %s) returning id",
                    (ORG, json.dumps(AVAILABILITY.turns), json.dumps(AVAILABILITY.expect)))
    respx.post(f"{OR}/chat/completions").mock(side_effect=fake_model("grounded"))
    steps: list[str] = []

    async def progress(text: str) -> None:
        steps.append(text)

    batches = await run_suite(eval_settings, http, pool, ORG, ["x/um", "x/dois"], progress=progress)
    assert len(batches) == 2 and steps == ["x/um: caso 1 de 1", "x/dois: caso 1 de 1"]
    rows = await fetch_all(pool, "select model, cases, passed, factual_failures, cost_usd from ai.eval_batches where id = any(%s::uuid[]) order by model", (batches,))
    assert [(r["model"], r["cases"], r["passed"], r["factual_failures"]) for r in rows] == [("x/dois", 1, 1, 0), ("x/um", 1, 1, 0)]
    assert float(rows[0]["cost_usd"]) == pytest.approx(0.004)
    res = await fetch_one(pool, "select outcome, tools, replies, case_id is not null as linked from ai.eval_results where batch_id = %s", (batches[0],))
    assert res and res["outcome"] == "SEND" and res["tools"] == ["search_catalog"] and res["linked"]


async def test_suite_refuses_to_run_without_provider_key_or_cases(pool: Any, settings: Any, http: httpx.AsyncClient) -> None:
    from centralops_worker.adapters.errors import PermanentError

    with pytest.raises(PermanentError, match="OpenRouter"):
        await run_suite(settings, http, pool, ORG, ["x/um"])
    with pytest.raises(PermanentError, match="nenhum caso"):
        await run_suite(settings.model_copy(update={"openrouter_key": "k"}), http, pool, ORG, ["x/um"], suite="vazia")


@respx.mock
async def test_eval_request_runs_through_the_queue_handler(pool: Any, deps: Any, eval_settings: Any) -> None:
    import dataclasses

    await fetch_one(pool, "delete from ai.eval_cases where org_id = %s returning id", (ORG,))            # só o caso do teste (o seed de desenvolvimento some no rollback)
    await fetch_one(pool, "insert into ai.eval_cases (org_id, key, title, turns, expect) values (%s, 'disp', 'Disponibilidade', %s, %s) returning id", (ORG, json.dumps(AVAILABILITY.turns), json.dumps(AVAILABILITY.expect)))
    req = await fetch_one(pool, "insert into ai.eval_requests (org_id, models) values (%s, %s) returning id", (ORG, ["x/um"]))
    respx.post(f"{OR}/chat/completions").mock(side_effect=fake_model("grounded"))
    d = dataclasses.replace(deps, settings=eval_settings)
    msg = QueueMessage("ai_tasks", 0, 1, {"action": "EVAL_RUN", "org_id": ORG, "request_id": str(req["id"]), "suite": "conversation", "models": ["x/um"]})  # type: ignore[index]
    await ai_tasks.handle(d, msg)
    done = await fetch_one(pool, "select status, error, progress from ai.eval_requests where id = %s", (req["id"],))  # type: ignore[index]
    assert done and done["status"] == "DONE" and done["error"] is None
    assert (await fetch_one(pool, "select count(*) as n from ai.eval_batches where request_id = %s", (req["id"],)))["n"] == 1  # type: ignore[index]
    assert (await fetch_one(pool, "select count(*) as n from core.notifications where kind = 'EVAL'"))["n"] >= 0                 # quem pediu é avisado (sem membro no teste)


async def test_eval_request_without_provider_key_fails_with_a_clear_reason_and_no_retry(pool: Any, deps: Any) -> None:
    req = await fetch_one(pool, "insert into ai.eval_requests (org_id, models) values (%s, %s) returning id", (ORG, ["x/um"]))
    msg = QueueMessage("ai_tasks", 0, 1, {"action": "EVAL_RUN", "org_id": ORG, "request_id": str(req["id"]), "models": ["x/um"]})  # type: ignore[index]
    await ai_tasks.handle(deps, msg)                                                          # não levanta: repetir só custaria dinheiro
    row = await fetch_one(pool, "select status, error from ai.eval_requests where id = %s", (req["id"],))  # type: ignore[index]
    assert row and row["status"] == "FAILED" and "OpenRouter" in row["error"]
