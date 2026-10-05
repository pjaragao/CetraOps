"""Clientes do agente. O contrato é o mesmo para o Hermes (ferramentas via MCP) e para o Plano B (laço de ferramentas aqui, chamando
agent.call_tool direto): no fim, a resposta está em ai.tool_calls como a última chamada de `propose_reply`."""
from __future__ import annotations

import json
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Protocol

import httpx
from psycopg_pool import AsyncConnectionPool

from centralops_agent_contract import schemas_for

from ..adapters.errors import PermanentError, TransientError
from ..db import call_fn


@dataclass
class AgentInput:
    run_id: str
    ctx: dict[str, Any]                    # payload do token (o banco confere de novo)
    ctx_token: str
    system_stable: str
    system_volatile: str
    history: list[dict[str, str]]          # [{role: user|assistant, content}]
    model: str
    fallback_models: list[str] = field(default_factory=list)
    params: dict[str, Any] = field(default_factory=dict)
    provider_prefs: dict[str, Any] = field(default_factory=dict)


@dataclass
class AgentOutput:
    text: str | None = None
    model: str | None = None
    tokens_in: int = 0
    tokens_out: int = 0
    cache_read_tokens: int = 0
    cost_usd: float = 0.0
    latency_ms: int = 0
    tool_calls: int = 0


class AgentClient(Protocol):
    async def run(self, inp: AgentInput) -> AgentOutput: ...


def _classify(resp: httpx.Response) -> None:
    if resp.status_code < 400:
        return
    if resp.status_code == 429 or resp.status_code >= 500:
        raise TransientError(f"LLM {resp.status_code}", status=resp.status_code)
    raise PermanentError(f"LLM {resp.status_code}: {resp.text[:300]}", status=resp.status_code)


class OpenRouterAgent:
    """Plano B (e caminho de desenvolvimento): chama o OpenRouter com function calling e executa as ferramentas no banco."""

    def __init__(self, pool: AsyncConnectionPool, http: httpx.AsyncClient, base: str, api_key: str, max_steps: int = 6) -> None:
        self._pool, self._http, self._base, self._key, self._max_steps = pool, http, base.rstrip("/"), api_key, max_steps

    async def _chat(self, inp: AgentInput, model: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> dict[str, Any]:
        body: dict[str, Any] = {"model": model, "messages": messages, "tools": tools, **{k: v for k, v in inp.params.items() if k in ("temperature", "max_tokens", "reasoning")}}
        if inp.fallback_models:
            body["models"] = [model, *inp.fallback_models]
        if inp.provider_prefs:
            body["provider"] = inp.provider_prefs           # zdr / data_collection: deny
        try:
            resp = await self._http.post(f"{self._base}/chat/completions", json=body, headers={"Authorization": f"Bearer {self._key}"}, timeout=90)
        except (httpx.TimeoutException, httpx.TransportError) as e:
            raise TransientError(f"rede: {e}") from e
        _classify(resp)
        return resp.json()

    async def run(self, inp: AgentInput) -> AgentOutput:
        t0 = time.monotonic()
        out = AgentOutput(model=inp.model)
        tools = schemas_for(inp.ctx["caps"])
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": inp.system_stable},          # estável e cacheável primeiro
            {"role": "system", "content": inp.system_volatile},
            *inp.history,
        ]
        for _ in range(self._max_steps):
            data = await self._chat(inp, inp.model, messages, tools)
            usage = data.get("usage") or {}
            out.tokens_in += int(usage.get("prompt_tokens") or 0)
            out.tokens_out += int(usage.get("completion_tokens") or 0)
            out.cache_read_tokens += int((usage.get("prompt_tokens_details") or {}).get("cached_tokens") or 0)
            out.cost_usd += float(usage.get("cost") or 0)
            out.model = data.get("model", out.model)
            choice = (data.get("choices") or [{}])[0].get("message", {})
            calls = choice.get("tool_calls") or []
            if not calls:
                out.text = choice.get("content")
                break
            messages.append({"role": "assistant", "content": choice.get("content"), "tool_calls": calls})
            finished = False
            for call in calls:
                name = call["function"]["name"]
                try:
                    args = json.loads(call["function"].get("arguments") or "{}")
                except ValueError:
                    args = {}
                args.pop("ctx", None)
                result = await call_fn(self._pool, "agent.call_tool", inp.ctx, name, args)
                out.tool_calls += 1
                messages.append({"role": "tool", "tool_call_id": call["id"], "content": json.dumps(result, ensure_ascii=False, default=str)})
                if name == "propose_reply" and result.get("ok"):
                    finished = True
            if finished:
                break
        out.latency_ms = int((time.monotonic() - t0) * 1000)
        return out


