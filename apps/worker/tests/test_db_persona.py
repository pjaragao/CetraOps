"""Persona dos sócios: tratamento do histórico, classificação, índice de exemplos, perfil de estilo e aprendizado contínuo (IA simulada com respx)."""
from __future__ import annotations

import dataclasses
import json
import uuid
from typing import Any

import httpx
import pytest
import respx

from centralops_worker import queues
from centralops_worker.adapters.errors import PermanentError
from centralops_worker.ai.llm import LLM, parse_json_content, vector_text
from centralops_worker.db import fetch_all, fetch_one
from centralops_worker.handlers import persona as handler
from centralops_worker.handlers import router

from .conftest import ORG, ingest, unique_phone

pytestmark = pytest.mark.db

OR = "https://or.test/api/v1"

EXPORT = """12/09/2025 10:00 - Mensagens e ligações são protegidas com a criptografia de ponta a ponta.
12/09/2025 10:00 - Bia Cliente: Oi Luisa, tem a legging preta no M?
12/09/2025 10:01 - Luisa Sócia: Oi Bia! Tem sim, amiga 💛
12/09/2025 10:01 - Luisa Sócia: Quer que eu separe pra você?
12/09/2025 10:05 - Bia Cliente: Quero sim! Quanto é?
12/09/2025 10:06 - Luisa Sócia: Ela está R$ 189,90, amiga!
12/09/2025 10:07 - Bia Cliente: Fechado, meu telefone é 48 99999-1234
12/09/2025 10:08 - Luisa Sócia: Perfeito, já separo pra você 💛
13/09/2025 20:00 - Bia Cliente: Oi! Posso trocar o top P pelo M?
13/09/2025 20:02 - Luisa Sócia: Pode sim, linda! Traz com a etiqueta.
14/09/2025 09:00 - Joana Mãe: Filha, passa aqui hoje pro almoço?
14/09/2025 09:05 - Luisa Sócia: Passo sim, mãe! Beijo
"""


def job(action: str, **kw: Any) -> queues.QueueMessage:
    return queues.QueueMessage("persona_tasks", 1, 1, {"action": action, "org_id": ORG, **kw})


def with_llm(deps: Any) -> Any:
    return dataclasses.replace(deps, llm=LLM(deps.pool, deps.http, OR, "or-key"))


async def make_persona(pool: Any, member: str | None = None) -> str:
    row = await fetch_one(pool, "insert into ai.personas (org_id, name, member_id) values (%s, %s, %s) returning id", (ORG, f"Persona {uuid.uuid4().hex[:8]}", member))
    assert row
    return str(row["id"])


async def make_source(pool: Any, persona: str, content: str = EXPORT, owner: str = "Luisa Sócia", kind: str = "WA_TXT") -> str:
    row = await fetch_one(pool, "insert into ai.corpus_sources (org_id, persona_id, kind, owner_name, bytes) values (%s, %s, %s, %s, %s) returning id", (ORG, persona, kind, owner, len(content)))
    assert row
    await fetch_one(pool, "insert into ai.corpus_raw (source_id, content) values (%s, %s) returning source_id", (row["id"], content))
    return str(row["id"])


async def processed(pool: Any, deps: Any, member: str | None = None) -> tuple[str, str]:
    persona = await make_persona(pool, member)
    source = await make_source(pool, persona)
    await handler.handle(deps, job("PROCESS", source_id=source))
    return persona, source


def classify_mock(request: httpx.Request) -> httpx.Response:
    body = json.loads(request.content)
    dialogues = json.loads(body["messages"][1]["content"])
    items = []
    for d in dialogues:
        text = " ".join(t["texto"] for t in d["turnos"])
        personal = "mãe" in text or "almoço" in text
        items.append({"i": d["i"], "commercial": not personal, "topics": ["Família"] if personal else ["Tamanho", "tamanho", "preço"], "outcome": "INDEFINIDO" if personal else "VENDA",
                      "pairs": [{"position": pos, "intent": "tamanho" if not personal else "inventada", "stage": "descoberta"} for pos in d["owner_turns"]]})
    return httpx.Response(200, json={"model": "google/gemini-2.5-flash", "choices": [{"message": {"content": json.dumps({"items": items})}}], "usage": {"prompt_tokens": 100, "completion_tokens": 20, "cost": 0.0012}})


