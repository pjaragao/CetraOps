// Utilidades PURAS das Edge Functions de ingresso (só Web Crypto; sem APIs do Deno): rodam no Deno e no Node, então os testes são os mesmos do que vai ao ar.
//
// Regras do plano (§1.3): validar a assinatura sobre o CORPO BRUTO, dar uma chave de idempotência a CADA evento e nunca perder um webhook —
// a Edge Function só valida, grava e responde 200; a interpretação do payload é do worker.

export type Provider = "META_WA" | "META_IG" | "TELEGRAM";
export type WebhookEvent = { provider: Provider; key: string; payload: Record<string, unknown> };

// deno-lint-ignore no-explicit-any
type Json = any;

const enc = new TextEncoder();

const toHex = (buf: ArrayBuffer): string => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
}

export async function sha256Hex(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}

/** Comparação em tempo constante (não vaza, pelo tempo, quantos caracteres batem). */
export function timingSafeEqual(a: string, b: string): boolean {
  const ea = enc.encode(a);
  const eb = enc.encode(b);
  let diff = ea.length ^ eb.length;
  const n = Math.max(ea.length, eb.length);
  for (let i = 0; i < n; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

/** `X-Hub-Signature-256: sha256=<hex>` = HMAC-SHA256 do corpo bruto com o App Secret. Aceita uma lista: WhatsApp e Instagram podem ser apps diferentes. */
export async function verifyMetaSignature(rawBody: string, header: string | null, secrets: string[]): Promise<boolean> {
  if (!header || !header.startsWith("sha256=")) return false;
  const got = header.slice("sha256=".length).trim().toLowerCase();
  let ok = false;
  for (const secret of secrets) {
    if (secret && timingSafeEqual(await hmacSha256Hex(secret, rawBody), got)) ok = true;   // percorre todos: o tempo não revela qual segredo bateu
  }
  return ok;
}

/** Handshake do Meta: GET com hub.mode=subscribe. Devolve o `hub.challenge` (texto) se o token confere; senão null. */
export function metaChallenge(url: URL, verifyToken: string): string | null {
  const p = url.searchParams;
  if (p.get("hub.mode") !== "subscribe" || !verifyToken) return null;
  const got = p.get("hub.verify_token") ?? "";
  return timingSafeEqual(got, verifyToken) ? (p.get("hub.challenge") ?? "") : null;
}

async function digestKey(prefix: string, value: unknown): Promise<string> {
  return `${prefix}:${(await sha256Hex(JSON.stringify(value))).slice(0, 32)}`;
}

/** Divide o POST do Meta em um evento por mensagem/status/comentário, cada um com a sua chave de idempotência. */
export async function splitMetaPayload(payload: Json): Promise<WebhookEvent[]> {
  const object = payload?.object;
  if (object === "whatsapp_business_account") return splitWhatsApp(payload);
  if (object === "instagram") return splitInstagram(payload);
  return [];
}

async function splitWhatsApp(payload: Json): Promise<WebhookEvent[]> {
  const out: WebhookEvent[] = [];
  const wrap = (entry: Json, change: Json, value: Json): Record<string, unknown> => ({
    object: payload.object, entry: [{ id: entry.id, changes: [{ field: change.field, value }] }],
  });
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const v = change.value ?? {};
      const shared = { messaging_product: v.messaging_product, metadata: v.metadata, contacts: v.contacts };
      let matched = false;
      for (const m of v.messages ?? []) {
        matched = true;
        out.push({ provider: "META_WA", key: `${m.id}:msg`, payload: wrap(entry, change, { ...shared, messages: [m] }) });
      }
      for (const m of v.message_echoes ?? []) {
        matched = true;
        out.push({ provider: "META_WA", key: `${m.id}:echo`, payload: wrap(entry, change, { ...shared, message_echoes: [m] }) });
      }
      for (const s of v.statuses ?? []) {
        matched = true;
        out.push({ provider: "META_WA", key: `${s.id}:${s.status}`, payload: wrap(entry, change, { ...shared, statuses: [s] }) });
      }
      if (!matched) {                                                 // templates, qualidade do número, conta… guardados para auditoria/uso futuro
        out.push({ provider: "META_WA", key: await digestKey(`wa:${change.field}`, v), payload: wrap(entry, change, v) });
      }
    }
  }
  return out;
}

async function splitInstagram(payload: Json): Promise<WebhookEvent[]> {
  const out: WebhookEvent[] = [];
  for (const entry of payload.entry ?? []) {
    for (const m of entry.messaging ?? []) {
      let key: string;
      if (m.message?.mid) key = m.message.mid;
      else if (m.read?.mid) key = `read:${m.read.mid}`;
      else if (m.reaction?.mid) key = `reaction:${m.reaction.mid}:${m.reaction.action ?? ""}`;
      else if (m.postback?.mid) key = `postback:${m.postback.mid}`;
      else key = await digestKey("ig:messaging", m);
      out.push({ provider: "META_IG", key, payload: { object: payload.object, entry: [{ id: entry.id, time: entry.time, messaging: [m] }] } });
    }
    for (const c of entry.changes ?? []) {
      const id = c.value?.id ?? c.value?.comment_id;
      const key = id ? `${c.field}:${id}` : await digestKey(`ig:${c.field}`, c.value);
      out.push({ provider: "META_IG", key, payload: { object: payload.object, entry: [{ id: entry.id, time: entry.time, changes: [c] }] } });
    }
  }
  return out;
}

/** Telegram: `update_id` é único por bot; o id do bot vem da URL (…/webhooks-telegram/<bot_id>) e é conferido contra o segredo do webhook. */
export function telegramEvent(update: Json, botId: string): WebhookEvent | null {
  if (typeof update?.update_id !== "number" || !/^\d+$/.test(botId)) return null;
  return { provider: "TELEGRAM", key: `${botId}:${update.update_id}`, payload: { ...update, _bot_id: botId } };
}

/** Segredo do webhook do Telegram (`X-Telegram-Bot-Api-Secret-Token`): 1–256 caracteres A-Z a-z 0-9 _ - ; confere em tempo constante. */
export function verifyTelegramSecret(header: string | null, secret: string): boolean {
  return !!secret && !!header && timingSafeEqual(header, secret);
}
