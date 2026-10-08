/**
 * Ciclo de vida da cliente: rótulos e explicações dos estágios, níveis e segmentos calculados no banco (private.refresh_lifecycle).
 * Só leitura para as telas — a regra mora no banco.
 */
export const STAGE_LABEL: Record<string, string> = {
  LEAD: "Lead", PROSPECT: "Prospect", CUSTOMER: "Cliente", VIP: "VIP", INACTIVE: "Inativa", LOST: "Perdida",
};

export const TIER_LABEL: Record<string, string> = { STANDARD: "Padrão", VIP: "VIP", VIP_BLACK: "VIP Black" };

export interface SegmentInfo { label: string; hint: string; action: string }

/** Segmentos RFM (recência, frequência e valor), na ordem de exibição. */
export const SEGMENTS: Record<string, SegmentInfo> = {
  CHAMPION: { label: "Campeãs", hint: "Compraram há até 60 dias e 4+ vezes no ano", action: "Pré-venda, eventos fechados e indicação" },
  LOYAL: { label: "Fiéis", hint: "Até 90 dias, 2+ compras", action: "Complemento do look e convite VIP" },
  NEW: { label: "Novas promissoras", hint: "1 compra há até 45 dias", action: "Régua pós-compra e 2ª compra" },
  NEEDS_ATTENTION: { label: "Precisam de atenção", hint: "2+ compras, sem comprar há 61 a 120 dias", action: "Contato pessoal" },
  ONE_TIMER: { label: "Compraram uma vez", hint: "1 compra, há 46 a 120 dias", action: "Convite para a 2ª compra" },
  HIBERNATING: { label: "Hibernando", hint: "121 a 365 dias sem comprar", action: "Reativação" },
  LOST: { label: "Perdidas", hint: "Mais de 365 dias sem comprar", action: "Nada proativo" },
};

export const CONSENT_LABEL: Record<string, string> = {
  TRANSACTIONAL: "Transacional", MARKETING_WHATSAPP: "Marketing WhatsApp", MARKETING_EMAIL: "Marketing e-mail",
  MARKETING_IG: "Marketing Instagram", MARKETING_ADS: "Anúncios Meta (público personalizado)", AI_PROFILING: "Perfilamento por IA", ENRICHMENT: "Enriquecimento", IMAGE_USE: "Uso de imagem",
};

/** Faixa do score de lead (padrão do seed: quente ≥ 70, morna ≥ 40). */
export function scoreBand(score: number, hot = 70, warm = 40): { label: string; tone: "danger" | "warning" | "neutral" } {
  if (score >= hot) return { label: "quente", tone: "danger" };
  if (score >= warm) return { label: "morna", tone: "warning" };
  return { label: "fria", tone: "neutral" };
}
