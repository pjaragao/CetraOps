"""Fila `persona_tasks`: treino da persona dos sócios.
PROCESS  trata o histórico enviado (pseudonimiza, separa diálogos, monta pares) e apaga o arquivo bruto;
CLASSIFY marca o que é conversa comercial e a etapa/intenção de cada resposta (IA, rota `classify`);
EMBED    indexa os pares para a busca de exemplos (rota `embeddings`);
PROFILE  gera o rascunho do perfil de estilo e do prompt (rota `persona_style`) — só o sócio aprova;
LEARN    transforma rascunho aprovado/editado e resposta humana da inbox em novos pares."""
from __future__ import annotations

import asyncio
import hashlib
import logging
from collections import defaultdict
from datetime import datetime
from typing import Any

from .. import queues
from ..adapters.errors import PermanentError as ProviderPermanent
from ..adapters.errors import TransientError
from ..ai import llm as llm_mod
from ..db import call_fn, fetch_all, fetch_one
from ..deps import Deps
from ..persona import labels
from ..persona.fewshot import embed_text
from ..persona.normalize import Dialogue, Turn
from ..persona.parsers import Msg
from ..persona.pipeline import parse_source, process
from ..persona.pseudonymize import Pseudonymizer, residual_pii
from ..persona.style import compute_style
from ..runner import RetryLater

log = logging.getLogger("sie_worker.persona")

CLASSIFY_BATCH = 6
CLASSIFY_PER_RUN = 60
EMBED_BATCH = 64
EMBED_PER_RUN = 128
MIN_RECOMMENDED = 300


async def _again(deps: Deps, payload: dict[str, Any], delay: int = 0) -> None:
    await queues.send(deps.pool, "persona_tasks", payload, delay)


async def _notify(deps: Deps, org_id: str, title: str, payload: dict[str, Any], kind: str = "PERSONA") -> None:
    await deps.notify(org_id, kind, title, payload, perm="ai.write")


def _resolve_owner(msgs: list[Msg], wanted: str) -> tuple[str | None, list[str]]:
    """Nome do sócio como aparece no arquivo: igual, igual sem diferença de caixa/acento, ou o único autor que contém o nome informado."""
    import unicodedata

    def norm(s: str) -> str:
        return "".join(c for c in unicodedata.normalize("NFD", s.casefold()) if unicodedata.category(c) != "Mn").strip()

    authors = sorted({m.author for m in msgs if m.author and m.kind != "system"})
    if wanted in authors:
        return wanted, authors
    same = [a for a in authors if norm(a) == norm(wanted)]
    if len(same) == 1:
        return same[0], authors
    part = [a for a in authors if norm(wanted) and norm(wanted) in norm(a)]
    return (part[0] if len(part) == 1 else None), authors


def _dialogue_payload(res: Any, owner: str) -> list[dict[str, Any]]:
    by_digest: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for p in res.pairs:
        by_digest[p.dialogue_digest].append({"position": p.position, "context": p.context, "reply": p.reply})
    out = []
    for d in res.dialogues:
        digest = d.digest()
        out.append({"digest": digest, "pairs": by_digest.get(digest, []), "turns": [
            {"role": "owner" if t.author == owner else "customer", "text": t.text, "bubbles": t.bubbles,
             "start": t.start.isoformat() if t.start else None, "end": t.end.isoformat() if t.end else None} for t in d.turns]})
    return out


async def _process(deps: Deps, p: dict[str, Any]) -> None:
    src = await fetch_one(deps.pool, """select s.id, s.org_id, s.persona_id, s.kind, s.owner_name, s.status, r.content
                                        from ai.corpus_sources s left join ai.corpus_raw r on r.source_id = s.id where s.id = %s""", (p["source_id"],))
    if src is None or src["content"] is None or src["status"] not in ("UPLOADED", "PROCESSING"):
        return                                                      # reentrega: já tratado ou removido
    sid = str(src["id"])
    await call_fn(deps.pool, "ai.corpus_mark_processing", sid)
    try:
        import json
        raw: Any = json.loads(src["content"]) if src["kind"] == "IG_JSON" else src["content"]
        msgs = await asyncio.to_thread(parse_source, src["kind"], raw)
        owner, authors = _resolve_owner(msgs, src["owner_name"])
        if not msgs:
            raise ValueError("Não consegui ler mensagens neste arquivo. Envie o .txt exportado do WhatsApp (sem mídia) ou os arquivos message_N.json do Instagram.")
        if owner is None:
            raise ValueError(f"Não encontrei mensagens de «{src['owner_name']}» no arquivo. Nomes que aparecem nele: {', '.join(authors[:8]) or 'nenhum'}.")
        res = await asyncio.to_thread(process, msgs, owner)
    except (ValueError, TypeError, KeyError) as e:                  # arquivo que não adianta repetir
        await call_fn(deps.pool, "ai.corpus_fail", sid, str(e))
        await _notify(deps, str(src["org_id"]), "Histórico da persona não pôde ser lido", {"persona_id": str(src["persona_id"]), "error": str(e)[:200]})
        return
    stats = {**res.report, "bubbles": res.stats.get("bubbles"), "owner_matched": owner}
    out = await call_fn(deps.pool, "ai.corpus_ingest", {"source_id": sid, "stats": stats, "dialogues": _dialogue_payload(res, owner)})
    await _notify(deps, str(src["org_id"]), f"Histórico tratado: {out['dialogues']} diálogos e {out['pairs']} exemplos", {"persona_id": str(src["persona_id"]), **out})
    if deps.llm is not None and out["dialogues"]:
        await _again(deps, {"action": "CLASSIFY", "persona_id": str(src["persona_id"]), "org_id": str(src["org_id"])})


