"""Fila `conversation_router` (uma execução por mensagem do cliente, já com debounce): decide entre ignorar, avisar humano, transferir,
pedir resposta à IA e então ENVIAR, guardar como RASCUNHO ou TRANSFERIR. O banco garante a concorrência (versão da conversa)."""
from __future__ import annotations

import logging
from typing import Any

import psycopg

from sie_agent_contract import CONCIERGE_CAPS, COPILOT_CAPS, sign_ctx

from .. import queues
from ..adapters.errors import PermanentError as ProviderPermanent
from ..adapters.errors import TransientError
from ..ai import guardrails, prompts, rules
from ..ai import llm as llm_mod
from ..ai.agent import AgentInput, AgentOutput
from ..db import call_fn, fetch_all, fetch_one
from ..deps import Deps
from ..persona.fewshot import embed_text, format_examples, mmr
from ..runner import RetryLater

log = logging.getLogger("sie_worker.router")

# Lista fechada do que o autopiloto pode responder sozinho (plano §6.3); o resto é copiloto/humano
AUTOPILOT_OK = {"GREETING", "STOCK", "PRODUCT_INFO", "SIZE_GUIDE", "STORE_INFO", "ORDER_STATUS", "RESERVATION", "PAYMENT_LINK", "LOCKER", "RSVP"}
ALWAYS_HUMAN = {"COMPLAINT", "EXCHANGE_DEFECT", "PRICE_NEGOTIATION", "B2B", "PARTNERSHIP", "PAYMENT_PROBLEM"}
DEFAULT_MODEL = "openrouter/auto"
WAIT_MESSAGE = "Já avisei a equipe e alguém responde por aqui em instantes. 💛"
OPT_OUT_MESSAGE = "Combinado, não vamos mais enviar novidades. Se precisar de algo, é só chamar por aqui."


async def _open_run(deps: Deps, claim: dict[str, Any], task: str, model: str | None, persona_version: str | None) -> str:
    row = await fetch_one(deps.pool, "insert into ai.runs (org_id, route_task, model, persona_version_id, conversation_id, party_id, status) values (%s, %s, %s, %s, %s, %s, 'RUNNING') returning id",
                          (claim["org_id"], task, model, persona_version, claim["conversation_id"], claim["party_id"]))
    return str(row["id"])  # type: ignore[index]


async def _finish_run(deps: Deps, run_id: str, out: AgentOutput | None, status: str | None = None, error: str | None = None) -> None:
    await fetch_one(deps.pool, """update ai.runs set model = coalesce(%s, model), tokens_in = %s, tokens_out = %s, cache_read_tokens = %s, cost_usd = %s, latency_ms = %s,
                                  status = coalesce(%s, status), error = coalesce(%s, error) where id = %s returning id""",
                    (out.model if out else None, out.tokens_in if out else None, out.tokens_out if out else None, out.cache_read_tokens if out else None,
                     out.cost_usd if out else None, out.latency_ms if out else None, status, error, run_id))


async def _handoff(deps: Deps, claim: dict[str, Any], reason: str, trigger: str, *, wait_message: bool = True) -> None:
    run_id = await _open_run(deps, claim, "router_rule", None, None)
    res = await call_fn(deps.pool, "omni.apply_ai_result", claim["conversation_id"], claim["version"], run_id, {"action": "HANDOFF", "reason": reason, "trigger": trigger})
    if res.get("applied"):
        if wait_message:
            await call_fn(deps.pool, "omni.queue_system_message", claim["conversation_id"], WAIT_MESSAGE)
        await deps.notify(claim["org_id"], "HANDOFF", f"Cliente aguardando atendimento humano — {reason}", {"conversation_id": claim["conversation_id"]}, perm="omni.write")


