"""Fila ai_tasks: rascunho da primeira DM da prospecção assistida (IA simulada com respx)."""
from __future__ import annotations

import dataclasses
import json
import uuid
from typing import Any

import httpx
import pytest
import respx

from centralops_worker import queues
from centralops_worker.ai.llm import LLM
from centralops_worker.db import fetch_one
from centralops_worker.handlers import ai_tasks

from .conftest import ORG

pytestmark = pytest.mark.db

OR = "https://or.test/api/v1"
SOCIO = "00000000-0000-4000-8000-000000000101"


def job(ids: list[str]) -> queues.QueueMessage:
    return queues.QueueMessage("ai_tasks", 1, 1, {"action": "OUTREACH_DRAFT", "org_id": ORG, "item_ids": ids})


def with_llm(deps: Any) -> Any:
    return dataclasses.replace(deps, llm=LLM(deps.pool, deps.http, OR, "or-key"))


async def make_item(pool: Any, name: str = "Marina Souza") -> str:
    party = await fetch_one(pool, "insert into crm.parties (org_id, kind, display_name, instagram_handle, profession, city, lifecycle_stage) values (%s, 'PERSON', %s, %s, 'médica', 'Florianópolis', 'LEAD') returning id",
                            (ORG, name, f"h_{uuid.uuid4().hex[:8]}"))
    assert party
    row = await fetch_one(pool, "insert into crm.outreach_items (org_id, party_id, channel, playbook_step, assigned_member_id) values (%s, %s, 'INSTAGRAM', 'DM', %s) returning id", (ORG, party["id"], SOCIO))
    assert row
    return str(row["id"])


async def message_of(pool: Any, item: str) -> str | None:
    row = await fetch_one(pool, "select suggested_message from crm.outreach_items where id = %s", (item,))
    return row["suggested_message"] if row else None


def ok_reply(text: str) -> httpx.Response:
    return httpx.Response(200, json={"model": "m", "choices": [{"message": {"content": json.dumps({"message": text})}}], "usage": {"cost": 0.001}})


def test_validation_blocks_spam_like_messages() -> None:
    assert ai_tasks.valid_message("Oi, Marina! Vi que você é médica e corre em Floripa. Quer conhecer a loja? 💛")
    assert not ai_tasks.valid_message("curto")
    assert not ai_tasks.valid_message("Oi Marina, veja em https://loja.com.br/promo nossa coleção completa toda nova")
    assert not ai_tasks.valid_message("Oi Marina, tudo por R$ 99 hoje, corre que acaba logo mesmo")
    assert not ai_tasks.valid_message("Oi Marina, me passa seu CPF para eu te cadastrar aqui na nossa lista")
    assert ai_tasks.fallback_message("Marina").startswith("Oi, Marina!")


async def test_without_ai_the_default_message_is_used(pool: Any, deps: Any) -> None:
    item = await make_item(pool)
    await ai_tasks.handle(deps, job([item]))
    assert (await message_of(pool, item) or "").startswith("Oi, Marina!")


@respx.mock
async def test_ai_message_is_used_when_it_passes_validation_and_persona_prompt_goes_along(pool: Any, deps: Any) -> None:
    d = with_llm(deps)
    item = await make_item(pool)
    pv = await fetch_one(pool, "insert into ai.personas (org_id, name, member_id) values (%s, %s, %s) returning id", (ORG, f"P {uuid.uuid4().hex[:6]}", SOCIO))
    ver = await fetch_one(pool, "insert into ai.persona_versions (org_id, persona_id, version, system_prompt, approved_at) values (%s, %s, 1, 'Fale como a Luisa: curto e caloroso.', now()) returning id", (ORG, pv["id"]))  # type: ignore[index]
    await fetch_one(pool, "update ai.personas set active_version_id = %s where id = %s returning id", (ver["id"], pv["id"]))  # type: ignore[index]
    route = respx.post(f"{OR}/chat/completions").mock(return_value=ok_reply("Oi, Marina! Vi que você é médica e ama se movimentar em Floripa. Quer conhecer a loja? 💛"))
    await ai_tasks.handle(d, job([item]))
    assert await message_of(pool, item) == "Oi, Marina! Vi que você é médica e ama se movimentar em Floripa. Quer conhecer a loja? 💛"
    sent = json.loads(route.calls[0].request.content)
    assert sent["model"] == "anthropic/claude-sonnet-4.5" and "Fale como a Luisa" in sent["messages"][0]["content"]
    facts = json.loads(sent["messages"][1]["content"])["fatos"]
    assert facts == {"primeiro_nome": "Marina", "profissao": "médica", "cidade": "Florianópolis"}          # só dados do perfil, nada de contato


@respx.mock
async def test_invalid_ai_output_or_outage_falls_back_to_the_default_text(pool: Any, deps: Any) -> None:
    d = with_llm(deps)
    bad = await make_item(pool, "Carla Dias")
    respx.post(f"{OR}/chat/completions").mock(return_value=ok_reply("Oi Carla! Aproveite 30% em https://loja.com/oferta só hoje para você"))
    await ai_tasks.handle(d, job([bad]))
    assert (await message_of(pool, bad) or "").startswith("Oi, Carla!")
    down = await make_item(pool, "Duda Reis")
    respx.post(f"{OR}/chat/completions").mock(return_value=httpx.Response(401, json={"error": "chave"}))
    await ai_tasks.handle(d, job([down]))
    assert (await message_of(pool, down) or "").startswith("Oi, Duda!")


async def test_items_already_drafted_or_closed_are_left_alone(pool: Any, deps: Any) -> None:
    item = await make_item(pool)
    await fetch_one(pool, "update crm.outreach_items set suggested_message = 'Texto que a vendedora já escreveu' where id = %s returning id", (item,))
    await ai_tasks.handle(deps, job([item]))
    assert await message_of(pool, item) == "Texto que a vendedora já escreveu"
    done = await make_item(pool, "Elisa Prado")
    await fetch_one(pool, "update crm.outreach_items set status = 'SKIPPED', skip_reason = 'privado' where id = %s returning id", (done,))
    await ai_tasks.handle(deps, job([done]))
    assert await message_of(pool, done) is None
