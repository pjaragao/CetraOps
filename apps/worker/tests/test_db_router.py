"""Roteador de conversas: pré-regras, modos, guardrails com nova tentativa, envio automático × rascunho × transferência e concorrência.
O agente é simulado, mas as ferramentas rodam DE VERDADE no banco (agent.call_tool), então a validação numérica usa o registro real de ai.tool_calls."""
from __future__ import annotations

import dataclasses
from collections.abc import Awaitable, Callable
from typing import Any

import pytest

from sie_worker import queues
from sie_worker.adapters.errors import PermanentError as ProviderPermanent
from sie_worker.adapters.errors import TransientError
from sie_worker.ai.agent import AgentInput, AgentOutput
from sie_worker.db import call_fn, fetch_all, fetch_one
from sie_worker.deps import Deps
from sie_worker.handlers import router
from sie_worker.runner import RetryLater

from .conftest import ORG, ingest, unique_phone

pytestmark = pytest.mark.db

Step = Callable[["FakeAgent", AgentInput], Awaitable[None]] | Exception


class FakeAgent:
    """Roteiro em vez de LLM: cada execução consome um passo; o passo chama ferramentas reais e termina com propose_reply."""

    def __init__(self, pool: Any, *steps: Step) -> None:
        self.pool, self.steps, self.inputs = pool, list(steps), []

    async def tool(self, inp: AgentInput, name: str, args: dict[str, Any]) -> dict[str, Any]:
        return await call_fn(self.pool, "agent.call_tool", inp.ctx, name, args)

    async def propose(self, inp: AgentInput, messages: list[str], *, intent: str = "GREETING", confidence: float = 0.9, needs_human: bool = False, stage: str = "GREETING") -> None:
        res = await self.tool(inp, "propose_reply", {"messages": messages, "intent": intent, "stage": stage, "confidence": confidence, "needs_human": needs_human, "reason": "teste"})
        assert res["ok"], res

    async def run(self, inp: AgentInput) -> AgentOutput:
        self.inputs.append(inp)
        step = self.steps[min(len(self.inputs), len(self.steps)) - 1]
        if isinstance(step, Exception):
            raise step
        await step(self, inp)
        return AgentOutput(model="fake/model", tokens_in=100, tokens_out=20, cost_usd=0.0021, latency_ms=12, tool_calls=1)


def says(*messages: str, **kw: Any) -> Step:
    async def step(agent: FakeAgent, inp: AgentInput) -> None:
        await agent.propose(inp, list(messages), **kw)
    return step


def with_deps(deps: Deps, agent: Any, **settings: Any) -> Deps:
    return dataclasses.replace(deps, agent=agent, settings=deps.settings.model_copy(update=settings))


async def set_mode(pool: Any, conv_id: str, mode: str) -> None:
    await fetch_one(pool, "update omni.conversations set mode = %s where id = %s returning id", (mode, conv_id))


async def start(pool: Any, channel: dict[str, str], text: str, mode: str = "AI_COPILOT", **extra: Any) -> dict[str, Any]:
    wa = unique_phone()
    conv = await ingest(pool, channel, wa, text, **extra)
    await set_mode(pool, conv["conversation_id"], mode)
    return {**conv, "wa": wa}


def job(conv: dict[str, Any]) -> queues.QueueMessage:
    return queues.QueueMessage("conversation_router", 1, 1, {"conversation_id": str(conv["conversation_id"]), "message_id": str(conv["message_id"])})


async def drafts(pool: Any, conv: dict[str, Any]) -> list[dict[str, Any]]:
    return await fetch_all(pool, "select status, intent, confidence, flags, variants from omni.message_drafts where conversation_id = %s order by created_at", (conv["conversation_id"],))


async def outgoing(pool: Any, conv: dict[str, Any]) -> list[dict[str, Any]]:
    return await fetch_all(pool, "select author_type, body, status from omni.messages where conversation_id = %s and direction = 'OUT' order by created_at, seq", (conv["conversation_id"],))


