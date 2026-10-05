import { describe, expect, it } from "vitest";
import { fromBrasilApi, fromCnpjWs, fromOpenCnpj, fromReceitaWs, stateRegs, type CnpjRaw } from "./cnpj";
import fixtures from "./__fixtures__/cnpj-caixa.json";

/** Respostas reais (Caixa Econômica Federal, dados públicos da Receita) gravadas das quatro fontes gratuitas. */
const f = fixtures as unknown as Record<"brasilapi" | "cnpjws" | "opencnpj" | "receitaws", CnpjRaw>;

describe("normalização de CNPJ", () => {
  it.each([
    ["BrasilAPI", () => fromBrasilApi(f.brasilapi)],
    ["OpenCNPJ", () => fromOpenCnpj(f.opencnpj)],
    ["CNPJ.ws", () => fromCnpjWs(f.cnpjws)],
    ["ReceitaWS", () => fromReceitaWs(f.receitaws)],
  ])("%s vira o mesmo formato", (_name, run) => {
    const d = run();
    expect(d.cnpj).toBe("00360305000104");
    expect(d.legal_name).toBe("CAIXA ECONOMICA FEDERAL");
    expect(d.trade_name).toBe("CEF MATRIZ");
    expect(d.situation.toLowerCase()).toBe("ativa");
    expect(d.opened_at).toBe("1971-02-03");
    expect(d.cnae_main?.code).toBe("6423900");
    expect(d.address.cep).toBe("70092900");
    expect(d.address.uf).toBe("DF");
    expect(d.address.district).toBe("ASA SUL");
    expect(d.share_capital).toBe(112600000000);
    expect(d.simples).toBe(false);
    expect(d.partners.length).toBeGreaterThan(0);
  });

  it("BrasilAPI traz o regime tributário e o telefone sem o DDD 00", () => {
    const d = fromBrasilApi(f.brasilapi);
    expect(d.tax_regime).toBe("LUCRO REAL (2024)");   // o ano mais recente da lista
    expect(d.phones).toEqual(["40040104"]);
    expect(d.address.ibge).toBe("5300108");
    expect(d.branch).toBe("Matriz");
  });

  it("CNPJ.ws traz a inscrição estadual", () => {
    expect(stateRegs(f.cnpjws)).toEqual([{ ie: "0731282500175", uf: "DF", active: true }]);
  });

  it("resposta incompleta não quebra", () => {
    const d = fromBrasilApi({ cnpj: "11222333000181", razao_social: "X" });
    expect(d.legal_name).toBe("X");
    expect(d.cnae_main).toBeNull();
    expect(d.phones).toEqual([]);
    expect(d.partners).toEqual([]);
  });
});
