import { describe, expect, it } from "vitest";
import { CAMPAIGN_PRESETS, describeAudience, isEmptyAudience, presetByKey, suggestVariables } from "./campaigns";

describe("descrição do público", () => {
  it("fala em português claro", () => {
    expect(describeAudience({ lifecycle: ["CUSTOMER", "VIP"], inactive_days: 60, inactive_max_days: 180 })).toEqual(["Etapa: clientes ou VIPs", "Sem comprar há 60 a 180 dias"]);
    expect(describeAudience({ never_bought: true, created_within_days: 30, sources: ["instagram"] })).toEqual(["Nunca comprou", "Entrou há até 30 dias", "Origem: instagram"]);
    expect(describeAudience({ spent_min: 500, period_days: 90 })).toEqual(["Gastou nos últimos 90 dias: a partir de R$ 500"]);
  });
  it("mostra a exclusão", () => {
    expect(describeAudience({ tiers: ["VIP"], exclude: { bought_within_days: 30 } })).toEqual(["Nível: VIP", "Exceto: comprou nos últimos 30 dias"]);
  });
  it("filtros vazios ou em branco não contam", () => {
    expect(isEmptyAudience({})).toBe(true);
    expect(isEmptyAudience({ tags: [], min_score: undefined })).toBe(true);
    expect(isEmptyAudience({ tags: ["x"] })).toBe(false);
  });
});

describe("modelos de campanha", () => {
  it("todos têm chave única e filtros que o banco aceita", () => {
    const keys = CAMPAIGN_PRESETS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const p of CAMPAIGN_PRESETS) expect(Object.keys(p.audience).every((k) => !k.startsWith("_"))).toBe(true);
  });
  it("cupom pessoal vem com validade e prefixo; lembrete só para quem ainda não agiu", () => {
    const p = presetByKey("reactivate");
    expect(p.offer).toMatchObject({ mode: "PERSONAL", valid_days: 14, prefix: "VOLTA" });
    expect(p.reminder?.filter).toBe("NOT_BOUGHT");
    expect(presetByKey("não existe").key).toBe("custom");
  });
  it("sugere as variáveis conforme a oferta", () => {
    expect(suggestVariables(4, "PERSONAL", false).map((v) => v.source)).toEqual(["FIRST_NAME", "COUPON_CODE", "COUPON_VALUE", "COUPON_EXPIRY"]);
    expect(suggestVariables(1, "NONE", false)).toEqual([{ source: "FIRST_NAME" }]);
    expect(suggestVariables(5, "SHARED", true).map((v) => v.source)).toEqual(["FIRST_NAME", "COUPON_CODE", "COUPON_VALUE", "CAMPAIGN_END", "TEXT"]);
  });
});
