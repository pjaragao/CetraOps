"""Hermes do CentralOps como modelo `hermes/...`: protocolo TOOL_CALL em texto e despacho Hermes × OpenRouter."""
from __future__ import annotations

import json

import httpx
import pytest
import respx

from centralops_worker.adapters.errors import TransientError
from centralops_worker.ai.agent import AgentInput, OpenRouterAgent
from centralops_worker.ai.hermes_llm import HermesLLM, parse_reply, to_hermes_messages

TOOLS = [{"type": "function", "function": {"name": "search_catalog", "description": "Busca produtos", "parameters": {"type": "object", "properties": {"q": {"type": "string"}}}}}]


def test_messages_flatten_tools_and_end_on_user() -> None:
    msgs = to_hermes_messages([
        {"role": "system", "content": "Você é a Íris."},
        {"role": "user", "content": "Tem vestido M?"},
        {"role": "assistant", "content": None, "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "search_catalog", "arguments": '{"q": "vestido"}'}}]},
        {"role": "tool", "tool_call_id": "c1", "content": '{"ok": true}'},
        {"role": "system", "content": "Reescreva sem valores."},
    ], TOOLS)
    assert msgs[0]["role"] == "system" and "TOOL_CALL" in msgs[0]["content"] and "search_catalog" in msgs[0]["content"]
    assert msgs[2] == {"role": "assistant", "content": 'TOOL_CALL {"name": "search_catalog", "arguments": {"q": "vestido"}}'}
    assert msgs[3]["role"] == "user" and msgs[3]["content"].startswith("[Resultado da ferramenta search_catalog")
    assert msgs[-1] == {"role": "user", "content": "[Instrução do sistema] Reescreva sem valores."}
    assert all(m["role"] in ("system", "user", "assistant") for m in msgs)


def test_json_schema_goes_to_system() -> None:
    msgs = to_hermes_messages([{"role": "user", "content": "oi"}], json_schema=("resumo", {"type": "object"}))
    assert "JSON Schema «resumo»" in msgs[0]["content"]


def test_parse_reply_tool_call_text_and_garbage() -> None:
    content, calls = parse_reply('TOOL_CALL {"name": "search_catalog", "arguments": {"q": "saia"}}', True)
    assert content is None and calls[0]["function"]["name"] == "search_catalog" and json.loads(calls[0]["function"]["arguments"]) == {"q": "saia"}
    content, calls = parse_reply("```\nTOOL_CALL {\"name\": \"x\"}\n```", True)
    assert [c["function"]["name"] for c in calls] == ["x"]
    content, calls = parse_reply('Oi!\nTOOL_CALL {"name": "x"}', False)      # sem ferramentas: a linha some, o texto fica
    assert content == "Oi!" and calls == []
    content, calls = parse_reply("TOOL_CALL {quebrado", True)
    assert content == "" and calls == []


@respx.mock
async def test_agent_routes_hermes_and_falls_back_to_openrouter() -> None:
    hermes_route = respx.post("http://hermes.test/v1/chat/completions").mock(return_value=httpx.Response(502, json={"error": {}}))
    or_route = respx.post("https://openrouter.test/v1/chat/completions").mock(return_value=httpx.Response(200, json={
        "model": "openai/gpt-4.1", "usage": {"prompt_tokens": 5}, "choices": [{"message": {"content": "olá"}}]}))
    async with httpx.AsyncClient() as http:
        agent = OpenRouterAgent(None, http, "https://openrouter.test/v1", "or-key", hermes=HermesLLM(http, "http://hermes.test/v1", "h-key"))  # type: ignore[arg-type]
        inp = AgentInput(run_id="r", ctx={"caps": []}, ctx_token="t", system_stable="s", system_volatile="v", history=[{"role": "user", "content": "oi"}],
                         model="hermes/agy", fallback_models=["openai/gpt-4.1"])
        out = await agent.run(inp)
    assert out.text == "olá"
    assert hermes_route.called and json.loads(hermes_route.calls[0].request.content)["messages"][-1] == {"role": "user", "content": "oi"}
    assert json.loads(or_route.calls[0].request.content)["model"] == "openai/gpt-4.1"


@respx.mock
async def test_hermes_only_without_openrouter_key() -> None:
    respx.post("http://hermes.test/v1/chat/completions").mock(return_value=httpx.Response(200, json={
        "model": "hermes-agy", "usage": {"prompt_tokens": 100, "completion_tokens": 3}, "choices": [{"message": {"content": "pronto"}}]}))
    async with httpx.AsyncClient() as http:
        agent = OpenRouterAgent(None, http, "https://openrouter.test/v1", "", hermes=HermesLLM(http, "http://hermes.test/v1", "h-key"))  # type: ignore[arg-type]
        inp = AgentInput(run_id="r", ctx={"caps": []}, ctx_token="t", system_stable="s", system_volatile="v", history=[{"role": "user", "content": "oi"}], model="hermes/agy")
        out = await agent.run(inp)
    assert out.text == "pronto" and out.model == "hermes/agy" and out.tokens_in == 100 and out.cost_usd == 0


@respx.mock
async def test_hermes_transient_without_fallback_raises() -> None:
    respx.post("http://hermes.test/v1/chat/completions").mock(return_value=httpx.Response(503))
    async with httpx.AsyncClient() as http:
        h = HermesLLM(http, "http://hermes.test/v1", "k")
        with pytest.raises(TransientError):
            await h.chat("hermes/agy", [{"role": "user", "content": "oi"}])
