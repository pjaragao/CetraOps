"""Preço de venda sugerido para produto novo do recebimento: custo × markup, para cima no passo da loja."""
from __future__ import annotations

from decimal import Decimal

from centralops_worker.handlers.receipt_ai import suggest_price


def test_matches_the_prices_already_in_the_catalog() -> None:
    # pares custo → preço que já estão no catálogo (markup 2,40, passo de R$ 2)
    assert [suggest_price(c) for c in (153, 262, 187, 205)] == [368, 630, 450, 492]


def test_custom_markup_and_step() -> None:
    assert suggest_price("99.90", Decimal("2"), Decimal("10")) == 200
    assert suggest_price(100, Decimal("2.5"), Decimal("0.1")) == 250


def test_no_cost_no_price() -> None:
    assert suggest_price(None) is None
    assert suggest_price(0) is None
    assert suggest_price("abc") is None
