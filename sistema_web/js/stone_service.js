/**
 * SIÉ Joy OS - Stone Service Integration Module
 * Referência: https://online.stone.com.br/reference/aviso
 * Gerencia conexão com maquininhas POS, emissor NFC-e, API Stone Online e Webhooks
 */

const StoneService = {
  apiConfig: {
    stoneCode: "84729104",
    merchantName: "SIÉ WEAR JOY FLORIANÓPOLIS LTDA",
    environment: "Production (Homologado)",
    webhookEndpoint: "https://sie-joy-os.local/api/stone/webhook",
    posTerminals: [
      { id: "POS-01", model: "Stone Smart POS P2 (Android)", serial: "ST-88492019", status: "ONLINE", battery: "94%" },
      { id: "POS-02", model: "Stone Smart POS A8 (Reserva)", serial: "ST-88492020", status: "STANDBY", battery: "100%" }
    ]
  },

  async getTransactions() {
    try {
      const res = await fetch("/api/sales");
      if (!res.ok) throw new Error("Erro ao carregar vendas Stone");
      return await res.json();
    } catch (e) {
      console.warn("Usando fallback de vendas locais:", e);
      return [];
    }
  },

  async simulateWebhookSale(saleData) {
    try {
      const res = await fetch("/api/stone/simulate-webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(saleData)
      });
      return await res.json();
    } catch (e) {
      console.error("Erro no webhook Stone:", e);
      return { success: false, error: e.message };
    }
  },

  async generatePaymentLink(amount, description) {
    try {
      const res = await fetch("/api/stone/generate-payment-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount, description })
      });
      return await res.json();
    } catch (e) {
      console.error("Erro ao gerar link de pagamento:", e);
      return { success: false };
    }
  },

  formatCurrency(val) {
    return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(val);
  }
};

window.StoneService = StoneService;