def embed_mock(request: httpx.Request) -> httpx.Response:
    body = json.loads(request.content)
    data = [{"index": i, "embedding": [1.0 if j == i % 1024 else 0.0 for j in range(1024)]} for i, _ in enumerate(body["input"])]
    return httpx.Response(200, json={"model": body["model"], "data": data, "usage": {"prompt_tokens": 10, "cost": 0.0001}})


PROFILE = {"resumo": "Acolhedora e curta.", "aberturas": ["Oi {CLIENTE}!"], "fechamentos": ["💛"], "vocativos": ["amiga", "linda"], "lexico_marca": ["mimos"],
           "tom_por_etapa": [{"etapa": "descoberta", "tom": "pergunta aberta e curta"}], "vendas": {"objecao_preco": "valor", "tamanho_modelagem": "pergunta a modelagem", "fechamento": "separa na loja", "followup": "no dia seguinte"},
           "tabus": ["barato"], "regras_extras": ["Sempre chame de amiga"], "system_prompt": "Você responde curto, com carinho, como no WhatsApp."}


# ------------------------------------------------------------------------------------------------ LLM
def test_parse_json_content_accepts_fences_and_rejects_garbage() -> None:
    assert parse_json_content('```json\n{"a": 1}\n```') == {"a": 1}
    with pytest.raises(PermanentError):
        parse_json_content("não é json")
    with pytest.raises(PermanentError):
        parse_json_content("[1, 2]")
    assert vector_text([1.0, 0.25]) == "[1,0.25]"


@respx.mock
async def test_llm_uses_the_route_model_logs_the_run_and_respects_the_budget(pool: Any, deps: Any) -> None:
    llm = LLM(pool, deps.http, OR, "or-key")
    route = respx.post(f"{OR}/chat/completions").mock(return_value=httpx.Response(200, json={"model": "m-x", "choices": [{"message": {"content": '{"ok": true}'}}], "usage": {"prompt_tokens": 50, "completion_tokens": 5, "cost": 0.5}}))
    assert await llm.complete_json(ORG, "classify", [{"role": "user", "content": "oi"}], "x", {"type": "object"}) == {"ok": True}
    sent = json.loads(route.calls[0].request.content)
    assert sent["model"] == "google/gemini-2.5-flash" and sent["response_format"]["json_schema"]["strict"] is True and sent["provider"] == {"zdr": True, "data_collection": "deny"}
    assert route.calls[0].request.headers["authorization"] == "Bearer or-key"
    run = await fetch_one(pool, "select status, tokens_in, cost_usd from ai.runs where route_task = 'classify' order by created_at desc limit 1")
    assert run and (run["status"], run["tokens_in"], float(run["cost_usd"])) == ("OK", 50, 0.5)
    await fetch_one(pool, "update ai.model_routes set daily_budget_usd = 0.4 where org_id = %s and task = 'classify' returning id", (ORG,))
    with pytest.raises(PermanentError, match="orçamento"):
        await llm.complete_json(ORG, "classify", [], "x", {})
    await fetch_one(pool, "update ai.model_routes set active = false where org_id = %s and task = 'extract' returning id", (ORG,))
    with pytest.raises(PermanentError, match="não está ativa"):
        await llm.complete_json(ORG, "extract", [], "x", {})


