import { describe, expect, it } from "vitest";
import { dueRange, moneyMentions, normalizeSize, unverifiedAmounts } from "./assistant";

describe("Central: conferência de números", () => {
  it("lê valores em reais no formato brasileiro", () => {
    expect(moneyMentions("Total R$ 1.234,50; Pix de R$99 e R$ 12,5")).toEqual([1234.5, 99, 12.5]);
  });

  it("aceita só valores que vieram das ferramentas (ou a soma de dois deles)", () => {
    const tools = [{ items: [{ amount: "320.00" }, { amount: 920 }] }, { total: 834.3 }];
    expect(unverifiedAmounts("Vencem hoje R$ 320,00 e R$ 920,00 (R$ 1.240,00 no total). Venda de R$ 834,30.", tools)).toEqual([]);
    expect(unverifiedAmounts("Você economiza R$ 50,00", tools)).toEqual([50]);
  });
});

describe("Central: períodos e tamanhos", () => {
  const now = new Date("2026-10-05T15:00:00Z");
  it("contas de hoje, da semana e vencidas no fuso de São Paulo", () => {
    expect(dueRange("hoje", now)).toEqual({ from: "2026-10-05", to: "2026-10-05" });
    expect(dueRange("semana", now)).toEqual({ from: "2026-10-05", to: "2026-10-11" });
    expect(dueRange("vencidas", now)).toEqual({ from: null, to: "2026-10-04" });
    expect(dueRange("mes", now)).toEqual({ from: "2026-10-05", to: "2026-10-31" });
  });

  it("tamanhos falados viram os do catálogo", () => {
    expect(normalizeSize("tamanho 4")).toBe("4");
    expect(normalizeSize("gêgê")).toBe("GG");
    expect(normalizeSize("m")).toBe("M");
    expect(normalizeSize("")).toBeNull();
  });
});
