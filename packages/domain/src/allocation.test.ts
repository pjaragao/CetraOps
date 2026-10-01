import { describe, expect, it } from "vitest";
import { allocateOldestFirst, cashEffect, findExactCombination, kindsFor, lateCharges, netCash } from "./allocation";
import { parseBankCsv, parseDate, parseMoney, parseOfx, parseStatement } from "./statement";

describe("rateio na baixa", () => {
  it("soma o movimento líquido: principal + juros − desconto", () => {
    expect(netCash([
      { kind: "PRINCIPAL", amount: 1000 }, { kind: "PRINCIPAL", amount: 650 },
      { kind: "INTEREST", amount: 10 }, { kind: "DISCOUNT", amount: 5 },
    ])).toBe(1655);
  });
  it("recebimento de cartão: taxa reduz o que entra no banco", () => {
    expect(netCash([{ kind: "PRINCIPAL", amount: 159.33 }, { kind: "FEE", amount: 7.5 }])).toBe(151.83);
    expect(cashEffect("WITHHOLDING", 15)).toBe(-15);
    expect(cashEffect("ADVANCE", 50)).toBe(50);
  });
  it("tarifa só existe em pagamento e taxa só em recebimento", () => {
    expect(kindsFor("PAYABLE")).not.toContain("FEE");
    expect(kindsFor("PAYABLE")).toContain("CHARGE");
    expect(kindsFor("RECEIVABLE")).not.toContain("CHARGE");
    expect(kindsFor("RECEIVABLE")).toContain("FEE");
  });
  it("distribui o valor pelas parcelas mais antigas e devolve a sobra", () => {
    const items = [
      { id: "b", balance: 300, due_date: "2026-11-10" },
      { id: "a", balance: 500, due_date: "2026-11-01" },
      { id: "c", balance: 200, due_date: "2026-11-20" },
    ];
    expect(allocateOldestFirst(700, items)).toEqual({ byId: { a: 500, b: 200 }, rest: 0 });
    expect(allocateOldestFirst(1100, items)).toEqual({ byId: { a: 500, b: 300, c: 200 }, rest: 100 });
  });
  it("acha a combinação exata de parcelas para o valor do extrato", () => {
    const items = [
      { id: "p1", amount: 159.33, due_date: "2026-10-30" },
      { id: "p2", amount: 159.33, due_date: "2026-11-29" },
      { id: "p3", amount: 159.34, due_date: "2026-12-29" },
      { id: "x", amount: 87.9, due_date: "2026-10-31" },
    ];
    expect(findExactCombination(318.66, items)?.sort()).toEqual(["p1", "p2"]);
    expect(findExactCombination(478, items)?.sort()).toEqual(["p1", "p2", "p3"]);
    expect(findExactCombination(87.9, items)).toEqual(["x"]);
    expect(findExactCombination(1, items)).toBeNull();
  });
  it("prefere as parcelas mais antigas quando há mais de uma solução", () => {
    const items = [
      { id: "novo", amount: 100, due_date: "2026-12-01" },
      { id: "velho", amount: 100, due_date: "2026-10-01" },
    ];
    expect(findExactCombination(100, items)).toEqual(["velho"]);
  });
  it("sugere multa e juros de atraso (2% + 1% ao mês pro rata)", () => {
    expect(lateCharges(6000, 0)).toEqual({ fine: 0, interest: 0 });
    expect(lateCharges(6000, 15)).toEqual({ fine: 120, interest: 30 });
  });
});