async def mode_of(pool: Any, conv: dict[str, Any]) -> str:
    return (await fetch_one(pool, "select mode from omni.conversations where id = %s", (conv["conversation_id"],)))["mode"]  # type: ignore[index]


async def notified(pool: Any, kind: str) -> int:
    return (await fetch_one(pool, "select count(*) as n from core.notifications where kind = %s", (kind,)))["n"]  # type: ignore[index]


# ---------------------------------------------------------------------------------------------------------------------------------------------
# Modos e destinos
# ---------------------------------------------------------------------------------------------------------------------------------------------
async def test_copilot_saves_draft_and_notifies(pool: Any, deps: Deps, channel: dict[str, str]) -> None:
    conv = await start(pool, channel, "Oi! Vocês têm legging preta?")
    agent = FakeAgent(pool, says("Oi! Que bom te ver por aqui. Qual atividade você pratica?", intent="STOCK", stage="DISCOVERY"))
    before = await notified(pool, "DRAFT_READY")
    await router.handle(with_deps(deps, agent), job(conv))
    (d,) = await drafts(pool, conv)
    assert d["status"] == "PENDING" and d["intent"] == "STOCK" and float(d["confidence"]) == 0.9 and d["flags"] == []
    assert d["variants"][0]["messages"] == ["Oi! Que bom te ver por aqui. Qual atividade você pratica?"]
    assert await outgoing(pool, conv) == []                                                     # copiloto nunca envia sozinho
    assert await notified(pool, "DRAFT_READY") > before
    run = await fetch_one(pool, "select status, model, tokens_in, cost_usd, confidence from ai.runs where conversation_id = %s", (conv["conversation_id"],))
    assert run and run["status"] == "OK" and run["model"] == "fake/model" and run["tokens_in"] == 100 and float(run["cost_usd"]) == 0.0021
    inp = agent.inputs[0]
    assert "propose_reply" in inp.ctx["caps"] and "create_payment_link" not in inp.ctx["caps"]           # copiloto: sem ferramentas de escrita
    assert inp.history == [{"role": "user", "content": "Oi! Vocês têm legging preta?"}] and inp.ctx_token in inp.system_volatile
    assert "Modo COPILOTO" in inp.system_volatile and "REGRAS OBRIGATÓRIAS" in inp.system_stable


async def test_autopilot_sends_allowed_intent(pool: Any, deps: Deps, channel: dict[str, str]) -> None:
    conv = await start(pool, channel, "Bom dia!", "AI_AUTOPILOT")
    agent = FakeAgent(pool, says("Bom dia! Como posso te ajudar hoje?", "Se quiser, mostro os lançamentos.", intent="GREETING", confidence=0.92))
    await router.handle(with_deps(deps, agent), job(conv))
    out = await outgoing(pool, conv)
    assert [(o["author_type"], o["status"]) for o in out] == [("AI", "QUEUED"), ("AI", "QUEUED")] and out[0]["body"].startswith("Bom dia")
    assert await drafts(pool, conv) == []
    sent = await fetch_all(pool, "select message from pgmq.q_outbound_messages where message->>'org_id' = %s", (ORG,))
    assert len(sent) >= 2
    assert "create_payment_link" in agent.inputs[0].ctx["caps"]                                          # autopiloto recebe o conjunto completo


@pytest.mark.parametrize("intent,confidence,expect", [
    ("PRICE_NEGOTIATION", 0.95, "HANDOFF"),         # lista "sempre humano"
    ("COMPLAINT", 0.99, "HANDOFF"),
    ("SMALL_TALK", 0.95, "DRAFT"),                  # fora da lista fechada do autopiloto
    ("GREETING", 0.60, "DRAFT"),                    # abaixo do limiar
])
async def test_autopilot_only_for_closed_intent_list_and_confidence(pool: Any, deps: Deps, channel: dict[str, str], intent: str, confidence: float, expect: str) -> None:
    conv = await start(pool, channel, "Oi", "AI_AUTOPILOT")
    await router.handle(with_deps(deps, FakeAgent(pool, says("Certo!", intent=intent, confidence=confidence))), job(conv))
    if expect == "HANDOFF":
        assert await mode_of(pool, conv) == "WAITING_HUMAN"
        assert [o["author_type"] for o in await outgoing(pool, conv)] == ["SYSTEM"]                      # só a mensagem de espera
    else:
        assert await mode_of(pool, conv) == "AI_AUTOPILOT" and len(await drafts(pool, conv)) == 1
        assert await outgoing(pool, conv) == []


