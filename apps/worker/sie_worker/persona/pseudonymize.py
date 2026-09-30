"""Pseudonimização do corpus (plano §6.2, etapa 4): o texto que sobra NÃO pode identificar a cliente e NÃO ensina números ao modelo.
  • dado pessoal → removido (e-mail, telefone, CPF/CNPJ, cartão, CEP, endereço, links, @usuários, nome da cliente);
  • preço → {PRECO}; estoque → {ESTOQUE}; prazo → {PRAZO}: assim o modelo aprende o ESTILO e não cita números de memória.
Regex + heurísticas conservadoras: na dúvida, remove. `residual_pii` serve de conferência final (diálogo com sobra de PII é descartado)."""
from __future__ import annotations

import re
from collections import Counter
from collections.abc import Iterable
from dataclasses import dataclass, field

EMAIL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
URL = re.compile(r"https?://\S+|www\.\S+|\b(?:instagram\.com|wa\.me|bit\.ly|linktr\.ee|tiktok\.com)/\S*", re.I)
# com pontuação (123.456.789-09) ou com o rótulo ("CPF 12345678909"); 11 dígitos soltos são telefone (DDD + 9 dígitos) e caem na regra do telefone
CNPJ = re.compile(r"(?<!\d)\d{2}\.\d{3}\.\d{3}/\d{4}-\d{2}(?!\d)|(?i:\bcnpj[:\s]*)\d{14}(?!\d)")
CPF = re.compile(r"(?<!\d)\d{3}\.\d{3}\.\d{3}-\d{2}(?!\d)|(?i:\bcpf[:\s]*)\d{11}(?!\d)")
CARD = re.compile(r"(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)")
PRICE = re.compile(
    r"R\$\s?\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|R\$\s?\d+(?:[.,]\d{1,2})?|"
    r"\b\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?\s?(?:reais|real|conto|contos)\b|\b\d+(?:[.,]\d{1,2})?\s?(?:reais|real|conto|contos)\b", re.I)
PRICE_VERB = re.compile(
    r"\b(fica|ficam|sai|saem|custa|custam|valor|vale|está|estão|por|é|são)\s+(?:só\s+|apenas\s+|de\s+)?(\d{2,5})(?:,\d{2})?"
    r"(?!\d|\s?(?:dias?|horas?|h\b|min(?:utos?)?|semanas?|mes(?:es)?|x\b|%|cm|kg|mm|anos?|pe[cç]as?|unidades?|itens?|vezes|parcelas?))", re.I)
INSTALLMENT = re.compile(r"\b\d{1,2}\s?x\s?(?:de\s+)?\{PRECO\}", re.I)
PHONE = re.compile(r"(?<![\w/])(?:\+?55[\s.-]?)?(?:\(?\d{2}\)?[\s.-]?)?9?\d{4}[\s.-]?\d{4}(?![\w/])")
CEP = re.compile(r"(?i:\bcep[:\s]*)\d{5}-?\d{3}|(?<!\d)\d{5}-\d{3}(?!\d)")
ADDRESS = re.compile(r"\b(?:rua|r\.|avenida|av\.?|travessa|tv\.|alameda|al\.|rodovia|estrada|servid[aã]o)\s+[^,\n.;!?]{2,50}(?:,\s*(?:n[º°o.]*\s*)?\d{1,5}(?:\s*[-,]\s*[^,\n.;!?]{2,30})?)?", re.I)
HANDLE = re.compile(r"(?<![\w@])@[\w.]{2,30}")
DEADLINE = re.compile(r"\b\d{1,2}\s?(?:dias?|horas?|semanas?)(?:\súteis)?\b", re.I)
STOCK = re.compile(r"\b(tenho|temos|tem|sobrou|sobraram|restam|resta|restou|restaram)\s+(só\s+|apenas\s+)?(\d{1,3})\b(?=\s*(?:unidades?|pe[cç]as?|pç|no\b|na\b|em\b|do\b|da\b|de\b|tamanho|$|[,.!?]))", re.I)
GREETING_NAME = re.compile(
    r"\b((?i:oi|oie|ol[aá]|bom dia|boa tarde|boa noite|obrigad[ao]|obg|querida|lindona|amiga|amore|meu bem))[,!\s]+([A-ZÀ-Ú][a-zà-ú]{2,}(?:\s[A-ZÀ-Ú][a-zà-ú]{2,})?)")
