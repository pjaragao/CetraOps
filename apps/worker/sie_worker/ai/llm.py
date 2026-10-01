"""Chamadas de IA "em volume" (classificar, extrair, resumir, estilo, embeddings): direto no OpenRouter, sem passar pelo Hermes (plano §1.1).
O modelo vem da tabela `ai.model_routes` (troca na tela Modelos & custos, sem deploy); cada chamada vira uma linha em `ai.runs` com custo e
respeita o orçamento diário da rota."""
from __future__ import annotations

import json
import re
import time
from typing import Any

import httpx
from psycopg_pool import AsyncConnectionPool

from ..adapters.errors import PermanentError, TransientError
from ..db import fetch_one


def _check(resp: httpx.Response) -> None:
    if resp.status_code < 400:
        return
    if resp.status_code == 429 or resp.status_code >= 500:
        raise TransientError(f"LLM {resp.status_code}", status=resp.status_code)
    raise PermanentError(f"LLM {resp.status_code}: {resp.text[:300]}", status=resp.status_code)


def parse_json_content(content: str | None) -> dict[str, Any]:
    """Conteúdo da resposta → objeto. Aceita cerca de código (```json) que alguns modelos colocam mesmo com schema."""
    text = (content or "").strip()
    fenced = re.match(r"^```(?:json)?\s*(.*?)\s*```$", text, re.S)
    if fenced:
        text = fenced.group(1)
    try:
        data = json.loads(text)
    except ValueError as e:
        raise PermanentError(f"a IA não devolveu JSON válido: {text[:120]!r}") from e
    if not isinstance(data, dict):
        raise PermanentError("a IA devolveu JSON que não é um objeto")
    return data


class LLM:
    def __init__(self, pool: AsyncConnectionPool, http: httpx.AsyncClient, base: str, api_key: str) -> None:
        self._pool, self._http, self._base, self._key = pool, http, base.rstrip("/"), api_key

    async def route(self, org_id: str, task: str) -> dict[str, Any]:
        row = await fetch_one(self._pool, "select primary_model, fallback_models, params, provider_prefs, daily_budget_usd, active from ai.model_routes where org_id = %s and task = %s", (org_id, task))
        if row is None or not row["active"]:
            raise PermanentError(f"A rota de IA «{task}» não está ativa (Inteligência › Modelos & custos)")
        if row.get("daily_budget_usd") is not None:
            spent = await fetch_one(self._pool, """select coalesce(sum(cost_usd), 0) as s from ai.runs where org_id = %s and route_task = %s
                                                   and created_at >= date_trunc('day', now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo'""", (org_id, task))
            if spent and float(spent["s"]) >= float(row["daily_budget_usd"]):
                raise PermanentError(f"O orçamento diário da rota «{task}» acabou (US$ {float(row['daily_budget_usd']):.2f})")
        return row

    async def _post(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        try:
            resp = await self._http.post(f"{self._base}{path}", json=body, headers={"Authorization": f"Bearer {self._key}"}, timeout=180)
        except (httpx.TimeoutException, httpx.TransportError) as e:
            raise TransientError(f"rede: {e}") from e
        _check(resp)
        return resp.json()

    async def _log(self, org_id: str, task: str, model: str | None, usage: dict[str, Any], started: float, status: str, error: str | None = None) -> None:
        await fetch_one(self._pool, """insert into ai.runs (org_id, route_task, model, tokens_in, tokens_out, cache_read_tokens, cost_usd, latency_ms, status, error)
                                       values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s) returning id""",
                        (org_id, task, model, int(usage.get("prompt_tokens") or 0), int(usage.get("completion_tokens") or 0),
                         int((usage.get("prompt_tokens_details") or {}).get("cached_tokens") or 0), float(usage.get("cost") or 0), int((time.monotonic() - started) * 1000), status, error))

    async def complete_json(self, org_id: str, task: str, messages: list[dict[str, str]], schema_name: str, schema: dict[str, Any]) -> dict[str, Any]:
        """Uma resposta estruturada (JSON schema) pela rota `task`."""
        route = await self.route(org_id, task)
        params = route.get("params") or {}
        body: dict[str, Any] = {"model": route["primary_model"], "messages": messages,
                                "response_format": {"type": "json_schema", "json_schema": {"name": schema_name, "strict": True, "schema": schema}},
                                **{k: v for k, v in params.items() if k in ("temperature", "max_tokens", "reasoning")}}
        if route.get("fallback_models"):
            body["models"] = [route["primary_model"], *route["fallback_models"]]
        if route.get("provider_prefs"):
            body["provider"] = route["provider_prefs"]
        t0 = time.monotonic()
        try:
            data = await self._post("/chat/completions", body)
            result = parse_json_content(((data.get("choices") or [{}])[0].get("message") or {}).get("content"))
        except (TransientError, PermanentError) as e:
            await self._log(org_id, task, route["primary_model"], {}, t0, "ERROR", str(e)[:300])
            raise
        await self._log(org_id, task, data.get("model") or route["primary_model"], data.get("usage") or {}, t0, "OK")
        return result

    async def embed(self, org_id: str, texts: list[str]) -> tuple[list[list[float]], str]:
        """Um vetor por texto (dimensão fixa da rota `embeddings`) e o modelo usado."""
        route = await self.route(org_id, "embeddings")
        params = route.get("params") or {}
        body: dict[str, Any] = {"model": route["primary_model"], "input": texts}
        if params.get("dimensions"):
            body["dimensions"] = params["dimensions"]
        if route.get("provider_prefs"):
            body["provider"] = route["provider_prefs"]
        t0 = time.monotonic()
        try:
            data = await self._post("/embeddings", body)
            rows = sorted(data.get("data") or [], key=lambda r: r.get("index", 0))
            vectors = [[float(x) for x in r["embedding"]] for r in rows]
            if len(vectors) != len(texts):
                raise PermanentError(f"embeddings: esperava {len(texts)} vetores e vieram {len(vectors)}")
        except (TransientError, PermanentError) as e:
            await self._log(org_id, "embeddings", route["primary_model"], {}, t0, "ERROR", str(e)[:300])
            raise
        await self._log(org_id, "embeddings", data.get("model") or route["primary_model"], data.get("usage") or {}, t0, "OK")
        return vectors, str(data.get("model") or route["primary_model"])


def vector_text(v: list[float]) -> str:
    """Formato de texto aceito pelo pgvector/halfvec."""
    return "[" + ",".join(f"{x:.6g}" for x in v) + "]"
