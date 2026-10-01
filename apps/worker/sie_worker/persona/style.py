"""Estatísticas de estilo da/o sócia/o (plano §6.2, etapa 6, parte em Python): o que se mede sem LLM — tamanho das mensagens, bolhas por turno, emojis,
pontuação, risadas, aberturas e fechamentos, vocabulário característico, tempo de resposta e horários. O LLM (rota `persona_style`) recebe isto
mais alguns exemplos para redigir o perfil de estilo."""
from __future__ import annotations

import re
import statistics
from collections import Counter
from collections.abc import Iterable
from datetime import timedelta
from typing import Any

from .normalize import Dialogue

# emojis: pictogramas, símbolos diversos, dingbats, bandeiras, sequências com ZWJ/seletor de variação (aproximação suficiente para estatística)
EMOJI = re.compile(
    "(?:[\U0001F1E6-\U0001F1FF]{2}|[\U0001F300-\U0001FAFF☀-➿⭐⬆⤴⤵〰〽㊗㊙©®‼⁉™ℹ↔-↪⌚-⏿Ⓜ▪-◾]"
    "[️\U0001F3FB-\U0001F3FF]?(?:‍[\U0001F300-\U0001FAFF☀-➿][️\U0001F3FB-\U0001F3FF]?)*)")
LAUGH = re.compile(r"\b(?:k{3,}|(?:ha){2,}h?|(?:he){2,}|rs+|rsrs+|kkk+|lol)\b", re.I)
WORD = re.compile(r"[a-zà-úç]+", re.I)
PLACEHOLDER = re.compile(r"\{[A-Z]+\}")

STOPWORDS = set(
    "a o as os um uma uns umas de do da dos das em no na nos nas por pra para com sem sobre entre e ou mas que se como quando onde já não nao sim é são foi ser está estou estão tá ta "
    "eu tu ele ela nós vocês você voce vc me te lhe nos lhes meu minha seu sua teu tua esse essa isso este esta isto aquele aquela aquilo ai aí lá aqui muito muita mais menos bem só "
    "também tambem ainda então entao né ne oi olá ola tudo bom boa dia tarde noite".split())


def _pct(n: int, total: int) -> float:
    return round(100 * n / total, 1) if total else 0.0


def _dist(values: list[int | float]) -> dict[str, float]:
    if not values:
        return {"mean": 0, "median": 0, "p90": 0, "max": 0}
    s = sorted(values)
    return {"mean": round(statistics.fmean(s), 1), "median": float(statistics.median(s)), "p90": float(s[min(len(s) - 1, int(0.9 * len(s)))]), "max": float(s[-1])}


def _ngram(text: str, n: int, *, last: bool) -> str:
    words = [w.lower() for w in WORD.findall(PLACEHOLDER.sub(" ", text))]
    if not words:
        return ""
    return " ".join(words[-n:] if last else words[:n])


def compute_style(dialogues: Iterable[Dialogue], owner: str, lexicon: Iterable[str] = ()) -> dict[str, Any]:
    """`owner`: nome do autor no histórico. `lexicon`: termos de marca a contar (ex.: mimos, look, matcha)."""
    bubbles: list[str] = []
    per_turn: list[int] = []
    openers: Counter[str] = Counter()
    closers: Counter[str] = Counter()
    first_bubbles: Counter[str] = Counter()
    latencies: list[float] = []
    hours: Counter[int] = Counter()
    n_dialogues = 0
    for d in dialogues:
        n_dialogues += 1
        prev = None
        for t in d.turns:
            if t.author == owner:
                texts = [b for b in t.bubbles if b != "[mídia]"]
                if texts:
                    bubbles.extend(texts)
                    per_turn.append(len(texts))
                    o, c = _ngram(texts[0], 2, last=False), _ngram(texts[-1], 3, last=True)
                    if o:
                        openers[o] += 1
                    if c:
                        closers[c] += 1
                    first_bubbles[texts[0].strip().lower()[:60]] += 1
                if t.start is not None:
                    hours[t.start.hour] += 1
                    if prev is not None and prev.author != owner and prev.end is not None:
                        delta = (t.start - prev.end).total_seconds()
                        if 0 <= delta <= timedelta(hours=6).total_seconds():
                            latencies.append(delta)
            prev = t

    total = len(bubbles)
    chars = [len(b) for b in bubbles]
    words = [len(WORD.findall(b)) for b in bubbles]
    emoji_all = [e for b in bubbles for e in EMOJI.findall(b)]
    vocab: Counter[str] = Counter()
    for b in bubbles:
        for w in WORD.findall(PLACEHOLDER.sub(" ", b).lower()):
            if len(w) > 2 and w not in STOPWORDS:
                vocab[w] += 1
    lex = {w.lower() for w in lexicon}
    lex_counts = {w: sum(1 for b in bubbles if re.search(rf"\b{re.escape(w)}", b, re.I)) for w in sorted(lex)}
    lowered = " ".join(bubbles).lower()

    return {
        "owner": owner,
        "dialogues": n_dialogues,
        "turns": len(per_turn),
        "bubbles": total,
        "bubbles_per_turn": _dist(per_turn),
        "chars_per_bubble": _dist(chars),
        "words_per_bubble": _dist(words),
        "emoji": {"pct_bubbles_with_emoji": _pct(sum(1 for b in bubbles if EMOJI.search(b)), total), "per_100_bubbles": round(100 * len(emoji_all) / total, 1) if total else 0.0,
                  "top": [{"emoji": e, "count": c} for e, c in Counter(emoji_all).most_common(15)]},
        "punctuation": {
            "exclamation_pct": _pct(sum(1 for b in bubbles if "!" in b), total), "question_pct": _pct(sum(1 for b in bubbles if "?" in b), total),
            "ellipsis_pct": _pct(sum(1 for b in bubbles if "..." in b or "…" in b), total), "ends_with_period_pct": _pct(sum(1 for b in bubbles if b.rstrip().endswith(".")), total),
            "lowercase_start_pct": _pct(sum(1 for b in bubbles if b[:1].islower()), total), "laughter_pct": _pct(sum(1 for b in bubbles if LAUGH.search(b)), total),
            "all_caps_words_pct": _pct(sum(1 for b in bubbles if any(w.isupper() and len(w) > 2 for w in re.findall(r"[A-ZÀ-Ú]{3,}", b))), total),
        },
        "address": {"voce": len(re.findall(r"\bvoc[eê]\b", lowered)), "vc": len(re.findall(r"\bvc\b", lowered)), "tu": len(re.findall(r"\btu\b", lowered)),
                    "vocatives": [{"word": w, "count": lowered.count(w)} for w in ("amiga", "linda", "querida", "lindona", "gata", "flor", "meu bem", "moça") if lowered.count(w)]},
        "openers": [{"text": k, "count": c} for k, c in openers.most_common(10)],
        "closers": [{"text": k, "count": c} for k, c in closers.most_common(10)],
        "first_bubbles": [{"text": k, "count": c} for k, c in first_bubbles.most_common(8) if c > 1],
        "vocabulary": [{"word": w, "count": c} for w, c in vocab.most_common(40)],
        "brand_terms": lex_counts,
        "response_seconds": _dist([int(x) for x in latencies]),
        "hours": {str(h): c for h, c in sorted(hours.items())},
    }
