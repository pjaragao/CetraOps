/**
 * Links rastreados: monta o endereço que vai no QR/bio. O banco reconhece "(ref: código)" na primeira mensagem do WhatsApp
 * e "/start código" no Telegram (private.capture_link_touch) — por isso o código precisa ir no texto.
 */
export const LINK_KINDS: Record<string, string> = {
  QR: "QR na loja/academia", BIO: "Bio do Instagram", STORY: "Story", TIKTOK: "TikTok", TRAINER: "Trainer", EVENT: "Evento", CAMPAIGN: "Campanha", PRINT: "Material impresso", OTHER: "Outro",
};

export function trackingMessage(code: string, prefill?: string | null): string {
  const base = (prefill ?? "").trim() || "Oi, SIÉ! Quero saber das novidades.";
  return `${base} (ref: ${code})`;
}

/** Endereço do link; null quando o canal ainda não tem número/@ cadastrado. */
export function trackingUrl(channel: string, address: string | null | undefined, code: string, prefill?: string | null): string | null {
  if (!address) return null;
  if (channel === "WHATSAPP") return `https://wa.me/${address.replace(/\D/g, "")}?text=${encodeURIComponent(trackingMessage(code, prefill))}`;
  if (channel === "TELEGRAM") return `https://t.me/${address.replace(/^@/, "")}?start=${encodeURIComponent(code)}`;
  return null;
}
