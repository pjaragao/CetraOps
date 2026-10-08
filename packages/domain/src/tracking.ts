/**
 * Links rastreados: monta o endereço que vai no QR/bio. O banco reconhece "(ref: código)" na primeira mensagem do WhatsApp
 * e "/start código" no Telegram (private.capture_link_touch) — por isso o código precisa ir no texto.
 */
export const LINK_KINDS: Record<string, string> = {
  QR: "QR na loja/academia", BIO: "Bio do Instagram", STORY: "Story", TIKTOK: "TikTok", TRAINER: "Trainer", EVENT: "Evento", CAMPAIGN: "Campanha", PRINT: "Material impresso", OTHER: "Outro",
};

export function trackingMessage(code: string, prefill?: string | null): string {
  const base = (prefill ?? "").trim() || "Oi! Quero saber das novidades.";
  return `${base} (ref: ${code})`;
}

/** Endereço do link; null quando o canal ainda não tem número/@ cadastrado. */
export function trackingUrl(channel: string, address: string | null | undefined, code: string, prefill?: string | null): string | null {
  if (!address) return null;
  if (channel === "WHATSAPP") return `https://wa.me/${address.replace(/\D/g, "")}?text=${encodeURIComponent(trackingMessage(code, prefill))}`;
  if (channel === "TELEGRAM") return `https://t.me/${address.replace(/^@/, "")}?start=${encodeURIComponent(code)}`;
  return null;
}

/** O que o banco devolve ao resolver um link curto (public.resolve_link). */
export interface ResolvedLink {
  target: string; code: string; kind: string; channel: string | null; address: string | null; prefill_text: string | null; target_url: string | null;
  utm: Record<string, string> | null; campaign_code: string | null;
}

/** Link curto que vai nos stories, na bio e no QR: passa pelo sistema, conta o clique e leva ao destino. */
export function shortLink(base: string | null | undefined, code: string): string | null {
  if (!base) return null;
  return `${base.replace(/\/+$/, "")}/r/${code}`;
}

/** Endereço final do link: WhatsApp/Telegram com o código de origem, ou a página do site com UTM (sem sobrescrever o que já existir na URL). */
export function linkDestination(r: ResolvedLink): string | null {
  if (r.target === "WEB") {
    if (!r.target_url) return null;
    let url: URL;
    try { url = new URL(r.target_url); } catch { return null; }
    const utm = r.utm ?? {};
    const set = (k: string, v: string | null | undefined) => { if (v && !url.searchParams.has(k)) url.searchParams.set(k, v); };
    set("utm_source", utm.source ?? r.kind.toLowerCase());
    set("utm_medium", utm.medium ?? "link");
    set("utm_campaign", utm.campaign ?? r.campaign_code ?? r.code);
    set("utm_content", r.code);
    return url.toString();
  }
  return trackingUrl(r.channel ?? "", r.address, r.code, r.prefill_text);
}

/** Tipo de aparelho pelo user-agent; robôs de pré-visualização (WhatsApp, Telegram, Facebook…) não contam como clique. */
export function classifyUserAgent(ua: string | null | undefined): "BOT" | "MOBILE" | "DESKTOP" | "OTHER" {
  const s = (ua ?? "").toLowerCase();
  if (!s) return "OTHER";
  if (/(bot|crawler|spider|preview|facebookexternalhit|whatsapp\/|telegrambot|slackbot|twitterbot|linkedinbot|headlesschrome|curl|wget)/.test(s)) return "BOT";
  if (/(iphone|android|mobile|ipad)/.test(s)) return "MOBILE";
  return "DESKTOP";
}
