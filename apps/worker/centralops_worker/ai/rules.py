"""Pré-regras SEM LLM aplicadas antes de qualquer chamada de IA: opt-out, pedido de humano e temas que exigem pessoa."""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass


def _norm(text: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", text.lower()) if unicodedata.category(c) != "Mn").strip()


OPT_OUT = re.compile(r"^\W*(parar|sair|stop|cancelar|descadastrar|remover)\W*$|nao quero mais receber|nao me envie mais|para de me mandar|sair da lista")
HUMAN = re.compile(
    r"\b(atendente|humano|pessoa de verdade|falar com (uma )?pessoa|falar com (a |o )?(luisa|paulo|dono|dona|gerente|responsavel|vendedora)|"
    r"quero falar com|chama (a |o )?(luisa|paulo)|passa pra (a |o )?(luisa|paulo))\b")
# Reclamação formal / jurídico / dinheiro em disputa → sempre humano (política do plano)
ESCALATE = re.compile(r"\b(procon|advogado|processo|justica|reclame aqui|reclameaqui|golpe|estelionato|chargeback|contestar (a )?compra|denunciar|indeniza\w*)\b")
HEALTH = re.compile(r"\b(lesao|lesionad\w*|gravida|gestante|hernia|cirurgia|dor (nas|no|na)|medico|fisioterapeuta)\b")


@dataclass(frozen=True)
class RuleHit:
    rule: str            # OPT_OUT | HUMAN_REQUEST | ESCALATE
    trigger: str         # valor para omni.mode_events.trigger
    reason: str


def match_pre_rule(text: str | None) -> RuleHit | None:
    if not text:
        return None
    t = _norm(text)
    if OPT_OUT.search(t):
        return RuleHit("OPT_OUT", "KEYWORD", "cliente pediu para não receber mais mensagens")
    if ESCALATE.search(t):
        return RuleHit("ESCALATE", "POLICY", "tema que exige atendimento humano (reclamação formal, jurídico ou contestação)")
    if HUMAN.search(t):
        return RuleHit("HUMAN_REQUEST", "KEYWORD", "cliente pediu para falar com uma pessoa")
    return None


def mentions_health(text: str | None) -> bool:
    return bool(text and HEALTH.search(_norm(text)))
