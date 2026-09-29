/**
 * Regras de janela das plataformas (aplicadas no servidor; a UI só as exibe).
 *  - WhatsApp: texto livre até 24h após a última mensagem do cliente; depois, só template aprovado.
 *    Template de marketing exige consentimento MARKETING_WHATSAPP.
 *  - Instagram: livre até 24h; de 24h a 7 dias só autor HUMANO com tag HUMAN_AGENT; depois, bloqueado.
 *  - Telegram: livre depois do /start (o bot não inicia conversa).
 *  - TikTok: atrás de feature flag (API de mensagens não confirmada no Brasil).
 */
export type MessagingChannel = "WHATSAPP" | "INSTAGRAM" | "TELEGRAM" | "TIKTOK";
export type Author = "AI" | "HUMAN";

export type SendDecision =
  | { allowed: true; mode: "FREE_FORM" | "HUMAN_AGENT_TAG" }
  | { allowed: true; mode: "TEMPLATE_ONLY"; requiresMarketingConsent: boolean }
  | { allowed: false; reason: string };

const HOUR = 3600_000;

export function canSend(params: {
  channel: MessagingChannel;
  author: Author;
  lastInboundAt: Date | null;
  now?: Date;
  isMarketing?: boolean;
  tiktokEnabled?: boolean;
}): SendDecision {
  const now = params.now ?? new Date();
  const elapsed = params.lastInboundAt ? now.getTime() - params.lastInboundAt.getTime() : Number.POSITIVE_INFINITY;

  switch (params.channel) {
    case "WHATSAPP":
      if (elapsed <= 24 * HOUR && !params.isMarketing) return { allowed: true, mode: "FREE_FORM" };
      return { allowed: true, mode: "TEMPLATE_ONLY", requiresMarketingConsent: Boolean(params.isMarketing) };
    case "INSTAGRAM":
      if (params.isMarketing && elapsed > 24 * HOUR) {
        return { allowed: false, reason: "Instagram não permite mensagem promocional fora da janela de 24h" };
      }
      if (elapsed <= 24 * HOUR) return { allowed: true, mode: "FREE_FORM" };
      if (elapsed <= 7 * 24 * HOUR) {
        return params.author === "HUMAN"
          ? { allowed: true, mode: "HUMAN_AGENT_TAG" }
          : { allowed: false, reason: "Entre 24h e 7 dias só um humano pode responder (tag HUMAN_AGENT)" };
      }
      return { allowed: false, reason: "Janela do Instagram encerrada (mais de 7 dias sem mensagem da cliente)" };
    case "TELEGRAM":
      return params.lastInboundAt
        ? { allowed: true, mode: "FREE_FORM" }
        : { allowed: false, reason: "O bot só fala com quem iniciou a conversa (/start)" };
    case "TIKTOK":
      if (!params.tiktokEnabled) return { allowed: false, reason: "Canal TikTok desativado (feature flag)" };
      return elapsed <= 48 * HOUR
        ? { allowed: true, mode: "FREE_FORM" }
        : { allowed: false, reason: "Janela do TikTok encerrada" };
  }
}

/** Tempo restante da janela de 24h, para o selo "Janela 24h: 3h12" da inbox. */
export function serviceWindowRemaining(lastInboundAt: Date | null, now = new Date()): string | null {
  if (!lastInboundAt) return null;
  const ms = lastInboundAt.getTime() + 24 * HOUR - now.getTime();
  if (ms <= 0) return null;
  const h = Math.floor(ms / HOUR);
  const m = Math.floor((ms % HOUR) / 60_000);
  return `${h}h${String(m).padStart(2, "0")}`;
}
