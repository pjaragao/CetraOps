"""Pipeline de persona (sem banco e sem LLM): formatos de exportação, turnos/diálogos, pseudonimização, estatísticas de estilo e pares."""
from __future__ import annotations

import json
from datetime import timedelta

import pytest

from centralops_worker.persona.normalize import Dialogue, Turn, dedupe, merge_turns, split_dialogues, two_sided
from centralops_worker.persona.pairs import build_pairs
from centralops_worker.persona.parsers import BRT, fix_mojibake, parse_instagram_json, parse_whatsapp_txt
from centralops_worker.persona.pipeline import parse_source, process
from centralops_worker.persona.pseudonymize import Pseudonymizer, residual_pii
from centralops_worker.persona.style import EMOJI, compute_style

ANDROID = "\n".join([
    "30/09/2026 08:59 - As mensagens e ligações são protegidas com a criptografia de ponta a ponta. Ninguém fora desta conversa pode ler.",
    "30/09/2026 09:00 - Fernanda Souza: Oi Luisa! Vocês têm legging preta no M?",
    "30/09/2026 09:02 - Luisa Moura: Oi, Fernanda! ✨",
    "Temos sim, linda",
    "Quer que eu separe pra você?",
    "30/09/2026 09:03 - Fernanda Souza: <Mídia oculta>",
    "30/09/2026 09:03 - Fernanda Souza: Quanto fica? Tenho 10 reais de crédito kkk",
    "30/09/2026 2:05 PM - Luisa Moura: Esta mensagem foi apagada",
    "30/09/2026 14:06 - Luisa Moura: Fica R$ 429,00 ou 3x de R$ 143,00 <Mensagem editada>",
    "01/10/2026 10:00 - Luisa Moura criou o grupo",
])

IOS = "\n".join([
    "‎[30/09/26, 09:00:12] Carla Dias: Bom dia!",
    "[30/09/26, 09:01:40] Paulo Moura: Bom dia, Carla! Em que posso ajudar?",
    "‎[30/09/26, 09:02:10] Carla Dias: ‎imagem ocultada",
    "‎[30/09/26, 09:02:50] Carla Dias: ‎áudio ocultado",
    "[30/09/26, 09:03:00] Paulo Moura: Me manda seu CEP que eu calculo o frete",
])


def test_whatsapp_android_parses_authors_times_and_kinds() -> None:
    msgs = parse_whatsapp_txt(ANDROID)
    kinds = [(m.author, m.kind) for m in msgs]
    assert kinds[0] == ("", "system") and kinds[-1] == ("", "system")                       # criptografia e "criou o grupo"
    assert msgs[1].author == "Fernanda Souza" and msgs[1].ts is not None and msgs[1].ts.tzinfo == BRT and (msgs[1].ts.day, msgs[1].ts.month, msgs[1].ts.year) == (30, 9, 2026)
    assert msgs[2].text == "Oi, Fernanda! ✨\nTemos sim, linda\nQuer que eu separe pra você?"     # linhas seguintes continuam a mensagem
    assert msgs[3].kind == "media"
    assert [m.kind for m in msgs if m.text.startswith("Esta mensagem")] == ["deleted"]
    pm = next(m for m in msgs if m.kind == "deleted")
    assert pm.ts is not None and pm.ts.hour == 14                                            # "2:05 PM" → 14:05
    assert msgs[-2].text.endswith("3x de R$ 143,00") and "<Mensagem editada>" not in msgs[-2].text


def test_whatsapp_ios_ignores_invisible_marks_and_detects_media() -> None:
    msgs = parse_whatsapp_txt(IOS)
    assert [m.author for m in msgs] == ["Carla Dias", "Paulo Moura", "Carla Dias", "Carla Dias", "Paulo Moura"]
    assert [m.kind for m in msgs] == ["text", "text", "media", "media", "text"]
    assert msgs[0].ts is not None and (msgs[0].ts.year, msgs[0].ts.hour, msgs[0].ts.second) == (2026, 9, 12)


def test_instagram_json_fixes_mojibake_orders_messages_and_flags_system() -> None:
    mojibake = "Não sei o tamanho 😊".encode().decode("latin-1")
    assert fix_mojibake(mojibake) == "Não sei o tamanho 😊" and fix_mojibake("texto normal") == "texto normal"
    data = {"participants": [{"name": "loja.demo"}, {"name": "Ana"}], "messages": [                      # o Instagram exporta do mais novo para o mais antigo
        {"sender_name": "loja.demo", "timestamp_ms": 1790000300000, "content": "Posso separar pra você!"},
        {"sender_name": "Ana", "timestamp_ms": 1790000200000, "photos": [{"uri": "x.jpg"}]},
        {"sender_name": "Ana", "timestamp_ms": 1790000100000, "content": mojibake},
        {"sender_name": "Ana", "timestamp_ms": 1790000050000, "content": "Ana curtiu uma mensagem"},
    ]}
    msgs = parse_instagram_json(data)
    assert [m.kind for m in msgs] == ["system", "text", "media", "text"] and msgs[1].text == "Não sei o tamanho 😊"
    assert msgs[2].text == "[mídia]" and msgs[0].ts is not None and msgs[0].ts < msgs[-1].ts  # type: ignore[operator]
    assert parse_instagram_json([data, {"messages": [{"sender_name": "Ana", "timestamp_ms": 1790000000000, "content": "oi"}]}])[0].text == "oi"   # vários arquivos da mesma conversa