async def test_autopilot_never_sends_to_vip_black_or_outside_window(pool: Any, deps: Deps, channel: dict[str, str]) -> None:
    conv = await start(pool, channel, "Oi", "AI_AUTOPILOT")
    await fetch_one(pool, "update crm.parties set tier = 'VIP_BLACK' where id = %s returning id", (conv["party_id"],))
    await router.handle(with_deps(deps, FakeAgent(pool, says("Olá!", intent="GREETING", confidence=0.95))), job(conv))
    assert len(await drafts(pool, conv)) == 1 and await outgoing(pool, conv) == []


async def test_health_topic_forces_draft_even_in_autopilot(pool: Any, deps: Deps, channel: dict[str, str]) -> None:
    conv = await start(pool, channel, "Tenho uma lesão no joelho, qual legging é melhor?", "AI_AUTOPILOT")
    await router.handle(with_deps(deps, FakeAgent(pool, says("Para o seu caso, vale conversar com um profissional de saúde.", intent="PRODUCT_INFO", confidence=0.95))), job(conv))
    (d,) = await drafts(pool, conv)
    assert "HEALTH_TOPIC" in d["flags"] and await outgoing(pool, conv) == []


async def test_model_without_propose_reply_becomes_low_confidence_draft(pool: Any, deps: Deps, channel: dict[str, str]) -> None:
    conv = await start(pool, channel, "Oi", "AI_AUTOPILOT")

    async def text_only(agent: FakeAgent, inp: AgentInput) -> None:
        return None

    class TextAgent(FakeAgent):
        async def run(self, inp: AgentInput) -> AgentOutput:
            self.inputs.append(inp)
            return AgentOutput(model="fake/model", text="Olá!\n\nComo posso ajudar?")

    await router.handle(with_deps(deps, TextAgent(pool)), job(conv))
    (d,) = await drafts(pool, conv)
    assert "NO_PROPOSAL" in d["flags"] and float(d["confidence"]) == 0.3 and d["variants"][0]["messages"] == ["Olá!", "Como posso ajudar?"]
    assert await outgoing(pool, conv) == []


# ---------------------------------------------------------------------------------------------------------------------------------------------
# Guardrails: numérico contra o registro real de ferramentas, com uma nova tentativa
# ---------------------------------------------------------------------------------------------------------------------------------------------
async def test_invented_price_is_rejected_then_retried_with_feedback(pool: Any, deps: Deps, channel: dict[str, str]) -> None:
    conv = await start(pool, channel, "Quanto custa a legging?", "AI_AUTOPILOT")
    agent = FakeAgent(pool, says("A legging sai por R$ 399,00 hoje.", intent="STOCK", confidence=0.95),
                      says("Vou conferir o valor certinho e já te conto.", intent="STOCK", confidence=0.95))
    await router.handle(with_deps(deps, agent), job(conv))
    assert len(agent.inputs) == 2 and "UNGROUNDED_PRICE" in agent.inputs[1].system_volatile                # o motivo volta para o modelo
    out = await outgoing(pool, conv)
    assert [o["body"] for o in out] == ["Vou conferir o valor certinho e já te conto."]                    # a resposta reprovada nunca sai
    run = await fetch_one(pool, "select tokens_in, cost_usd from ai.runs where conversation_id = %s", (conv["conversation_id"],))
    assert run and run["tokens_in"] == 200                                                                # custo das duas tentativas somado


