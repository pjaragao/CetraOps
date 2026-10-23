"""Triagem da NF-e recebida: o XML chegando põe a nota na fila; regras decidem o que dá (cabide → patrimônio), a IA (simulada)
só vê o resto; o cruzamento com reembolsos do mesmo CNPJ sugere ligar a nota a eles; confirmar cria a conta a pagar em rascunho
já classificada (ou liga aos reembolsos) e desfazer volta tudo."""
from __future__ import annotations

import dataclasses
import json
import uuid
from typing import Any

import pytest

from centralops_worker import queues
from centralops_worker.db import fetch_all, fetch_one
from centralops_worker.deps import Deps
from centralops_worker.handlers import ai_tasks
from centralops_worker.handlers.dfe_triage import rule_for

from .conftest import ORG

pytestmark = pytest.mark.db
LE = "00000000-0000-4000-8000-0000000000e1"
CNPJ = "11222333000181"


class FakeLLM:
    def __init__(self, answer: dict[str, Any]) -> None:
        self.answer, self.calls = answer, []

    async def complete_json(self, org_id: str, task: str, messages: list[dict[str, str]], schema_name: str, schema: dict[str, Any]) -> dict[str, Any]:
        self.calls.append((task, messages))
        return self.answer


def _key(n: int) -> str:
    base = f"352610{CNPJ}55001{n:09d}112345678"            # UF, ano/mês, CNPJ, modelo 55, série 1, número, emissão normal, código
    total, w = 0, 2
    for c in reversed(base):
        total, w = total + int(c) * w, (w + 1 if w < 9 else 2)
    dv = 11 - total % 11
    return base + str(0 if dv >= 10 else dv)


def _xml(n: int, items: list[tuple[str, str, float]]) -> tuple[str, str, float]:
    key, total = _key(n), sum(v for _, _, v in items)
    dets = "".join(
        f'<det nItem="{i}"><prod><cProd>T{i}</cProd><cEAN>SEM GTIN</cEAN><xProd>{d}</xProd><NCM>{ncm}</NCM><CFOP>6102</CFOP><uCom>UN</uCom>'
        f"<qCom>1.0000</qCom><vUnCom>{v:.2f}</vUnCom><vProd>{v:.2f}</vProd><indTot>1</indTot></prod>"
        f"<imposto><ICMS><ICMSSN102><orig>0</orig><CSOSN>400</CSOSN></ICMSSN102></ICMS></imposto></det>"
        for i, (d, ncm, v) in enumerate(items, start=1))
    xml = (f'<nfeProc versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe"><NFe><infNFe versao="4.00" Id="NFe{key}"><ide><cUF>35</cUF><cNF>12345678</cNF>'
           f"<natOp>VENDA DE MERCADORIA</natOp><mod>55</mod><serie>1</serie><nNF>{n}</nNF><dhEmi>2026-10-21T20:53:30-03:00</dhEmi><tpNF>1</tpNF>"
           f"<tpAmb>1</tpAmb><finNFe>1</finNFe></ide><emit><CNPJ>{CNPJ}</CNPJ><xNome>CABIDES TESTE LTDA</xNome><xFant>CABIDES TESTE</xFant>"
           f"<enderEmit><xMun>Sao Paulo</xMun><UF>SP</UF></enderEmit><IE>1</IE><CRT>1</CRT></emit><dest><CNPJ>69510606000173</CNPJ><xNome>LOJA</xNome></dest>{dets}"
           f"<total><ICMSTot><vProd>{total:.2f}</vProd><vFrete>0.00</vFrete><vSeg>0.00</vSeg><vDesc>0.00</vDesc><vIPI>0.00</vIPI><vOutro>0.00</vOutro><vNF>{total:.2f}</vNF></ICMSTot></total>"
           f"<pag><detPag><tPag>90</tPag><vPag>0.00</vPag></detPag></pag></infNFe></NFe></nfeProc>")
    return key, xml, total


async def _dfe(pool: Any, n: int, items: list[tuple[str, str, float]]) -> str:
    key, xml, total = _xml(n, items)
    row = await fetch_one(pool, """insert into fiscal.inbound_dfe (org_id, legal_entity_id, access_key, issuer_cnpj, issuer_name, amount, manifest_status)
                                   values (%s, %s, %s, %s, 'CABIDES TESTE', %s, 'CONFIRMADA') returning id::text""", (ORG, LE, key, CNPJ, total))
    assert row
    await fetch_one(pool, "update fiscal.inbound_dfe set xml = %s, xml_downloaded = true where id = %s returning id", (xml, row["id"]))   # a SEFAZ entregou o XML
    return row["id"]


