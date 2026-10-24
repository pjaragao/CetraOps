import { describe, expect, it } from "vitest";
import {
  canSend, computeCommission, DEFAULT_COMMISSION_PLAN, formatBRL, periodRange, serviceWindowRemaining,
  splitInstallments, visibleNav,
} from "./index";

describe("dinheiro", () => {
  it("formata em reais", () => expect(formatBRL(1234.5)).toBe("R$ 1.234,50"));
  it("divide parcelas com centavos na última (igual ao banco)", () => {
    expect(splitInstallments(478, 3)).toEqual([159.33, 159.33, 159.34]);
    expect(splitInstallments(100, 3).reduce((a, b) => a + b, 0)).toBeCloseTo(100, 2);
  });
});

describe("comissão (doc 08)", () => {
  it("abaixo de 35 mil: só a comissão", () => {
    const s = computeCommission(DEFAULT_COMMISSION_PLAN, [{ channel: "POS", amount: 30000 }]);
    expect(s).toMatchObject({ commission: 900, bonus: 0, total: 900 });
    expect(s.nextTier?.missing).toBe(5000);
  });
  it("entre 35 e 60 mil: bônus fixo de R$ 200", () => {
    expect(computeCommission(DEFAULT_COMMISSION_PLAN, [{ channel: "POS", amount: 40000 }]).bonus).toBe(200);
  });
  it("acima de 60 mil: 1% sobre o excedente", () => {
    expect(computeCommission(DEFAULT_COMMISSION_PLAN, [{ channel: "WHATSAPP", amount: 70000 }]).bonus).toBe(100);
  });
  it("canal sem taxa não gera comissão", () => {
    expect(computeCommission(DEFAULT_COMMISSION_PLAN, [{ channel: "B2B", amount: 1000 }]).commission).toBe(0);
  });
});

describe("janelas das plataformas", () => {
  const now = new Date("2026-10-10T12:00:00Z");
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600_000);
  it("WhatsApp: livre em 24h, template depois", () => {
    expect(canSend({ channel: "WHATSAPP", author: "AI", lastInboundAt: hoursAgo(2), now })).toEqual({ allowed: true, mode: "FREE_FORM" });
    expect(canSend({ channel: "WHATSAPP", author: "AI", lastInboundAt: hoursAgo(30), now })).toMatchObject({ mode: "TEMPLATE_ONLY" });
  });
  it("Instagram: IA bloqueada entre 24h e 7d; humano usa HUMAN_AGENT", () => {
    expect(canSend({ channel: "INSTAGRAM", author: "AI", lastInboundAt: hoursAgo(30), now }).allowed).toBe(false);
    expect(canSend({ channel: "INSTAGRAM", author: "HUMAN", lastInboundAt: hoursAgo(30), now })).toEqual({ allowed: true, mode: "HUMAN_AGENT_TAG" });
    expect(canSend({ channel: "INSTAGRAM", author: "HUMAN", lastInboundAt: hoursAgo(24 * 8), now }).allowed).toBe(false);
  });
  it("Telegram só depois do /start; TikTok atrás de flag", () => {
    expect(canSend({ channel: "TELEGRAM", author: "AI", lastInboundAt: null, now }).allowed).toBe(false);
    expect(canSend({ channel: "TIKTOK", author: "AI", lastInboundAt: hoursAgo(1), now }).allowed).toBe(false);
  });
  it("selo da janela", () => {
    expect(serviceWindowRemaining(hoursAgo(20.5), now)).toBe("3h30");
    expect(serviceWindowRemaining(hoursAgo(25), now)).toBeNull();
  });
});

describe("período e menu", () => {
  it("mês atual começa no dia 1 (fuso SP)", () => {
    expect(periodRange("mes", new Date("2026-10-15T02:00:00Z"))).toMatchObject({ from: "2026-10-01", to: "2026-10-14" });
  });
  it("vendedora não vê Financeiro nem Configurações", () => {
    const keys = visibleNav(new Set(["sales.read", "sales.write", "crm.read", "omni.read", "catalog.read", "inv.read"]), false).map((a) => a.key);
    expect(keys).toContain("vender");
    expect(keys).not.toContain("financeiro");
    expect(keys).not.toContain("configuracoes");
  });
  it("quem só pede reembolso vê Financeiro com Reembolsos e a Caixa de documentos (foto do cupom vira reembolso)", () => {
    const fin = visibleNav(new Set(["sales.read", "fin.reimburse"]), false).find((a) => a.key === "financeiro");
    expect(fin?.items.map((i) => i.label)).toEqual(["Reembolsos", "Caixa de documentos"]);
    expect(fin?.href).toBe("/financeiro/reembolsos");
  });
  it("o financeiro vê Reembolsos junto com o resto", () => {
    const fin = visibleNav(new Set(["fin.read"]), false).find((a) => a.key === "financeiro");
    expect(fin?.href).toBe("/financeiro");
    expect(fin?.items.map((i) => i.label)).toContain("Reembolsos");
  });
});
