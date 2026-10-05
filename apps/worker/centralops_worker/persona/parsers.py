"""Leitura dos históricos de conversa dos sócios: exportação `.txt` do WhatsApp (Android e iOS) e JSON do Instagram ("Baixar suas informações").
Só interpreta o formato; nada de filtro de assunto nem anonimização (vêm depois)."""
from __future__ import annotations

import json
import re
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta, timezone
from typing import Any, Literal

Kind = Literal["text", "media", "deleted", "system"]
BRT = timezone(timedelta(hours=-3))                      # o Brasil não tem horário de verão desde 2019


@dataclass(frozen=True)
class Msg:
    ts: datetime | None
    author: str
    text: str
    kind: Kind = "text"


# ---------------------------------------------------------------------------------------------------------------------------------------------
# WhatsApp
# ---------------------------------------------------------------------------------------------------------------------------------------------
_TIME = r"(?P<d>\d{1,2})/(?P<m>\d{1,2})/(?P<y>\d{2,4}),?\s+(?P<H>\d{1,2}):(?P<M>\d{2})(?::(?P<S>\d{2}))?\s*(?P<ap>[AaPp]\.?\s?[Mm]\.?)?"
ANDROID = re.compile(rf"^{_TIME}\s+-\s+(?P<rest>.*)$", re.S)
IOS = re.compile(rf"^\[{_TIME}\]\s+(?P<rest>.*)$", re.S)
INVISIBLE = "‎‏‪‬﻿"            # marcas de direção que o WhatsApp insere (sobretudo no iOS)

_MEDIA = re.compile(
    r"^(<m[ií]dia oculta>|<media omitted>|imagem ocultada|v[ií]deo ocultado|[aá]udio ocultado|figurinha omitida|gif omitido|documento omitido|"
    r"sticker omitted|image omitted|video omitted|audio omitted|document omitted|gif omitted|<anexo: .+>|.+\(arquivo anexado\)|.+ \(file attached\)|contato omitido|localiza[cç][aã]o: .+)$", re.I)
_DELETED = re.compile(r"^(esta mensagem foi apagada|voc[eê] apagou esta mensagem|mensagem apagada|mensagem exclu[ií]da|this message was deleted|you deleted this message)\.?$", re.I)
_EDITED = re.compile(r"\s*(<mensagem editada>|\(editada\)|<this message was edited>)\s*$", re.I)
_SYSTEM = re.compile(
    r"(mensagens e liga[cç][oõ]es s[aã]o protegidas|messages and calls are end-to-end encrypted|criptografia de ponta a ponta|chamada de (voz|v[ií]deo)|missed (voice|video) call|"
    r"mensagens tempor[aá]rias|mudou (o assunto|a imagem|o [ií]cone)|criou o grupo|adicionou|saiu$|removeu|entrou usando o link|n[uú]mero de seguran[cç]a)", re.I)


def _clean(s: str) -> str:
    return s.translate({ord(c): None for c in INVISIBLE})


def _parse_dt(g: dict[str, str | None]) -> datetime | None:
    try:
        year = int(g["y"] or 0)
        year += 2000 if year < 100 else 0
        hour = int(g["H"] or 0)
        ap = (g["ap"] or "").replace(".", "").replace(" ", "").lower()
        if ap == "pm" and hour < 12:
            hour += 12
        elif ap == "am" and hour == 12:
            hour = 0
        return datetime(year, int(g["m"] or 0), int(g["d"] or 0), hour, int(g["M"] or 0), int(g["S"] or 0), tzinfo=BRT)
    except (TypeError, ValueError):
        return None


def _classify(author: str, text: str) -> Kind:
    t = text.strip()
    if not author:
        return "system"
    if _MEDIA.match(t):
        return "media"
    if _DELETED.match(t):
        return "deleted"
    return "text"


def parse_whatsapp_txt(raw: str) -> list[Msg]:
    """Android (`31/12/2025 14:05 - Nome: texto`) e iOS (`[31/12/25, 14:05:33] Nome: texto`). Linhas sem cabeçalho continuam a mensagem anterior."""
    out: list[dict[str, Any]] = []
    for line in _clean(raw).splitlines():
        m = IOS.match(line) or ANDROID.match(line)
        if m:
            rest = m.group("rest")
            mm = re.match(r"^([^:\n]{1,80}?):\s(.*)$", rest, re.S)
            author, text = (mm.group(1).strip(), mm.group(2)) if mm and not _SYSTEM.search(mm.group(1)) else ("", rest)
            out.append({"ts": _parse_dt(m.groupdict()), "author": author, "text": text})
        elif out:
            out[-1]["text"] += "\n" + line
    msgs: list[Msg] = []
    for o in out:
        text = _EDITED.sub("", o["text"]).strip()
        msgs.append(Msg(o["ts"], o["author"], text, _classify(o["author"], text)))
    return msgs


# ---------------------------------------------------------------------------------------------------------------------------------------------
# Instagram
# ---------------------------------------------------------------------------------------------------------------------------------------------
def fix_mojibake(s: str) -> str:
    """O Instagram exporta UTF-8 lido como latin-1 ("NÃ£o" → "Não"). Só corrige se o texto realmente parece quebrado."""
    if not any(ch in s for ch in ("Ã", "Â", "â", "ð")):
        return s
    try:
        return s.encode("latin-1").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return s


_IG_SYSTEM = re.compile(r"(liked a message|curtiu uma mensagem|reacted .* to your message|reagiu .* à sua mensagem|sent an attachment|enviou um anexo|missed a call|chamada perdida|"
                        r"started a call|iniciou uma chamada|shared a story|compartilhou um story|mentioned you in)", re.I)


def parse_instagram_json(data: dict[str, Any] | Iterable[dict[str, Any]]) -> list[Msg]:
    """Aceita o conteúdo de um `message_N.json` ou uma lista deles (uma conversa dividida em vários arquivos). Devolve em ordem cronológica."""
    files = [data] if isinstance(data, dict) else list(data)
    msgs: list[Msg] = []
    for f in files:
        for m in f.get("messages", []):
            author = fix_mojibake(str(m.get("sender_name", "")))
            ts_ms = m.get("timestamp_ms")
            ts = datetime.fromtimestamp(ts_ms / 1000, tz=UTC).astimezone(BRT) if ts_ms else None
            content = fix_mojibake(m.get("content") or "")
            has_media = any(k in m for k in ("photos", "videos", "audio_files", "sticker", "share", "gifs"))
            if content and _IG_SYSTEM.search(content) and len(content) < 140:
                kind: Kind = "system"
            elif content:
                kind = "text"
            elif has_media:
                kind, content = "media", "[mídia]"
            else:
                kind = "system"
            msgs.append(Msg(ts, author, content, kind))
    msgs.sort(key=lambda x: x.ts or datetime.min.replace(tzinfo=BRT))
    return msgs


def parse_instagram_files(contents: Iterable[str]) -> list[Msg]:
    return parse_instagram_json([json.loads(c) for c in contents])