@respx.mock
async def test_llm_embeddings_keep_order_and_fixed_dimensions(pool: Any, deps: Any) -> None:
    llm = LLM(pool, deps.http, OR, "or-key")
    route = respx.post(f"{OR}/embeddings").mock(side_effect=embed_mock)
    vectors, model = await llm.embed(ORG, ["a", "b"])
    assert model == "openai/text-embedding-3-small" and len(vectors) == 2 and vectors[1][1] == 1.0
    assert json.loads(route.calls[0].request.content)["dimensions"] == 1024
    respx.post(f"{OR}/embeddings").mock(return_value=httpx.Response(200, json={"data": [{"index": 0, "embedding": [0.1]}]}))
    with pytest.raises(PermanentError, match="vetores"):
        await llm.embed(ORG, ["a", "b"])


# ------------------------------------------------------------------------------------------------ histórico
async def test_process_builds_pseudonymized_dialogues_and_deletes_the_raw_file(pool: Any, deps: Any) -> None:
    persona, source = await processed(pool, deps)
    s = await fetch_one(pool, "select status, stats, raw_deleted_at, (select count(*) from ai.corpus_raw where source_id = s.id) as raw from ai.corpus_sources s where id = %s", (source,))
    assert s and s["status"] == "READY" and s["raw"] == 0 and s["raw_deleted_at"] is not None and s["stats"]["owner_matched"] == "Luisa Sócia"
    dialogues = await fetch_all(pool, "select turns, digest from ai.corpus_dialogues where persona_id = %s", (persona,))
    assert len(dialogues) == 3
    blob = json.dumps([d["turns"] for d in dialogues], ensure_ascii=False)
    assert "Bia" not in blob and "99999" not in blob and "189,90" not in blob and "{CLIENTE}" in blob and "{PRECO}" in blob
    assert all({"role", "text", "bubbles", "start"} <= set(t) for t in dialogues[0]["turns"])
    pairs = await fetch_all(pool, "select reply, source from ai.corpus_pairs where persona_id = %s", (persona,))
    assert pairs and {p["source"] for p in pairs} == {"HISTORICAL"}
    assert (await fetch_one(pool, "select count(*) as n from pgmq.q_persona_tasks where message ->> 'action' = 'CLASSIFY' and message ->> 'persona_id' = %s", (persona,)))["n"] == 0   # type: ignore[index]


async def test_process_enqueues_classification_when_the_ai_is_configured_and_ignores_redelivery(pool: Any, deps: Any) -> None:
    d = with_llm(deps)
    persona, source = await processed(pool, d)
    assert (await fetch_one(pool, "select count(*) as n from pgmq.q_persona_tasks where message ->> 'action' = 'CLASSIFY' and message ->> 'persona_id' = %s", (persona,)))["n"] == 1   # type: ignore[index]
    await handler.handle(d, job("PROCESS", source_id=source))                                       # reentrega: já tratado
    assert (await fetch_one(pool, "select count(*) as n from ai.corpus_dialogues where persona_id = %s", (persona,)))["n"] == 3   # type: ignore[index]


async def test_process_fails_with_a_friendly_message_when_the_owner_is_not_in_the_file(pool: Any, deps: Any) -> None:
    persona = await make_persona(pool)
    source = await make_source(pool, persona, owner="Fulana de Tal")
    await handler.handle(deps, job("PROCESS", source_id=source))
    s = await fetch_one(pool, "select status, error, (select count(*) from ai.corpus_raw where source_id = s.id) as raw from ai.corpus_sources s where id = %s", (source,))
    assert s and s["status"] == "FAILED" and "Luisa Sócia" in s["error"] and s["raw"] == 0
    bad = await make_source(pool, persona, content="isto não é uma conversa exportada do WhatsApp, é só um texto qualquer", owner="Luisa")
    await handler.handle(deps, job("PROCESS", source_id=bad))
    assert (await fetch_one(pool, "select status from ai.corpus_sources where id = %s", (bad,)))["status"] == "FAILED"   # type: ignore[index]


async def test_process_matches_the_owner_name_ignoring_case_and_accents(pool: Any, deps: Any) -> None:
    persona = await make_persona(pool)
    source = await make_source(pool, persona, owner="luisa socia")
    await handler.handle(deps, job("PROCESS", source_id=source))
    assert (await fetch_one(pool, "select status from ai.corpus_sources where id = %s", (source,)))["status"] == "READY"   # type: ignore[index]