async def test_grounded_price_from_real_search_is_accepted(pool: Any, deps: Deps, channel: dict[str, str]) -> None:
    conv = await start(pool, channel, "Tem legging preta?", "AI_AUTOPILOT")

    async def grounded(agent: FakeAgent, inp: AgentInput) -> None:
        res = await agent.tool(inp, "search_catalog", {"query": "legging"})
        assert res["ok"] and res["products"], res
        price = res["products"][0]["price"]
        br = f"{price:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
        await agent.propose(inp, [f"Temos a {res['products'][0]['name']} por R$ {br}."], intent="STOCK", confidence=0.95)

    await router.handle(with_deps(deps, FakeAgent(pool, grounded)), job(conv))
    out = await outgoing(pool, conv)
    assert len(out) == 1 and out[0]["author_type"] == "AI" and "R$" in out[0]["body"]
    tools = await fetch_all(pool, "select tool, ok from ai.tool_calls tc join ai.runs r on r.id = tc.run_id where r.conversation_id = %s order by tc.id", (conv["conversation_id"],))
    assert [t["tool"] for t in tools] == ["search_catalog", "propose_reply"] and all(t["ok"] for t in tools)


async def test_persistent_violation_falls_back_to_draft_with_flags(pool: Any, deps: Deps, channel: dict[str, str]) -> None:
    conv = await start(pool, channel, "Quanto custa?", "AI_AUTOPILOT")
    bad = says("Fica R$ 399,00 pra você.", intent="STOCK", confidence=0.95)
    await router.handle(with_deps(deps, FakeAgent(pool, bad, bad)), job(conv))
    (d,) = await drafts(pool, conv)
    assert "UNGROUNDED_PRICE" in d["flags"] and await outgoing(pool, conv) == []                           # vira rascunho para humano revisar


# ---------------------------------------------------------------------------------------------------------------------------------------------
# Pré-regras (sem LLM) e modos que não usam IA
# ---------------------------------------------------------------------------------------------------------------------------------------------
async def test_human_request_hands_off_without_calling_the_model(pool: Any, deps: Deps, channel: dict[str, str]) -> None:
    conv = await start(pool, channel, "Quero falar com a Luisa, por favor", "AI_AUTOPILOT")
    agent = FakeAgent(pool, says("nunca deveria ser chamado"))
    before = await notified(pool, "HANDOFF")
    await router.handle(with_deps(deps, agent), job(conv))
    assert agent.inputs == [] and await mode_of(pool, conv) == "WAITING_HUMAN"
    assert [o["author_type"] for o in await outgoing(pool, conv)] == ["SYSTEM"]
    ev = await fetch_one(pool, "select trigger, reason from omni.mode_events where conversation_id = %s order by id desc limit 1", (conv["conversation_id"],))
    assert ev and ev["trigger"] == "KEYWORD" and "pessoa" in ev["reason"]
    assert await notified(pool, "HANDOFF") > before
    sla = await fetch_one(pool, "select sla_due_at is not null as has_sla from omni.conversations where id = %s", (conv["conversation_id"],))
    assert sla and sla["has_sla"] is True


async def test_legal_threat_escalates(pool: Any, deps: Deps, channel: dict[str, str]) -> None:
    conv = await start(pool, channel, "Vou procurar o Procon se não resolverem", "AI_AUTOPILOT")
    agent = FakeAgent(pool, says("x"))
    await router.handle(with_deps(deps, agent), job(conv))
    assert agent.inputs == [] and await mode_of(pool, conv) == "WAITING_HUMAN"
    ev = await fetch_one(pool, "select trigger from omni.mode_events where conversation_id = %s order by id desc limit 1", (conv["conversation_id"],))
    assert ev and ev["trigger"] == "POLICY"