def test_turns_dialogues_dedupe_and_sides() -> None:
    msgs = parse_whatsapp_txt(ANDROID)
    turns = merge_turns(msgs)
    assert [(t.author, len(t.bubbles)) for t in turns] == [("Fernanda Souza", 1), ("Luisa Moura", 1), ("Fernanda Souza", 2), ("Luisa Moura", 1)]   # 14:06 é outro turno (apagada some)
    assert turns[1].bubbles == ["Oi, Fernanda! ✨\nTemos sim, linda\nQuer que eu separe pra você?"]
    assert turns[2].bubbles == ["[mídia]", "Quanto fica? Tenho 10 reais de crédito kkk"]
    dialogues = split_dialogues(turns, gap=timedelta(hours=3))
    assert len(dialogues) == 2 and dialogues[1].turns[0].author == "Luisa Moura"                   # pausa das 09h às 14h
    assert len(dedupe(dialogues + dialogues)) == 2
    assert two_sided(dialogues[0], "Luisa Moura") and not two_sided(dialogues[1], "Luisa Moura")


@pytest.mark.parametrize("text,expected", [
    ("Me chama no (48) 99999-8888 ou 48999998888", "Me chama no {TELEFONE} ou {TELEFONE}"),
    ("meu email é ana.silva@gmail.com tá?", "meu email é {EMAIL} tá?"),
    ("CPF 123.456.789-09 e CNPJ 12.345.678/0001-95", "CPF {CPF} e CNPJ {CNPJ}"),
    ("cartão 4111 1111 1111 1111 vence 12/30", "cartão {CARTAO} vence 12/30"),
    ("Fica R$ 429,00 ou 3x de R$ 143,00 sem juros", "Fica {PRECO} ou {PRECO} sem juros"),
    ("sai por 429 à vista", "sai por {PRECO} à vista"),
    ("custa 1.299,90 reais", "custa {PRECO}"),
    ("chega em 2 dias úteis ou 24 horas", "chega em {PRAZO} ou {PRAZO}"),
    ("tenho 2 no M e temos só 3 peças do G", "tenho {ESTOQUE} no M e temos só {ESTOQUE} peças do G"),
    ("moro na Rua das Flores, 123 - Centro", "moro na {ENDERECO}"),
    ("CEP 88010-000", "{CEP}"),
    ("segue no @ana.silva e veja instagram.com/loja.demo ou https://wa.me/5548999998888", "segue no @{USUARIO} e veja {LINK} ou {LINK}"),
    ("Oi Fernanda! Tudo bem?", "Oi {CLIENTE}! Tudo bem?"),
    ("Bom dia Carla Dias, como vai?", "Bom dia {CLIENTE}, como vai?"),
    ("Oi Tudo bem? Show, combinado", "Oi Tudo bem? Show, combinado"),                            # palavras comuns não viram nome
    ("são 10 peças, por 3 dias, 5x sem juros, 30 minutos", "são 10 peças, por {PRAZO}, 5x sem juros, 30 minutos"),
])
def test_pseudonymizer_cases(text: str, expected: str) -> None:
    out = Pseudonymizer().apply(text).text
    assert out == expected, out


def test_pseudonymizer_names_from_the_source_and_keep_the_owner() -> None:
    p = Pseudonymizer(customer_names=["Fernanda Souza", "Ana"], keep_names=["Luisa Moura"])
    r = p.apply("Fernanda, aqui é a Luisa. A Souza e a ana já pegaram!")
    assert r.text == "{CLIENTE}, aqui é a Luisa. A {CLIENTE} e a {CLIENTE} já pegaram!" and r.counts["nome"] == 3
    assert Pseudonymizer(customer_names=["Luisa Moura"], keep_names=["Luisa Moura"]).apply("Oi Luisa").text == "Oi Luisa"      # nome do sócio não é tratado como cliente


def test_residual_pii_detects_what_is_left() -> None:
    assert residual_pii("tudo certo {CLIENTE}, {PRECO}") == []
    assert set(residual_pii("ligue 48 99999-8888 ou ana@x.com")) == {"telefone", "email"}
    assert "cartao" in residual_pii("cartão 4111 1111 1111 1111")


def test_emoji_detection_handles_zwj_flags_and_modifiers() -> None:
    assert EMOJI.findall("Oi ✨💛 tudo bem 👩🏽‍🦰 🇧🇷 ❤️") == ["✨", "💛", "👩🏽‍🦰", "🇧🇷", "❤️"]


def _dialogue(*turns: tuple[str, list[str], int]) -> Dialogue:
    base = __import__("datetime").datetime(2026, 9, 30, 9, 0, tzinfo=BRT)
    return Dialogue([Turn(a, b, base + timedelta(minutes=m), base + timedelta(minutes=m)) for a, b, m in turns])


