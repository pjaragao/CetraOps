import { describe, expect, it } from "vitest";
import { docAmount, docCounterpart, docMissing, docReady } from "./doc-inbox";

describe("caixa de documentos", () => {
  const boleto = { kind: "boleto", destination: "PAYABLE", duplicate: null, fields: { beneficiario: "Energia SC", valor: 320.5, vencimento: "2026-11-10" } };

  it("lê valor e contraparte de qualquer tipo", () => {
    expect(docAmount(boleto.fields)).toBe(320.5);
    expect(docAmount({ valor_total: "2340.00" })).toBe(2340);
    expect(docAmount({})).toBeNull();
    expect(docCounterpart({ emitente: " Alfa " })).toBe("Alfa");
    expect(docCounterpart(null)).toBeNull();
  });

  it("boleto completo está pronto; sem vencimento, não", () => {
    expect(docReady(boleto)).toBe(true);
    expect(docMissing({ ...boleto, fields: { valor: 10 } })).toEqual(["vencimento"]);
  });

  it("XML vira conta a pagar sem vencimento (vêm as duplicatas) e só XML vai para o recebimento", () => {
    const xml = { kind: "nfe_xml", destination: "PAYABLE", duplicate: null, fields: { valor_total: "900.00" } };
    expect(docReady(xml)).toBe(true);
    expect(docMissing(xml, "RECEIPT")).toEqual([]);
    expect(docMissing({ ...boleto, destination: "RECEIPT" })).toEqual(["o recebimento precisa do XML da NF-e"]);
  });

  it("revisão e duplicado nunca entram no lote", () => {
    expect(docReady({ ...boleto, destination: "REVIEW" })).toBe(false);
    expect(docReady({ ...boleto, duplicate: { tipo: "Conta a pagar com o mesmo código de barras" } })).toBe(false);
  });

  it("reembolso precisa só do valor", () => {
    expect(docMissing({ kind: "nota_ou_recibo", destination: "REIMBURSEMENT", duplicate: null, fields: { valor_total: 0 } })).toEqual(["valor"]);
  });
});
