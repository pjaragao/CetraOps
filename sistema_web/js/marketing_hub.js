/**
 * SIÉ Joy OS - Marketing & Drops Management Module
 * Calendário oficial dos 6 drops bimestrais no JOY Wellness Club
 * Controle de budget de R$ 4.000 por evento, cálculo de ROAS e programa de personais parceiros
 */

const MarketingHub = {
  dropsData: null,

  async init() {
    try {
      const res = await fetch("/api/drops");
      this.dropsData = await res.json();
    } catch (e) {
      console.error("Erro ao carregar dados de marketing:", e);
    }
  },

  calculateDropMetrics(dropId, salesWithin7Days = 24500.00) {
    const drop = (this.dropsData?.drops || []).find(d => d.id === dropId);
    if (!drop) return null;

    const budget = drop.budgetAllocated || 4000.00;
    const roas = (salesWithin7Days / budget).toFixed(2);
    const grossProfitEvent = (salesWithin7Days * 0.5833);
    const netReturnEvent = grossProfitEvent - budget;

    return {
      drop,
      salesWithin7Days,
      budget,
      roas: `${roas}x`,
      netReturnEvent,
      roiPct: ((netReturnEvent / budget) * 100).toFixed(1) + "%"
    };
  }
};

window.MarketingHub = MarketingHub;
