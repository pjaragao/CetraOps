import { describe, expect, it } from "vitest";
import { acquirerCsvTemplate, parseAcquirerCsv, parseAcquirerDate, parseAcquirerMoney } from "./acquirer-csv";

describe("parseAcquirerMoney / parseAcquirerDate", () => {
  it("entende o formato brasileiro e o internacional", () => {
    expect(parseAcquirerMoney("1.234,56")).toBe(1234.56);
    expect(parseAcquirerMoney("R$ 99,90")).toBe(99.9);
    expect(parseAcquirerMoney("1234.56")).toBe(1234.56);
    expect(parseAcquirerMoney("")).toBeNull();
    expect(parseAcquirerMoney("abc")).toBeNull();
  });
  it("datas em horário de Brasília quando não há fuso", () => {
    expect(parseAcquirerDate("30/09/2026 14:32")).toBe("2026-09-30T14:32:00-03:00");
    expect(parseAcquirerDate("30/09/2026", true)).toBe("2026-09-30");
    expect(parseAcquirerDate("2026-09-30T14:32:00Z")).toBe("2026-09-30T14:32:00Z");
    expect(parseAcquirerDate("31/13/2026")).toBeNull();
    expect(parseAcquirerDate("ontem")).toBeNull();
  });
});

describe("parseAcquirerCsv", () => {
  it("o modelo para download é lido sem erro: 1 transação, 2 parcelas, 2 repasses", () => {
    const r = parseAcquirerCsv(acquirerCsvTemplate());
    expect(r.errors).toEqual([]);
    expect(r.transactions).toHaveLength(1);
    expect(r.transactions[0]).toMatchObject({ external_id: "ST-0001", method: "CREDIT", installments: 2, gross: 300, mdr_fee: 5.1, nsu: "123456" });
    expect(r.transactions[0].receivables.map((x) => [x.n, x.net, x.payout_external_id])).toEqual([[1, 147.45, "REP-2026-10-30"], [2, 147.45, "REP-2026-11-29"]]);
    expect(r.payouts).toEqual([{ external_id: "REP-2026-10-30", paid_on: "2026-10-30", amount: 147.45 }, { external_id: "REP-2026-11-29", paid_on: "2026-11-29", amount: 147.45 }]);
  });
  it("aceita vírgula como separador e soma as taxas das parcelas quando a transação não traz o total", () => {
    const csv = "codigo,data_hora,forma,valor_bruto,parcela,bruto_parcela,mdr_parcela,repasse,data_repasse\nA1,2026-09-30 10:00,debito,\"100,00\",1,\"100,00\",\"0,89\",R1,01/10/2026\n";
    const r = parseAcquirerCsv(csv);
    expect(r.errors).toEqual([]);
    expect(r.transactions[0]).toMatchObject({ method: "DEBIT", mdr_fee: 0.89 });
    expect(r.payouts).toEqual([{ external_id: "R1", paid_on: "2026-10-01", amount: 99.11 }]);
  });
  it("aponta a linha e o motivo de cada problema", () => {
    expect(parseAcquirerCsv("codigo;forma\nA;PIX").errors[0]).toContain("data_hora");
    const r = parseAcquirerCsv("codigo;data_hora;forma;valor_bruto\n;30/09/2026;PIX;10\nB;30/09/2026 10:00;BOLETO;10\nC;30/09/2026 10:00;PIX;0\n");
    expect(r.errors).toEqual(["Linha 2: sem código da transação.", "Linha 3: forma “BOLETO” inválida (PIX, DEBITO ou CREDITO).", "Linha 4: valor_bruto inválido."]);
    expect(r.transactions).toEqual([]);
  });
  it("repasse sem data é erro", () => {
    const r = parseAcquirerCsv("codigo;data_hora;forma;valor_bruto;parcela;bruto_parcela;repasse\nA;30/09/2026 10:00;CREDITO;10;1;10;R9\n");
    expect(r.errors).toEqual(["Repasse R9: falta data_repasse."]);
  });
});
