"""Mensagens → turnos (bolhas seguidas do mesmo autor) → diálogos (separados por pausas longas)."""
from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from .parsers import Msg


@dataclass
class Turn:
    author: str
    bubbles: list[str]                     # texto de cada bolha; mídia vira "[mídia]"
    start: datetime | None = None
    end: datetime | None = None

    @property
    def text(self) -> str:
        return "\n".join(self.bubbles)


@dataclass
class Dialogue:
    turns: list[Turn] = field(default_factory=list)

    @property
    def authors(self) -> set[str]:
        return {t.author for t in self.turns}

    def digest(self) -> str:
        """Identidade estável (evita contar duas vezes o mesmo diálogo vindo de exportações sobrepostas)."""
        h = hashlib.sha256()
        for t in self.turns:
            h.update(t.author.encode())
            h.update(b"\x1f")
            h.update(t.text.encode())
            h.update(b"\x1e")
        return h.hexdigest()[:32]


def merge_turns(msgs: list[Msg], max_gap: timedelta = timedelta(minutes=10)) -> list[Turn]:
    """Junta bolhas seguidas do mesmo autor (respeitando um intervalo máximo). Mensagens de sistema e apagadas somem; mídia vira bolha "[mídia]"."""
    turns: list[Turn] = []
    for m in msgs:
        if m.kind in ("system", "deleted") or not m.author:
            continue
        text = "[mídia]" if m.kind == "media" else m.text.strip()
        if not text:
            continue
        last = turns[-1] if turns else None
        same = last is not None and last.author == m.author and (m.ts is None or last.end is None or m.ts - last.end <= max_gap)
        if same and last is not None:
            last.bubbles.append(text)
            last.end = m.ts or last.end
        else:
            turns.append(Turn(m.author, [text], m.ts, m.ts))
    return turns


def split_dialogues(turns: list[Turn], gap: timedelta = timedelta(hours=6)) -> list[Dialogue]:
    """Uma nova conversa começa depois de uma pausa longa entre turnos."""
    dialogues: list[Dialogue] = []
    current = Dialogue()
    for t in turns:
        prev = current.turns[-1] if current.turns else None
        if prev is not None and prev.end is not None and t.start is not None and t.start - prev.end > gap:
            dialogues.append(current)
            current = Dialogue()
        current.turns.append(t)
    if current.turns:
        dialogues.append(current)
    return dialogues


def dedupe(dialogues: list[Dialogue]) -> list[Dialogue]:
    seen: set[str] = set()
    out: list[Dialogue] = []
    for d in dialogues:
        k = d.digest()
        if k not in seen:
            seen.add(k)
            out.append(d)
    return out


def two_sided(dialogue: Dialogue, owner: str) -> bool:
    """Só interessa diálogo com as duas pontas (o sócio respondendo a alguém)."""
    return any(t.author == owner for t in dialogue.turns) and any(t.author != owner for t in dialogue.turns)
