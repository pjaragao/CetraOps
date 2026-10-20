"""RECEIPT_MATCH (fila ai_tasks): a IA sugere como ligar cada item da NF-e recebida ao catálogo.

Entra sozinho ao importar a nota (purch.receipts → private.receipt_ai_auto) ou à mão (purch.request_ai_match). Para cada item:
peça que já existe (vincular), nova cor/tamanho de um produto existente (nova_variante) ou produto novo (novo_produto), sempre
agrupando pela referência — cores e tamanhos do mesmo modelo são variações de UM produto — e com a coleção quando der para saber.
A resposta da IA é conferida aqui contra o catálogo (ids que não vieram dos candidatos são descartados; referência que já existe vira
nova_variante; cor/tamanho que já existe vira vincular) e fica em purch.receipt_items.ai_suggestion. Aplicar é com a pessoa
(purch.apply_ai_suggestions, na tela do recebimento). Peça existente em item ainda sem vínculo também vira SUGGESTED (fluxo de sempre)."""
from __future__ import annotations

import logging
import re
from typing import Any

from ..adapters.errors import PermanentError, TransientError
from ..db import fetch_all, fetch_one, jb
from ..deps import Deps
from ..runner import RetryLater

log = logging.getLogger("centralops_worker.receipt_ai")

BATCH = 25
ACOES = ["vincular", "nova_variante", "novo_produto", "manter", "indefinido"]
_s = {"type": ["string", "null"]}
SCHEMA: dict[str, Any] = {
    "type": "object", "additionalProperties": False, "required": ["itens"],
    "properties": {"itens": {"type": "array", "items": {
        "type": "object", "additionalProperties": False,
        "required": ["n", "acao", "variant_id", "product_id", "referencia", "nome", "genero", "categoria", "colecao", "cor", "tamanho", "confianca", "motivo"],
        "properties": {
            "n": {"type": "integer"}, "acao": {"type": "string", "enum": ACOES}, "variant_id": _s, "product_id": _s, "referencia": _s, "nome": _s,
            "genero": {"type": ["string", "null"], "enum": ["FEM", "MASC", "UNISSEX", None]}, "categoria": _s, "colecao": _s, "cor": _s, "tamanho": _s,
            "confianca": {"type": "number"}, "motivo": {"type": "string"},
        }}}},
}

SYSTEM = """Você liga os itens de uma nota fiscal de compra (NF-e de fornecedor de moda) ao catálogo da loja. Para cada item, escolha UMA ação:
- vincular: a peça (mesmo modelo, cor e tamanho) já existe no catálogo → variant_id de uma das PEÇAS listadas.
- nova_variante: o modelo já existe, mas falta essa cor ou tamanho → product_id de um dos PRODUTOS listados + cor + tamanho.
- novo_produto: o modelo não existe → referencia (código do modelo, sem cor nem tamanho), nome do modelo (SEM cor e SEM tamanho), genero, categoria, colecao, cor e tamanho.
- manter: o item já está ligado à peça certa (só quando a nota informa o vínculo atual).
- indefinido: não dá para decidir com segurança (explique no motivo).
Regras:
1. Cores e tamanhos do mesmo modelo usam a MESMA referência e o MESMO nome: viram variações de um produto só. Nunca crie um produto por linha da nota.
2. O código do fornecedor costuma ser referência + código da cor + tamanho (ex.: 17073212M = modelo 17073, cor 212, tamanho M). Compare com o SKU das peças.
3. A descrição costuma ser "Modelo - tecido : Cor : Tamanho". O tecido pode distinguir modelos diferentes com o mesmo nome; na dúvida, prefira o que bate com o código.
4. Use só ids que aparecem nas listas. Coleção e categoria: prefira as que já existem; deixe null se não souber.
5. confianca de 0 a 1. motivo curto em português.
Responda só o JSON pedido, um objeto por item, com o mesmo n."""