async def test_opt_out_revokes_marketing_and_confirms(pool: Any, deps: Deps, channel: dict[str, str]) -> None:
    conv = await start(pool, channel, "PARAR", "AI_AUTOPILOT")
    agent = FakeAgent(pool, says("x"))
    await router.handle(with_deps(deps, agent), job(conv))
    assert agent.inputs == []
    rows = await fetch_all(pool, "select purpose, granted from crm.consents where party_id = %s and (evidence->>'keyword') = 'true' order by purpose", (conv["party_id"],))
    assert {r["purpose"] for r in rows} == {"MARKETING_WHATSAPP", "MARKETING_EMAIL", "MARKETING_IG"} and not any(r["granted"] for r in rows)
    out = await outgoing(pool, conv)
    assert len(out) == 1 and "não vamos mais enviar" in out[0]["body"]


async def test_human_mode_only_notifies(pool: Any, deps: Deps, channel: dict[str, str]) -> None:
    conv = await start(pool, channel, "Oi", "HUMAN")
    agent = FakeAgent(pool, says("x"))
    before = await notified(pool, "NEW_MESSAGE")
    await router.handle(with_deps(deps, agent), job(conv))
    assert agent.inputs == [] and await outgoing(pool, conv) == [] and await drafts(pool, conv) == []
    assert await notified(pool, "NEW_MESSAGE") >= before                                                     # (sem responsável, notifica quem tem omni.write)


async def test_waiting_human_sends_the_wait_message_only_once(pool: Any, deps: Deps, channel: dict[str, str]) -> None:
    conv = await start(pool, channel, "Oi", "WAITING_HUMAN")
    d = with_deps(deps, FakeAgent(pool))
    await router.handle(d, job(conv))
    second = await ingest(pool, channel, conv["wa"], "alguém aí?")                                            # a cliente insiste: a espera não se repete
    await router.handle(d, job(second))
    assert len([o for o in await outgoing(pool, conv) if o["author_type"] == "SYSTEM"]) == 1


# ---------------------------------------------------------------------------------------------------------------------------------------------
# Horário de atendimento
# ---------------------------------------------------------------------------------------------------------------------------------------------
async def close_store_now(pool: Any, channel: dict[str, str], after_hours_ai: str = "SAFE_AUTOPILOT") -> None:
    """Horário só num dia que não é hoje: agora a loja está fechada."""
    await fetch_one(pool, """update omni.channel_accounts set business_hours = jsonb_build_object('after_hours_ai', %s::text, 'days',
                               jsonb_build_object(((extract(dow from now() at time zone 'America/Sao_Paulo')::int + 3) %% 7)::text, '[["09:00","18:00"]]'::jsonb))
                             where id = %s returning id""", (after_hours_ai, channel["account_id"]))


async def test_after_hours_copilot_answers_information_alone(pool: Any, deps: Deps, channel: dict[str, str]) -> None:
    await close_store_now(pool, channel)
    conv = await start(pool, channel, "Que horas vocês abrem?")
    agent = FakeAgent(pool, says("Abrimos às 9h, dentro da JOY!", intent="STORE_INFO", confidence=0.9))
    await router.handle(with_deps(deps, agent), job(conv))
    assert [o["author_type"] for o in await outgoing(pool, conv)] == ["AI"]                             # fora do horário, informação sai sozinha
    assert "create_payment_link" not in agent.inputs[0].ctx["caps"]                                        # sem ferramentas de pedido/link/reserva


async def test_after_hours_transactional_waits_with_task_for_opening(pool: Any, deps: Deps, channel: dict[str, str]) -> None:
    await close_store_now(pool, channel)
    conv = await start(pool, channel, "Separa a legging M pra mim?")
    agent = FakeAgent(pool, says("Separo sim! Qual cor?", intent="RESERVATION", confidence=0.95))
    await router.handle(with_deps(deps, agent), job(conv))
    assert await outgoing(pool, conv) == [] and len(await drafts(pool, conv)) == 1                        # reserva espera a equipe
    task = await fetch_one(pool, "select title, due_at > now() as future from crm.tasks where source_rule = %s", (f"after_hours:{conv['conversation_id']}",))
    assert task and "fora do horário" in task["title"] and task["future"]