async def _llm_error(deps: Deps, org_id: str, what: str, e: Exception) -> None:
    await _notify(deps, org_id, f"{what} parou: {e}", {"error": str(e)[:200]}, kind="INTEGRATION_ERROR")


async def _classify(deps: Deps, p: dict[str, Any]) -> None:
    org, persona = str(p["org_id"]), str(p["persona_id"])
    if deps.llm is None:
        await _llm_error(deps, org, "Classificação do histórico", ValueError("a IA (OpenRouter) não está configurada neste ambiente"))
        return
    rows = await fetch_all(deps.pool, "select id, turns from ai.corpus_dialogues where persona_id = %s and classified_at is null order by created_at, id limit %s", (persona, CLASSIFY_PER_RUN))
    done = 0
    for i in range(0, len(rows), CLASSIFY_BATCH):
        batch = rows[i:i + CLASSIFY_BATCH]
        try:
            data = await deps.llm.complete_json(org, "classify", labels.classify_messages([r["turns"] for r in batch]), "classificacao_dialogos", labels.CLASSIFY_SCHEMA)
        except TransientError as e:
            raise RetryLater(int(e.retry_after or 30), str(e)) from e
        except ProviderPermanent as e:
            await _llm_error(deps, org, "Classificação do histórico", e)
            return
        items = []
        for it in data.get("items") or []:
            idx = it.get("i")
            if not isinstance(idx, int) or not 0 <= idx < len(batch):
                continue
            allowed = set(labels.owner_positions(batch[idx]["turns"]))
            items.append({"dialogue_id": str(batch[idx]["id"]), "commercial": bool(it.get("commercial")), "topics": labels.clean_topics(it.get("topics")),
                          "outcome": labels.clean_label(it.get("outcome"), labels.OUTCOMES, "INDEFINIDO"),
                          "pairs": [{"position": pr["position"], "intent": labels.clean_label(pr.get("intent"), labels.INTENTS), "stage": labels.clean_label(pr.get("stage"), labels.STAGES)}
                                    for pr in it.get("pairs") or [] if pr.get("position") in allowed]})
        if items:
            done += int(await call_fn(deps.pool, "ai.corpus_labels", {"items": items}) or 0)
    left = await fetch_one(deps.pool, "select count(*) as n from ai.corpus_dialogues where persona_id = %s and classified_at is null", (persona,))
    if left and left["n"] and done:
        await _again(deps, dict(p))                                 # próximo lote
        return
    if left and left["n"]:
        await _llm_error(deps, org, "Classificação do histórico", ValueError(f"a IA não devolveu rótulos para {left['n']} diálogos"))
        return
    await _notify(deps, org, "Histórico classificado: revise os diálogos marcados como não comerciais", {"persona_id": persona})
    await _again(deps, {"action": "EMBED", "persona_id": persona, "org_id": org})


async def _embed(deps: Deps, p: dict[str, Any]) -> None:
    org, persona = str(p["org_id"]), str(p["persona_id"])
    if deps.llm is None:
        await _llm_error(deps, org, "Indexação dos exemplos", ValueError("a IA (OpenRouter) não está configurada neste ambiente"))
        return
    rows = await fetch_all(deps.pool, "select id, context from ai.corpus_pairs where persona_id = %s and embedding is null order by created_at, id limit %s", (persona, EMBED_PER_RUN))
    for i in range(0, len(rows), EMBED_BATCH):
        batch = rows[i:i + EMBED_BATCH]
        try:
            vectors, model = await deps.llm.embed(org, [embed_text(r["context"]) for r in batch])
        except TransientError as e:
            raise RetryLater(int(e.retry_after or 30), str(e)) from e
        except ProviderPermanent as e:
            await _llm_error(deps, org, "Indexação dos exemplos", e)
            return
        await call_fn(deps.pool, "ai.corpus_embeddings", {"model": model, "items": [{"pair_id": str(r["id"]), "embedding": llm_mod.vector_text(v)} for r, v in zip(batch, vectors, strict=True)]})
    if len(rows) >= EMBED_PER_RUN:
        await _again(deps, dict(p))
    else:
        await _notify(deps, org, "Exemplos indexados: a persona já pode usar o estilo nas respostas", {"persona_id": persona})