_SIZE = re.compile(r"^(XXG|XG|GG|PP|P|M|G|U|UN|UNICO|TU|3[4-9]|4[0-8])$", re.I)


def _norm_size(s: str | None) -> str | None:
    if not s:
        return None
    t = s.strip().upper()
    return "U" if t in ("UNICO", "ÚNICO", "UN", "TU") else t


def _refs_of(cprod: str | None, desc: str | None) -> set[str]:
    """Referências prováveis do item: prefixos numéricos do código do fornecedor e números da descrição."""
    out: set[str] = set()
    c = (cprod or "").upper()
    digits = re.match(r"^([A-Z]*\d+)", c)
    if digits:
        d = digits.group(1)
        for n in range(4, min(len(d), 8) + 1):
            out.add(d[:n])
    for tok in re.findall(r"\b[A-Z]*\d{3,}[A-Z0-9-]*\b", (desc or "").upper()):
        out.add(tok)
    return out


def _words_of(desc: str | None) -> list[str]:
    head = (desc or "").split(":")[0]
    return [w for w in re.findall(r"[A-Za-zÀ-ÿ]{4,}", head)][:3]


def _label(s: dict[str, Any], var: dict[str, dict[str, Any]], prod: dict[str, dict[str, Any]]) -> str:
    a = s["acao"]
    if a in ("vincular", "trocar"):
        v = var.get(s["variant_id"], {})
        return f"{'Trocar para' if a == 'trocar' else 'Ligar a'} {v.get('sku', '')} {v.get('product', '')} · {v.get('color') or '—'} · {v.get('size', '')}".strip()
    if a == "nova_variante":
        p = prod.get(s.get("product_id") or "", {})
        return f"Nova cor/tamanho em {p.get('reference_code', s.get('reference', ''))} {p.get('name', '')}: {s.get('color')} {s.get('size')}"
    if a == "novo_produto":
        coll = f" (coleção {s['collection']})" if s.get("collection") else ""
        return f"Produto novo {s.get('reference')} — {s.get('name')}{coll}: {s.get('color')} {s.get('size')}"
    return s.get("motivo") or "sem sugestão"


