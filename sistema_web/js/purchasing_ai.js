/**
 * SIÉ Joy OS - Purchasing AI & Smart Inventory Optimization
 * Calcula sugestão de compras para a fábrica SIÉ Wear com base no giro real da Stone
 * Curva ABC, ruptura de estoque por grade (P, M, G, GG) e lote de pedido
 */

const PurchasingAI = {
  async getRecommendations() {
    try {
      const res = await fetch("/api/purchasing/recommendations");
      return await res.json();
    } catch (e) {
      console.error("Erro ao carregar recomendações de compra:", e);
      return { recommendations: [], totalBudgetNeeded: 0 };
    }
  },

  generateSupplierOrder(recommendations) {
    const selectedItems = recommendations.filter(r => r.suggestedOrderQty > 0);
    const totalPieces = selectedItems.reduce((acc, it) => acc + it.suggestedOrderQty, 0);
    const totalCost = selectedItems.reduce((acc, it) => acc + it.orderCostTotal, 0);

    const orderNumber = `PED-SIE-JOY-${Math.floor(1000 + Math.random() * 9000)}`;
    const installmentAmount = (totalCost / 3).toFixed(2);

    return {
      orderNumber,
      date: new Date().toLocaleDateString("pt-BR"),
      supplier: "SIÉ Wear Confecções & Lifestyle Ltda",
      deliveryAddress: "JOY Wellness Club - Rua Esteves Júnior, 567 - Centro, Florianópolis/SC",
      paymentTerms: "30 / 60 / 90 Dias (Boleto Faturado)",
      installments: [
        { dueDate: "30 dias", amount: installmentAmount },
        { dueDate: "60 dias", amount: installmentAmount },
        { dueDate: "90 dias", amount: installmentAmount }
      ],
      totalPieces,
      totalCost,
      items: selectedItems
    };
  }
};

window.PurchasingAI = PurchasingAI;