async def _as_partner(pool: Any) -> None:
    await fetch_one(pool, """select set_config('request.jwt.claims', json_build_object('sub', m.user_id, 'role', 'authenticated',
                               'app_metadata', json_build_object('org_id', m.org_id, 'member_id', m.id))::text, true) as c
                             from core.members m where m.user_id = '00000000-0000-4000-8000-0000000000f1'""")


def test_rules() -> None:
    assert rule_for("44211000", "Cabide de acrilico com presilhas ja personalizado")["conta_codigo"] == "1.2.1.04"   # type: ignore[index]
    assert rule_for("61046200", "Legging suplex preta M")["destino"] == "ESTOQUE"                                     # type: ignore[index]
    assert rule_for("94036000", "Arara de chão cabideiro de metal")["conta_codigo"] == "1.2.1.02"                     # type: ignore[index]
    assert rule_for("48192000", "Sacola kraft personalizada")["destino"] == "CONSUMO"                                 # type: ignore[index]
    assert rule_for("00000000", "Serviço de instalação") is None                                                      # sem regra: vai para a IA
    assert rule_for("61091000", "Camiseta para manequim") is None                                                     # regras se contradizem: IA decide


async def test_triage_rules_ai_apply_and_reopen(pool: Any, deps: Deps) -> None:
    dfe = await _dfe(pool, 901, [("Cabide de acrilico com presilhas ja personalizado", "44211000", 900.0), ("Servico de instalacao eletrica na loja", "00000000", 100.0)])
    st = await fetch_one(pool, "select triage_status from fiscal.inbound_dfe where id = %s", (dfe,))
    assert st and st["triage_status"] == "QUEUED"                                                    # o XML chegou: entrou na fila sozinho
    q = await fetch_one(pool, "select count(*) as n from pgmq.q_ai_tasks where message ->> 'action' = 'DFE_TRIAGE' and message ->> 'dfe_id' = %s", (dfe,))
    assert q and q["n"] == 1

    llm = FakeLLM({"itens": [{"n": 2, "destino": "DESPESA", "conta_codigo": "7.2.15", "confianca": 0.8, "motivo": "serviço de montagem"}]})
    await ai_tasks.handle(dataclasses.replace(deps, llm=llm), queues.QueueMessage("ai_tasks", 1, 1, {"action": "DFE_TRIAGE", "org_id": ORG, "dfe_id": dfe}))
    assert len(llm.calls) == 1 and "Servico de instalacao" in llm.calls[0][1][1]["content"] and "Cabide de acrilico" not in llm.calls[0][1][1]["content"]   # a IA só vê o que a regra não decidiu
    d = await fetch_one(pool, "select triage_status, triage from fiscal.inbound_dfe where id = %s", (dfe,))
    assert d and d["triage_status"] == "SUGGESTED"
    t = d["triage"]
    assert t["destino"] == "ASSET" and t["sem_cobranca"] is True
    assert [(i["destino"], i["fonte"]) for i in t["itens"]] == [("PATRIMONIO", "regra"), ("DESPESA", "ia")]
    assert sorted((ln["conta"][:8], ln["amount"]) for ln in t["linhas"]) == [("1.2.1.04", 900.0), ("7.2.15 ·", 100.0)]
    n = await fetch_one(pool, "select count(*) as n from core.notifications where kind = 'DFE_TRIAGE' and payload ->> 'dfe_id' = %s", (dfe,))
    assert n and n["n"] >= 1                                                                          # quem cuida do financeiro é avisado

    # confirmar é da pessoa: conta a pagar em rascunho, classificada, e a NF-e entra no fiscal
    await _as_partner(pool)
    res = await fetch_one(pool, "select fiscal.apply_dfe_destination(%s, %s::jsonb) as r", (dfe, '{"destination": "ASSET", "lines": ' + json.dumps(t["linhas"]) + "}"))
    assert res and res["r"]["destination"] == "ASSET" and res["r"]["title_id"]
    title = await fetch_one(pool, "select approval_status, total_amount::float as total, origin_type from fin.titles where id = %s", (res["r"]["title_id"],))
    assert title and title["approval_status"] == "DRAFT" and title["total"] == 1000.0 and title["origin_type"] == "INBOUND_NFE"
    lines = await fetch_all(pool, "select c.code, l.amount::float as amount from fin.title_lines l join fin.chart_accounts c on c.id = l.chart_account_id where l.title_id = %s order by c.code", (res["r"]["title_id"],))
    assert [(r["code"], r["amount"]) for r in lines] == [("1.2.1.04", 900.0), ("7.2.15", 100.0)]
    doc = await fetch_one(pool, "select document_id, destination from fiscal.inbound_dfe where id = %s", (dfe,))
    assert doc and doc["document_id"] and doc["destination"] == "ASSET"
    pref = await fetch_one(pool, "select preferences -> 'nfe_destino' ->> 'destination' as d from crm.parties where cnpj = %s", (CNPJ,))
    assert pref and pref["d"] == "ASSET"                                                              # o fornecedor aprende o destino

    # desfazer enquanto a conta é rascunho: cancela a conta e tira o documento fiscal
    await fetch_one(pool, "select fiscal.reopen_dfe_destination(%s) as r", (dfe,))
    back = await fetch_one(pool, "select destination, document_id, triage_status from fiscal.inbound_dfe where id = %s", (dfe,))
    assert back and back["destination"] is None and back["document_id"] is None and back["triage_status"] == "SUGGESTED"
    cancelled = await fetch_one(pool, "select status from fin.titles where id = %s", (res["r"]["title_id"],))
    assert cancelled and cancelled["status"] == "CANCELLED"


