"""Fila `conversation_router` (uma execução por mensagem do cliente, já com debounce): decide entre ignorar, avisar humano, transferir,
pedir resposta à IA e então ENVIAR, guardar como RASCUNHO ou TRANSFERIR. O banco garante a concorrência (versão da conversa)."""
from __future__ import annotations

import logging
from typing import Any

import psycopg

from centralops_agent_contract import CONCIERGE_CAPS, COPILOT_CAPS, sign_ctx

from .. import queues
from ..adapters.errors import PermanentError as ProviderPermanent
from ..adapters.errors import TransientError
from ..ai import guardrails, prompts, rules
from ..ai import llm as llm_mod
from ..ai.agent import AgentInput, AgentOutput
from ..db import brand_name, call_fn, fetch_all, fetch_one
from ..deps import Deps
from ..persona.fewshot import embed_text, format_examples, mmr
from ..runner import RetryLater

log = logging.getLogger("centralops_worker.router")

# Lista fechada do que o autopiloto pode responder sozinho (plano §6.3); o resto é copiloto/humano
AUTOPILOT_OK = {"GREETING", "STOCK", "PRODUCT_INFO", "SIZE_GUIDE", "STORE_INFO", "ORDER_STATUS", "RESERVATION", "PAYMENT_LINK", "LOCKER", "RSVP"}
ALWAYS_HUMAN = {"COMPLAINT", "EXCHANGE_DEFECT", "PRICE_NEGOTIATION", "B2B", "PARTNERSHIP", "PAYMENT_PROBLEM"}
# Fora do horário (canal com "SAFE_AUTOPILOT"): só respostas informativas saem sozinhas; reserva, pedido e link esperam a equipe
AFTER_HOURS_OK = {"GREETING", "STOCK", "PRODUCT_INFO", "SIZE_GUIDE", "STORE_INFO", "ORDER_STATUS"}
DEFAULT_MODEL = "openrouter/auto"
WAIT_MESSAGE = "Já avisei a equipe e alguém responde por aqui em instantes. 💛"
OPT_OUT_MESSAGE = "Combinado, não vamos mais enviar novidades. Se precisar de algo, é só chamar por aqui."


def waiting_text(claim: dict[str, Any]) -> str:
    """Mensagem de espera: dentro do horário, "em instantes"; fora, quando a equipe volta."""
    if claim.get("is_open", True) or not claim.get("next_open_label"):
        return WAIT_MESSAGE
    return f"Já avisei a equipe! Estamos fora do horário agora e respondemos {claim['next_open_label']}. 💛"


async def _after_hours(deps: Deps, claim: dict[str, Any]) -> None:
    """Fora do horário, o que ficou para uma pessoa vira tarefa para a abertura."""
    if not claim.get("is_open", True):
        await call_fn(deps.pool, "omni.after_hours_followup", claim["conversation_id"])


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
            await call_fn(deps.pool, "omni.queue_system_message", claim["conversation_id"], waiting_text(claim))
        await deps.notify(claim["org_id"], "HANDOFF", f"Cliente aguardando atendimento humano — {reason}", {"conversation_id": claim["conversation_id"]}, perm="omni.write")
        await _after_hours(deps, claim)


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
    # `quoted`: quando a cliente responde (reply) a uma mensagem específica, o texto citado vai junto para a IA entender a referência
    rows = await fetch_all(deps.pool, """select m.direction, m.body, m.transcript, m.type,
                                                (select coalesce(q.body, q.transcript) from omni.messages q
                                                  where q.channel_account_id = m.channel_account_id and q.provider_message_id = m.payload ->> 'reply_to' limit 1) as quoted
                                           from omni.messages m where m.conversation_id = %s
                                         and (m.body is not null or m.transcript is not null) order by m.created_at desc, m.seq desc limit 30""", (conversation_id,))
    out: list[dict[str, str]] = []
    for r in reversed(rows):
        text = r["body"] or r["transcript"]
        if r["transcript"] and r["type"] == "AUDIO":
            text = f'[áudio transcrito] {r["transcript"]}'
        if r.get("quoted"):
            quoted = " ".join(str(r["quoted"]).split())
            text = f'[respondendo à mensagem: "{quoted[:200]}{"…" if len(quoted) > 200 else ""}"] {text}'
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


