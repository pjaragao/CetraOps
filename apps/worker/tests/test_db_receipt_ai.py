"""Sugestão da IA no recebimento de NF-e: a nota importada entra na fila sozinha, a resposta da IA (simulada) é conferida contra o
catálogo e aplicar cria um produto por referência (não um por linha da nota) e liga os itens."""
from __future__ import annotations

import dataclasses
import uuid
from typing import Any

import pytest

from centralops_worker import queues
from centralops_worker.db import fetch_all, fetch_one
from centralops_worker.deps import Deps
from centralops_worker.handlers import ai_tasks

from .conftest import ORG

pytestmark = pytest.mark.db
PROD = "00000000-0000-4000-8000-000000000401"


class FakeLLM:
    def __init__(self, answer: dict[str, Any]) -> None:
        self.answer, self.calls = answer, []

    async def complete_json(self, org_id: str, task: str, messages: list[dict[str, str]], schema_name: str, schema: dict[str, Any]) -> dict[str, Any]:
        self.calls.append((task, messages))
        return self.answer


async def _receipt(pool: Any) -> tuple[str, dict[str, Any]]:
    rc = str(uuid.uuid4())
    supplier = await fetch_one(pool, "select id from crm.parties where org_id = %s order by created_at limit 1", (ORG,))
    await fetch_one(pool, """insert into purch.receipts (id, org_id, legal_entity_id, location_id, supplier_party_id, number, nf_total)
                             values (%s, %s, '00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000b1', %s, 'RCB-T076', 500) returning id""",
                       (rc, ORG, supplier["id"]))  # type: ignore[index]
    ref = await fetch_one(pool, "select reference_code from catalog.products where id = %s", (PROD,))
    vs = await fetch_all(pool, "select v.id::text, v.sku, v.size, c.name as color from catalog.variants v left join catalog.colors c on c.id = v.color_id where v.product_id = %s order by v.size", (PROD,))
    rows = [(1, vs[0]["sku"], "PECA EXISTENTE", None), (2, "T076PRP", "Legging Teste - suplex : Preto : P", None), (3, "T076PRM", "Legging Teste - suplex : Preto : M", None),
            (4, "X-NOVA-COR", "Peça do modelo existente : Lilás : M", None), (5, vs[1]["sku"], "VINCULO ERRADO", vs[0]["id"])]
    for n, cprod, desc, var in rows:
        await fetch_one(pool, """insert into purch.receipt_items (org_id, receipt_id, n_item, supplier_cprod, description, ncm, qty_nfe, unit_cost_nfe, item_total, variant_id, match_status)
                                 values (%s, %s, %s, %s, %s, '61046200', 1, 100, 100, %s, %s) returning id""", (ORG, rc, n, cprod, desc, var, "MANUAL" if var else "UNMATCHED"))
    return rc, {"ref": ref["reference_code"], "vs": vs}  # type: ignore[index]