class HermesAgent:
    """Hermes Agent (Nous Research) por API compatível com OpenAI. As ferramentas rodam no servidor MCP; o ctx vai no prompt."""

    def __init__(self, http: httpx.AsyncClient, base: str, api_key: str) -> None:
        self._http, self._base, self._key = http, base.rstrip("/"), api_key

    async def run(self, inp: AgentInput) -> AgentOutput:
        t0 = time.monotonic()
        body = {"model": inp.model, "stream": False, "messages": [{"role": "system", "content": inp.system_stable}, {"role": "system", "content": inp.system_volatile}, *inp.history]}
        headers = {"Authorization": f"Bearer {self._key}", "X-Hermes-Session-Id": f'conv_{inp.ctx["conv"]}'}
        try:
            resp = await self._http.post(f"{self._base}/chat/completions", json=body, headers=headers, timeout=120)
        except (httpx.TimeoutException, httpx.TransportError) as e:
            raise TransientError(f"rede: {e}") from e
        _classify(resp)
        data = resp.json()
        usage = data.get("usage") or {}
        return AgentOutput(
            text=((data.get("choices") or [{}])[0].get("message") or {}).get("content"), model=data.get("model", inp.model),
            tokens_in=int(usage.get("prompt_tokens") or 0), tokens_out=int(usage.get("completion_tokens") or 0),
            cache_read_tokens=int((usage.get("prompt_tokens_details") or {}).get("cached_tokens") or 0), cost_usd=float(usage.get("cost") or 0),
            latency_ms=int((time.monotonic() - t0) * 1000),
        )


log = logging.getLogger("centralops_worker.agent")


class FallbackAgent:
    """Hermes primeiro; se ele falhar (erro transitório ou definitivo), a MESMA execução segue pelo Plano B (OpenRouter direto, mesmas ferramentas).
    Circuit breaker: depois de `threshold` falhas seguidas o primário é pulado por `cooldown_s` segundos — sem esperar timeout a cada mensagem."""

    def __init__(self, primary: AgentClient, secondary: AgentClient, *, threshold: int = 3, cooldown_s: float = 60.0, clock: Callable[[], float] = time.monotonic) -> None:
        self._primary, self._secondary = primary, secondary
        self._threshold, self._cooldown, self._clock = threshold, cooldown_s, clock
        self._failures = 0
        self._opened_at: float | None = None

    @property
    def open(self) -> bool:
        if self._opened_at is None:
            return False
        if self._clock() - self._opened_at >= self._cooldown:          # meia-abertura: a próxima execução testa o primário de novo
            self._opened_at, self._failures = None, self._threshold - 1
            return False
        return True

    async def run(self, inp: AgentInput) -> AgentOutput:
        if self.open:
            return await self._secondary.run(inp)
        try:
            out = await self._primary.run(inp)
        except (TransientError, PermanentError) as e:
            self._failures += 1
            if self._failures >= self._threshold:
                self._opened_at = self._clock()
                log.error("Hermes falhou %s vezes seguidas: usando o Plano B por %ss (%s)", self._failures, self._cooldown, e)
            else:
                log.warning("Hermes falhou (%s); esta execução segue pelo Plano B", e)
            return await self._secondary.run(inp)
        self._failures = 0
        return out