async def receipt_match(deps: Deps, p: dict[str, Any]) -> None:
    receipt_id, org = str(p["receipt_id"]), str(p["org_id"])
    rc = await fetch_one(deps.pool, "select id, number, status, supplier_party_id from purch.receipts where id = %s and org_id = %s", (receipt_id, org))
    if rc is None or rc["status"] == "POSTED":
        return

    async def finish(status: str, note: str) -> None:
        await fetch_one(deps.pool, "update purch.receipts set ai_status = %s, ai_note = %s where id = %s returning id", (status, note[:300], receipt_id))

    if deps.llm is None:
        await finish("FAILED", "IA não configurada neste servidor")
        return
    await finish("RUNNING", "analisando os itens")
    items = await fetch_all(deps.pool, """select ri.id, ri.n_item, ri.supplier_cprod, ri.cean, ri.description, ri.qty_nfe, ri.variant_id, ri.match_status, ri.match_confidence
                                          from purch.receipt_items ri where ri.receipt_id = %s order by ri.n_item""", (receipt_id,))
    review_all = bool(p.get("all"))
    targets = [i for i in items if review_all or i["variant_id"] is None or (i["match_status"] == "SUGGESTED" and float(i["match_confidence"] or 0) < 0.85)]
    if not targets:
        await finish("DONE", "todos os itens já estão ligados")
        return

    # candidatos do catálogo: pela referência provável, pelo SKU igual ao código do fornecedor e por palavras do nome
    refs = sorted({r for i in targets for r in _refs_of(i["supplier_cprod"], i["description"])})
    cprods = sorted({(i["supplier_cprod"] or "").upper() for i in targets if i["supplier_cprod"]})
    words = sorted({w.lower() for i in targets for w in _words_of(i["description"])})
    linked = [str(i["variant_id"]) for i in targets if i["variant_id"]]
    prods = await fetch_all(deps.pool, """
        select distinct p.id::text, p.reference_code, p.name, p.gender::text, cat.name as category, coll.name as collection
        from catalog.products p left join catalog.categories cat on cat.id = p.category_id left join catalog.collections coll on coll.id = p.collection_id
        where p.org_id = %(org)s and p.status <> 'DISCONTINUED' and (
          upper(p.reference_code) = any(%(refs)s)
          or exists (select 1 from catalog.variants v where v.product_id = p.id and (upper(v.sku) = any(%(cprods)s) or upper(coalesce(v.supplier_sku, '')) = any(%(cprods)s)
                                                                                  or v.id::text = any(%(linked)s)))
          or exists (select 1 from unnest(%(words)s::text[]) w where private.norm(p.name) like '%%' || private.norm(w) || '%%'))
        limit 80""", {"org": org, "refs": refs, "cprods": cprods, "words": words, "linked": linked})
    pids = [r["id"] for r in prods]
    variants = await fetch_all(deps.pool, """
        select v.id::text, v.product_id::text, v.sku, v.size, c.name as color from catalog.variants v left join catalog.colors c on c.id = v.color_id
        where v.product_id::text = any(%s) and v.active order by v.product_id, c.name, v.size limit 1500""", (pids,)) if pids else []
    colls = [r["name"] for r in await fetch_all(deps.pool, "select name from catalog.collections where org_id = %s order by created_at desc limit 40", (org,))]
    cats = [r["name"] for r in await fetch_all(deps.pool, "select name from catalog.categories where org_id = %s order by name limit 80", (org,))]
    prod_by_id = {r["id"]: r for r in prods}
    var_by_id = {r["id"]: {**r, "product": prod_by_id.get(r["product_id"], {}).get("name", "")} for r in variants}
    by_ref = {r["reference_code"].upper(): r for r in prods}

    catalog_txt = "\n".join(
        f"PRODUTO product_id={r['id']} ref={r['reference_code']} nome={r['name']} genero={r['gender']} categoria={r['category'] or '-'} colecao={r['collection'] or '-'}\n"
        + "\n".join(f"  PEÇA variant_id={v['id']} sku={v['sku']} cor={v['color'] or '-'} tam={v['size']}" for v in variants if v["product_id"] == r["id"])
        for r in prods) or "(nenhum produto parecido no catálogo)"

    suggestions: dict[int, dict[str, Any]] = {}
    for start in range(0, len(targets), BATCH):
        batch = targets[start:start + BATCH]
        lines = []
        for i in batch:
            cur = var_by_id.get(str(i["variant_id"])) if i["variant_id"] else None
            lines.append(f"n={i['n_item']} codigo={i['supplier_cprod'] or '-'} ean={i['cean'] or '-'} qtd={float(i['qty_nfe']):g} descricao={i['description']}"
                         + (f" | ligado hoje a variant_id={cur['id']} ({cur['sku']} {cur['product']} {cur['color']} {cur['size']})" if cur else ""))
        user = (f"CATÁLOGO (candidatos):\n{catalog_txt}\n\nCOLEÇÕES EXISTENTES: {', '.join(colls) or '-'}\nCATEGORIAS EXISTENTES: {', '.join(cats) or '-'}\n\n"
                f"ITENS DA NOTA {rc['number']}:\n" + "\n".join(lines))
        try:
            data = await deps.llm.complete_json(org, "extract", [{"role": "system", "content": SYSTEM}, {"role": "user", "content": user}], "vinculo_nota", SCHEMA)
        except TransientError as e:
            await finish("QUEUED", f"IA instável, tentando de novo: {e}")
            raise RetryLater(int(e.retry_after or 60), str(e)) from e
        except PermanentError as e:
            await finish("FAILED", f"IA indisponível: {e}")
            return
        for s in data.get("itens") or []:
            if isinstance(s, dict) and isinstance(s.get("n"), int):
                suggestions[s["n"]] = s

    # confere a resposta contra o catálogo e normaliza
    new_names: dict[str, str] = {}
    counts = {"vincular": 0, "trocar": 0, "nova_variante": 0, "novo_produto": 0, "outros": 0}
    for i in targets:
        s = suggestions.get(i["n_item"])
        cur_var = str(i["variant_id"]) if i["variant_id"] else None
        out: dict[str, Any] | None = None
        if s:
            acao, conf = s.get("acao"), max(0.0, min(1.0, float(s.get("confianca") or 0)))
            color, size = (s.get("cor") or "").strip() or None, _norm_size(s.get("tamanho"))
            if acao == "vincular" and s.get("variant_id") in var_by_id:
                out = {"acao": "vincular", "variant_id": s["variant_id"]}
            elif acao in ("nova_variante", "novo_produto") and color and size:
                ref = (s.get("referencia") or "").strip().upper() or None
                prod = prod_by_id.get(s.get("product_id") or "") if acao == "nova_variante" else None
                if prod is None and ref and ref in by_ref:
                    prod = by_ref[ref]                                    # a referência já existe: é variação, não produto novo
                if prod is not None:
                    same = next((v for v in variants if v["product_id"] == prod["id"] and (v["color"] or "").lower() == color.lower() and v["size"].upper() == size), None)
                    out = {"acao": "vincular", "variant_id": same["id"]} if same else {"acao": "nova_variante", "product_id": prod["id"], "color": color, "size": size}
                elif ref and (s.get("nome") or "").strip():
                    name = new_names.setdefault(ref, re.sub(r"\s+", " ", s["nome"]).strip())   # mesma referência → mesmo nome
                    out = {"acao": "novo_produto", "reference": ref, "name": name, "gender": s.get("genero") or "FEM", "category": s.get("categoria"),
                           "collection": s.get("colecao"), "color": color, "size": size}
            if out is not None:
                if out["acao"] == "vincular" and cur_var:
                    out = None if out["variant_id"] == cur_var else {**out, "acao": "trocar"}
                if out is not None:
                    out.update({"confianca": round(conf, 2), "motivo": (s.get("motivo") or "")[:200]})
            elif acao == "indefinido" or (acao not in ("manter",) and not cur_var):
                out = {"acao": "indefinido", "confianca": 0, "motivo": (s.get("motivo") or "a IA não conseguiu decidir")[:200]}
        if out is not None:
            out["rotulo"] = _label(out, var_by_id, prod_by_id)
            counts[out["acao"] if out["acao"] in counts else "outros"] += 1
        # peça existente em item sem vínculo: também vira SUGGESTED (o botão "Confirmar sugestões" de sempre)
        if out and out["acao"] == "vincular" and not cur_var and out["confianca"] >= 0.6:
            await fetch_one(deps.pool, """update purch.receipt_items set ai_suggestion = %s, ai_suggested_at = now(), variant_id = %s, match_status = 'SUGGESTED', match_confidence = %s
                                          where id = %s returning id""", (jb(out), out["variant_id"], out["confianca"], i["id"]))
        else:
            await fetch_one(deps.pool, "update purch.receipt_items set ai_suggestion = %s, ai_suggested_at = now() where id = %s returning id", (jb(out) if out else None, i["id"]))

    parts = [f"{counts['vincular']} peça(s) existente(s)", f"{counts['nova_variante']} cor/tamanho novo(s)", f"{len(new_names)} produto(s) novo(s) ({counts['novo_produto']} item(ns))"]
    if counts["trocar"]:
        parts.append(f"{counts['trocar']} vínculo(s) suspeito(s)")
    if counts["outros"]:
        parts.append(f"{counts['outros']} sem decisão")
    await finish("DONE", "Sugestões da IA: " + ", ".join(parts))
    log.info("nota %s: %s", rc["number"], parts)
