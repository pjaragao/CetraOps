"""Avaliação da IA de atendimento: cada caso vira uma conversa num sandbox (rollback no fim), o roteador de produção responde com o modelo
candidato e o resultado é conferido contra o que o caso espera. Mede: passou ou não, número/promessa sem fundamento, transferência certa,
latência e custo. Os lotes (um por modelo) alimentam o ranking e o portão de troca de modelo."""
from __future__ import annotations

import logging
import re
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

import httpx

from ..adapters.errors import PermanentError, TransientError
from ..ai import guardrails
from ..ai.agent import OpenRouterAgent
from ..ai.hermes_llm import HermesLLM, is_hermes
from ..config import Settings
from ..db import call_fn, fetch_all, fetch_one
from ..deps import Deps
from ..handlers import router
from ..queues import QueueMessage
from ..runner import RetryLater
from .sandbox import sandbox

log = logging.getLogger("centralops_worker.evals")

OUTCOMES = ("SEND", "DRAFT", "HANDOFF", "NONE")


@dataclass
class EvalCase:
    key: str
    title: str
    turns: list[dict[str, str]]
    expect: dict[str, Any] = field(default_factory=dict)


@dataclass
class CaseResult:
    case_key: str
    passed: bool = False
    failures: list[str] = field(default_factory=list)
    outcome: str = "NONE"
    flags: list[str] = field(default_factory=list)
    replies: list[str] = field(default_factory=list)
    tools: list[str] = field(default_factory=list)
    latency_ms: int = 0
    cost_usd: float = 0.0
    tokens_in: int = 0
    tokens_out: int = 0
    error: str | None = None

    def to_json(self) -> dict[str, Any]:
        return {"case_key": self.case_key, "passed": self.passed, "failures": self.failures, "outcome": self.outcome, "flags": self.flags, "replies": self.replies,
                "tools": self.tools, "latency_ms": self.latency_ms, "cost_usd": self.cost_usd, "tokens_in": self.tokens_in, "tokens_out": self.tokens_out, "error": self.error}


def evaluate(expect: dict[str, Any], *, outcome: str, flags: list[str], replies: list[str], tools_ok: set[str], tools_all: set[str]) -> list[str]:
    """Confere o resultado contra as expectativas do caso. Devolve as falhas em português (vazio = passou)."""
    failures: list[str] = []
    allowed = expect.get("outcome_in")
    if allowed and outcome not in allowed:
        failures.append(f"resultado {outcome}; esperado {' ou '.join(allowed)}")
    any_tools = expect.get("tools_any")
    if any_tools and not (set(any_tools) & tools_ok):
        failures.append(f"não consultou nenhuma destas ferramentas: {', '.join(any_tools)}")
    none_tools = set(expect.get("tools_none") or [])
    if none_tools & tools_all:
        failures.append(f"usou ferramenta proibida: {', '.join(sorted(none_tools & tools_all))}")
    if expect.get("no_flags") and flags:
        failures.append(f"reprovada pelo validador: {', '.join(flags)}")
    text = "\n".join(replies)
    for rx in expect.get("must_not_match") or []:
        if re.search(rx, text, re.I):
            failures.append(f"a resposta contém algo proibido ({rx})")
    must = expect.get("must_match_any") or []
    if must and not any(re.search(rx, text, re.I) for rx in must):
        failures.append("a resposta não traz o que o caso exige")
    return failures


async def load_cases(pool: Any, org_id: str, suite: str) -> list[EvalCase]:
    rows = await fetch_all(pool, "select key, title, turns, expect from ai.eval_cases where org_id = %s and suite = %s and active order by key", (org_id, suite))
    return [EvalCase(r["key"], r["title"], list(r["turns"]), dict(r["expect"] or {})) for r in rows]


async def _prepare(pool: Any, org_id: str, case: EvalCase, persona_id: str | None) -> tuple[str, str]:
    """Cria, no sandbox, uma conta de teste e a conversa do caso. Devolve (conversa, última mensagem da cliente)."""
    store = await fetch_one(pool, "select id from core.stores where org_id = %s order by created_at limit 1", (org_id,))
    persona = persona_id or (await fetch_one(pool, "select default_persona_id as p from omni.channel_accounts where org_id = %s and channel = 'WHATSAPP' and default_persona_id is not null limit 1", (org_id,)) or {}).get("p")
    suffix = uuid.uuid4().hex[:10]
    await fetch_one(pool, """insert into omni.channel_accounts (org_id, channel, provider_account_id, display_name, store_id, default_ai_mode, default_persona_id)
                             values (%s, 'WHATSAPP', %s, 'Avaliação (sandbox)', %s, 'AI_AUTOPILOT', %s) returning id""", (org_id, f"EVAL-{suffix}", store["id"] if store else None, persona))
    phone = "5548" + str(uuid.uuid4().int)[:9]
    conv_id: str | None = None
    last_mid = ""
    for i, turn in enumerate(case.turns):
        if turn["role"] == "user":
            mid = f"wamid.eval.{suffix}.{i}"
            res = await call_fn(pool, "omni.ingest_event", {"kind": "MESSAGE", "channel": "WHATSAPP", "provider_account_id": f"EVAL-{suffix}", "external_id": phone, "phone": phone,
                                                          "display_name": "Cliente Avaliação", "provider_message_id": mid, "type": "TEXT", "body": turn["text"]})
            conv_id = str(res["conversation_id"])
            last_mid = mid
        else:
            row = await fetch_one(pool, "select id, channel_account_id from omni.conversations where id = %s", (conv_id,))
            await fetch_one(pool, """insert into omni.messages (org_id, conversation_id, channel_account_id, direction, author_type, body, status, provider_message_id)
                                     values (%s, %s, %s, 'OUT', 'AI', %s, 'DELIVERED', %s) returning id""", (org_id, conv_id, row["channel_account_id"], turn["text"], f"wamid.eval.{suffix}.{i}"))  # type: ignore[index]
    msg = await fetch_one(pool, "select id from omni.messages where provider_message_id = %s and conversation_id = %s", (last_mid, conv_id))
    return str(conv_id), str(msg["id"])  # type: ignore[index]