async def _cart(deps: Deps, conv_id: str) -> list[dict[str, Any]]:
    """Carrinho da conversa para o prompt (numerado). Falha aqui não impede a resposta."""
    try:
        return list(await call_fn(deps.pool, "omni.cart_for_ai", conv_id) or [])
    except psycopg.Error as e:
        log.warning("carrinho da conversa %s indisponível: %s", conv_id, e)
        return []


def cart_updates(cart: list[dict[str, Any]], updates: Any) -> list[dict[str, Any]]:
    """propose_reply.cart (item = número da lista) → [{id, size, qty, remove}] com os ids reais; número desconhecido é ignorado."""
    by_n = {int(i["n"]): str(i["id"]) for i in cart}
    out: list[dict[str, Any]] = []
    for u in updates if isinstance(updates, list) else []:
        try:
            item_id = by_n.get(int(u.get("item")))
        except (TypeError, ValueError, AttributeError):
            continue
        if not item_id:
            continue
        row: dict[str, Any] = {"id": item_id}
        if u.get("remove"):
            row["remove"] = True
        if isinstance(u.get("size"), str) and u["size"].strip():
            row["size"] = u["size"].strip()[:10]
        try:
            if u.get("qty") is not None and 1 <= int(u["qty"]) <= 99:
                row["qty"] = int(u["qty"])
        except (TypeError, ValueError):
            pass
        if len(row) > 1:
            out.append(row)
    return out


async def _apply_cart(deps: Deps, conv_id: str, cart: list[dict[str, Any]], updates: Any) -> None:
    """Tamanho/quantidade que a cliente escolheu vai para o carrinho (rascunho ou envio: o carrinho é só o mapa do atendimento)."""
    rows = cart_updates(cart, updates)
    if not rows:
        return
    try:
        await call_fn(deps.pool, "omni.cart_ai_apply", conv_id, rows)
    except psycopg.Error as e:
        log.warning("carrinho da conversa %s não atualizado pela IA: %s", conv_id, e)


def _bubbles(text: str | None) -> list[str]:
    parts = [p.strip() for p in (text or "").split("\n\n") if p.strip()]
    return parts[:3] or ([text.strip()] if text and text.strip() else [])


async def _forced_instruction(deps: Deps, payload: dict[str, Any], base: str | None, history: list[dict[str, str]]) -> str:
    """Instrução de uma sugestão pedida pelo atendente (botão Sugerir resposta / Comentar): o comentário dele, a sugestão que ele quer
    refeita e, se a última mensagem é da loja, que a IA proponha a próxima mensagem da loja."""
    parts = [base] if base else []
    parts.append("O atendente pediu esta sugestão pelo botão da inbox: ela vira rascunho para ele revisar, nada sai sozinho.")
    if history and history[-1]["role"] == "assistant":
        parts.append("A última mensagem da conversa é da loja, não da cliente: sugira a PRÓXIMA mensagem da loja (retomar, complementar ou "
                     "dar seguimento ao que foi mostrado), sem repetir o que já foi dito.")
    if payload.get("draft_id"):
        row = await fetch_one(deps.pool, "select variants from omni.message_drafts where id = %s", (payload["draft_id"],))
        previous = "\n\n".join(((row or {}).get("variants") or [{}])[0].get("messages") or [])
        if previous:
            parts.append(f'Sugestão anterior, que o atendente quer refeita: """{previous[:1500]}"""')
    if payload.get("comment"):
        parts.append(f"Comentário do atendente sobre o que mudar (siga-o sem contrariar as políticas): {str(payload['comment'])[:1000]}")
    return " ".join(parts)


async def _clear_forced(deps: Deps, conv_id: str) -> None:
    await fetch_one(deps.pool, "update omni.conversations set ai_forced_at = null where id = %s and ai_forced_at is not null returning id", (conv_id,))


async def handle(deps: Deps, msg: queues.QueueMessage) -> None:
    if msg.payload.get("force"):
        try:
            await _handle(deps, msg, forced=True)
        except RetryLater:
            raise                                                    # vai tentar de novo: a inbox continua mostrando "IA preparando…"
        except BaseException:
            await _clear_forced(deps, msg.payload["conversation_id"])
            raise
        await _clear_forced(deps, msg.payload["conversation_id"])  # pronto (ou sem rascunho): a inbox para de mostrar "IA preparando…"
        return
    await _handle(deps, msg, forced=False)