def _to_dialogue(turns: list[dict[str, Any]]) -> Dialogue:
    def ts(v: Any) -> datetime | None:
        return datetime.fromisoformat(v) if v else None
    return Dialogue([Turn("owner" if t["role"] == "owner" else "cliente", list(t.get("bubbles") or str(t["text"]).split("\n")), ts(t.get("start")), ts(t.get("end"))) for t in turns])


def _samples(rows: list[dict[str, Any]], per_stage: int = 6, limit: int = 40) -> list[dict[str, Any]]:
    """Amostra estável e variada: por etapa, os de maior peso (desempate por hash do id, para não depender da ordem do banco)."""
    by_stage: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for r in rows:
        by_stage[r["stage"] or "outro"].append(r)
    picked: list[dict[str, Any]] = []
    for stage in sorted(by_stage):
        items = sorted(by_stage[stage], key=lambda r: (-float(r["weight"]), hashlib.md5(str(r["id"]).encode()).hexdigest()))
        picked += items[:per_stage]
    return [{"etapa": r["stage"] or "outro", "cliente": embed_text(r["context"], last=3, max_chars=400), "resposta": [str(b)[:400] for b in r["reply"]]} for r in picked[:limit]]


async def _profile(deps: Deps, p: dict[str, Any]) -> None:
    org, persona_id = str(p["org_id"]), str(p["persona_id"])
    if deps.llm is None:
        await _llm_error(deps, org, "Geração do perfil", ValueError("a IA (OpenRouter) não está configurada neste ambiente"))
        return
    persona = await fetch_one(deps.pool, "select id, name from ai.personas where id = %s", (persona_id,))
    if persona is None:
        return
    drows = await fetch_all(deps.pool, "select turns from ai.corpus_dialogues where persona_id = %s and include and commercial is not false order by created_at, id", (persona_id,))
    lexicon = [str(w) for w in p.get("lexicon") or []]
    stats = await asyncio.to_thread(lambda: compute_style([_to_dialogue(r["turns"]) for r in drows], "owner", lexicon))
    pairs = await fetch_all(deps.pool, """select cp.id, cp.context, cp.reply, cp.stage, cp.weight from ai.corpus_pairs cp left join ai.corpus_dialogues d on d.id = cp.dialogue_id
                                          where cp.persona_id = %s and (cp.dialogue_id is null or (d.include and d.commercial is not false))""", (persona_id,))
    try:
        data = await deps.llm.complete_json(org, "persona_style", labels.profile_messages(persona["name"], stats, _samples(pairs), lexicon, len(drows)), "perfil_de_estilo", labels.PROFILE_SCHEMA)
    except TransientError as e:
        raise RetryLater(int(e.retry_after or 60), str(e)) from e
    except ProviderPermanent as e:
        await _llm_error(deps, org, "Geração do perfil", e)
        return
    prompt = str(data.pop("system_prompt", "")).strip()
    rules = [str(r) for r in data.get("regras_extras") or []][:10] + [f"Evite: {t}" for t in (data.get("tabus") or [])][:10]
    warnings = [f"Só {len(drows)} diálogos aproveitáveis (o recomendado é {MIN_RECOMMENDED}+): o estilo pode ficar pouco fiel."] if len(drows) < MIN_RECOMMENDED else []
    vid = await call_fn(deps.pool, "ai.persona_new_version", {
        "persona_id": persona_id, "system_prompt": f"{prompt}\n\n{labels.TRANSPARENCY.format(name=persona['name'])}".strip(), "guardrails": {"extra_rules": rules},
        "style_profile": {"stats": stats, "narrative": data, "generated": {"dialogues": len(drows), "pairs": len(pairs), "lexicon": lexicon, "warnings": warnings}}})
    await _notify(deps, org, f"Perfil de estilo de {persona['name']} pronto para revisão", {"persona_id": persona_id, "version_id": str(vid)})