async def _examples(deps: Deps, claim: dict[str, Any], history: list[dict[str, str]]) -> str | None:
    """Exemplos de ESTILO da persona (os pares mais parecidos com a conversa, com diversidade). Opcional: qualquer falha volta sem exemplos, nunca trava a resposta."""
    if deps.llm is None or not claim.get("persona_id") or not history:
        return None
    ctx: list[dict[str, str]] = []
    for h in history[-6:]:
        role = "customer" if h["role"] == "user" else "owner"
        if ctx and ctx[-1]["role"] == role:
            ctx[-1]["text"] += "\n" + h["content"]
        else:
            ctx.append({"role": role, "text": h["content"]})
    try:
        vectors, _ = await deps.llm.embed(str(claim["org_id"]), [embed_text(ctx)])
        rows = await fetch_all(deps.pool, "select id, context, reply, weight, distance, embedding from ai.similar_pairs(%s, %s, 20)", (claim["persona_id"], llm_mod.vector_text(vectors[0])))
    except (TransientError, ProviderPermanent, psycopg.Error) as e:
        log.info("sem exemplos de estilo nesta resposta: %s", e)
        return None
    return format_examples(mmr(rows, 6)) or None


async def _history(deps: Deps, conversation_id: str) -> list[dict[str, str]]:
    rows = await fetch_all(deps.pool, """select direction, body, transcript, type from omni.messages where conversation_id = %s
                                         and (body is not null or transcript is not null) order by created_at desc, seq desc limit 30""", (conversation_id,))
    out: list[dict[str, str]] = []
    for r in reversed(rows):
        text = r["body"] or r["transcript"]
        if r["transcript"] and r["type"] == "AUDIO":
            text = f'[áudio transcrito] {r["transcript"]}'
        out.append({"role": "user" if r["direction"] == "IN" else "assistant", "content": text})
    return out


async def _route(deps: Deps, org_id: str) -> dict[str, Any]:
    row = await fetch_one(deps.pool, "select primary_model, fallback_models, params, provider_prefs, daily_budget_usd from ai.model_routes where org_id = %s and task = 'conversation' and active", (org_id,))
    return row or {"primary_model": DEFAULT_MODEL, "fallback_models": [], "params": {}, "provider_prefs": {}, "daily_budget_usd": None}


async def _proposal(deps: Deps, run_id: str) -> dict[str, Any] | None:
    row = await fetch_one(deps.pool, "select args from ai.tool_calls where run_id = %s and tool = 'propose_reply' and ok order by id desc limit 1", (run_id,))
    return row["args"] if row else None


async def _tool_results(deps: Deps, run_id: str) -> list[guardrails.ToolResult]:
    rows = await fetch_all(deps.pool, "select tool, ok, result_digest from ai.tool_calls where run_id = %s order by id", (run_id,))
    return [guardrails.ToolResult(r["tool"], r["ok"], r["result_digest"] or {}) for r in rows]


def _bubbles(text: str | None) -> list[str]:
    parts = [p.strip() for p in (text or "").split("\n\n") if p.strip()]
    return parts[:3] or ([text.strip()] if text and text.strip() else [])