async def test_after_hours_draft_only_keeps_copilot_behaviour(pool: Any, deps: Deps, channel: dict[str, str]) -> None:
    await close_store_now(pool, channel, "DRAFT_ONLY")
    conv = await start(pool, channel, "Que horas vocês abrem?")
    await router.handle(with_deps(deps, FakeAgent(pool, says("Às 9h!", intent="STORE_INFO"))), job(conv))
    assert await outgoing(pool, conv) == [] and len(await drafts(pool, conv)) == 1


async def test_after_hours_wait_message_says_when_the_team_returns(pool: Any, deps: Deps, channel: dict[str, str]) -> None:
    await close_store_now(pool, channel)
    conv = await start(pool, channel, "Oi", "WAITING_HUMAN")
    await router.handle(with_deps(deps, FakeAgent(pool)), job(conv))
    (msg,) = [o for o in await outgoing(pool, conv) if o["author_type"] == "SYSTEM"]
    assert "fora do horário" in msg["body"] and " às " in msg["body"]


def test_waiting_text_inside_hours_is_the_usual_message() -> None:
    assert router.waiting_text({"is_open": True}) == router.WAIT_MESSAGE
    assert "amanhã às 9h" in router.waiting_text({"is_open": False, "next_open_label": "amanhã às 9h"})


# ---------------------------------------------------------------------------------------------------------------------------------------------
# Concorrência, limites e falhas
# ---------------------------------------------------------------------------------------------------------------------------------------------
async def test_newer_customer_message_skips_the_run(pool: Any, deps: Deps, channel: dict[str, str]) -> None:
    wa = unique_phone()
    first = await ingest(pool, channel, wa, "Oi")
    await set_mode(pool, first["conversation_id"], "AI_COPILOT")
    await ingest(pool, channel, wa, "Na verdade, queria saber do tamanho")
    agent = FakeAgent(pool, says("x"))
    await router.handle(with_deps(deps, agent), job(first))
    assert agent.inputs == [] and await drafts(pool, first) == []


async def test_human_takeover_during_the_run_discards_the_result(pool: Any, deps: Deps, channel: dict[str, str]) -> None:
    conv = await start(pool, channel, "Oi", "AI_AUTOPILOT")

    async def takeover(agent: FakeAgent, inp: AgentInput) -> None:
        await set_mode(pool, str(conv["conversation_id"]), "HUMAN")                                        # a vendedora assume enquanto a IA pensa
        await agent.propose(inp, ["Olá! Como posso ajudar?"], intent="GREETING", confidence=0.95)

    await router.handle(with_deps(deps, FakeAgent(pool, takeover)), job(conv))
    assert await outgoing(pool, conv) == [] and await drafts(pool, conv) == [] and await mode_of(pool, conv) == "HUMAN"
    run = await fetch_one(pool, "select status from ai.runs where conversation_id = %s", (conv["conversation_id"],))
    assert run and run["status"] == "DISCARDED"


async def test_hourly_reply_limit_hands_off(pool: Any, deps: Deps, channel: dict[str, str]) -> None:
    conv = await start(pool, channel, "Oi", "AI_AUTOPILOT")
    await fetch_one(pool, """insert into omni.messages (org_id, conversation_id, channel_account_id, direction, author_type, body, status)
                             select org_id, id, channel_account_id, 'OUT', 'AI', 'antes', 'SENT' from omni.conversations where id = %s returning id""", (conv["conversation_id"],))
    agent = FakeAgent(pool, says("x"))
    await router.handle(with_deps(deps, agent, ai_max_replies_per_hour=1), job(conv))
    assert agent.inputs == [] and await mode_of(pool, conv) == "WAITING_HUMAN"
    ev = await fetch_one(pool, "select trigger from omni.mode_events where conversation_id = %s order by id desc limit 1", (conv["conversation_id"],))
    assert ev and ev["trigger"] == "AI_RATE_LIMIT"