async def _learn(deps: Deps, p: dict[str, Any]) -> None:
    if p.get("draft_id"):
        d = await fetch_one(deps.pool, """select d.status, d.intent, d.stage, m.id as message_id, m.org_id, m.conversation_id, m.body, m.created_at, m.seq
                                          from omni.message_drafts d join omni.messages m on m.id = d.final_message_id where d.id = %s""", (p["draft_id"],))
        if d is None or d["status"] not in ("SENT", "EDITED_SENT"):
            return
        source, weight, intent, stage = ("HUMAN_EDIT", 2.0, d["intent"], d["stage"]) if d["status"] == "EDITED_SENT" else ("APPROVED_DRAFT", 1.5, d["intent"], d["stage"])
        m, author_type, author_member = d, None, None
    else:
        m = await fetch_one(deps.pool, """select id as message_id, org_id, conversation_id, direction, author_type, author_member_id, body, created_at, seq
                                          from omni.messages where id = %s""", (p["message_id"],))
        if m is None or m["direction"] != "OUT" or m["author_type"] not in ("HUMAN", "ECHO_FROM_APP"):
            return
        if await fetch_one(deps.pool, "select 1 as x from omni.message_drafts where final_message_id = %s", (m["message_id"],)):
            return                                                  # já aprendido pelo caminho do rascunho (peso maior)
        source, weight, intent, stage = "HUMAN_LIVE", 1.2, None, None
        author_type, author_member = m["author_type"], m["author_member_id"]
    conv = await fetch_one(deps.pool, """select coalesce(c.persona_id, ca.default_persona_id) as persona_id, pa.display_name from omni.conversations c
                                         join omni.channel_accounts ca on ca.id = c.channel_account_id join crm.parties pa on pa.id = c.party_id where c.id = %s""", (m["conversation_id"],))
    if conv is None or conv["persona_id"] is None:
        return
    persona = await fetch_one(deps.pool, "select id, member_id, name from ai.personas where id = %s", (conv["persona_id"],))
    if persona is None:
        return
    if source == "HUMAN_LIVE" and not (persona["member_id"] is not None and (author_member == persona["member_id"] or author_type == "ECHO_FROM_APP")):
        return                                                      # resposta de outra pessoa da equipe não ensina o estilo desta persona
    prev = await fetch_all(deps.pool, """select direction, body from omni.messages where conversation_id = %s and (created_at, seq) < (%s, %s) and type = 'TEXT'
                                         and coalesce(trim(body), '') <> '' and author_type <> 'SYSTEM' order by created_at desc, seq desc limit 10""", (m["conversation_id"], m["created_at"], m["seq"]))
    turns: list[dict[str, str]] = []
    for r in reversed(prev):
        role = "customer" if r["direction"] == "IN" else "owner"
        if turns and turns[-1]["role"] == role:
            turns[-1]["text"] += "\n" + r["body"]
        else:
            turns.append({"role": role, "text": r["body"]})
    context = turns[-6:]
    if not context or context[-1]["role"] != "customer":
        return                                                      # precisa responder a uma mensagem da cliente
    pseudo = Pseudonymizer([conv["display_name"] or ""], keep_names=[persona["name"]])
    clean_ctx = [{"role": c["role"], "text": pseudo.apply(c["text"]).text} for c in context]
    reply = [pseudo.apply(b.strip()).text for b in str(m["body"]).split("\n\n") if b.strip()][:3]
    if not reply or any(residual_pii(t) for t in [c["text"] for c in clean_ctx] + reply):
        return
    pair: dict[str, Any] = {"org_id": str(m["org_id"]), "persona_id": str(persona["id"]), "message_id": str(m["message_id"]), "source": source, "weight": weight,
                            "context": clean_ctx, "reply": reply, "intent": intent.lower() if intent else None, "stage": stage.lower() if stage else None}
    if deps.llm is not None:
        try:
            vectors, model = await deps.llm.embed(str(m["org_id"]), [embed_text(clean_ctx)])
            pair.update({"embedding": llm_mod.vector_text(vectors[0]), "model": model})
        except (TransientError, ProviderPermanent) as e:
            log.info("par aprendido sem embedding (a indexação completa depois): %s", e)
    await call_fn(deps.pool, "ai.corpus_add_live_pair", pair)


async def handle(deps: Deps, msg: queues.QueueMessage) -> None:
    action = msg.payload.get("action")
    if action == "PROCESS":
        await _process(deps, msg.payload)
    elif action == "CLASSIFY":
        await _classify(deps, msg.payload)
    elif action == "EMBED":
        await _embed(deps, msg.payload)
    elif action == "PROFILE":
        await _profile(deps, msg.payload)
    elif action == "LEARN":
        await _learn(deps, msg.payload)
    else:
        log.warning("ação de persona desconhecida: %s", action)
