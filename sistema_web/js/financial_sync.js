/**
 * SIÉ Joy OS - Financial Synchronization Engine
 * Cruza o faturamento em tempo real capturado da Stone com as metas do modelo financeiro
 * Suporta o novo aluguel de R$ 6.000,00 e o cálculo especial da Carência de 3 Meses
 */

const FinancialSync = {
  targets: null,

  async init() {
    try {
      const res = await fetch("/api/financial-targets");
      this.targets = await res.json();
    } catch (e) {
      console.error("Erro ao carregar metas financeiras:", e);
    }
  },

  calculateRealizedDRE(transactions, selectedScenarioId = "c4", isGracePeriodActive = false) {
    if (!this.targets) return null;

    let grossRevenue = 0;
    let stoneFeesTotal = 0;
    let totalItemsCost = 0;
    let salespersonCommission = 0;
    let paymentMix = { PIX: 0, DEBIT: 0, CREDIT_CARD: 0 };

    transactions.forEach(tx => {
      grossRevenue += tx.grossAmount || 0;
      stoneFeesTotal += (tx.grossAmount - tx.netAmount) || 0;
      salespersonCommission += tx.commissionAmount || 0;
      
      const m = tx.paymentMethod || "CREDIT_CARD";
      paymentMix[m] = (paymentMix[m] || 0) + (tx.grossAmount || 0);

      // Approximate cost from items or markup
      if (tx.items && tx.items.length > 0) {
        tx.items.forEach(it => {
          totalItemsCost += (it.price / 2.40) * (it.qty || 1);
        });
      } else {
        totalItemsCost += (tx.grossAmount / 2.40);
      }
    });

    const scenario = this.targets.scenarios.find(s => s.id === selectedScenarioId) || this.targets.scenarios[3];
    const simplesTaxRate = scenario.simplesRate || 0.055;
    const simplesTaxAmount = grossRevenue * simplesTaxRate;

    const commissionLaborCharges = salespersonCommission * 0.285;
    const packagingAndLosses = grossRevenue * this.targets.packagingLossesPct; // 1.5%

    const totalVariableCosts = totalItemsCost + simplesTaxAmount + stoneFeesTotal + salespersonCommission + commissionLaborCharges + packagingAndLosses;
    const contributionMargin = grossRevenue - totalVariableCosts;
    const contributionMarginPct = grossRevenue > 0 ? (contributionMargin / grossRevenue) : this.targets.netContributionMarginPct;

    // Fixed Costs: if grace period is active, rent is R$ 0,00
    const fixedCostsRegular = isGracePeriodActive ? this.targets.monthlyFixedCostsGrace : this.targets.monthlyFixedCostsRegular;
    const eventProvision = this.targets.eventProvisionMonthly; // R$ 2.000
    const totalFixedCosts = fixedCostsRegular + eventProvision;

    const netOperatingProfit = contributionMargin - totalFixedCosts;
    const netMarginPct = grossRevenue > 0 ? (netOperatingProfit / grossRevenue) : 0;

    // Breakeven metrics
    const targetBreakeven = isGracePeriodActive 
      ? this.targets.breakeven.graceWithEvents.monthlyRevenue 
      : this.targets.breakeven.regularWithEvents.monthlyRevenue;

    const breakevenProgressPct = Math.min(Math.round((grossRevenue / targetBreakeven) * 100), 150);

    return {
      grossRevenue,
      totalItemsCost,
      grossProfit: grossRevenue - totalItemsCost,
      simplesTaxAmount,
      stoneFeesTotal,
      salespersonCommission,
      commissionLaborCharges,
      packagingAndLosses,
      totalVariableCosts,
      contributionMargin,
      contributionMarginPct,
      fixedCostsRegular,
      eventProvision,
      totalFixedCosts,
      netOperatingProfit,
      netMarginPct,
      targetBreakeven,
      breakevenProgressPct,
      isGracePeriodActive,
      scenario,
      paymentMix,
      txCount: transactions.length,
      averageTicket: transactions.length > 0 ? (grossRevenue / transactions.length) : 0
    };
  }
};

window.FinancialSync = FinancialSync;
