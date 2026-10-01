"""Orquestra o tratamento de um histórico: ler → turnos → diálogos → pseudonimizar → descartar o que sobrar de dado pessoal → estatísticas e pares.
Função pura (sem banco/LLM): o handler da fila chama isto e grava o resultado. Filtrar o que é conversa COMERCIAL (e não pessoal/familiar) é etapa
separada, com LLM, depois desta — aqui só sai texto que já não identifica ninguém."""
from __future__ import annotations

from collections import Counter
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any, Literal

from .normalize import Dialogue, Turn, dedupe, merge_turns, split_dialogues, two_sided
from .pairs import Pair, build_pairs
from .parsers import Msg, parse_instagram_json, parse_whatsapp_txt
from .pseudonymize import Pseudonymizer, residual_pii
from .style import compute_style

SourceKind = Literal["WA_TXT", "IG_JSON"]


@dataclass
class Processed:
    dialogues: list[Dialogue]
    pairs: list[Pair]
    stats: dict[str, Any]
    report: dict[str, Any] = field(default_factory=dict)


def parse_source(kind: SourceKind, raw: str | list[dict[str, Any]]) -> list[Msg]:
    if kind == "WA_TXT":
        return parse_whatsapp_txt(str(raw))
    import json
    data = json.loads(raw) if isinstance(raw, str) else raw
    return parse_instagram_json(data)


def process(msgs: list[Msg], owner: str, *, extra_customer_names: Iterable[str] = (), keep_names: Iterable[str] = (), lexicon: Iterable[str] = (),
            turn_gap: timedelta = timedelta(minutes=10), dialogue_gap: timedelta = timedelta(hours=6), context_turns: int = 6) -> Processed:
    authors = {m.author for m in msgs if m.author and m.kind != "system"}
    customers = [a for a in authors if a != owner]
    pseudo = Pseudonymizer([*customers, *extra_customer_names], keep_names=[owner, *keep_names])

    turns = merge_turns(msgs, turn_gap)
    dialogues = dedupe(split_dialogues(turns, dialogue_gap))
    report: dict[str, Any] = {"messages": len(msgs), "turns": len(turns), "dialogues": len(dialogues)}
    dialogues = [d for d in dialogues if two_sided(d, owner)]
    report["dialogues_two_sided"] = len(dialogues)

    counts: Counter[str] = Counter()
    clean: list[Dialogue] = []
    dropped_pii = 0
    for d in dialogues:
        new_turns: list[Turn] = []
        for t in d.turns:
            bubbles = []
            for b in t.bubbles:
                r = pseudo.apply(b)
                counts.update(r.counts)
                bubbles.append(r.text)
            # o autor também é removido do texto final: só "Sócio"/"Cliente" sobram nos pares
            new_turns.append(Turn(t.author, bubbles, t.start, t.end))
        nd = Dialogue(new_turns)
        if any(residual_pii(t.text) for t in nd.turns):
            dropped_pii += 1
            continue
        clean.append(nd)
    report.update({"dialogues_kept": len(clean), "dialogues_dropped_residual_pii": dropped_pii, "replaced": dict(counts)})

    stats = compute_style(clean, owner, lexicon)
    pairs = build_pairs(clean, owner, context_turns)
    report["pairs"] = len(pairs)
    return Processed(clean, pairs, stats, report)
