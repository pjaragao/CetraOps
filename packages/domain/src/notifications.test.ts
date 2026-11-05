import { describe, expect, it } from "vitest";
import { describeNotification, timeAgo } from "./index";

describe("notificações", () => {
  it("conversas abrem a caixa de entrada na conversa certa", () => {
    for (const kind of ["NEW_MESSAGE", "DRAFT_READY", "HANDOFF", "SLA_BREACH", "WINDOW_EXPIRING"]) {
      expect(describeNotification(kind, { conversation_id: "c-1" }).href).toBe("/atendimento?c=c-1");
    }
    expect(describeNotification("HANDOFF", {}).href).toBe("/atendimento");
  });

  it("alertas técnicos e fiscais levam à tela de quem resolve", () => {
    expect(describeNotification("INTEGRATION_ERROR", { connection_id: "x" })).toEqual({ label: "Integração", tone: "danger", href: "/configuracoes/integracoes" });
    expect(describeNotification("FISCAL_REJECTED", {}).href).toBe("/fiscal/emitidas?status=REJECTED");
    expect(describeNotification("FISCAL_PENDING", {}).tone).toBe("warning");
    expect(describeNotification("PAYMENT_LINK_REQUESTED", { order_id: "o-9" }).href).toBe("/vender/pedidos/o-9");
    expect(describeNotification("PAYMENT_LINK_REQUESTED", {}).href).toBe("/vender/pedidos");
  });

  it("plantão e fechamento do mês levam à tela certa", () => {
    expect(describeNotification("OPS_WATCH", { n: 2 }).href).toBe("/configuracoes/plantao");
    expect(describeNotification("MONTH_CLOSE", { competencia: "2026-09-01", legal_entity_id: "e1" }).href).toBe("/financeiro/fechamento?mes=2026-09&entity=e1");
    expect(describeNotification("MONTH_CLOSE", {}).href).toBe("/financeiro/fechamento");
  });

  it("o href do payload (tela exata) vence o destino padrão, mas só caminho interno", () => {
    expect(describeNotification("INTEGRATION_ERROR", { href: "/produtos/site" }).href).toBe("/produtos/site");
    expect(describeNotification("INTEGRATION_ERROR", { access_key: "352610" }).href).toBe("/fiscal/recebidas/nota/352610");
    expect(describeNotification("INTEGRATION_ERROR", { order_id: "o-1" }).href).toBe("/vender/pedidos/o-1");
    expect(describeNotification("BACKORDER_ARRIVED", { order_id: "o-2", href: "/vender/pedidos/o-2" }).href).toBe("/vender/pedidos/o-2");
    expect(describeNotification("INTEGRATION_ERROR", { href: "//evil.com" }).href).toBe("/configuracoes/integracoes");
    expect(describeNotification("INTEGRATION_ERROR", { href: "/\\evil.com" }).href).toBe("/configuracoes/integracoes");
    expect(describeNotification("INTEGRATION_ERROR", { href: "https://evil.com" }).href).toBe("/configuracoes/integracoes");
  });

  it("tipos gerados pelo banco têm destino próprio (não voltam para a lista)", () => {
    expect(describeNotification("LOAN_OVERDUE", { loan_id: "l-1" }).href).toBe("/vender/malinhas/l-1");
    expect(describeNotification("PRICE_CHANGED", { count: 3 }).href).toBe("/produtos/site");
    expect(describeNotification("STORE_CLOSED", { store_id: "s" }).href).toBe("/vender/rotina");
    expect(describeNotification("TEMPLATE_STATUS", { template_id: "t" }).href).toBe("/atendimento/templates");
    expect(describeNotification("REIMBURSEMENT_SUBMITTED", {}).href).toBe("/financeiro/reembolsos");
  });

  it("tipo desconhecido ou payload vazio não quebra", () => {
    expect(describeNotification("NOVO_TIPO", null)).toEqual({ label: "Aviso", tone: "info", href: "/notificacoes" });
    expect(describeNotification("NEW_MESSAGE", undefined).href).toBe("/atendimento");
    expect(describeNotification("NEW_MESSAGE", { conversation_id: 42 }).href).toBe("/atendimento");          // id que não é texto é ignorado
  });

  it("tempo relativo", () => {
    const now = new Date("2026-09-30T15:00:00Z").getTime();
    const ago = (ms: number) => new Date(now - ms).toISOString();
    expect(timeAgo(ago(20_000), now)).toBe("agora");
    expect(timeAgo(ago(5 * 60_000), now)).toBe("há 5 min");
    expect(timeAgo(ago(3 * 3_600_000), now)).toBe("há 3 h");
    expect(timeAgo(ago(30 * 3_600_000), now)).toBe("ontem");
    expect(timeAgo(ago(4 * 86_400_000), now)).toBe("há 4 dias");
    expect(timeAgo(ago(20 * 86_400_000), now)).toBe("10/09");
    expect(timeAgo(new Date(now + 60_000).toISOString(), now)).toBe("agora");                               // relógio adiantado não vira "há -1 min"
  });
});
