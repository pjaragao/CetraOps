"""Sugestão pedida pelo atendente (botão Sugerir resposta / Comentar), sem banco."""
from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from centralops_worker.handlers import router
from centralops_worker.runner import RetryLater


async def test_instrucao_leva_comentario_sugestao_anterior_e_ultima_da_loja(monkeypatch: Any) -> None:
    async def fake_one(pool: Any, sql: str, params: Any = None) -> dict[str, Any]:
        assert "message_drafts" in sql
        return {"variants": [{"messages": ["Temos a Blusa Iza.", "Quer ver?"]}]}

    monkeypatch.setattr(router, "fetch_one", fake_one)
    history = [{"role": "user", "content": "tem camiseta branca?"}, {"role": "assistant", "content": "Temos a Blusa Iza."}]
    text = await router._forced_instruction(SimpleNamespace(pool=None), {"draft_id": "d1", "comment": "ele é homem, mostre a Pierre White"}, "Cliente VIP", history)  # type: ignore[arg-type]
    assert text.startswith("Cliente VIP")
    assert "última mensagem da conversa é da loja" in text
    assert '"""Temos a Blusa Iza.\n\nQuer ver?"""' in text
    assert "ele é homem, mostre a Pierre White" in text


async def test_sem_comentario_e_cliente_por_ultimo_e_so_o_aviso() -> None:
    text = await router._forced_instruction(SimpleNamespace(pool=None), {}, None, [{"role": "user", "content": "oi"}])  # type: ignore[arg-type]
    assert "rascunho" in text and "última mensagem" not in text and "Comentário" not in text


async def test_pedido_forcado_limpa_o_aviso_mas_nao_quando_vai_repetir(monkeypatch: Any) -> None:
    cleared: list[str] = []
    calls: list[bool] = []

    async def fake_clear(deps: Any, conv: str) -> None:
        cleared.append(conv)

    async def ok(deps: Any, msg: Any, forced: bool) -> None:
        calls.append(forced)

    async def retry(deps: Any, msg: Any, forced: bool) -> None:
        raise RetryLater(10, "transcrição")

    monkeypatch.setattr(router, "_clear_forced", fake_clear)
    msg = SimpleNamespace(payload={"conversation_id": "c1", "message_id": "m1", "force": True})
    monkeypatch.setattr(router, "_handle", ok)
    await router.handle(SimpleNamespace(), msg)  # type: ignore[arg-type]
    assert calls == [True] and cleared == ["c1"]
    monkeypatch.setattr(router, "_handle", retry)
    with pytest.raises(RetryLater):
        await router.handle(SimpleNamespace(), msg)  # type: ignore[arg-type]
    assert cleared == ["c1"]                                        # vai repetir: continua "IA preparando…"
    monkeypatch.setattr(router, "_handle", ok)
    await router.handle(SimpleNamespace(), SimpleNamespace(payload={"conversation_id": "c2", "message_id": "m2"}))  # type: ignore[arg-type]
    assert cleared == ["c1"] and calls == [True, False]             # mensagem comum do cliente não mexe no aviso


def test_carrinho_da_ia_usa_o_numero_do_item_e_ignora_o_resto() -> None:
    cart = [{"n": 1, "id": "a"}, {"n": 2, "id": "b"}, {"n": 3, "id": "c"}]
    updates = [{"item": 1, "size": " M ", "qty": 2}, {"item": 2, "remove": True}, {"item": 9, "size": "P"}, {"item": "x"}, {"item": 3}, "lixo"]
    assert router.cart_updates(cart, updates) == [{"id": "a", "size": "M", "qty": 2}, {"id": "b", "remove": True}]
    assert router.cart_updates(cart, None) == []


def test_carrinho_no_prompt_mostra_numero_tamanho_e_opcoes() -> None:
    from centralops_worker.ai import prompts
    text = prompts.cart_text([{"n": 1, "name": "Camiseta Pierre", "color": "White", "size": None, "qty": 1, "sizes": ["P", "M", "G"]},
                              {"n": 2, "name": "Bermuda Nico", "color": "Cinza", "size": "M", "qty": "2.000"}])
    assert "1. Camiseta Pierre White · tamanho NÃO definido · 1 un. (tamanhos da peça: P, M, G)" in text
    assert "2. Bermuda Nico Cinza · tam. M · 2 un." in text
    assert prompts.cart_text([]) is None