async def handle(deps: Deps, msg: queues.QueueMessage) -> None:
    conv_id, message_id = msg.payload["conversation_id"], msg.payload["message_id"]
    claim = await call_fn(deps.pool, "omni.claim_router", conv_id, message_id)
    if claim.get("skip"):
        return
    m = claim["message"]
    text = m.get("body") or m.get("transcript")
    if m["type"] == "AUDIO" and not m.get("transcript") and msg.read_ct < 4:
        raise RetryLater(10, "aguardando transcrição do áudio")     # a mídia volta a enfileirar o roteador quando a transcrição fica pronta

    hit = rules.match_pre_rule(text)
    mode = claim["mode"]

    if hit and hit.rule == "OPT_OUT":
        await call_fn(deps.pool, "omni.record_opt_out", claim["party_id"], message_id)
        await call_fn(deps.pool, "omni.queue_system_message", conv_id, OPT_OUT_MESSAGE)
        return
    if mode == "HUMAN":
        await deps.notify(claim["org_id"], "NEW_MESSAGE", "Nova mensagem de cliente", {"conversation_id": conv_id})
        return
    if mode == "WAITING_HUMAN":
        already = await fetch_one(deps.pool, """select 1 as x from omni.messages where conversation_id = %s and direction = 'OUT' and author_type in ('SYSTEM', 'AI')
                                                and created_at >= coalesce((select max(created_at) from omni.mode_events where conversation_id = %s and to_mode = 'WAITING_HUMAN'), 'epoch') limit 1""", (conv_id, conv_id))
        if not already:
            await call_fn(deps.pool, "omni.queue_system_message", conv_id, WAIT_MESSAGE)
        await deps.notify(claim["org_id"], "HANDOFF", "Cliente aguardando atendimento humano", {"conversation_id": conv_id}, perm="omni.write")
        return

    # --- modos de IA ---
    if hit:                                                          # pedido de humano / tema sensível
        await _handoff(deps, claim, hit.reason, hit.trigger)
        return
    if claim.get("ai_paused"):
        return
    if claim["ai_replies_last_hour"] >= deps.settings.ai_max_replies_per_hour:
        await _handoff(deps, claim, "limite de respostas automáticas por hora atingido", "AI_RATE_LIMIT")
        return
    route = await _route(deps, claim["org_id"])
    if route.get("daily_budget_usd") is not None:
        spent = await fetch_one(deps.pool, """select coalesce(sum(cost_usd), 0) as s from ai.runs where org_id = %s and route_task = 'conversation'
                                              and created_at >= date_trunc('day', now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo'""", (claim["org_id"],))
        if float(spent["s"]) >= float(route["daily_budget_usd"]):  # type: ignore[index]
            await _handoff(deps, claim, "orçamento diário de IA esgotado", "AI_BUDGET")
            return
    if deps.agent is None:                                           # IA não configurada neste ambiente: cai para atendimento humano, sem travar a fila
        if mode == "AI_AUTOPILOT":
            await _handoff(deps, claim, "IA indisponível neste ambiente", "AI_FAILURE")
        else:
            await deps.notify(claim["org_id"], "NEW_MESSAGE", "Nova mensagem de cliente (IA indisponível)", {"conversation_id": conv_id})
        return

    persona = await fetch_one(deps.pool, """select pv.id, pv.system_prompt, pv.guardrails from ai.persona_versions pv
                                            join ai.personas p on p.active_version_id = pv.id where p.id = %s""", (claim["persona_id"],)) if claim.get("persona_id") else None
    party = await fetch_one(deps.pool, "select split_part(display_name, ' ', 1) as first_name from crm.parties where id = %s", (claim["party_id"],))
    caps = CONCIERGE_CAPS if mode == "AI_AUTOPILOT" else COPILOT_CAPS
    run_id = await _open_run(deps, claim, "conversation", route["primary_model"], str(persona["id"]) if persona else None)
    history = await _history(deps, conv_id)
    examples = await _examples(deps, claim, history)

    async def ask(feedback: str | None = None) -> AgentOutput:
        token = sign_ctx(deps.settings.agent_ctx_secret, org=claim["org_id"], conv=conv_id, party=claim["party_id"], run=run_id, version=claim["version"],
                         caps=caps, persona_version=str(persona["id"]) if persona else None, mode=mode)
        ctx = {"org": claim["org_id"], "conv": conv_id, "party": claim["party_id"], "run": run_id, "version": claim["version"], "caps": caps}
        return await deps.agent.run(AgentInput(  # type: ignore[union-attr]
            run_id=run_id, ctx=ctx, ctx_token=token, system_stable=prompts.system_stable(persona["system_prompt"] if persona else None, persona["guardrails"] if persona else None),
            system_volatile=prompts.system_volatile(ctx_token=token, mode=mode, channel=claim["channel"], window_mode=claim.get("window_mode"),
                                                    party_first_name=party["first_name"] if party else None, feedback=feedback, last_message_id=message_id, examples=examples),
            history=history, model=route["primary_model"], fallback_models=list(route.get("fallback_models") or []), params=route.get("params") or {},
            provider_prefs=route.get("provider_prefs") or {}))

    try:
        out = await ask()
    except TransientError as e:
        await _finish_run(deps, run_id, None, "ERROR", str(e))
        raise RetryLater(int(e.retry_after or 20), str(e)) from e
    except ProviderPermanent as e:                                  # circuit breaker: falhou de vez → humano
        await _finish_run(deps, run_id, None, "ERROR", str(e))
        await _handoff(deps, claim, "falha do agente de IA", "AI_FAILURE")
        return

    proposal = await _proposal(deps, run_id)
    violations: list[guardrails.Violation] = []
    if proposal:
        results = await _tool_results(deps, run_id)
        violations = guardrails.validate(proposal["messages"], results)
        if violations:                                              # uma nova tentativa com o motivo da reprovação
            try:
                out2 = await ask(guardrails.feedback_for(violations))
                out = AgentOutput(model=out2.model, tokens_in=out.tokens_in + out2.tokens_in, tokens_out=out.tokens_out + out2.tokens_out,
                                  cache_read_tokens=out.cache_read_tokens + out2.cache_read_tokens, cost_usd=out.cost_usd + out2.cost_usd, latency_ms=out.latency_ms + out2.latency_ms,
                                  tool_calls=out.tool_calls + out2.tool_calls, text=out2.text)
            except (TransientError, ProviderPermanent) as e:
                log.warning("nova tentativa do agente falhou: %s", e)
            proposal = await _proposal(deps, run_id) or proposal
            results = await _tool_results(deps, run_id)
            violations = guardrails.validate(proposal["messages"], results)
    flags = [v.code for v in violations]
    if not proposal:                                                # o modelo não chamou propose_reply: rascunho de baixa confiança
        proposal = {"messages": _bubbles(out.text), "confidence": 0.3, "intent": None}
        flags.append("NO_PROPOSAL")
    if not proposal["messages"]:
        await _finish_run(deps, run_id, out, "ERROR", "resposta vazia")
        await _handoff(deps, claim, "a IA não conseguiu responder", "AI_FAILURE")
        return
    if rules.mentions_health(text) and "HEALTH_TOPIC" not in flags:
        flags.append("HEALTH_TOPIC")

    intent = (proposal.get("intent") or "").upper() or None
    confidence = float(proposal.get("confidence") or 0)
    can_autosend = (mode == "AI_AUTOPILOT" and not flags and not proposal.get("needs_human") and intent in AUTOPILOT_OK and confidence >= deps.settings.autopilot_min_confidence
                    and claim.get("tier") != "VIP_BLACK" and claim.get("window_allowed"))
    if proposal.get("needs_human") or intent in ALWAYS_HUMAN:
        action = "HANDOFF"
    elif can_autosend:
        action = "SEND"
    else:
        action = "DRAFT"

    result = await call_fn(deps.pool, "omni.apply_ai_result", conv_id, claim["version"], run_id, {
        "action": action, "messages": proposal["messages"], "intent": intent, "stage": proposal.get("stage"), "confidence": confidence,
        "needs_human": bool(proposal.get("needs_human")), "flags": flags, "reason": proposal.get("reason") or f"intenção {intent or 'não classificada'}",
        "based_on_message_at": m["created_at"], "trigger": "AI_REQUEST_HANDOFF"})
    await _finish_run(deps, run_id, out)
    if not result.get("applied"):
        log.info("resultado da IA descartado (%s) na conversa %s", result.get("reason"), conv_id)
        return
    if action == "DRAFT":
        await deps.notify(claim["org_id"], "DRAFT_READY", "Rascunho da IA pronto para revisar", {"conversation_id": conv_id})
    elif action == "HANDOFF":
        await call_fn(deps.pool, "omni.queue_system_message", conv_id, WAIT_MESSAGE)
        await deps.notify(claim["org_id"], "HANDOFF", "Cliente aguardando atendimento humano", {"conversation_id": conv_id}, perm="omni.write")