# ------------------------------------------------------------------------------------------------ classificação e índice
@respx.mock
async def test_classify_labels_dialogues_then_chains_the_index(pool: Any, deps: Any) -> None:
    d = with_llm(deps)
    persona, _ = await processed(pool, d)
    respx.post(f"{OR}/chat/completions").mock(side_effect=classify_mock)
    await handler.handle(d, job("CLASSIFY", persona_id=persona))
    rows = await fetch_all(pool, "select commercial, include, topics, outcome from ai.corpus_dialogues where persona_id = %s order by commercial", (persona,))
    assert [r["commercial"] for r in rows] == [False, True, True]
    assert rows[0]["include"] is False and rows[0]["topics"] == ["família"]                          # conversa pessoal sai da persona
    assert rows[1]["topics"] == ["tamanho", "preço"]                                                 # minúsculas, sem repetir
    labels = await fetch_all(pool, "select intent, stage from ai.corpus_pairs where persona_id = %s", (persona,))
    assert {(x["intent"], x["stage"]) for x in labels} == {("tamanho", "descoberta"), ("outro", "descoberta")}    # intenção fora da lista vira "outro"
    assert (await fetch_one(pool, "select count(*) as n from pgmq.q_persona_tasks where message ->> 'action' = 'EMBED' and message ->> 'persona_id' = %s", (persona,)))["n"] == 1   # type: ignore[index]
    run = await fetch_one(pool, "select count(*) as n from ai.runs where route_task = 'classify' and status = 'OK'")
    assert run and run["n"] >= 1


@respx.mock
async def test_classify_stops_and_warns_when_the_ai_fails_for_good(pool: Any, deps: Any) -> None:
    d = with_llm(deps)
    persona, _ = await processed(pool, d)
    respx.post(f"{OR}/chat/completions").mock(return_value=httpx.Response(401, json={"error": "chave inválida"}))
    await handler.handle(d, job("CLASSIFY", persona_id=persona))
    assert (await fetch_one(pool, "select count(*) as n from ai.corpus_dialogues where persona_id = %s and classified_at is null", (persona,)))["n"] == 3   # type: ignore[index]
    note = await fetch_one(pool, "select title from core.notifications where kind = 'INTEGRATION_ERROR' order by created_at desc limit 1")
    assert note and "Classificação do histórico parou" in note["title"]


@respx.mock
async def test_embed_indexes_pairs_and_the_router_finds_them_as_style_examples(pool: Any, deps: Any) -> None:
    d = with_llm(deps)
    persona, _ = await processed(pool, d)
    respx.post(f"{OR}/chat/completions").mock(side_effect=classify_mock)
    respx.post(f"{OR}/embeddings").mock(side_effect=embed_mock)
    await handler.handle(d, job("CLASSIFY", persona_id=persona))
    await handler.handle(d, job("EMBED", persona_id=persona))
    assert (await fetch_one(pool, "select count(*) as n from ai.corpus_pairs where persona_id = %s and embedding is null", (persona,)))["n"] == 0   # type: ignore[index]
    claim = {"org_id": ORG, "persona_id": persona}
    text = await router._examples(d, claim, [{"role": "user", "content": "Oi, tem legging no M?"}])
    assert text and text.startswith("EXEMPLOS DE ESTILO") and "Resposta:" in text
    assert "Mãe" not in text and "almoço" not in text                                                # conversa pessoal excluída da busca
    assert await router._examples(dataclasses.replace(d, llm=None), claim, [{"role": "user", "content": "oi"}]) is None
    respx.post(f"{OR}/embeddings").mock(return_value=httpx.Response(500, json={}))
    assert await router._examples(d, claim, [{"role": "user", "content": "oi"}]) is None             # falha da IA nunca trava a resposta