async def test_daily_budget_exhausted_hands_off(pool: Any, deps: Deps, channel: dict[str, str]) -> None:
    conv = await start(pool, channel, "Oi", "AI_AUTOPILOT")
    await fetch_one(pool, """insert into ai.model_routes (org_id, task, primary_model, daily_budget_usd) values (%s, 'conversation', 'x/y', 1.00)
                             on conflict (org_id, task) do update set daily_budget_usd = 1.00, active = true returning id""", (ORG,))
    await fetch_one(pool, "insert into ai.runs (org_id, route_task, status, cost_usd) values (%s, 'conversation', 'OK', 5) returning id", (ORG,))
    agent = FakeAgent(pool, says("x"))
    await router.handle(with_deps(deps, agent), job(conv))
    assert agent.inputs == [] and await mode_of(pool, conv) == "WAITING_HUMAN"
    ev = await fetch_one(pool, "select trigger from omni.mode_events where conversation_id = %s order by id desc limit 1", (conv["conversation_id"],))
    assert ev and ev["trigger"] == "AI_BUDGET"


async def test_provider_failures(pool: Any, deps: Deps, channel: dict[str, str]) -> None:
    conv = await start(pool, channel, "Oi", "AI_AUTOPILOT")
    with pytest.raises(RetryLater):                                                                          # 429/5xx: tenta de novo, sem transferir
        await router.handle(with_deps(deps, FakeAgent(pool, TransientError("LLM 503", retry_after=7))), job(conv))
    assert await mode_of(pool, conv) == "AI_AUTOPILOT"
    assert (await fetch_one(pool, "select status from ai.runs where conversation_id = %s", (conv["conversation_id"],)))["status"] == "ERROR"  # type: ignore[index]
    conv2 = await start(pool, channel, "Oi", "AI_AUTOPILOT")
    await router.handle(with_deps(deps, FakeAgent(pool, ProviderPermanent("LLM 401: chave inválida"))), job(conv2))  # erro definitivo: humano assume
    assert await mode_of(pool, conv2) == "WAITING_HUMAN"
    ev = await fetch_one(pool, "select trigger from omni.mode_events where conversation_id = %s order by id desc limit 1", (conv2["conversation_id"],))
    assert ev and ev["trigger"] == "AI_FAILURE"


async def test_no_agent_configured_falls_back_to_humans(pool: Any, deps: Deps, channel: dict[str, str]) -> None:
    copilot = await start(pool, channel, "Oi", "AI_COPILOT")
    before = await notified(pool, "NEW_MESSAGE")
    await router.handle(deps, job(copilot))                                                                  # copiloto: só avisa a equipe, nada vai para a cliente
    assert await mode_of(pool, copilot) == "AI_COPILOT" and await outgoing(pool, copilot) == [] and await notified(pool, "NEW_MESSAGE") > before
    auto = await start(pool, channel, "Oi", "AI_AUTOPILOT")
    await router.handle(deps, job(auto))                                                                     # autopiloto sem IA: transfere para uma pessoa
    assert await mode_of(pool, auto) == "WAITING_HUMAN"
    ev = await fetch_one(pool, "select trigger from omni.mode_events where conversation_id = %s order by id desc limit 1", (auto["conversation_id"],))
    assert ev and ev["trigger"] == "AI_FAILURE"


async def test_audio_waits_for_transcription(pool: Any, deps: Deps, channel: dict[str, str]) -> None:
    conv = await start(pool, channel, "[áudio]", "AI_COPILOT", type="AUDIO", payload={"media": {"id": "M1"}})
    agent = FakeAgent(pool, says("Claro!", intent="STOCK"))
    with pytest.raises(RetryLater):
        await router.handle(with_deps(deps, agent), job(conv))
    await call_fn(pool, "omni.attach_media", str(conv["message_id"]), "org/conv/msg.ogg", "Tem legging preta no M?")
    await router.handle(with_deps(deps, agent), job(conv))
    assert len(await drafts(pool, conv)) == 1
    assert agent.inputs[0].history[-1] == {"role": "user", "content": "[áudio transcrito] Tem legging preta no M?"}
