"""Etapas de IA sobre o histórico: classificar cada diálogo (conversa comercial? etapa e intenção de cada resposta) e gerar o perfil de estilo.
Só montagem de prompt e schema; quem chama o modelo é o handler (rotas `classify` e `persona_style`)."""
from __future__ import annotations

import json
from typing import Any

STAGES = ["saudacao", "descoberta", "recomendacao", "tamanho", "objecao_preco", "fechamento", "pos_venda", "outro"]
INTENTS = ["disponibilidade", "tamanho", "preco", "pagamento", "entrega_retirada", "troca", "produto_info", "agradecimento", "agendamento", "outro"]
OUTCOMES = ["VENDA", "SEM_VENDA", "INDEFINIDO"]

MAX_TURNS = 14
MAX_TURN_CHARS = 280

TRANSPARENCY = ("Transparência: você escreve no ESTILO de {name}, mas é a assistente virtual da SIÉ e NUNCA diz que é {name} nem que é uma pessoa. "
                "Se perguntarem se é robô, responda a verdade e ofereça chamar alguém da equipe. "
                "Os exemplos de conversa podem trazer marcadores como {{PRECO}}, {{ESTOQUE}} e {{PRAZO}}: são valores que você só informa depois de consultar as ferramentas.")

CLASSIFY_SCHEMA: dict[str, Any] = {
    "type": "object", "additionalProperties": False, "required": ["items"],
    "properties": {"items": {"type": "array", "items": {
        "type": "object", "additionalProperties": False, "required": ["i", "commercial", "topics", "outcome", "pairs"],
        "properties": {
            "i": {"type": "integer"},
            "commercial": {"type": "boolean"},
            "topics": {"type": "array", "items": {"type": "string"}},
            "outcome": {"type": "string", "enum": OUTCOMES},
            "pairs": {"type": "array", "items": {
                "type": "object", "additionalProperties": False, "required": ["position", "intent", "stage"],
                "properties": {"position": {"type": "integer"}, "intent": {"type": "string", "enum": INTENTS}, "stage": {"type": "string", "enum": STAGES}}}},
        }}}},
}

PROFILE_SCHEMA: dict[str, Any] = {
    "type": "object", "additionalProperties": False,
    "required": ["resumo", "aberturas", "fechamentos", "vocativos", "lexico_marca", "tom_por_etapa", "vendas", "tabus", "regras_extras", "system_prompt"],
    "properties": {
        "resumo": {"type": "string"},
        "aberturas": {"type": "array", "items": {"type": "string"}},
        "fechamentos": {"type": "array", "items": {"type": "string"}},
        "vocativos": {"type": "array", "items": {"type": "string"}},
        "lexico_marca": {"type": "array", "items": {"type": "string"}},
        "tom_por_etapa": {"type": "array", "items": {"type": "object", "additionalProperties": False, "required": ["etapa", "tom"],
                                                      "properties": {"etapa": {"type": "string"}, "tom": {"type": "string"}}}},
        "vendas": {"type": "object", "additionalProperties": False, "required": ["objecao_preco", "tamanho_modelagem", "fechamento", "followup"],
                   "properties": {k: {"type": "string"} for k in ("objecao_preco", "tamanho_modelagem", "fechamento", "followup")}},
        "tabus": {"type": "array", "items": {"type": "string"}},
        "regras_extras": {"type": "array", "items": {"type": "string"}},
        "system_prompt": {"type": "string"},
    },
}


def condensed(turns: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{"n": n, "quem": "sócio" if t["role"] == "owner" else "cliente", "texto": str(t["text"])[:MAX_TURN_CHARS]} for n, t in enumerate(turns[:MAX_TURNS])]


def owner_positions(turns: list[dict[str, Any]]) -> list[int]:
    """Turnos de resposta do sócio a um turno da cliente (os mesmos que viram pares), dentro do trecho mostrado à IA."""
    return [n for n, t in enumerate(turns[:MAX_TURNS]) if n > 0 and t["role"] == "owner" and turns[n - 1]["role"] != "owner"]


def classify_messages(dialogues: list[list[dict[str, Any]]]) -> list[dict[str, str]]:
    system = ("Você organiza históricos de conversa de uma marca de moda fitness (SIÉ JOY) para treinar o atendimento. "
              "Nomes, telefones e valores já foram trocados por marcadores ({CLIENTE}, {PRECO}…). Para CADA diálogo informe: "
              "commercial = true se é atendimento/venda a cliente (produto, tamanho, preço, pedido, troca, entrega, pós-venda); false se é conversa pessoal, familiar, "
              "de amigos, de trabalho interno ou sem relação com a loja. topics = até 3 assuntos curtos em minúsculas. outcome = VENDA se a cliente fechou/pagou/reservou, "
              "SEM_VENDA se claramente não comprou, INDEFINIDO se não dá para saber. pairs = para cada turno do sócio listado em owner_turns, a intenção da cliente "
              "(intent) e a etapa da venda (stage). Responda só o JSON do schema.")
    payload = [{"i": i, "owner_turns": owner_positions(t), "turnos": condensed(t)} for i, t in enumerate(dialogues)]
    return [{"role": "system", "content": system}, {"role": "user", "content": json.dumps(payload, ensure_ascii=False)}]


def profile_messages(persona_name: str, stats: dict[str, Any], samples: list[dict[str, Any]], lexicon: list[str], n_dialogues: int) -> list[dict[str, str]]:
    keep = {k: stats.get(k) for k in ("dialogues", "turns", "bubbles", "bubbles_per_turn", "chars_per_bubble", "words_per_bubble", "emoji", "punctuation", "address",
                                      "openers", "closers", "first_bubbles", "vocabulary", "brand_terms", "response_seconds")}
    system = (f"Você analisa como {persona_name} conversa com clientes da SIÉ JOY (moda para quem se movimenta) para que uma assistente virtual imite o ESTILO, sem se passar pela pessoa. "
              "Os dados abaixo vêm de conversas reais já pseudonimizadas ({CLIENTE}, {PRECO}, {ESTOQUE}, {PRAZO} são marcadores). "
              "Descreva o estilo de forma concreta e verificável nos exemplos: tom, tamanho e ritmo das mensagens, uso de emojis e pontuação, aberturas e fechamentos típicos, vocativos, "
              "vocabulário da marca, como lida com objeção de preço, dúvida de tamanho/modelagem, fechamento e follow-up, e o que a pessoa evita dizer. Não invente nada que não apareça nos dados. "
              "Em system_prompt escreva, em português e na 2ª pessoa (\"Você…\"), as instruções finais para a assistente (até 1.800 caracteres): tom, formato curto de WhatsApp, "
              "expressões típicas, como conduzir a venda e o que evitar. Não inclua preços, prazos nem dados de clientes. Responda só o JSON do schema.")
    user = {"estatisticas": keep, "exemplos": samples, "vocabulario_da_marca": lexicon, "dialogos_analisados": n_dialogues}
    return [{"role": "system", "content": system}, {"role": "user", "content": json.dumps(user, ensure_ascii=False, default=str)}]


def clean_label(value: Any, allowed: list[str], default: str = "outro") -> str:
    v = str(value or "").strip().lower()
    return v if v in allowed else default


def clean_topics(topics: Any) -> list[str]:
    out: list[str] = []
    for t in topics if isinstance(topics, list) else []:
        s = str(t).strip().lower()[:30]
        if s and s not in out:
            out.append(s)
    return out[:3]