# ------------------------------------------------------------------------------------------------ perfil
@respx.mock
async def test_profile_creates_a_draft_version_with_transparency_and_warnings(pool: Any, deps: Any) -> None:
    d = with_llm(deps)
    persona, _ = await processed(pool, d)
    route = respx.post(f"{OR}/chat/completions").mock(return_value=httpx.Response(200, json={"model": "anthropic/claude-opus-4.1", "choices": [{"message": {"content": json.dumps(PROFILE)}}], "usage": {"cost": 0.3}}))
    await handler.handle(d, job("PROFILE", persona_id=persona, lexicon=["mimos", "look"]))
    sent = json.loads(route.calls[0].request.content)
    assert sent["model"] == "anthropic/claude-opus-4.1" and "perfil_de_estilo" in json.dumps(sent["response_format"])
    user = json.loads(sent["messages"][1]["content"])
    assert user["vocabulario_da_marca"] == ["mimos", "look"] and user["exemplos"] and "bubbles" in user["estatisticas"]
    assert "Bia" not in sent["messages"][1]["content"]                                               # nada de cliente vai para o modelo
    v = await fetch_one(pool, "select version, approved_at, system_prompt, guardrails, style_profile from ai.persona_versions where persona_id = %s", (persona,))
    assert v and v["version"] == 1 and v["approved_at"] is None
    assert v["system_prompt"].startswith("Você responde curto") and "NUNCA diz que é Persona" in v["system_prompt"] and "{PRECO}" in v["system_prompt"]
    assert v["guardrails"]["extra_rules"] == ["Sempre chame de amiga", "Evite: barato"]
    assert v["style_profile"]["narrative"]["resumo"] == "Acolhedora e curta." and "system_prompt" not in v["style_profile"]["narrative"]
    assert v["style_profile"]["stats"]["bubbles"] > 0 and "300" in v["style_profile"]["generated"]["warnings"][0]
    assert (await fetch_one(pool, "select active_version_id from ai.personas where id = %s", (persona,)))["active_version_id"] is None   # type: ignore[index]


# ------------------------------------------------------------------------------------------------ aprendizado contínuo
async def live_conversation(pool: Any, channel: dict[str, str], persona: str) -> tuple[str, str]:
    ev = await ingest(pool, channel, unique_phone(), "Oi, tem a legging preta no M?", name="Clara Teste")
    conv = str(ev["conversation_id"])
    await fetch_one(pool, "update omni.conversations set persona_id = %s where id = %s returning id", (persona, conv))
    return conv, channel["account_id"]


async def human_reply(pool: Any, conv: str, account: str, body: str, author_type: str = "HUMAN", member: str | None = None) -> str:
    row = await fetch_one(pool, """insert into omni.messages (org_id, conversation_id, channel_account_id, direction, author_type, author_member_id, body, status, client_dedupe_key)
                                   values (%s, %s, %s, 'OUT', %s, %s, %s, 'SENT', %s) returning id""", (ORG, conv, account, author_type, member, body, uuid.uuid4().hex))
    assert row
    return str(row["id"])


SOCIO = "00000000-0000-4000-8000-000000000101"
VENDEDORA = "00000000-0000-4000-8000-000000000102"


async def test_learn_from_an_edited_draft_weighs_more_and_pseudonymizes(pool: Any, deps: Any, channel: dict[str, str]) -> None:
    persona = await make_persona(pool, SOCIO)
    conv, account = await live_conversation(pool, channel, persona)
    mid = await human_reply(pool, conv, account, "Tem sim, Clara! Qual cor você quer?\n\nPosso separar pra você 💛", member=VENDEDORA)
    draft = await fetch_one(pool, """insert into omni.message_drafts (org_id, conversation_id, variants, intent, stage, status, final_message_id) values (%s, %s, '[]', 'disponibilidade', 'descoberta', 'EDITED_SENT', %s) returning id""", (ORG, conv, mid))
    assert draft
    await handler.handle(deps, job("LEARN", draft_id=str(draft["id"])))
    p = await fetch_one(pool, "select source, weight, context, reply, intent, stage from ai.corpus_pairs where persona_id = %s and message_id = %s", (persona, mid))
    assert p and (p["source"], float(p["weight"]), p["intent"], p["stage"]) == ("HUMAN_EDIT", 2.0, "disponibilidade", "descoberta")
    assert p["reply"] == ["Tem sim, {CLIENTE}! Qual cor você quer?", "Posso separar pra você 💛"] and p["context"][-1] == {"role": "customer", "text": "Oi, tem a legging preta no M?"}
    await handler.handle(deps, job("LEARN", message_id=mid))                                          # o mesmo envio pelo caminho "resposta humana": o rascunho (peso maior) prevalece
    assert (await fetch_one(pool, "select source from ai.corpus_pairs where message_id = %s", (mid,)))["source"] == "HUMAN_EDIT"   # type: ignore[index]