async def run_case(settings: Settings, http: httpx.AsyncClient, org_id: str, case: EvalCase, model: str, *, persona_id: str | None = None) -> CaseResult:
    result = CaseResult(case.key)
    async with sandbox(settings.database_url) as pool:
        conv_id, msg_id = await _prepare(pool, org_id, case, persona_id)
        # o modelo candidato entra só neste sandbox; a rota de verdade não muda
        await fetch_one(pool, "update ai.model_routes set primary_model = %s, fallback_models = '{}', daily_budget_usd = null, active = true where org_id = %s and task = 'conversation' returning id", (model, org_id))
        deps = Deps(pool=pool, settings=settings, http=http, agent=OpenRouterAgent(
            pool, http, settings.openrouter_base, settings.openrouter_key,
            hermes=HermesLLM(http, settings.hermes_llm_base, settings.hermes_llm_key) if settings.hermes_llm_key else None))  # type: ignore[arg-type]
        t0 = time.monotonic()
        try:
            await router.handle(deps, QueueMessage("conversation_router", 0, 1, {"conversation_id": conv_id, "message_id": msg_id}))
        except (TransientError, RetryLater, PermanentError) as e:
            result.error = f"{type(e).__name__}: {e}"
        result.latency_ms = int((time.monotonic() - t0) * 1000)

        conv = await fetch_one(pool, "select mode from omni.conversations where id = %s", (conv_id,))
        drafts = await fetch_all(pool, "select variants, flags, status from omni.message_drafts where conversation_id = %s order by created_at desc", (conv_id,))
        sent = await fetch_all(pool, "select body from omni.messages where conversation_id = %s and direction = 'OUT' and author_type = 'AI' and status = 'QUEUED' and body is not null order by created_at, seq", (conv_id,))
        runs = await fetch_all(pool, "select id, cost_usd, tokens_in, tokens_out from ai.runs where conversation_id = %s and route_task = 'conversation'", (conv_id,))
        calls = await fetch_all(pool, "select tool, ok, args, result_digest from ai.tool_calls where run_id = any(%s) order by id", ([r["id"] for r in runs],))

        if conv and conv["mode"] == "WAITING_HUMAN":
            result.outcome = "HANDOFF"
        elif sent:
            result.outcome = "SEND"
        elif any(d["status"] == "PENDING" for d in drafts):
            result.outcome = "DRAFT"
        proposals = [c["args"] for c in calls if c["tool"] == "propose_reply" and c["ok"]]
        if proposals:
            result.replies = [str(m) for m in proposals[-1].get("messages", [])]
        elif sent:
            result.replies = [str(s["body"]) for s in sent]
        results = [guardrails.ToolResult(c["tool"], c["ok"], c["result_digest"] or {}) for c in calls]
        flags = {v.code for v in guardrails.validate(result.replies, results)} if result.replies else set()
        for d in drafts[:1]:
            flags |= set(d["flags"] or [])
        result.flags = sorted(flags)
        names = [c["tool"] for c in calls if c["tool"] != "propose_reply"]
        result.tools = names
        result.cost_usd = float(sum(float(r["cost_usd"] or 0) for r in runs))
        result.tokens_in = sum(int(r["tokens_in"] or 0) for r in runs)
        result.tokens_out = sum(int(r["tokens_out"] or 0) for r in runs)
        result.failures = evaluate(case.expect, outcome=result.outcome, flags=result.flags, replies=result.replies,
                                   tools_ok={c["tool"] for c in calls if c["ok"]}, tools_all=set(names))
    if result.error:
        result.failures.append(f"erro na execução: {result.error}")
    result.passed = not result.failures
    return result


ProgressFn = Callable[[str], Awaitable[None]]


async def run_suite(settings: Settings, http: httpx.AsyncClient, pool: Any, org_id: str, models: list[str], *, suite: str = "conversation",
                    request_id: str | None = None, persona_id: str | None = None, progress: ProgressFn | None = None) -> list[str]:
    """Roda todos os casos ativos em cada modelo e grava um lote por modelo. Devolve os ids dos lotes."""
    if not settings.openrouter_key and any(not is_hermes(m) for m in models):
        raise PermanentError("OpenRouter não configurado (CENTRALOPS_OPENROUTER_KEY)")
    if not settings.hermes_llm_key and any(is_hermes(m) for m in models):
        raise PermanentError("Hermes do CentralOps não configurado (CENTRALOPS_HERMES_LLM_KEY)")
    cases = await load_cases(pool, org_id, suite)
    if not cases:
        raise PermanentError("nenhum caso de teste ativo")
    batches: list[str] = []
    for model in models:
        results: list[CaseResult] = []
        for i, case in enumerate(cases, 1):
            if progress:
                await progress(f"{model}: caso {i} de {len(cases)}")
            try:
                results.append(await run_case(settings, http, org_id, case, model, persona_id=persona_id))
            except Exception as e:  # um caso com defeito não derruba o lote: vira falha com o motivo
                log.exception("caso %s no modelo %s falhou", case.key, model)
                results.append(CaseResult(case.key, False, [f"erro inesperado: {e}"], error=str(e)))
        batch = await call_fn(pool, "ai.eval_save_batch", org_id, {"request_id": request_id, "suite": suite, "route_task": "conversation", "model": model, "results": [r.to_json() for r in results]})
        batches.append(str(batch))
    return batches
