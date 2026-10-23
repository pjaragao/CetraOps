"""DFE_TRIAGE (fila ai_tasks): para onde vai a NF-e recebida — nem toda nota é mercadoria para revenda.

Entra sozinho quando o XML da nota chega (fiscal.inbound_dfe → private.dfe_triage_auto) ou à mão (fiscal.request_dfe_triage).
Para cada item, nesta ordem (a IA só vê o que sobrar):
  1. catálogo: o item já casa com uma peça (private.nfe_match) → ESTOQUE;
  2. regras de NCM + descrição: vestuário/calçado/acessório (cap. 61, 62, 64, 65, 4202, 7117) → ESTOQUE; cabide, manequim, expositor
     → PATRIMONIO 1.2.1.04; arara, móvel, espelho → 1.2.1.02; letreiro, iluminação → 1.2.1.01; equipamento → 1.2.1.03;
     sacola, embalagem, etiqueta → CONSUMO 1.1.3.02; escritório e limpeza → DESPESA 7.2.14;
  3. o destino que o fornecedor recebeu da última vez (crm.parties.preferences.nfe_destino);
  4. a IA (rota 'extract'), com as contas permitidas e o histórico do fornecedor como pista.
Depois cruza com o financeiro, para a mesma compra não entrar duas vezes: reembolsos do mesmo CNPJ (paga do bolso), contas a pagar
do fornecedor (abertas ou pagas), linhas do extrato ainda não conciliadas e movimentos lançados direto (já saiu do banco). Grava a sugestão em fiscal.inbound_dfe.triage e avisa quem cuida do financeiro.
Confirmar é sempre da pessoa (fiscal.apply_dfe_destination, na tela da nota)."""
from __future__ import annotations

import logging
import re
import unicodedata
from decimal import Decimal
from typing import Any

from ..adapters.errors import PermanentError, TransientError
from ..db import fetch_all, fetch_one, jb
from ..deps import Deps
from ..runner import RetryLater

log = logging.getLogger("centralops_worker.dfe_triage")

DESTINOS = ["ESTOQUE", "PATRIMONIO", "CONSUMO", "DESPESA", "INDEFINIDO"]
DEFAULT_ACCOUNT = {"PATRIMONIO": "1.2.1.04", "CONSUMO": "1.1.3.02", "DESPESA": "7.2.99"}
LABEL = {"ESTOQUE": "mercadoria para revenda", "PATRIMONIO": "patrimônio", "CONSUMO": "material de consumo", "DESPESA": "despesa", "INDEFINIDO": "a decidir"}

# (destino, conta, palavras da descrição, prefixos de NCM)
GROUPS: list[tuple[str, str | None, tuple[str, ...], tuple[str, ...]]] = [
    ("ESTOQUE", None, (), ("61", "62", "64", "65", "4202", "7117", "9004")),
    ("PATRIMONIO", "1.2.1.04", ("cabide", "manequim", "busto", "expositor", "display", "vitrine", "porta bijuteria", "porta-bijuteria"), ("9618", "442110")),
    ("PATRIMONIO", "1.2.1.02", ("arara", "cabideiro", "movel", "moveis", "armario", "prateleira", "estante", "balcao", "banqueta", "espelho", "provador", "nicho", "puff", "cadeira", "mesa "),
     ("9403", "9401", "7009")),
    ("PATRIMONIO", "1.2.1.01", ("letreiro", "neon", "luminaria", "iluminacao", "spot", "trilho de luz", "luminoso"), ("9405",)),
    ("PATRIMONIO", "1.2.1.03", ("impressora", "tablet", "notebook", "computador", "leitor de codigo", "scanner", "maquininha", "balanca", "monitor", "smartphone", "celular"),
     ("8471", "8443", "8470", "8517", "8528", "8423")),
    ("CONSUMO", "1.1.3.02", ("sacola", "embalagem", "caixa de presente", "papel de seda", "papel seda", "tag ", "etiqueta", "lacre", "envelope", "fita adesiva"), ("4819", "4821", "3923", "4823")),
    ("DESPESA", "7.2.14", ("papel a4", "caneta", "grampeador", "detergente", "desinfetante", "limpeza", "papel higienico", "papel toalha", "saco de lixo", "copo descartavel", "cafe ", "agua mineral"),
     ("4820", "4817", "3402", "4818", "9608", "4802")),
]