def test_style_statistics_are_computed_on_the_owner_only() -> None:
    d = _dialogue(("Ana", ["Oi! Tem legging?"], 0), ("Luisa", ["Oi, linda! ✨", "Temos sim 💛", "Quer ver as cores?"], 2),
                  ("Ana", ["quero a preta"], 3), ("Luisa", ["Separo pra você!", "kkk mimo pra você"], 4))
    s = compute_style([d], "Luisa", lexicon=["mimo", "look"])
    assert (s["dialogues"], s["turns"], s["bubbles"]) == (1, 2, 5) and s["bubbles_per_turn"]["mean"] == 2.5
    assert s["emoji"]["pct_bubbles_with_emoji"] == 40.0 and {e["emoji"] for e in s["emoji"]["top"]} == {"✨", "💛"}
    assert s["punctuation"]["exclamation_pct"] == 40.0 and s["punctuation"]["question_pct"] == 20.0 and s["punctuation"]["laughter_pct"] == 20.0
    assert s["address"]["voce"] == 2 and {v["word"] for v in s["address"]["vocatives"]} == {"linda"}
    assert s["openers"][0]["text"] in {"oi linda", "separo pra"} and s["brand_terms"] == {"look": 0, "mimo": 1}
    assert s["response_seconds"]["median"] == 90.0                                          # respondeu em 120 s (0→2 min) e em 60 s (3→4 min)
    assert s["hours"] == {"9": 2}


def test_pairs_context_ends_with_the_customer_and_skips_owner_follow_ups() -> None:
    d = _dialogue(("Ana", ["Oi"], 0), ("Luisa", ["Oi, linda!"], 1), ("Luisa", ["Posso ajudar?"], 2), ("Ana", ["Quero a legging"], 3), ("Luisa", ["[mídia]", "Separo!", "Qual tamanho?"], 4),
                  ("Ana", ["M"], 5), ("Luisa", ["[mídia]"], 6))
    pairs = build_pairs([d], "Luisa", context_turns=3)
    assert [p.reply for p in pairs] == [["Oi, linda!"], ["Separo!", "Qual tamanho?"]]         # o "Posso ajudar?" (sócio depois do sócio) e a resposta só de mídia ficam de fora
    assert pairs[1].context[-1] == {"role": "customer", "text": "Quero a legging"}             # o contexto sempre termina na fala da cliente
    assert [c["role"] for c in pairs[1].context] == ["owner", "owner", "customer"]              # janela de 3 turnos, do mais antigo ao mais novo
    assert pairs[0].context == [{"role": "customer", "text": "Oi"}] and "Cliente: Oi" in pairs[0].context_text


def test_end_to_end_pipeline_anonymizes_and_drops_dialogues_with_residual_pii() -> None:
    raw = "\n".join([
        "30/09/2026 09:00 - Fernanda Souza: Oi Luisa! Quanto é a legging? Meu cel 48 99999-8888",
        "30/09/2026 09:02 - Luisa Moura: Oi, Fernanda! Fica R$ 429,00 ✨",
        "30/09/2026 09:03 - Fernanda Souza: Separa a preta no M pra mim?",
        "30/09/2026 09:04 - Luisa Moura: Separo sim, linda! Retira em 2 dias.",
        "01/10/2026 10:00 - Carla Dias: Oi, o link é https://exemplo.com/x e meu CPF 111.444.777-35",
        "01/10/2026 10:05 - Luisa Moura: Recebi, obrigada!",
    ])
    out = process(parse_source("WA_TXT", raw), "Luisa Moura", lexicon=["linda"])
    text = "\n".join(t.text for d in out.dialogues for t in d.turns)
    assert out.report["dialogues"] == 2 and out.report["dialogues_kept"] == 2                # os dados pessoais foram trocados, então nada sobra
    assert "Fernanda" not in text and "99999" not in text and "429" not in text and "111.444" not in text and "exemplo.com" not in text
    assert "{TELEFONE}" in text and "{PRECO}" in text and "{CPF}" in text and "{PRAZO}" in text and "{CLIENTE}" in text and "{LINK}" in text
    assert "Oi Luisa" in text                                                                  # o nome do sócio é estilo: fica
    assert out.report["replaced"]["preco"] >= 1 and len(out.pairs) == 3 and out.stats["bubbles"] == 3
    assert json.dumps(out.stats)                                                               # serializável para gravar no banco


def test_greeting_followed_by_an_exclamation_mark_does_not_swallow_the_next_sentence() -> None:
    from centralops_worker.persona.pseudonymize import Pseudonymizer

    p = Pseudonymizer([])
    assert p.apply("Oi amiga! Tem sim 💛").text == "Oi amiga! Tem sim 💛"
    assert p.apply("Oi! Temos o M").text == "Oi! Temos o M"
    assert p.apply("Oi Maria, tudo bem?").text == "Oi {CLIENTE}, tudo bem?"          # saudação + nome continua trocado
    assert p.apply("Obrigada Fernanda").text == "Obrigada {CLIENTE}"