async def _handle(deps: Deps, msg: queues.QueueMessage, forced: bool) -> None:
    conv_id, message_id = msg.payload["conversation_id"], msg.payload["message_id"]
    claim = await call_fn(deps.pool, "omni.claim_router", conv_id, message_id)
    if claim.get("skip"):
        return
    handled = await fetch_one(deps.pool, "select payload ->> 'automation_handled' as h from omni.messages where id = %s", (message_id,))
    if handled and handled["h"] == "true" and not forced:
        return                                                      # uma automação já respondeu a esta mensagem: a IA não responde de novo
    m = claim["message"]
    text = m.get("body") or m.get("transcript")
    if m["type"] == "AUDIO" and not m.get("transcript") and msg.read_ct < 4:
        raise RetryLater(10, "aguardando transcrição do áudio")     # a mídia volta a enfileirar o roteador quando a transcrição fica pronta

    hit = None if forced else rules.match_pre_rule(text)             # pedido do atendente: só rascunho, sem regras de transferência
    mode = "AI_COPILOT" if forced else claim["mode"]

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
            await call_fn(deps.pool, "omni.queue_system_message", conv_id, waiting_text(claim))
        await deps.notify(claim["org_id"], "HANDOFF", "Cliente aguardando atendimento humano", {"conversation_id": conv_id}, perm="omni.write")
        return

    # --- modos de IA ---
    if hit:                                                          # pedido de humano / tema sensível
        await _handoff(deps, claim, hit.reason, hit.trigger)
        return
    if claim.get("ai_paused") and not forced:
        return
    if claim["ai_replies_last_hour"] >= deps.settings.ai_max_replies_per_hour and not forced:
        await _handoff(deps, claim, "limite de respostas automáticas por hora atingido", "AI_RATE_LIMIT")
        return
    route = await _route(deps, claim["org_id"])
    if route.get("daily_budget_usd") is not None:
        spent = await fetch_one(deps.pool, """select coalesce(sum(cost_usd), 0) as s from ai.runs where org_id = %s and route_task = 'conversation'
                                              and created_at >= date_trunc('day', now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo'""", (claim["org_id"],))
        if float(spent["s"]) >= float(route["daily_budget_usd"]):  # type: ignore[index]
            if not forced:
                await _handoff(deps, claim, "orçamento diário de IA esgotado", "AI_BUDGET")
            return
    if deps.agent is None:
        if forced:
            return                                           # IA não configurada neste ambiente: cai para atendimento humano, sem travar a fila
        if mode == "AI_AUTOPILOT":
            await _handoff(deps, claim, "IA indisponível neste ambiente", "AI_FAILURE")
        else:
            await deps.notify(claim["org_id"], "NEW_MESSAGE", "Nova mensagem de cliente (IA indisponível)", {"conversation_id": conv_id})
        return

    persona = await fetch_one(deps.pool, """select pv.id, pv.system_prompt, pv.guardrails from ai.persona_versions pv
                                            join ai.personas p on p.active_version_id = pv.id where p.id = %s""", (claim["persona_id"],)) if claim.get("persona_id") else None
    party = await fetch_one(deps.pool, "select split_part(display_name, ' ', 1) as first_name from crm.parties where id = %s", (claim["party_id"],))
    brand = None if persona else await brand_name(deps.pool, claim["org_id"])
    # fora do horário, com o canal em "SAFE_AUTOPILOT", o copiloto responde sozinho o que é só informação (sem ferramentas de pedido/link/reserva)
    after_hours_auto = mode == "AI_COPILOT" and not claim.get("is_open", True) and claim.get("after_hours_ai") == "SAFE_AUTOPILOT"
    caps = CONCIERGE_CAPS if mode == "AI_AUTOPILOT" else COPILOT_CAPS
    run_id = await _open_run(deps, claim, "conversation", route["primary_model"], str(persona["id"]) if persona else None)
    history = await _history(deps, conv_id)
    examples = await _examples(deps, claim, history)
    instruction = await _forced_instruction(deps, msg.payload, claim.get("instruction"), history) if forced else claim.get("instruction")
    cart = await _cart(deps, conv_id)

    async def ask(feedback: str | None = None) -> AgentOutput:
        token = sign_ctx(deps.settings.agent_ctx_secret, org=claim["org_id"], conv=conv_id, party=claim["party_id"], run=run_id, version=claim["version"],
                         caps=caps, persona_version=str(persona["id"]) if persona else None, mode=mode)
        ctx = {"org": claim["org_id"], "conv": conv_id, "party": claim["party_id"], "run": run_id, "version": claim["version"], "caps": caps}
        return await deps.agent.run(AgentInput(  # type: ignore[union-attr]
            run_id=run_id, ctx=ctx, ctx_token=token, system_stable=prompts.system_stable(persona["system_prompt"] if persona else None, persona["guardrails"] if persona else None, brand),
            system_volatile=prompts.system_volatile(ctx_token=token, mode=mode, channel=claim["channel"], window_mode=claim.get("window_mode"),
                                                    party_first_name=party["first_name"] if party else None, feedback=feedback, last_message_id=message_id, examples=examples, instruction=instruction,
                                                    cart=prompts.cart_text(cart)),
            history=history, model=route["primary_model"], fallback_models=list(route.get("fallback_models") or []), params=route.get("params") or {},
            provider_prefs=route.get("provider_prefs") or {}))

    try:
        out = await ask()
    except TransientError as e:
        await _finish_run(deps, run_id, None, "ERROR", str(e))
        raise RetryLater(int(e.retry_after or 20), str(e)) from e
    except ProviderPermanent as e:                                  # circuit breaker: falhou de vez → humano
        await _finish_run(deps, run_id, None, "ERROR", str(e))
        if not forced:
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
        if not forced:
            await _handoff(deps, claim, "a IA não conseguiu responder", "AI_FAILURE")
        return
    if rules.mentions_health(text) and "HEALTH_TOPIC" not in flags:
        flags.append("HEALTH_TOPIC")

    intent = (proposal.get("intent") or "").upper() or None
    confidence = float(proposal.get("confidence") or 0)
    allowed = AUTOPILOT_OK if mode == "AI_AUTOPILOT" else AFTER_HOURS_OK if after_hours_auto else set()
    can_autosend = (bool(allowed) and not flags and not proposal.get("needs_human") and intent in allowed and confidence >= deps.settings.autopilot_min_confidence
                    and claim.get("tier") != "VIP_BLACK" and claim.get("window_allowed"))
    if forced:                                                       # pedido do atendente: sempre rascunho (ele decide)
        action = "DRAFT"
        if (proposal.get("needs_human") or intent in ALWAYS_HUMAN) and "NEEDS_HUMAN" not in flags:
            flags.append("NEEDS_HUMAN")
    elif proposal.get("needs_human") or intent in ALWAYS_HUMAN:
        action = "HANDOFF"
    elif can_autosend:
        action = "SEND"
    else:
        action = "DRAFT"

    result = await call_fn(deps.pool, "omni.apply_ai_result", conv_id, claim["version"], run_id, {
        "action": action, "messages": proposal["messages"], "intent": intent, "stage": proposal.get("stage"), "confidence": confidence,
        "needs_human": bool(proposal.get("needs_human")), "flags": flags, "reason": proposal.get("reason") or f"intenção {intent or 'não classificada'}",
        "based_on_message_at": m["created_at"], "trigger": "AI_REQUEST_HANDOFF", "force": forced})
    await _finish_run(deps, run_id, out)
    if not result.get("applied"):
        log.info("resultado da IA descartado (%s) na conversa %s", result.get("reason"), conv_id)
        return
    await _apply_cart(deps, conv_id, cart, proposal.get("cart"))
    if action == "DRAFT":
        await deps.notify(claim["org_id"], "DRAFT_READY", "Rascunho da IA pronto para revisar", {"conversation_id": conv_id})
        await _after_hours(deps, claim)
    elif action == "HANDOFF":
        await call_fn(deps.pool, "omni.queue_system_message", conv_id, waiting_text(claim))
        await deps.notify(claim["org_id"], "HANDOFF", "Cliente aguardando atendimento humano", {"conversation_id": conv_id}, perm="omni.write")
        await _after_hours(deps, claim)