_s = {"type": ["string", "null"]}
SCHEMA: dict[str, Any] = {
    "type": "object", "additionalProperties": False, "required": ["itens"],
    "properties": {"itens": {"type": "array", "items": {
        "type": "object", "additionalProperties": False, "required": ["n", "destino", "conta_codigo", "confianca", "motivo"],
        "properties": {"n": {"type": "integer"}, "destino": {"type": "string", "enum": DESTINOS}, "conta_codigo": _s,
                       "confianca": {"type": "number"}, "motivo": {"type": "string"}}}}},
}

SYSTEM = """Você classifica os itens de uma nota fiscal de COMPRA recebida por uma loja de moda (revende roupas, calçados e acessórios).
Para cada item, escolha o destino:
- ESTOQUE: mercadoria que a loja revende (roupa, calçado, acessório de moda) — vai para o estoque.
- PATRIMONIO: bem durável usado na loja e não revendido (cabides, araras, manequins, expositores, móveis, letreiro, iluminação, equipamentos).
- CONSUMO: material que se gasta na operação e fica guardado (sacolas, embalagens, etiquetas, papel de seda).
- DESPESA: gasto que não fica guardado (material de escritório, limpeza, serviço, manutenção).
- INDEFINIDO: não dá para saber com segurança (explique no motivo).
Para PATRIMONIO, CONSUMO e DESPESA, escolha conta_codigo SÓ entre as contas listadas; para ESTOQUE e INDEFINIDO, conta_codigo = null.
Use a descrição, o NCM, a natureza da operação e a atividade do fornecedor. confianca de 0 a 1. motivo: uma frase curta em português.
Responda só o JSON pedido, um objeto por item, com o mesmo n."""


def norm(s: str | None) -> str:
    t = unicodedata.normalize("NFD", (s or "").lower())
    return re.sub(r"\s+", " ", "".join(c for c in t if unicodedata.category(c) != "Mn")).strip()


def rule_for(ncm: str | None, desc: str | None) -> dict[str, Any] | None:
    """Destino pelas regras de NCM e descrição; None quando não decidem (ou se contradizem) — aí a IA decide."""
    d, code = f" {norm(desc)} ", re.sub(r"\D", "", ncm or "")
    by_word = next((g for g in GROUPS if any(re.search(rf"\b{re.escape(w.strip())}(s|es)?\b", d) for w in g[2])), None)   # palavra inteira: "cabideiro" não é "cabide"
    by_ncm = next((g for g in GROUPS if code and any(code.startswith(p) for p in g[3])), None)
    if by_word and by_ncm and by_word[0] != by_ncm[0]:
        return None
    g = by_word or by_ncm
    if g is None:
        return None
    if by_word and by_ncm:
        conf, why = 0.95, f"descrição e NCM {code} indicam {LABEL[g[0]]}"
    elif by_word:
        conf, why = 0.88, f"a descrição indica {LABEL[g[0]]}"
    else:
        conf, why = (0.9 if g[0] == "ESTOQUE" else 0.82), f"NCM {code} é de {LABEL[g[0]]}"
    return {"destino": g[0], "conta_codigo": g[1], "confianca": conf, "motivo": why, "fonte": "regra"}


def item_value(it: dict[str, Any]) -> Decimal:
    return sum((Decimal(str(it.get(k) or 0)) for k in ("vprod", "vfrete", "vseg", "voutro", "vipi", "vicmsst")), Decimal(0)) - Decimal(str(it.get("vdesc") or 0))


def summarize(items: list[dict[str, Any]], total: Decimal) -> tuple[str, list[dict[str, Any]]]:
    """Destino da nota (pelo valor) e as linhas de classificação por conta, somando exatamente o total da nota."""
    by_dest: dict[str, Decimal] = {}
    by_acc: dict[str, Decimal] = {}
    for it in items:
        by_dest[it["destino"]] = by_dest.get(it["destino"], Decimal(0)) + it["valor"]
        if it["destino"] in DEFAULT_ACCOUNT and it.get("conta_id"):
            by_acc[it["conta_id"]] = by_acc.get(it["conta_id"], Decimal(0)) + it["valor"]
    if not by_dest:
        return "UNKNOWN", []
    if by_dest.get("ESTOQUE") and len(by_dest) == 1:
        return "STOCK", []
    main = max(by_dest, key=lambda k: by_dest[k])
    dest = {"ESTOQUE": "STOCK", "PATRIMONIO": "ASSET", "CONSUMO": "EXPENSE", "DESPESA": "EXPENSE"}.get(main, "UNKNOWN")
    lines = [{"chart_account_id": a, "amount": v} for a, v in sorted(by_acc.items(), key=lambda kv: -kv[1])]
    if lines and not by_dest.get("ESTOQUE") and not by_dest.get("INDEFINIDO"):
        diff = total - sum((ln["amount"] for ln in lines), Decimal(0))   # frete/arredondamento da nota vão para a linha maior
        lines[0]["amount"] += diff
    return dest, [{"chart_account_id": ln["chart_account_id"], "amount": float(round(ln["amount"], 2))} for ln in lines]