async def test_learn_from_a_live_reply_only_when_it_is_the_persona_owner(pool: Any, deps: Any, channel: dict[str, str]) -> None:
    persona = await make_persona(pool, SOCIO)
    conv, account = await live_conversation(pool, channel, persona)
    other = await human_reply(pool, conv, account, "Temos sim!", member=VENDEDORA)
    await handler.handle(deps, job("LEARN", message_id=other))
    assert (await fetch_one(pool, "select count(*) as n from ai.corpus_pairs where message_id = %s", (other,)))["n"] == 0   # type: ignore[index]
    conv2, account2 = await live_conversation(pool, channel, persona)
    mine = await human_reply(pool, conv2, account2, "Tem sim, amiga!", member=SOCIO)
    await handler.handle(deps, job("LEARN", message_id=mine))
    p = await fetch_one(pool, "select source, weight from ai.corpus_pairs where message_id = %s", (mine,))
    assert p and (p["source"], float(p["weight"])) == ("HUMAN_LIVE", 1.2)
    conv3, account3 = await live_conversation(pool, channel, persona)
    echo = await human_reply(pool, conv3, account3, "Te espero aqui!", author_type="ECHO_FROM_APP")
    await handler.handle(deps, job("LEARN", message_id=echo))                                         # resposta pelo app do celular (eco) conta como da pessoa da persona
    assert (await fetch_one(pool, "select source from ai.corpus_pairs where message_id = %s", (echo,)))["source"] == "HUMAN_LIVE"   # type: ignore[index]
    again = await human_reply(pool, conv3, account3, "Qualquer coisa me chama", author_type="ECHO_FROM_APP")
    await handler.handle(deps, job("LEARN", message_id=again))                                        # segunda bolha seguida: o último turno é do sócio, não da cliente
    assert (await fetch_one(pool, "select count(*) as n from ai.corpus_pairs where message_id = %s", (again,)))["n"] == 0   # type: ignore[index]


async def test_learn_skips_replies_without_persona_and_masks_personal_data(pool: Any, deps: Any, channel: dict[str, str]) -> None:
    conv, account = await live_conversation(pool, channel, await make_persona(pool, SOCIO))
    await fetch_one(pool, "update omni.conversations set persona_id = null where id = %s returning id", (conv,))
    m = await human_reply(pool, conv, account, "Tem sim!", member=SOCIO)
    await handler.handle(deps, job("LEARN", message_id=m))
    assert (await fetch_one(pool, "select count(*) as n from ai.corpus_pairs where message_id = %s", (m,)))["n"] == 0   # type: ignore[index]
    persona = await make_persona(pool, SOCIO)
    conv2, account2 = await live_conversation(pool, channel, persona)
    leak = await human_reply(pool, conv2, account2, "Me manda seu CPF 123.456.789-09 pra nota", member=SOCIO)
    await handler.handle(deps, job("LEARN", message_id=leak))
    row = await fetch_one(pool, "select reply from ai.corpus_pairs where message_id = %s", (leak,))
    assert row and "123.456" not in json.dumps(row["reply"]) and "{CPF}" in json.dumps(row["reply"])   # o dado pessoal nunca entra no corpus: vira marcador