async def test_paid_by_reimbursement_is_linked_not_charged_twice(pool: Any, deps: Deps) -> None:
    party = await fetch_one(pool, "select id from crm.parties where org_id = %s and kind = 'PERSON' order by created_at limit 1", (ORG,))
    assert party
    rid = str(uuid.uuid4())
    await fetch_one(pool, """insert into fin.reimbursements (id, org_id, number, legal_entity_id, party_id, purpose, status, total)
                             values (%s, %s, 'REE-T-0001', %s, %s, 'Cabides customizados', 'SUBMITTED', 1800) returning id""", (rid, ORG, LE, party["id"]))
    await fetch_one(pool, """insert into fin.reimbursement_items (org_id, reimbursement_id, position, spent_on, description, supplier_doc, supplier_name, document_kind, amount)
                             values (%s, %s, 1, current_date, 'Cabides', %s, 'CABIDES TESTE', 'RECIBO', 1800) returning id""", (ORG, rid, CNPJ))
    dfe = await _dfe(pool, 902, [("Cabide de acrilico com presilhas ja personalizado", "44211000", 900.0)])
    llm = FakeLLM({"itens": []})
    await ai_tasks.handle(dataclasses.replace(deps, llm=llm), queues.QueueMessage("ai_tasks", 1, 1, {"action": "DFE_TRIAGE", "org_id": ORG, "dfe_id": dfe}))
    assert llm.calls == []                                                                            # tudo decidido por regra: nem chamou a IA
    t = (await fetch_one(pool, "select triage from fiscal.inbound_dfe where id = %s", (dfe,)) or {})["triage"]
    assert t["destino"] == "REIMBURSED" and t["classificacao"] == "ASSET" and [r["number"] for r in t["reembolsos"]] == ["REE-T-0001"]
    assert any("somam R$ 1.800,00 e a nota R$ 900,00" in a for a in t["alertas"])

    await _as_partner(pool)
    res = await fetch_one(pool, "select fiscal.apply_dfe_destination(%s, %s::jsonb) as r",
                          (dfe, '{"destination": "REIMBURSED", "reimbursement_ids": ["' + rid + '"], "lines": [{"chart_account_id": "' + t["linhas"][0]["chart_account_id"] + '", "amount": 900}]}'))
    assert res and res["r"]["destination"] == "REIMBURSED" and res["r"]["title_id"] is None             # nenhuma conta nova: já foi paga
    linked = await fetch_one(pool, "select reimbursement_ids::text[] as ids from fiscal.inbound_dfe where id = %s", (dfe,))
    assert linked and linked["ids"] == [rid]
    item = await fetch_one(pool, "select c.code from fin.reimbursement_items i join fin.chart_accounts c on c.id = i.chart_account_id where i.reimbursement_id = %s", (rid,))
    assert item and item["code"] == "1.2.1.04"                                                        # o item do reembolso ficou classificado como patrimônio


async def _supplier(pool: Any) -> str:
    row = await fetch_one(pool, "insert into crm.parties (org_id, kind, display_name, cnpj) values (%s, 'COMPANY', 'CABIDES TESTE', %s) returning id::text", (ORG, CNPJ))
    assert row
    return row["id"]