async def dfe_triage(deps: Deps, p: dict[str, Any]) -> None:
    dfe_id, org = str(p["dfe_id"]), str(p["org_id"])
    d = await fetch_one(deps.pool, """select id, access_key, issuer_cnpj, issuer_name, xml, document_id, destination
                                      from fiscal.inbound_dfe where id = %s and org_id = %s""", (dfe_id, org))
    if d is None or not d["xml"] or d["destination"] or d["document_id"]:
        return

    async def finish(status: str, note: str, triage: dict[str, Any] | None = None) -> None:
        await fetch_one(deps.pool, """update fiscal.inbound_dfe set triage_status = %s, triage_note = %s, triage = coalesce(%s, triage), triage_at = now()
                                      where id = %s returning id""", (status, note[:300], jb(triage) if triage is not None else None, dfe_id))

    await finish("RUNNING", "analisando os itens")
    nf = (await fetch_one(deps.pool, "select fiscal.parse_nfe(%s) as j", (d["xml"],)) or {}).get("j") or {}
    items_nf: list[dict[str, Any]] = nf.get("items") or []
    total = Decimal(str((nf.get("totals") or {}).get("vNF") or 0))
    cnpj = re.sub(r"\D", "", d["issuer_cnpj"] or (nf.get("issuer") or {}).get("cnpj") or "")

    accounts = await fetch_all(deps.pool, """select id::text, code, name from fin.chart_accounts where org_id = %s and kind = 'ANALYTIC' and archived_at is null
                                              and (code like '1.2.1.%%' or code = '1.1.3.02' or code like '7.%%') and code <> '1.2.1.09' order by code""", (org,))
    acc_by_code = {a["code"]: a for a in accounts}
    acc_by_id = {a["id"]: a for a in accounts}
    party = await fetch_one(deps.pool, "select id::text, preferences, registry from crm.parties where org_id = %s and cnpj = %s and merged_into_id is null", (org, cnpj)) if cnpj else None
    pref = ((party or {}).get("preferences") or {}).get("nfe_destino") or {}
    history = await fetch_one(deps.pool, "select count(*) as n from purch.receipts where org_id = %s and supplier_party_id = %s", (org, party["id"])) if party else None
    stock_history = int((history or {}).get("n") or 0)

    def account(code: str | None, destino: str) -> dict[str, Any] | None:
        return acc_by_code.get(code or "") or acc_by_code.get(DEFAULT_ACCOUNT.get(destino, ""))

    out: list[dict[str, Any]] = []
    pending: list[dict[str, Any]] = []
    for it in items_nf:
        base = {"n": int(it.get("n_item") or len(out) + 1), "descricao": it.get("xprod"), "ncm": it.get("ncm"), "cfop": it.get("cfop"),
                "qtd": float(it.get("qcom") or 0), "unidade": it.get("ucom"), "valor": item_value(it)}
        guess: dict[str, Any] | None = None
        if party:
            m = await fetch_one(deps.pool, "select o_variant, o_conf from private.nfe_match(%s, %s, %s, %s, %s)", (org, party["id"], it.get("cprod"), it.get("cean"), it.get("xprod")))
            if m and m["o_variant"] and float(m["o_conf"] or 0) >= 0.8:
                guess = {"destino": "ESTOQUE", "conta_codigo": None, "confianca": 0.97, "motivo": "o item já está no catálogo", "fonte": "catalogo"}
        if guess is None:
            guess = rule_for(it.get("ncm"), it.get("xprod"))
        if pref.get("destination") in ("ASSET", "EXPENSE") and (guess is None or (guess["destino"] != "ESTOQUE" and guess["confianca"] < 0.95)):
            acc = acc_by_id.get(pref.get("chart_account_id") or "")
            if acc:
                destino = "PATRIMONIO" if pref["destination"] == "ASSET" else ("CONSUMO" if acc["code"].startswith("1.1.3") else "DESPESA")
                guess = {"destino": destino, "conta_codigo": acc["code"], "confianca": 0.97, "motivo": "mesmo destino da última nota deste fornecedor", "fonte": "fornecedor"}
        if guess is None:
            pending.append({**base})
            out.append({**base, "destino": "INDEFINIDO", "confianca": 0.0, "motivo": "", "fonte": "ia"})
        else:
            out.append({**base, **guess})

    note_extra = ""
    if pending:
        if deps.llm is None:
            for o in out:
                if o["fonte"] == "ia":
                    o.update(destino="ESTOQUE" if stock_history else "INDEFINIDO", confianca=0.6 if stock_history else 0.0,
                             motivo="fornecedor já entregou mercadoria antes" if stock_history else "IA não configurada: decida pela descrição")
            note_extra = " (IA não configurada)"
        else:
            reg = (party or {}).get("registry") or {}
            atividade = ((reg.get("cnae_main") or {}).get("description")) if isinstance(reg, dict) else None
            acc_txt = "\n".join(f"{a['code']} {a['name']}" for a in accounts)
            lines = "\n".join(f"n={i['n']} ncm={i['ncm'] or '-'} cfop={i['cfop'] or '-'} qtd={i['qtd']:g} {i['unidade'] or ''} valor={float(i['valor']):.2f} descricao={i['descricao']}" for i in pending)
            user = (f"FORNECEDOR: {d['issuer_name']} (CNPJ {cnpj}){f' · atividade: {atividade}' if atividade else ''}"
                    f" · já entregou mercadoria para estoque {stock_history} vez(es)\nNATUREZA DA OPERAÇÃO: {(nf.get('header') or {}).get('operation_nature') or '-'}\n\n"
                    f"CONTAS PERMITIDAS:\n{acc_txt}\n\nITENS:\n{lines}")
            try:
                data = await deps.llm.complete_json(org, "extract", [{"role": "system", "content": SYSTEM}, {"role": "user", "content": user}], "destino_nota", SCHEMA)
            except TransientError as e:
                await finish("QUEUED", f"IA instável, tentando de novo: {e}")
                raise RetryLater(int(e.retry_after or 60), str(e)) from e
            except PermanentError as e:
                data = {"itens": []}
                note_extra = f" (IA indisponível: {str(e)[:80]})"
            answers = {a["n"]: a for a in data.get("itens") or [] if isinstance(a, dict) and isinstance(a.get("n"), int)}
            for o in out:
                a = answers.get(o["n"]) if o["fonte"] == "ia" else None
                if a and a.get("destino") in DESTINOS:
                    o.update(destino=a["destino"], conta_codigo=a.get("conta_codigo"), confianca=round(max(0.0, min(1.0, float(a.get("confianca") or 0))), 2),
                             motivo=str(a.get("motivo") or "")[:200])
                elif o["fonte"] == "ia":
                    o.update(motivo="a IA não conseguiu decidir")

    for o in out:
        acc = account(o.get("conta_codigo"), o["destino"]) if o["destino"] in DEFAULT_ACCOUNT else None
        o["conta_id"], o["conta"] = (acc["id"], f"{acc['code']} · {acc['name']}") if acc else (None, None)
        o.pop("conta_codigo", None)

    dest, lines = summarize(out, total)
    for ln in lines:
        ln["conta"] = f"{acc_by_id[ln['chart_account_id']]['code']} · {acc_by_id[ln['chart_account_id']]['name']}"

    # já foi paga ou lançada? reembolsos e contas a pagar do mesmo CNPJ nos últimos 180 dias
    reimb = await fetch_all(deps.pool, """
        select r.id::text, r.number, r.purpose, r.status, r.total::float as total, sum(i.amount)::float as do_fornecedor
        from fin.reimbursements r join fin.reimbursement_items i on i.reimbursement_id = r.id
        where r.org_id = %s and r.status <> 'CANCELLED' and r.created_at > now() - interval '180 days'
          and regexp_replace(coalesce(i.supplier_doc, ''), '\\D', '', 'g') = %s
          and not exists (select 1 from fiscal.inbound_dfe x where x.id <> %s and r.id = any (x.reimbursement_ids))
        group by r.id order by r.number""", (org, cnpj, dfe_id)) if cnpj else []
    payables = await fetch_all(deps.pool, """
        select t.id::text, t.number, t.description, t.total_amount::float as total, t.approval_status,
               coalesce((select sum(amount_settled) from fin.title_installments where title_id = t.id), 0)::float as pago
        from fin.titles t join crm.parties p on p.id = t.party_id
        where t.org_id = %s and t.direction = 'PAYABLE' and t.status <> 'CANCELLED' and p.cnpj = %s and t.created_at > now() - interval '180 days'
          and coalesce(t.origin_type, '') <> 'INBOUND_NFE'
          and not exists (select 1 from fiscal.inbound_dfe x where x.id <> %s and x.destination_title_id = t.id)
        order by abs(t.total_amount - %s), t.created_at desc limit 5""", (org, cnpj, dfe_id, total)) if cnpj else []

    # já saiu do banco? linha do extrato pendente ou movimento lançado direto (sem conta a pagar), perto da emissão
    issued = str((nf.get("header") or {}).get("issue_at") or "")[:10] or None
    word = next((w for w in re.findall(r"[a-z]{4,}", norm(f"{(nf.get('issuer') or {}).get('fantasy') or ''} {d['issuer_name'] or ''}"))
                 if w not in ("ltda", "eireli", "comercio", "industria", "servicos", "brasil", "distribuidora")), None)
    like = f"%{word}%" if word else "%%-nada-%%"
    statement = await fetch_all(deps.pool, """
        select l.id::text, l.posted_on::text, l.amount::float as amount, coalesce(l.counterpart_name, '') || ' ' || coalesce(l.description, '') as descricao, b.name as banco
        from fin.statement_lines l join fin.bank_accounts b on b.id = l.bank_account_id
        where l.org_id = %(org)s and l.status = 'PENDING' and l.amount < 0
          and l.posted_on between coalesce(%(d)s::date, current_date) - 45 and coalesce(%(d)s::date, current_date) + 45
          and (abs(l.amount) = %(v)s or regexp_replace(coalesce(l.counterpart_doc, ''), '\\D', '', 'g') = %(cnpj)s
               or private.norm(coalesce(l.counterpart_name, '') || ' ' || coalesce(l.description, '')) like %(like)s)
          and not exists (select 1 from fiscal.inbound_dfe x where x.id <> %(id)s and x.statement_line_id = l.id)
        order by abs(abs(l.amount) - %(v)s), l.posted_on limit 5""", {"org": org, "d": issued, "v": total, "cnpj": cnpj, "like": like, "id": dfe_id})
    moves = await fetch_all(deps.pool, """
        select t.id::text, t.occurred_on::text, t.amount::float as amount, t.description as descricao, coalesce(c.code || ' · ' || c.name, '') as conta, b.name as banco
        from fin.cash_transactions t join fin.bank_accounts b on b.id = t.bank_account_id left join fin.chart_accounts c on c.id = t.chart_account_id
        where t.org_id = %(org)s and t.amount < 0 and not t.voided and t.settlement_id is null
          and t.occurred_on between coalesce(%(d)s::date, current_date) - 45 and coalesce(%(d)s::date, current_date) + 45
          and (t.party_id = %(party)s or private.norm(coalesce(t.description, '')) like %(like)s or (abs(t.amount) = %(v)s and t.party_id is null))
          and not exists (select 1 from fiscal.inbound_dfe x where x.id <> %(id)s and x.cash_transaction_id = t.id)
        order by abs(abs(t.amount) - %(v)s), t.occurred_on limit 5""", {"org": org, "d": issued, "v": total, "party": (party or {}).get("id"), "like": like, "id": dfe_id})

    alerts: list[str] = []
    no_charge = all(str(pg.get("t_pag")) == "90" for pg in (nf.get("payments") or [])) and bool(nf.get("payments"))
    if no_charge:
        alerts.append("A nota está sem cobrança (forma de pagamento 90): o pagamento foi feito por fora.")
    if reimb:
        paid = sum(Decimal(str(r["do_fornecedor"])) for r in reimb)
        alerts.append(f"Este fornecedor aparece em {len(reimb)} reembolso(s) ({', '.join(r['number'] for r in reimb)}): a nota provavelmente já foi paga do bolso — ligue a eles em vez de lançar outra conta.")
        if abs(paid - total) >= Decimal("0.01"):
            alerts.append(f"Os reembolsos somam R$ {paid:,.2f} e a nota R$ {total:,.2f}: confira se falta outra nota ou se o recibo inclui mais coisa.".replace(",", "X").replace(".", ",").replace("X", "."))
    brl = lambda v: f"R$ {v:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")   # noqa: E731
    same = lambda v: abs(abs(Decimal(str(v))) - total) < Decimal("0.01")                 # noqa: E731
    if payables:
        alerts.append("Já existe conta a pagar deste fornecedor: " + "; ".join(
            f"{t['number']} de {brl(t['total'])}{' (paga)' if t['pago'] >= t['total'] - 0.005 else ''}" for t in payables) + ". Se for a mesma compra, ligue a nota a ela.")
    if statement:
        alerts.append("O extrato tem saída(s) ainda não conciliada(s) que podem ser o pagamento desta nota: " + "; ".join(
            f"{brl(abs(x['amount']))} em {x['posted_on'][8:10]}/{x['posted_on'][5:7]} ({x['banco']})" for x in statement) + ".")
    if moves:
        alerts.append("Há movimento(s) já lançado(s) que podem ser o pagamento desta nota: " + "; ".join(
            f"{brl(abs(x['amount']))} em {x['occurred_on'][8:10]}/{x['occurred_on'][5:7]}{' · ' + x['conta'] if x['conta'] else ''}" for x in moves) + ".")
    kinds = {o["destino"] for o in out}
    if "ESTOQUE" in kinds and len(kinds - {"ESTOQUE"}) > 0:
        alerts.append("Nota mista: parte é mercadoria e parte não. Dê entrada no estoque e lance o restante à parte, ou classifique tudo aqui.")
    if any(o["destino"] == "INDEFINIDO" for o in out):
        alerts.append("Há item que nem as regras nem a IA souberam classificar: escolha o destino.")

    # o que já existe no financeiro manda na sugestão (nunca lançar a mesma compra duas vezes); senão, a classificação
    link: dict[str, Any] | None = None
    if dest == "STOCK":
        suggested = dest
    elif reimb:
        suggested = "REIMBURSED"
    elif (t := next((t for t in payables if same(t["total"])), None)):
        suggested, link = "PAYABLE", {"title_id": t["id"]}
    elif (x := next((x for x in statement if same(x["amount"])), None)):
        suggested, link = "PAID", {"statement_line_id": x["id"]}
    elif (x := next((x for x in moves if same(x["amount"])), None)):
        suggested, link = "PAID", {"cash_transaction_id": x["id"]}
    else:
        suggested = dest
    weights = [(o["confianca"], float(o["valor"])) for o in out]
    conf = round(sum(c * v for c, v in weights) / max(sum(v for _, v in weights), 0.01), 2) if weights else 0.0
    why = {
        "REIMBURSED": "paga pelos reembolsos " + ", ".join(r["number"] for r in reimb),
        "PAYABLE": "já lançada na conta a pagar " + next((t["number"] for t in payables if link and t["id"] == link.get("title_id")), ""),
        "PAID": "já paga pelo banco" + (" (extrato ainda não conciliado)" if link and link.get("statement_line_id") else " (movimento já lançado)"),
        "STOCK": "mercadoria para revenda: dê entrada no estoque",
        "ASSET": "patrimônio (" + ", ".join(sorted({o["conta"] or "" for o in out if o["destino"] == "PATRIMONIO"})) + ")",
        "EXPENSE": "despesa/consumo (" + ", ".join(sorted({o["conta"] or "" for o in out if o["destino"] in ("CONSUMO", "DESPESA")})) + ")",
    }.get(suggested, "a decidir")
    triage = {
        "destino": suggested, "classificacao": dest, "confianca": conf, "motivo": why, "linhas": lines, "alertas": alerts, "sem_cobranca": no_charge,
        "itens": [{**o, "valor": float(round(o["valor"], 2))} for o in out], "reembolsos": reimb, "contas": payables,
        "extrato": statement, "movimentos": moves, "vinculo": link,
    }
    await finish("SUGGESTED", f"Sugestão: {why}{note_extra}", triage)
    if suggested != "STOCK":
        await fetch_one(deps.pool, "select core.notify(%s, 'DFE_TRIAGE', %s, %s, 'fin.write') as n",
                        (org, f"Nota de {d['issuer_name']}: {why}", jb({"dfe_id": dfe_id, "access_key": d["access_key"]})))
    log.info("nota %s: %s (%s)", d["access_key"], suggested, why)
