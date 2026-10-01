import { describe, expect, it } from "vitest";
import { monthBounds, toCsv } from "./csv";

describe("toCsv", () => {
  const cols = [
    { header: "Nome", get: (r: { n: string }) => r.n },
    { header: "Valor", get: (r: { v: number | string | null }) => r.v, kind: "money" as const },
    { header: "Data", get: (r: { d: string }) => r.d, kind: "date" as const },
  ];
  it("usa ; , vírgula decimal, data brasileira, BOM e CRLF", () => {
    const out = toCsv([{ n: "Loja Centro", v: 1234.5, d: "2026-09-30T12:00:00Z" }], cols as never);
    expect(out).toBe("﻿Nome;Valor;Data\r\nLoja Centro;1234,50;30/09/2026\r\n");
  });
  it("protege contra fórmula e escapa aspas, ponto e vírgula e quebra de linha", () => {
    const out = toCsv([{ n: '=HYPERLINK("x")', v: null, d: "" }, { n: "A;B", v: "10", d: "" }, { n: "linha\n2", v: 0, d: "" }], cols as never);
    const lines = out.split("\r\n");
    expect(lines[1]).toBe("\"'=HYPERLINK(\"\"x\"\")\";;");
    expect(lines[2]).toBe('"A;B";10,00;');
    expect(out).toContain('"linha\n2";0,00;');
  });
  it("número negativo continua número (só texto vira fórmula)", () => {
    expect(toCsv([{ n: "x", v: -5, d: "" }], cols as never)).toContain("x;-5,00;");
    expect(toCsv([{ n: "-cuidado", v: 1, d: "" }], cols as never)).toContain("'-cuidado;1,00;");
  });
});

describe("monthBounds", () => {
  it("devolve o mês em horário de Brasília", () => {
    expect(monthBounds("2026-09")).toEqual({ from: "2026-09-01T00:00:00-03:00", to: "2026-10-01T00:00:00-03:00", fromDate: "2026-09-01", toDate: "2026-10-01", label: "09/2026" });
    expect(monthBounds("2026-12")?.toDate).toBe("2027-01-01");
  });
  it("recusa formato inválido", () => {
    expect(monthBounds("2026-13")).toBeNull();
    expect(monthBounds("setembro")).toBeNull();
  });
});
