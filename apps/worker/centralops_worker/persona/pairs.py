"""Pares (contexto da cliente → resposta da/o sócia/o): a matéria-prima dos exemplos de estilo (few-shot) e da avaliação."""
from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass

from .normalize import Dialogue


@dataclass(frozen=True)
class Pair:
    context: list[dict[str, str]]          # [{role: customer|owner, text}], do mais antigo ao mais novo; termina num turno da cliente
    reply: list[str]                       # bolhas da resposta do sócio
    dialogue_digest: str
    position: int                          # índice do turno de resposta no diálogo

    @property
    def context_text(self) -> str:
        return "\n".join(f'{"Cliente" if c["role"] == "customer" else "Sócio"}: {c["text"]}' for c in self.context)


def build_pairs(dialogues: Iterable[Dialogue], owner: str, context_turns: int = 6, max_chars: int = 1800) -> list[Pair]:
    pairs: list[Pair] = []
    for d in dialogues:
        digest = d.digest()
        for i, t in enumerate(d.turns):
            if t.author != owner or i == 0 or d.turns[i - 1].author == owner:
                continue                                              # só respostas a um turno da cliente
            reply = [b for b in t.bubbles if b != "[mídia]"]
            if not reply or sum(len(b) for b in reply) < 2:
                continue
            ctx: list[dict[str, str]] = []
            size = 0
            for prev in reversed(d.turns[max(0, i - context_turns): i]):
                text = prev.text
                if size + len(text) > max_chars and ctx:
                    break
                size += len(text)
                ctx.append({"role": "owner" if prev.author == owner else "customer", "text": text})
            ctx.reverse()
            pairs.append(Pair(ctx, reply, digest, i))
    return pairs