# palavras capitalizadas comuns depois de saudação que NÃO são nome
NOT_NAMES = {
    "tudo", "bem", "como", "gente", "pessoal", "meninas", "menina", "queridas", "linda", "lindas", "lindo", "amigas", "obrigada", "obrigado", "você", "vocês", "sim", "não", "claro",
    "aqui", "tá", "ta", "então", "entao", "show", "certo", "combinado", "ok", "beleza", "perfeito", "maravilha", "joy", "sié", "wear", "florianópolis", "floripa",
}


def _luhn(digits: str) -> bool:
    total, alt = 0, False
    for ch in reversed(digits):
        d = int(ch)
        if alt:
            d *= 2
            d -= 9 if d > 9 else 0
        total += d
        alt = not alt
    return total % 10 == 0


@dataclass
class Result:
    text: str
    counts: Counter[str] = field(default_factory=Counter)


class Pseudonymizer:
    """`customer_names`: nomes que aparecem na origem (participantes do chat/IG, exceto os sócios) — trocados por {CLIENTE}."""

    def __init__(self, customer_names: Iterable[str] = (), keep_names: Iterable[str] = ()) -> None:
        # nomes dos sócios (inteiros e cada parte) nunca são tratados como nome de cliente: é o estilo deles, e precisa ficar
        keep = {k.lower() for k in keep_names} | {tok.lower() for k in keep_names for tok in k.split() if len(tok) >= 3}
        self._keep = keep
        names: set[str] = set()
        for full in customer_names:
            full = full.strip()
            if not full or full.lower() in keep:
                continue
            names.add(full)
            for tok in re.split(r"\s+", full):
                if len(tok) >= 3 and tok.lower() not in NOT_NAMES and tok.lower() not in keep and not tok.isdigit():
                    names.add(tok)
        ordered = sorted(names, key=len, reverse=True)
        self._names = re.compile(r"(?<!\w)(?:" + "|".join(re.escape(n) for n in ordered) + r")(?!\w)", re.I) if ordered else None

    def apply(self, text: str) -> Result:
        res = Result(text)
        t = text

        def sub(pattern: re.Pattern[str], repl: str | re.Pattern[str] | object, label: str) -> None:
            nonlocal t
            t, n = pattern.subn(repl, t)  # type: ignore[arg-type]
            if n:
                res.counts[label] += n

        sub(EMAIL, "{EMAIL}", "email")
        sub(URL, "{LINK}", "link")
        sub(CNPJ, "{CNPJ}", "cnpj")
        sub(CPF, "{CPF}", "cpf")

        def card(m: re.Match[str]) -> str:
            digits = re.sub(r"\D", "", m.group(0))
            if 13 <= len(digits) <= 19 and _luhn(digits):
                res.counts["cartao"] += 1
                return "{CARTAO}"
            return m.group(0)
        t = CARD.sub(card, t)

        sub(PRICE, "{PRECO}", "preco")
        t, n = PRICE_VERB.subn(lambda m: f"{m.group(1)} {{PRECO}}", t)
        res.counts["preco"] += n
        sub(INSTALLMENT, "{PRECO}", "preco")
        sub(CEP, "{CEP}", "cep")
        sub(PHONE, "{TELEFONE}", "telefone")
        sub(ADDRESS, "{ENDERECO}", "endereco")
        sub(HANDLE, "@{USUARIO}", "usuario")
        sub(STOCK, lambda m: f"{m.group(1)} {m.group(2) or ''}{{ESTOQUE}}", "estoque")
        sub(DEADLINE, "{PRAZO}", "prazo")

        if self._names is not None:
            sub(self._names, "{CLIENTE}", "nome")

        def greet(m: re.Match[str]) -> str:
            first = m.group(2).split()[0].lower()
            if first in NOT_NAMES or first in self._keep:
                return m.group(0)
            res.counts["nome"] += 1
            return f"{m.group(0)[: m.start(2) - m.start(0)]}{{CLIENTE}}"
        t = GREETING_NAME.sub(greet, t)

        res.text = t
        return res


def residual_pii(text: str) -> list[str]:
    """O que AINDA parece dado pessoal depois da pseudonimização (vazio = limpo). Diálogo com sobra é descartado."""
    found: list[str] = []
    for label, pat in (("email", EMAIL), ("cpf", CPF), ("cnpj", CNPJ), ("telefone", PHONE), ("cep", CEP), ("link", URL)):
        if pat.search(text):
            found.append(label)
    for m in CARD.finditer(text):
        d = re.sub(r"\D", "", m.group(0))
        if 13 <= len(d) <= 19 and _luhn(d):
            found.append("cartao")
            break
    return found