async def test_receipt_import_queues_ai_and_suggestions_are_checked_and_applied(pool: Any, deps: Deps) -> None:
    rc, cat = await _receipt(pool)
    st = await fetch_one(pool, "select ai_status from purch.receipts where id = %s", (rc,))
    assert st and st["ai_status"] == "QUEUED"                                                  # nota nova entra na fila sozinha
    q = await fetch_one(pool, "select count(*) as n from pgmq.q_ai_tasks where message ->> 'action' = 'RECEIPT_MATCH' and message ->> 'receipt_id' = %s", (rc,))
    assert q and q["n"] == 1

    vs = cat["vs"]
    answer = {"itens": [
        {"n": 1, "acao": "vincular", "variant_id": vs[0]["id"], "product_id": None, "referencia": None, "nome": None, "genero": None, "categoria": None, "colecao": None, "cor": None, "tamanho": None, "confianca": 0.95, "motivo": "SKU igual"},
        {"n": 2, "acao": "novo_produto", "variant_id": None, "product_id": None, "referencia": "t076", "nome": "Legging Teste", "genero": "FEM", "categoria": "Legging", "colecao": "Verão 27", "cor": "Preto", "tamanho": "P", "confianca": 0.8, "motivo": "modelo novo"},
        {"n": 3, "acao": "novo_produto", "variant_id": None, "product_id": None, "referencia": "T076", "nome": "Legging Teste Suplex", "genero": "FEM", "categoria": "Legging", "colecao": "Verão 27", "cor": "Preto", "tamanho": "M", "confianca": 0.8, "motivo": "modelo novo"},
        {"n": 4, "acao": "novo_produto", "variant_id": None, "product_id": None, "referencia": cat["ref"], "nome": "Outro nome", "genero": "FEM", "categoria": None, "colecao": None, "cor": "Lilás", "tamanho": "M", "confianca": 0.7, "motivo": "cor nova"},
        {"n": 5, "acao": "vincular", "variant_id": vs[1]["id"], "product_id": None, "referencia": None, "nome": None, "genero": None, "categoria": None, "colecao": None, "cor": None, "tamanho": None, "confianca": 0.9, "motivo": "código bate com outro SKU"},
    ]}
    llm = FakeLLM(answer)
    await ai_tasks.handle(dataclasses.replace(deps, llm=llm), queues.QueueMessage("ai_tasks", 1, 1, {"action": "RECEIPT_MATCH", "org_id": ORG, "receipt_id": rc, "all": True}))
    assert llm.calls[0][0] == "extract" and "Legging Teste - suplex" in llm.calls[0][1][1]["content"]

    rows = {r["n_item"]: r for r in await fetch_all(pool, "select n_item, ai_suggestion, variant_id::text, match_status from purch.receipt_items where receipt_id = %s", (rc,))}
    assert rows[1]["ai_suggestion"]["acao"] == "vincular" and rows[1]["match_status"] == "SUGGESTED" and rows[1]["variant_id"] == vs[0]["id"]
    assert rows[2]["ai_suggestion"]["acao"] == "novo_produto" and rows[2]["ai_suggestion"]["reference"] == "T076"
    assert rows[3]["ai_suggestion"]["name"] == rows[2]["ai_suggestion"]["name"] == "Legging Teste"     # mesma referência → mesmo nome
    assert rows[2]["ai_suggestion"]["price"] == 240 and "venda R$ 240,00" in rows[2]["ai_suggestion"]["rotulo"]   # custo 100 × 2,4
    assert rows[4]["ai_suggestion"]["acao"] == "nova_variante" and rows[4]["ai_suggestion"]["product_id"] == PROD   # referência existente vira variação
    assert rows[5]["ai_suggestion"]["acao"] == "trocar"                                         # vínculo suspeito apontado, não trocado sozinho
    assert rows[5]["variant_id"] == vs[0]["id"]
    st = await fetch_one(pool, "select ai_status, ai_note from purch.receipts where id = %s", (rc,))
    assert st and st["ai_status"] == "DONE" and "1 produto(s) novo(s)" in st["ai_note"]

    # aplicar é da pessoa, na tela: roda com a sessão de um sócio
    await fetch_one(pool, """select set_config('request.jwt.claims', json_build_object('sub', m.user_id, 'role', 'authenticated',
                               'app_metadata', json_build_object('org_id', m.org_id, 'member_id', m.id))::text, true) as c
                             from core.members m where m.user_id = '00000000-0000-4000-8000-0000000000f1'""")
    res = await fetch_one(pool, "select purch.apply_ai_suggestions(%s) as r", (rc,))
    assert res and res["r"]["aplicadas"] == 5 and res["r"]["erros"] == []
    n = await fetch_one(pool, """select count(*) as p, (select count(*) from catalog.variants v join catalog.products p2 on p2.id = v.product_id where p2.reference_code = 'T076') as v,
                                        (select coll.name from catalog.products p3 join catalog.collections coll on coll.id = p3.collection_id where p3.reference_code = 'T076') as coll
                                 from catalog.products where reference_code = 'T076'""")
    assert n and n["p"] == 1 and n["v"] == 2 and n["coll"] == "Verão 27"                       # um produto, duas variações, com a coleção
    pr = await fetch_one(pool, "select pr.price from catalog.prices pr join catalog.products p on p.id = pr.product_id where p.reference_code = 'T076'")
    assert pr and float(pr["price"]) == 240                                                     # o produto novo já nasce com preço de venda
    left = await fetch_one(pool, "select count(*) filter (where variant_id is null) as sem, count(*) filter (where ai_suggestion is not null) as pend from purch.receipt_items where receipt_id = %s", (rc,))
    assert left and left["sem"] == 0 and left["pend"] == 0
    five = await fetch_one(pool, "select variant_id::text from purch.receipt_items where receipt_id = %s and n_item = 5", (rc,))
    assert five and five["variant_id"] == vs[1]["id"]
