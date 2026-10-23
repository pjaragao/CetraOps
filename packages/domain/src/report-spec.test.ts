import { describe, expect, it } from "vitest";
import { describeSpec, filterOpsFor, normalizeSpec, type ReportDataset } from "./report-spec";

const vendas: ReportDataset = {
  key: "pedidos", label: "Vendas (pedidos)", description: "", area: "Vendas", perm: "sales.read", date_label: "data do pedido", has_period: true, has_store: true,
  fields: [
    { key: "canal", label: "Canal", role: "dimension", type: "text", description: null },
    { key: "mes", label: "Mês", role: "dimension", type: "month", description: null },
    { key: "dia", label: "Dia", role: "dimension", type: "date", description: null },
    { key: "com_ia", label: "Atendido com IA", role: "dimension", type: "boolean", description: null },
    { key: "receita", label: "Receita", role: "measure", type: "money", description: null },
    { key: "pedidos", label: "Pedidos", role: "measure", type: "number", description: null },
  ],
};

describe("normalizeSpec", () => {
  it("mantém um roteiro válido e completa o limite padrão", () => {
    const { spec, problems } = normalizeSpec({ dataset: "pedidos", dimensions: ["canal"], measures: ["receita"], sort: { field: "receita", dir: "desc" } }, [vendas]);
    expect(problems).toEqual([]);
    expect(spec).toEqual({ dataset: "pedidos", dimensions: ["canal"], measures: ["receita"], filters: [], sort: { field: "receita", dir: "desc" }, limit: 500 });
  });

  it("recusa fonte que a pessoa não vê", () => {
    const r = normalizeSpec({ dataset: "contas", measures: ["valor"] }, [vendas]);
    expect(r.spec).toBeNull();
    expect(r.problems[0]).toContain("contas");
  });

  it("tira campos inventados, papel errado e repetidos, e explica", () => {
    const { spec, problems } = normalizeSpec({ dataset: "pedidos", dimensions: ["canal", "canal", "receita", "o.total"], measures: ["pedidos", "lucro"] }, [vendas]);
    expect(spec?.dimensions).toEqual(["canal"]);
    expect(spec?.measures).toEqual(["pedidos"]);
    expect(problems).toHaveLength(3);
  });

  it("valida operador e valor do filtro pelo tipo do campo", () => {
    const { spec, problems } = normalizeSpec({
      dataset: "pedidos", measures: ["receita"],
      filters: [
        { field: "canal", op: "in", values: ["WhatsApp", "", "WhatsApp"] },
        { field: "canal", op: "gt", value: "a" },
        { field: "receita", op: "gte", value: "100,50" },
        { field: "receita", op: "gt", value: "muito" },
        { field: "dia", op: "lt", value: "10/10/2026" },
        { field: "mes", op: "eq", value: "2026-10" },
        { field: "com_ia", op: "eq", value: true },
        { field: "canal", op: "empty", value: "ignorado" },
      ],
    }, [vendas]);
    expect(spec?.filters).toEqual([
      { field: "canal", op: "in", values: ["WhatsApp"] },
      { field: "receita", op: "gte", value: "100,50" },
      { field: "mes", op: "eq", value: "2026-10" },
      { field: "com_ia", op: "eq", value: "true" },
      { field: "canal", op: "empty" },
    ]);
    expect(problems).toHaveLength(3);
  });

  it("ordem só por campo do relatório; limite entre 1 e 5000; use_period só quando falso", () => {
    const { spec } = normalizeSpec({ dataset: "pedidos", dimensions: ["canal"], sort: { field: "receita" }, limit: 99999, use_period: false }, [vendas]);
    expect(spec?.sort).toBeNull();
    expect(spec?.limit).toBe(5000);
    expect(spec?.use_period).toBe(false);
  });

  it("sem campo nenhum não é relatório", () => {
    expect(normalizeSpec({ dataset: "pedidos", dimensions: [], measures: [] }, [vendas]).spec).toBeNull();
  });
});

describe("apoio da tela", () => {
  it("operadores por tipo", () => {
    expect(filterOpsFor("boolean")).toEqual(["eq", "neq"]);
    expect(filterOpsFor("text")).toContain("contains");
    expect(filterOpsFor("money")).not.toContain("contains");
  });
  it("descreve o relatório", () => {
    expect(describeSpec({ dataset: "pedidos", dimensions: ["canal", "mes"], measures: ["receita", "pedidos"], filters: [] }, vendas)).toBe("Receita, Pedidos por canal, mês");
  });
});
