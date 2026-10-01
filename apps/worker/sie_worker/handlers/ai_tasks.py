"""Fila `ai_tasks`: tarefas de IA sob demanda disparadas por telas e rotinas do sistema.
OUTREACH_DRAFT  redige a primeira DM da prospecção assistida (a vendedora revisa e envia pelo app oficial).
EVAL_RUN        roda as avaliações da IA de atendimento nos modelos pedidos (sandbox; grava um lote por modelo)."""
from __future__ import annotations

import json
import logging
import re
from typing import Any

from .. import queues
from ..adapters.errors import PermanentError as ProviderPermanent
from ..adapters.errors import TransientError
from ..db import call_fn, fetch_all, fetch_one
from ..deps import Deps
from ..evals.runner import run_suite
from ..runner import RetryLater

log = logging.getLogger("sie_worker.ai_tasks")

SCHEMA: dict[str, Any] = {"type": "object", "additionalProperties": False, "required": ["message"], "properties": {"message": {"type": "string"}}}
URL = re.compile(r"https?://|www\.|\.com\b", re.I)


def fallback_message(first_name: str) -> str:
    return f"Oi, {first_name}! Vi seu perfil e adorei o seu movimento. Sou da SIÉ JOY, moda para quem vive se movimentando. Quer conhecer a loja? 💛"


def valid_message(text: str) -> bool:
    """A abordagem não pode parecer spam nem prometer nada: curta, sem link, sem preço, sem pedir dado pessoal."""
    t = text.strip()
    return 20 <= len(t) <= 400 and not URL.search(t) and "R$" not in t and not re.search(r"\b(cpf|cart[aã]o|senha)\b", t, re.I)


def prompt(persona: str | None, row: dict[str, Any]) -> list[dict[str, str]]:
    facts = {k: v for k, v in {"primeiro_nome": str(row["display_name"]).split()[0], "profissao": row.get("profession"), "cidade": row.get("city"), "interesses": row.get("tags") or None}.items() if v}
    system = ((persona or "Você atende a SIÉ JOY, marca de moda para quem se movimenta: tom acolhedor, direto e elegante.")[:1500] + "\n\n"
              "Escreva UMA mensagem de primeiro contato por DM no Instagram (até 280 caracteres, português do Brasil, no máximo 1 emoji). "
              "Regras: não pareça propaganda; não cite preço, desconto, prazo nem link; não invente fatos: só use o que estiver em 'fatos'; "
              "mostre interesse genuíno e convide, sem pressão, para conhecer a loja ou um evento. Responda só o JSON do schema.")
    return [{"role": "system", "content": system}, {"role": "user", "content": json.dumps({"fatos": facts}, ensure_ascii=False)}]


async def _outreach_draft(deps: Deps, p: dict[str, Any]) -> None:
    org = str(p["org_id"])
    rows = await fetch_all(deps.pool, """select o.id, o.assigned_member_id, pa.display_name, pa.profession, pa.city, pa.tags from crm.outreach_items o join crm.parties pa on pa.id = o.party_id
                                         where o.id = any(%s) and o.status = 'SUGGESTED' and o.suggested_message is null""", (p.get("item_ids") or [],))
    for r in rows:
        first = str(r["display_name"]).split()[0]
        message = fallback_message(first)
        if deps.llm is not None:
            persona = await fetch_one(deps.pool, """select pv.system_prompt from ai.personas pa join ai.persona_versions pv on pv.id = pa.active_version_id
                                                    where pa.member_id = %s limit 1""", (r["assigned_member_id"],))
            try:
                data = await deps.llm.complete_json(org, "ops_copilot", prompt(persona["system_prompt"] if persona else None, r), "abordagem_instagram", SCHEMA)
                drafted = str(data.get("message", "")).strip()
                if valid_message(drafted):
                    message = drafted
                else:
                    log.info("abordagem da IA recusada pela validação; usando o texto padrão")
            except TransientError as e:
                raise RetryLater(int(e.retry_after or 30), str(e)) from e
            except ProviderPermanent as e:
                log.info("IA indisponível para a abordagem (%s); usando o texto padrão", e)
        await call_fn(deps.pool, "crm.outreach_set_draft", r["id"], message)


async def _eval_run(deps: Deps, msg: queues.QueueMessage) -> None:
    """Avaliação pedida na tela. Demora (um caso por vez, com o modelo de verdade): renova a reserva da mensagem a cada passo e NÃO repete
    em caso de falha, porque cada tentativa custa dinheiro; o erro vai para o pedido e avisa quem pediu."""
    p = msg.payload
    request_id = str(p["request_id"])

    async def progress(text: str) -> None:
        await queues.set_visibility(deps.pool, msg.queue, msg.msg_id, 240)
        await call_fn(deps.pool, "ai.eval_mark", request_id, "RUNNING", None, text)

    try:
        await call_fn(deps.pool, "ai.eval_mark", request_id, "RUNNING", None, "iniciando")
        await run_suite(deps.settings, deps.http, deps.pool, str(p["org_id"]), [str(m) for m in p["models"]], suite=str(p.get("suite") or "conversation"), request_id=request_id, progress=progress)
        await call_fn(deps.pool, "ai.eval_mark", request_id, "DONE", None, None)
    except (ProviderPermanent, TransientError) as e:
        await call_fn(deps.pool, "ai.eval_mark", request_id, "FAILED", str(e)[:500], None)
    except Exception as e:
        log.exception("avaliação %s falhou", request_id)
        await call_fn(deps.pool, "ai.eval_mark", request_id, "FAILED", f"erro inesperado: {e}"[:500], None)


async def handle(deps: Deps, msg: queues.QueueMessage) -> None:
    action = msg.payload.get("action")
    if action == "OUTREACH_DRAFT":
        await _outreach_draft(deps, msg.payload)
    elif action == "EVAL_RUN":
        await _eval_run(deps, msg)
    else:
        log.warning("ação de IA desconhecida: %s", action)
