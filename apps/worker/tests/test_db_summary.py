"""Resumo da conversa encerrada: a IA (simulada) devolve o JSON e o banco grava resumo, temas, sentimento e a lacuna na base."""
from __future__ import annotations

import dataclasses
from typing import Any

import pytest

from sie_worker import queues
from sie_worker.adapters.errors import PermanentError
from sie_worker.db import fetch_one
from sie_worker.deps import Deps
from sie_worker.handlers import ai_tasks

from .conftest import ORG, ingest, unique_phone

pytestmark = pytest.mark.db


class FakeLLM:
    def __init__(self, answer: dict[str, Any] | Exception) -> None:
        self.answer, self.calls = answer, []

    async def complete_json(self, org_id: str, task: str, messages: list[dict[str, str]], schema_name: str, schema: dict[str, Any]) -> dict[str, Any]:
        self.calls.append((task, messages))
        if isinstance(self.answer, Exception):
            raise self.answer
        return self.answer


def job(conv_id: str) -> queues.QueueMessage:
    return queues.QueueMessage("ai_tasks", 1, 1, {"action": "CONVERSATION_SUMMARY", "org_id": ORG, "conversation_id": conv_id})


async def test_summary_is_saved_with_topics_and_knowledge_gap(pool: Any, deps: Deps, channel: dict[str, str]) -> None:
    conv = await ingest(pool, channel, unique_phone(), "Vocês abrem domingo? E tem legging M?")
    llm = FakeLLM({"summary": "Cliente quis saber de domingo e da legging M.", "topics": ["horário", "legging"], "sentiment": "POSITIVE",
                   "knowledge_gap": True, "unanswered_question": "A loja abre aos domingos?"})
    await ai_tasks.handle(dataclasses.replace(deps, llm=llm), job(str(conv["conversation_id"])))
    row = await fetch_one(pool, "select summary, topics, sentiment from omni.conversations where id = %s", (conv["conversation_id"],))
    assert row and row["summary"].startswith("Cliente quis saber") and row["topics"] == ["horário", "legging"] and row["sentiment"] == "POSITIVE"
    assert llm.calls[0][0] == "summarize" and "legging M" in llm.calls[0][1][1]["content"]                  # rota certa e a conversa vai no pedido
    gap = await fetch_one(pool, "select payload ->> 'question' as q from ai.suggestions where kind = 'KB_GAP' and status = 'OPEN' and target_id = %s", (conv["conversation_id"],))
    assert gap and gap["q"] == "A loja abre aos domingos?"


async def test_without_ai_or_with_provider_failure_nothing_breaks(pool: Any, deps: Deps, channel: dict[str, str]) -> None:
    conv = await ingest(pool, channel, unique_phone(), "Oi")
    await ai_tasks.handle(dataclasses.replace(deps, llm=None), job(str(conv["conversation_id"])))
    await ai_tasks.handle(dataclasses.replace(deps, llm=FakeLLM(PermanentError("modelo fora"))), job(str(conv["conversation_id"])))
    row = await fetch_one(pool, "select summary from omni.conversations where id = %s", (conv["conversation_id"],))
    assert row and row["summary"] is None
