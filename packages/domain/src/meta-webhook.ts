// Webhook da Meta (WhatsApp Cloud API e Instagram) recebido pelo próprio web (/api/webhooks/meta), para quando o sistema roda no homelab
// e o Supabase não está na internet: a Meta chama o relay da Vercel, que repassa o corpo BRUTO ao web pelo Tailscale Funnel.
//
// Mesmas regras da Edge Function `webhooks-meta` (supabase/functions/_shared/webhooks.ts — o teste confere que as duas dividem igual):
// assinatura sobre o corpo bruto, uma chave de idempotência por evento, e a interpretação do payload fica com o worker.
// Só Web Crypto: roda no Node do web e nos testes.

export type MetaProvider = "META_WA" | "META_IG";
export type MetaWebhookEvent = { provider: MetaProvider; key: string; payload: Record<string, unknown> };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const enc = new TextEncoder();
const toHex = (buf: ArrayBuffer): string => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
}

async function shaHex(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}

/** Comparação em tempo constante (o tempo não revela quantos caracteres batem). */
function sameText(a: string, b: string): boolean {
  const ea = enc.encode(a);
  const eb = enc.encode(b);
  let diff = ea.length ^ eb.length;
  const n = Math.max(ea.length, eb.length);
  for (let i = 0; i < n; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

/** Lista de segredos separada por vírgula (WhatsApp e Instagram podem ser apps diferentes). */
export function metaSecretList(value: string | undefined | null): string[] {
  return (value ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

/** `X-Hub-Signature-256: sha256=<hex>` = HMAC-SHA256 do corpo bruto com o App Secret. Sem segredo, nada passa. */
export async function verifyMetaWebhookSignature(rawBody: string, header: string | null, secrets: string[]): Promise<boolean> {
  if (!header || !header.startsWith("sha256=")) return false;
  const got = header.slice("sha256=".length).trim().toLowerCase();
  let ok = false;
  for (const secret of secrets) {
    if (secret && sameText(await hmacHex(secret, rawBody), got)) ok = true;   // percorre todos: o tempo não revela qual segredo bateu
  }
  return ok;
}

/** Handshake da Meta: GET com hub.mode=subscribe. Devolve o `hub.challenge` se o token confere; senão null. */
export function metaWebhookChallenge(params: URLSearchParams, verifyToken: string): string | null {
  if (params.get("hub.mode") !== "subscribe" || !verifyToken) return null;
  return sameText(params.get("hub.verify_token") ?? "", verifyToken) ? (params.get("hub.challenge") ?? "") : null;
}

async function digestKey(prefix: string, value: unknown): Promise<string> {
  return `${prefix}:${(await shaHex(JSON.stringify(value))).slice(0, 32)}`;
}

/** Divide o POST da Meta em um evento por mensagem/status/comentário, cada um com a sua chave de idempotência. */
export async function splitMetaWebhook(payload: Json): Promise<MetaWebhookEvent[]> {
  const object = payload?.object;
  if (object === "whatsapp_business_account") return splitWhatsApp(payload);
  if (object === "instagram") return splitInstagram(payload);
  return [];
}

async function splitWhatsApp(payload: Json): Promise<MetaWebhookEvent[]> {
  const out: MetaWebhookEvent[] = [];
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

async function splitInstagram(payload: Json): Promise<MetaWebhookEvent[]> {
  const out: MetaWebhookEvent[] = [];
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
