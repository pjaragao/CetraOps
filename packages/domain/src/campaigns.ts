/**
 * Campanhas e públicos: rótulos, descrição em português dos filtros e modelos por objetivo.
 * Só apresentação e atalhos para as telas: quem decide quem entra, quem recebe e de qual campanha é cada venda é o banco.
 */

export const CAMPAIGN_STATUS_LABEL: Record<string, { label: string; tone: "neutral" | "info" | "warning" | "success" | "danger" }> = {
  DRAFT: { label: "rascunho", tone: "neutral" }, ACTIVE: { label: "ativa", tone: "success" }, ENDED: { label: "encerrada", tone: "info" }, CANCELLED: { label: "cancelada", tone: "danger" },
};

export const DISPATCH_STATUS_LABEL: Record<string, { label: string; tone: "neutral" | "info" | "warning" | "success" | "danger" }> = {
  DRAFT: { label: "rascunho", tone: "neutral" }, SCHEDULED: { label: "agendado", tone: "info" }, SENDING: { label: "enviando", tone: "warning" }, DONE: { label: "concluído", tone: "success" }, CANCELLED: { label: "cancelado", tone: "danger" },
};

export const OBJECTIVE_LABEL: Record<string, string> = {
  REACTIVATE: "Reativar clientes", LAUNCH: "Lançamento / drop", ACQUIRE: "Captar novas leads", CONVERT: "Converter leads", LOYALTY: "Fidelizar VIPs", EVENT: "Evento", CLEARANCE: "Queima de estoque", CUSTOM: "Personalizada",
};

export const SKIP_REASON_LABEL: Record<string, string> = {
  NO_CONSENT: "sem consentimento de marketing no WhatsApp", NO_PHONE: "sem telefone", FREQUENCY_CAP: "já recebeu marketing há pouco", TEMPLATE_NOT_APPROVED: "template deixou de estar aprovado",
  IDENTITY_CONFLICT: "número ligado a outra pessoa", CAMPAIGN_CANCELLED: "campanha cancelada", CAMPAIGN_ENDED: "campanha encerrada", DISPATCH_CANCELLED: "disparo cancelado",
  NOT_IN_AUDIENCE: "fora do público", ALREADY_BOUGHT: "já comprou", ALREADY_READ: "já leu a mensagem", ALREADY_REPLIED: "já respondeu", NO_COUPON: "sem cupom para entregar", NO_LINK: "sem link da campanha", NO_VALUE: "valor da variável indisponível",
};

export const OFFER_MODES: Record<string, { label: string; hint: string }> = {
  NONE: { label: "Sem cupom", hint: "Só a mensagem, o link e os anúncios." },
  SHARED: { label: "Código único", hint: "Um código para todo mundo (ex.: OUTONO10), bom para stories, bio e anúncio." },
  PERSONAL: { label: "Cupom pessoal", hint: "Um cupom por pessoa, de uso único, entregue na mensagem e aplicado sozinho no PDV." },
  AFFILIATE: { label: "Cupom de cada afiliada", hint: "Cada trainer divulga o próprio cupom e link; a comissão já entra no custo." },
};

export const DISPATCH_FILTERS: Record<string, string> = {
  ALL: "Todo o público", NOT_BOUGHT: "Só quem ainda não comprou", NOT_READ: "Só quem não leu", NOT_REPLIED: "Só quem não respondeu",
};

export const VARIABLE_SOURCES: Record<string, { label: string; needs?: "offer" | "ends_at" | "landing"; sample: string }> = {
  FIRST_NAME: { label: "Primeiro nome da pessoa", sample: "Ana" },
  FULL_NAME: { label: "Nome completo", sample: "Ana Souza" },
  TEXT: { label: "Texto fixo", sample: "…" },
  COUPON_CODE: { label: "Código do cupom", needs: "offer", sample: "OUTONO10" },
  COUPON_VALUE: { label: "Valor do desconto", needs: "offer", sample: "10%" },
  COUPON_EXPIRY: { label: "Validade do cupom", needs: "offer", sample: "30/10" },
  LINK: { label: "Link da campanha", needs: "landing", sample: "https://loja.com.br/r/outono-web" },
  CAMPAIGN_END: { label: "Data de fim da campanha", needs: "ends_at", sample: "31/10" },
};

export const ATTRIBUTION_KIND_LABEL: Record<string, string> = {
  COUPON: "Cupom da campanha", LINK: "Link / QR da campanha", AD: "Anúncio ligado", MESSAGE: "Mensagem recebida",
};

export const AD_AUDIENCE_STATUS: Record<string, { label: string; tone: "neutral" | "info" | "warning" | "success" | "danger" }> = {
  PENDING: { label: "na fila", tone: "neutral" }, SYNCING: { label: "enviando", tone: "warning" }, READY: { label: "pronto", tone: "success" }, ERROR: { label: "erro", tone: "danger" },
};

