/**
 * SIÉ Joy OS - WhatsApp AI Concierge Bot Module
 * Simulador interativo de vendas assistidas por IA para alunas do JOY Wellness Club
 * Recomendação personalizada de looks, consulta de estoque Stone e link de pagamento
 */

const WhatsAppBot = {
  chatHistory: [
    {
      sender: "bot",
      text: "Olá! ✨ Seja muito bem-vinda ao atendimento exclusivo da **SIÉ Wear @ JOY Wellness Club**.\n\nSou a sua Concierge Virtual. Como posso te vestir hoje? Você está procurando um look para **Pilates Reformer**, **Musculação**, **Beach Tennis** ou um look confortável para o pós-treino no SPA?",
      time: "10:15",
      suggestions: ["Pilates Reformer", "Musculação", "Jaqueta Pós-Treino", "Armário VIP"]
    }
  ],

  async sendMessage(text, customerName = "Dra. Beatriz Silveira") {
    const timeNow = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    
    // Add user message
    this.chatHistory.push({
      sender: "user",
      text: text,
      time: timeNow
    });

    // Call server AI endpoint
    try {
      const res = await fetch("/api/whatsapp/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, customerName })
      });
      const data = await res.json();

      this.chatHistory.push({
        sender: "bot",
        text: data.response,
        time: new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }),
        suggestions: data.suggestions || [],
        recommendedProduct: data.recommendedProduct || null
      });

      return data;
    } catch (e) {
      console.error("Erro na resposta do bot:", e);
      return null;
    }
  }
};

window.WhatsAppBot = WhatsAppBot;
