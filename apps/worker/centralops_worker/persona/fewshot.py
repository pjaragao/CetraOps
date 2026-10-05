"""Exemplos de ESTILO para o prompt: os pares mais parecidos com a conversa atual, com diversidade (MMR) e formatados para o modelo."""
from __future__ import annotations

import math
from typing import Any

PREAMBLE = ("EXEMPLOS DE ESTILO (como a pessoa costuma responder em situações parecidas). Use só como referência de TOM e de jeito de escrever: "
            "fatos, preços, prazos e estoque dos exemplos podem estar desatualizados; nunca copie números, consulte as ferramentas.")


def embed_text(context: list[dict[str, str]], last: int = 3, max_chars: int = 600) -> str:
    """Texto que representa a situação (últimos turnos): é o MESMO formato na indexação e na busca."""
    text = "\n".join(f'{"Cliente" if c["role"] == "customer" else "Sócio"}: {c["text"]}' for c in context[-last:])
    return text[-max_chars:]


def cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b, strict=False))
    na, nb = math.sqrt(sum(x * x for x in a)), math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


def mmr(candidates: list[dict[str, Any]], k: int = 6, lam: float = 0.7) -> list[dict[str, Any]]:
    """Relevância (1 − distância, levemente puxada pelo peso do par) menos a semelhança com o que já foi escolhido.
    `candidates`: dicts com `distance`, `weight` e `embedding` (lista de floats)."""
    pool = list(candidates)
    chosen: list[dict[str, Any]] = []
    rel = {id(c): (1 - float(c["distance"])) * (1 + 0.1 * (float(c.get("weight") or 1) - 1)) for c in pool}
    while pool and len(chosen) < k:
        def score(c: dict[str, Any]) -> float:
            redundancy = max((cosine(c["embedding"], s["embedding"]) for s in chosen), default=0.0)
            return lam * rel[id(c)] - (1 - lam) * redundancy
        best = max(pool, key=score)
        chosen.append(best)
        pool.remove(best)
    return chosen


def format_examples(pairs: list[dict[str, Any]], max_chars: int = 500) -> str:
    if not pairs:
        return ""
    lines = [PREAMBLE]
    for n, p in enumerate(pairs, 1):
        lines.append(f"{n}) {embed_text(p['context'], last=2, max_chars=max_chars).replace(chr(10), chr(10) + '   ')}")
        lines.append("   Resposta: " + " / ".join(str(b)[:max_chars] for b in p["reply"]))
    return "\n".join(lines)