async def _triage(pool: Any, deps: Deps, dfe: str) -> dict[str, Any]:
    await ai_tasks.handle(dataclasses.replace(deps, llm=FakeLLM({"itens": []})), queues.QueueMessage("ai_tasks", 1, 1, {"action": "DFE_TRIAGE", "org_id": ORG, "dfe_id": dfe}))
    return (await fetch_one(pool, "select triage from fiscal.inbound_dfe where id = %s", (dfe,)) or {})["triage"]


async def test_existing_payable_is_linked_not_duplicated(pool: Any, deps: Deps) -> None:
    party = await _supplier(pool)
    title = await fetch_one(pool, """select (private.insert_title(jsonb_build_object('direction', 'PAYABLE', 'legal_entity_id', %s::uuid, 'party_id', %s::uuid, 'description', 'Cabides (lançado à mão)',
                                       'installments', jsonb_build_array(jsonb_build_object('due_date', current_date, 'amount', 900))), null)).id::text as id""", (LE, party))
    assert title
    dfe = await _dfe(pool, 903, [("Cabide de acrilico com presilhas ja personalizado", "44211000", 900.0)])
    t = await _triage(pool, deps, dfe)
    assert t["destino"] == "PAYABLE" and t["vinculo"] == {"title_id": title["id"]} and t["classificacao"] == "ASSET"
    assert any("Já existe conta a pagar" in a for a in t["alertas"])

    await _as_partner(pool)
    res = await fetch_one(pool, "select fiscal.apply_dfe_destination(%s, %s::jsonb) as r", (dfe, json.dumps({"destination": "PAYABLE", "title_id": title["id"]})))
    assert res and res["r"]["title_id"] == title["id"]                                                # a nota vira o documento da conta que já existia
    doc = await fetch_one(pool, "select document_kind, document_number, (select count(*) from fin.titles where origin_id = %s) as novas from fin.titles where id = %s", (dfe, title["id"]))
    assert doc and doc["document_kind"] == "NF-e" and doc["document_number"] == "903" and doc["novas"] == 0
    await fetch_one(pool, "select fiscal.reopen_dfe_destination(%s) as r", (dfe,))
    still = await fetch_one(pool, "select status from fin.titles where id = %s", (title["id"],))
    assert still and still["status"] == "OPEN"                                                        # desfazer só desliga: a conta antiga continua


async def test_bank_statement_line_is_reconciled_as_payment(pool: Any, deps: Deps) -> None:
    await _supplier(pool)
    line = await fetch_one(pool, """insert into fin.statement_lines (org_id, legal_entity_id, bank_account_id, posted_on, amount, description, dedupe_key)
                                    values (%s, %s, '00000000-0000-4000-8000-000000000701', '2026-10-21', -900, 'PIX ENVIADO CABIDES TESTE LTDA', 'teste-dfe-904') returning id::text""", (ORG, LE))
    assert line
    dfe = await _dfe(pool, 904, [("Cabide de acrilico com presilhas ja personalizado", "44211000", 900.0)])
    t = await _triage(pool, deps, dfe)
    assert t["destino"] == "PAID" and t["vinculo"] == {"statement_line_id": line["id"]}
    assert any("extrato tem saída" in a for a in t["alertas"])

    await _as_partner(pool)
    res = await fetch_one(pool, "select fiscal.apply_dfe_destination(%s, %s::jsonb) as r",
                          (dfe, json.dumps({"destination": "PAID", "statement_line_id": line["id"], "lines": t["linhas"]})))
    assert res and res["r"]["destination"] == "PAID" and res["r"]["title_id"] is None
    tx = await fetch_one(pool, """select c.code, t.amount::float as amount, (select count(*) from fin.reconciliation_links where statement_line_id = %s) as links
                                  from fiscal.inbound_dfe d join fin.cash_transactions t on t.id = d.cash_transaction_id join fin.chart_accounts c on c.id = t.chart_account_id
                                  where d.id = %s""", (line["id"], dfe))
    assert tx and tx["code"] == "1.2.1.04" and tx["amount"] == -900.0 and tx["links"] == 1          # o Pix do extrato virou o pagamento, classificado como patrimônio
    with pytest.raises(Exception, match="estorne o movimento"):
        await fetch_one(pool, "select fiscal.reopen_dfe_destination(%s) as r", (dfe,))