describe("extratos bancários", () => {
  it("interpreta valores e datas em formatos brasileiros", () => {
    expect(parseMoney("R$ 1.234,56")).toBe(1234.56);
    expect(parseMoney("-1.234,56")).toBe(-1234.56);
    expect(parseMoney("(45,90)")).toBe(-45.9);
    expect(parseMoney("1234.50")).toBe(1234.5);
    expect(parseMoney("abc")).toBeNull();
    expect(parseDate("20261005120000[-3:BRT]")).toBe("2026-10-05");
    expect(parseDate("05/10/2026")).toBe("2026-10-05");
    expect(parseDate("2026-10-05T10:00:00Z")).toBe("2026-10-05");
  });

  it("lê OFX v1 (SGML) com Pix, tarifa e saldo", () => {
    const ofx = `OFXHEADER:100\nDATA:OFXSGML\n\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
<DTSTART>20261001<DTEND>20261031
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261005120000[-3:BRT]<TRNAMT>-1655.00<FITID>202610050001<MEMO>PIX ENVIADO CONFECCOES AURORA 45723174000110 E18236120202610051200abcdefghijk
</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261006<TRNAMT>200,00<FITID>202610060002<NAME>CLIENTE TESTE<MEMO>PIX RECEBIDO
</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261007<TRNAMT>-12.50<FITID>202610070003<MEMO>TARIFA PIX
</STMTTRN>
</BANKTRANLIST><LEDGERBAL><BALAMT>48532.50<DTASOF>20261031</LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
    const r = parseOfx(ofx);
    expect(r.lines).toHaveLength(3);
    expect(r.lines[0]).toMatchObject({ posted_on: "2026-10-05", amount: -1655, external_id: "202610050001", counterpart_doc: "45723174000110" });
    expect(r.lines[0].e2e_id).toBe("E18236120202610051200abcdefghijk");
    expect(r.lines[1]).toMatchObject({ amount: 200, counterpart_name: "CLIENTE TESTE" });
    expect(r.closing_balance).toBe(48532.5);
    expect(r.period_start).toBe("2026-10-01");
    expect(parseStatement("extrato.ofx", ofx).source).toBe("OFX");
  });

  it("lê CSV do Inter com resumo antes do cabeçalho", () => {
    const csv = `Extrato Conta Corrente\nPeríodo;01/10/2026 a 31/10/2026\n\nData Lançamento;Histórico;Descrição;Valor;Saldo\n05/10/2026;Pix enviado;CONFECCOES AURORA;-1.655,00;48.345,00\n06/10/2026;Pix recebido;CLIENTE TESTE;200,00;48.545,00\n`;
    const r = parseBankCsv(csv);
    expect(r.lines).toHaveLength(2);
    expect(r.lines[0]).toMatchObject({ posted_on: "2026-10-05", amount: -1655, balance_after: 48345 });
    expect(r.lines[0].description).toContain("CONFECCOES AURORA");
  });

  it("lê CSV do Mercado Pago (vírgula, valores com ponto)", () => {
    const csv = `RELEASE_DATE,TRANSACTION_TYPE,REFERENCE_ID,TRANSACTION_NET_AMOUNT,PARTIAL_BALANCE\n2026-10-05T10:00:00Z,Liberação de dinheiro,987654,455.50,1200.00\n2026-10-06T09:00:00Z,Pagamento,123456,-30.00,1170.00\n`;
    const r = parseBankCsv(csv);
    expect(r.lines).toHaveLength(2);
    expect(r.lines[0]).toMatchObject({ posted_on: "2026-10-05", amount: 455.5, external_id: "987654" });
    expect(r.lines[1].amount).toBe(-30);
  });

  it("lê CSV com colunas separadas de débito e crédito", () => {
    const csv = `Data;Descrição;Débito;Crédito;Saldo\n05/10/2026;TED enviada;1.000,00;;9.000,00\n06/10/2026;Pix recebido;;250,00;9.250,00\n`;
    const r = parseBankCsv(csv);
    expect(r.lines.map((l) => l.amount)).toEqual([-1000, 250]);
  });

  it("avisa quando o cabeçalho não é reconhecido", () => {
    expect(parseBankCsv("a;b\n1;2").warnings[0]).toMatch(/Cabeçalho/);
  });
});
