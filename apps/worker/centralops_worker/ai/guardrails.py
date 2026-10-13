"""Validador determinístico pós-geração. A IA só é enviada se TODOS os números e afirmações vierem de ferramentas chamadas nesta execução."""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

MONEY = re.compile(r"R\$\s?(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|\d+(?:,\d{1,2})?)")
INSTALLMENT = re.compile(r"(\d{1,2})\s?x\s+(?:de\s+)?R\$\s?(\d{1,3}(?:\.\d{3})*(?:,\d{2})?|\d+(?:,\d{2})?)", re.I)
CPF = re.compile(r"\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b")
CARD = re.compile(r"\b(?:\d[ -]?){13,19}\b")
DISCOUNT = re.compile(r"\b(desconto|% ?off|promo[cç][aã]o|cupom|abatimento|mais barato|faz(emos)? por)\b", re.I)
AVAILABILITY = re.compile(r"\b(tem|temos|temos sim|dispon[ií]vel|dispon[ií]veis|em estoque|no estoque|sobrou|restou)\b", re.I)
HEALTH_CLAIM = re.compile(r"\b(cura|curar|trata|tratamento|previne|previnir|trata dor|alivia|trata les[aã]o|indicado para (les[aã]o|dor))\b", re.I)
PRICE_TOOLS = {"search_catalog", "check_stock_by_size", "create_order_draft", "apply_coupon", "get_order_status", "get_customer_360", "create_payment_link", "confirm_order_draft"}
STOCK_TOOLS = {"search_catalog", "check_stock_by_size", "get_product_details", "get_store_info", "create_reservation", "create_order_draft", "list_upcoming_events", "rsvp_event"}   # "tem vaga" também precisa de consulta; detalhes trazem o estoque por cor; "tem horário" vem da loja


@dataclass(frozen=True)
class Violation:
    code: str
    detail: str


@dataclass
class ToolResult:
    tool: str
    ok: bool
    result: dict[str, Any] = field(default_factory=dict)


def _brl(s: str) -> float:
    return float(s.replace(".", "").replace(",", "."))


def _numbers(node: Any, out: set[float]) -> None:
    """Coleta todo valor numérico (e o texto numérico de campos monetários) dos resultados das ferramentas."""
    if isinstance(node, bool):
        return
    if isinstance(node, (int, float)):
        out.add(round(float(node), 2))
    elif isinstance(node, str):
        try:
            out.add(round(float(node), 2))
        except ValueError:
            for raw in MONEY.findall(node):                      # valores escritos em texto (políticas, base de conhecimento): "R$ 500"
                out.add(round(_brl(raw), 2))
    elif isinstance(node, dict):
        for v in node.values():
            _numbers(v, out)
    elif isinstance(node, list):
        for v in node:
            _numbers(v, out)


def allowed_amounts(results: list[ToolResult]) -> set[float]:
    out: set[float] = set()
    for r in results:
        if r.ok:
            _numbers(r.result, out)
    # parcelas derivadas do total (1x..12x) e do desconto aplicado
    derived = set()
    for a in list(out):
        for n in range(2, 13):
            derived.add(round(a / n, 2))
    return out | derived


def validate(messages: list[str], results: list[ToolResult], *, max_bubbles: int = 3, max_chars: int = 600) -> list[Violation]:
    v: list[Violation] = []
    if not 1 <= len(messages) <= max_bubbles:
        v.append(Violation("FORMAT", f"a resposta precisa ter de 1 a {max_bubbles} mensagens"))
    for m in messages:
        if len(m) > max_chars:
            v.append(Violation("FORMAT", f"mensagem com {len(m)} caracteres (máximo {max_chars})"))
    text = "\n".join(messages)
    used = {r.tool for r in results if r.ok}

    amounts = allowed_amounts(results)
    for raw in MONEY.findall(text):
        if round(_brl(raw), 2) not in amounts:
            v.append(Violation("UNGROUNDED_PRICE", f"R$ {raw} não veio de nenhuma consulta desta execução"))
    for n, raw in INSTALLMENT.findall(text):
        # "3x de R$ 143,00": vale se o valor da parcela ou o total (parcela × n) constam nas consultas
        if round(_brl(raw), 2) not in amounts and round(_brl(raw) * int(n), 2) not in amounts:
            v.append(Violation("UNGROUNDED_INSTALLMENT", f"{n}x de R$ {raw} não confere com os valores consultados"))

    if AVAILABILITY.search(text) and not (used & STOCK_TOOLS):
        v.append(Violation("UNGROUNDED_STOCK", "afirmou disponibilidade sem consultar o estoque nesta execução"))
    if DISCOUNT.search(text):
        coupon_ok = any(r.tool == "apply_coupon" and r.ok for r in results)
        order_discount = any(r.tool == "create_order_draft" and r.ok and float(r.result.get("discount") or 0) > 0 for r in results)
        if not (coupon_ok or order_discount):
            v.append(Violation("DISCOUNT_NOT_ALLOWED", "a IA não concede desconto; só aplica cupom válido"))
    if CPF.search(text):
        v.append(Violation("PII", "a resposta contém algo que parece CPF"))
    if any(len(re.sub(r"\D", "", c)) >= 13 for c in CARD.findall(text)):
        v.append(Violation("PII", "a resposta contém algo que parece número de cartão"))
    if HEALTH_CLAIM.search(text):
        v.append(Violation("HEALTH_CLAIM", "alegação de saúde: resposta genérica e encaminhar para profissional"))
    return v


def feedback_for(violations: list[Violation]) -> str:
    """Texto devolvido ao modelo para a única nova tentativa."""
    lines = "\n".join(f"- {x.code}: {x.detail}" for x in violations)
    return ("Sua proposta foi reprovada pelo validador:\n" + lines +
            "\nRefaça usando SOMENTE valores e disponibilidade retornados pelas ferramentas nesta conversa; "
            "não ofereça desconto; no máximo 3 mensagens curtas. Chame propose_reply de novo.")