// ---------------------------------------------------------------------------------------------------------------------
// Filtro de público (mesmas chaves de crm.audience no banco)
// ---------------------------------------------------------------------------------------------------------------------
export interface AudienceDef {
  lifecycle?: string[]; tiers?: string[]; min_score?: number; inactive_days?: number; inactive_max_days?: number; birthday_month?: number; cities?: string[]; tags?: string[]; sources?: string[];
  event_id?: string; rsvp?: string[];
  never_bought?: boolean; bought_within_days?: number; period_days?: number; orders_min?: number; orders_max?: number; spent_min?: number; spent_max?: number; ticket_min?: number;
  bought_categories?: string[]; bought_collections?: string[]; bought_products?: string[]; bought_sizes?: string[]; bought_period_days?: number;
  created_within_days?: number; created_older_than_days?: number; any_link?: boolean; link_ids?: string[]; from_ads?: boolean; ad_ids?: string[]; referred?: boolean; affiliate_ids?: string[];
  deal_status?: string[]; lost_reasons?: string[];
  has_active_coupon?: boolean; received_campaigns?: string[]; not_received_campaigns?: string[]; no_marketing_days?: number; replied_within_days?: number;
  reachable_whatsapp?: boolean; has_email?: boolean; ads_consent?: boolean;
  segment_id?: string; exclude?: AudienceDef;
}

const MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const LIFECYCLE: Record<string, string> = { LEAD: "leads", PROSPECT: "prospects", CUSTOMER: "clientes", VIP: "VIPs", INACTIVE: "inativas", LOST: "perdidas" };
const TIER: Record<string, string> = { STANDARD: "padrão", VIP: "VIP", VIP_BLACK: "VIP black" };
const DEAL: Record<string, string> = { OPEN: "em negociação", WON: "negócio ganho", LOST: "negócio perdido" };
const brl = (n: number) => `R$ ${n.toLocaleString("pt-BR")}`;
const list = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} ou ${xs[xs.length - 1]}`);

/** Frases curtas e legíveis sobre o filtro (para listas, prévia e resumo da campanha). */
export function describeAudience(d: AudienceDef | null | undefined, names: { segment?: string } = {}): string[] {
  if (!d) return [];
  const out: string[] = [];
  const has = (v: unknown) => (Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== "");
  if (has(d.segment_id)) out.push(`Público salvo${names.segment ? ` “${names.segment}”` : ""}`);
  if (has(d.lifecycle)) out.push(`Etapa: ${list(d.lifecycle!.map((x) => LIFECYCLE[x] ?? x))}`);
  if (has(d.tiers)) out.push(`Nível: ${list(d.tiers!.map((x) => TIER[x] ?? x))}`);
  if (has(d.min_score)) out.push(`Pontuação a partir de ${d.min_score}`);
  if (has(d.never_bought)) out.push(d.never_bought ? "Nunca comprou" : "Já comprou");
  if (has(d.inactive_days) && has(d.inactive_max_days)) out.push(`Sem comprar há ${d.inactive_days} a ${d.inactive_max_days} dias`);
  else if (has(d.inactive_days)) out.push(`Sem comprar há mais de ${d.inactive_days} dias`);
  else if (has(d.inactive_max_days)) out.push(`Comprou nos últimos ${d.inactive_max_days} dias`);
  if (has(d.bought_within_days)) out.push(`Comprou nos últimos ${d.bought_within_days} dias`);
  const per = has(d.period_days) ? ` nos últimos ${d.period_days} dias` : "";
  if (has(d.orders_min) || has(d.orders_max)) out.push(`Pedidos${per}: ${has(d.orders_min) ? `a partir de ${d.orders_min}` : ""}${has(d.orders_min) && has(d.orders_max) ? " e " : ""}${has(d.orders_max) ? `até ${d.orders_max}` : ""}`);
  if (has(d.spent_min) || has(d.spent_max)) out.push(`Gastou${per}: ${has(d.spent_min) ? `a partir de ${brl(d.spent_min!)}` : ""}${has(d.spent_min) && has(d.spent_max) ? " e " : ""}${has(d.spent_max) ? `até ${brl(d.spent_max!)}` : ""}`);
  if (has(d.ticket_min)) out.push(`Ticket médio a partir de ${brl(d.ticket_min!)}`);
  if (has(d.bought_categories)) out.push(`Comprou de ${d.bought_categories!.length} categoria(s)`);
  if (has(d.bought_collections)) out.push(`Comprou de ${d.bought_collections!.length} coleção(ões)`);
  if (has(d.bought_products)) out.push(`Comprou ${d.bought_products!.length} produto(s) específico(s)`);
  if (has(d.bought_sizes)) out.push(`Comprou tamanho ${list(d.bought_sizes!)}`);
  if (has(d.created_within_days)) out.push(`Entrou há até ${d.created_within_days} dias`);
  if (has(d.created_older_than_days)) out.push(`Entrou há mais de ${d.created_older_than_days} dias`);
  if (has(d.sources)) out.push(`Origem: ${list(d.sources!)}`);
  if (has(d.any_link)) out.push(d.any_link ? "Chegou por algum link ou QR" : "Não chegou por link ou QR");
  if (has(d.link_ids)) out.push(`Chegou por ${d.link_ids!.length} link(s) escolhido(s)`);
  if (has(d.from_ads)) out.push(d.from_ads ? "Chegou por anúncio" : "Não chegou por anúncio");
  if (has(d.referred)) out.push(d.referred ? "Veio por indicação ou afiliada" : "Não veio por indicação");
  if (has(d.affiliate_ids)) out.push(`Indicada por ${d.affiliate_ids!.length} afiliada(s) escolhida(s)`);
  if (has(d.deal_status)) out.push(`Funil: ${list(d.deal_status!.map((x) => DEAL[x] ?? x))}`);
  if (has(d.lost_reasons)) out.push(`Motivo da perda: ${list(d.lost_reasons!)}`);
  if (has(d.birthday_month)) out.push(`Aniversário em ${MONTHS[(d.birthday_month ?? 1) - 1]}`);
  if (has(d.cities)) out.push(`Cidade: ${list(d.cities!)}`);
  if (has(d.tags)) out.push(`Etiqueta: ${list(d.tags!)}`);
  if (has(d.event_id)) out.push(`Convidadas de um evento${has(d.rsvp) ? ` (${list(d.rsvp!)})` : ""}`);
  if (has(d.has_active_coupon)) out.push(d.has_active_coupon ? "Tem cupom ativo sem usar" : "Sem cupom ativo");
  if (has(d.received_campaigns)) out.push(`Recebeu ${d.received_campaigns!.length} campanha(s) escolhida(s)`);
  if (has(d.not_received_campaigns)) out.push(`Não recebeu ${d.not_received_campaigns!.length} campanha(s) escolhida(s)`);
  if (has(d.no_marketing_days)) out.push(`Sem marketing há ${d.no_marketing_days} dias`);
  if (has(d.replied_within_days)) out.push(`Respondeu nos últimos ${d.replied_within_days} dias`);
  if (has(d.reachable_whatsapp)) out.push(d.reachable_whatsapp ? "Alcançável no WhatsApp" : "Fora do WhatsApp");
  if (has(d.has_email)) out.push(d.has_email ? "Tem e-mail" : "Sem e-mail");
  if (has(d.ads_consent)) out.push(d.ads_consent ? "Aceitou receber anúncios" : "Não aceitou anúncios");
  if (d.exclude && Object.keys(d.exclude).length > 0) {
    const ex = describeAudience(d.exclude, names);
    if (ex.length) out.push(`Exceto: ${ex.join("; ").toLowerCase()}`);
  }
  return out;
}

/** O filtro está vazio (público = todas as pessoas elegíveis)? */
export function isEmptyAudience(d: AudienceDef | null | undefined): boolean {
  return describeAudience(d).length === 0;
}

// ---------------------------------------------------------------------------------------------------------------------
// Modelos por objetivo (preenchem o assistente; tudo continua editável)
// ---------------------------------------------------------------------------------------------------------------------
export interface CampaignPreset {
  key: string; label: string; description: string; objective: string;
  audience: AudienceDef; scope: "LOCAL" | "META" | "BOTH"; holdout_pct: number; attribution_days: number;
  offer: { mode: "NONE" | "SHARED" | "PERSONAL" | "AFFILIATE"; kind?: "PERCENT" | "AMOUNT"; value?: number; valid_days?: number; prefix?: string; min_order?: number };
  reminder?: { filter: "NOT_BOUGHT" | "NOT_READ" | "NOT_REPLIED"; after_days: number };
  suggestion: string;
}

export const CAMPAIGN_PRESETS: CampaignPreset[] = [
  { key: "reactivate", label: "Reativar inativas", objective: "REACTIVATE", description: "Clientes que sumiram: cupom pessoal e um lembrete para quem não comprou.",
    audience: { lifecycle: ["CUSTOMER", "VIP", "INACTIVE"], inactive_days: 60, inactive_max_days: 365, no_marketing_days: 14 }, scope: "LOCAL", holdout_pct: 10, attribution_days: 7,
    offer: { mode: "PERSONAL", kind: "PERCENT", value: 10, valid_days: 14, prefix: "VOLTA" }, reminder: { filter: "NOT_BOUGHT", after_days: 3 },
    suggestion: "Oi {{1}}! Faz um tempinho que você não passa por aqui 💛 Separei um cupom só seu: {{2}}, {{3}} de desconto até {{4}}." },
  { key: "launch", label: "Lançamento / drop", objective: "LAUNCH", description: "Avisar a base e divulgar nos stories, na bio e nos anúncios com um código único.",
    audience: { lifecycle: ["CUSTOMER", "VIP"], no_marketing_days: 7 }, scope: "BOTH", holdout_pct: 0, attribution_days: 7,
    offer: { mode: "SHARED", kind: "PERCENT", value: 10, prefix: "DROP" }, reminder: { filter: "NOT_READ", after_days: 2 },
    suggestion: "Oi {{1}}! A nova coleção chegou. Use o código {{2}} e ganhe {{3}} de desconto até {{4}}." },
  { key: "acquire", label: "Captar leads", objective: "ACQUIRE", description: "Público geral nos anúncios, com link para o WhatsApp e código de primeira compra.",
    audience: { lifecycle: ["CUSTOMER", "VIP"], ads_consent: true }, scope: "META", holdout_pct: 0, attribution_days: 14,
    offer: { mode: "SHARED", kind: "PERCENT", value: 10, prefix: "BEMVINDA" }, suggestion: "" },
  { key: "convert", label: "Converter leads", objective: "CONVERT", description: "Leads que ainda não compraram: cupom pessoal curto e lembrete.",
    audience: { lifecycle: ["LEAD", "PROSPECT"], never_bought: true, created_within_days: 30, no_marketing_days: 7 }, scope: "LOCAL", holdout_pct: 10, attribution_days: 7,
    offer: { mode: "PERSONAL", kind: "PERCENT", value: 10, valid_days: 7, prefix: "LEAD" }, reminder: { filter: "NOT_BOUGHT", after_days: 2 },
    suggestion: "Oi {{1}}! Vi que você se interessou pela nossa loja. Seu cupom de primeira compra: {{2}} ({{3}} de desconto até {{4}})." },
  { key: "loyalty", label: "Fidelizar VIPs", objective: "LOYALTY", description: "Clientes VIP e fiéis: acesso antecipado, sem desconto.",
    audience: { tiers: ["VIP", "VIP_BLACK"], bought_within_days: 180 }, scope: "LOCAL", holdout_pct: 0, attribution_days: 7,
    offer: { mode: "NONE" }, suggestion: "Oi {{1}}! Você tem acesso antecipado à nossa nova coleção. Quer ver antes de todo mundo?" },
  { key: "event", label: "Evento", objective: "EVENT", description: "Convidar para um evento ou pré-venda.",
    audience: { lifecycle: ["CUSTOMER", "VIP"], min_score: 40 }, scope: "LOCAL", holdout_pct: 0, attribution_days: 7, offer: { mode: "NONE" }, reminder: { filter: "NOT_REPLIED", after_days: 2 },
    suggestion: "Oi {{1}}! Estamos organizando um encontro e queremos você lá. Posso reservar seu lugar?" },
  { key: "clearance", label: "Queima de estoque", objective: "CLEARANCE", description: "Código único com prazo curto para a base inteira.",
    audience: { lifecycle: ["CUSTOMER", "VIP", "INACTIVE"] }, scope: "LOCAL", holdout_pct: 0, attribution_days: 5,
    offer: { mode: "SHARED", kind: "PERCENT", value: 30, prefix: "SALDAO" }, reminder: { filter: "NOT_BOUGHT", after_days: 2 },
    suggestion: "Oi {{1}}! Saldão rolando: use {{2}} e ganhe {{3}} de desconto até {{4}}." },
  { key: "custom", label: "Personalizada", objective: "CUSTOM", description: "Comece do zero e escolha tudo.", audience: {}, scope: "LOCAL", holdout_pct: 0, attribution_days: 7, offer: { mode: "NONE" }, suggestion: "" },
];

export const presetByKey = (key: string): CampaignPreset => CAMPAIGN_PRESETS.find((p) => p.key === key) ?? CAMPAIGN_PRESETS[CAMPAIGN_PRESETS.length - 1];

/** Variáveis sugeridas por quantidade de {{n}} e tipo de oferta (o texto do template continua sendo o da Meta). */
export function suggestVariables(n: number, offerMode: string, hasEnd: boolean): { source: string; text?: string }[] {
  const base = [{ source: "FIRST_NAME" }, ...(offerMode === "PERSONAL" || offerMode === "SHARED" ? [{ source: "COUPON_CODE" }, { source: "COUPON_VALUE" }, { source: hasEnd && offerMode === "SHARED" ? "CAMPAIGN_END" : "COUPON_EXPIRY" }] : [])];
  return Array.from({ length: n }, (_, i) => base[i] ?? { source: "TEXT", text: "" });
}
