// Utilidades do relay. Sem dependências: fila no Upstash Redis via REST (integração "Upstash for Redis" da Vercel).
const crypto = require("node:crypto");

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const QUEUE = "stone:events";
const MAX_QUEUE = 5000;

async function redis(...cmd) {
  if (!URL_ || !TOKEN) throw new Error("Redis não configurado");
  const r = await fetch(URL_, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(cmd) });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error || `redis ${r.status}`);
  return j.result;
}

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Autenticação do webhook: ?key= na URL (Connect Stone) ou Basic auth (dashboard Pagar.me). */
function webhookAuthorized(req) {
  const user = process.env.WEBHOOK_USER, pass = process.env.WEBHOOK_PASS;
  if (!user || !pass) return false;
  // O formulário de ativação do Connect Stone só aceita uma URL: o segredo pode ir nela (?key=<WEBHOOK_PASS>)
  const key = new URL(req.url, "http://x").searchParams.get("key");
  if (key && safeEqual(key, pass)) return true;
  const h = req.headers.authorization || "";
  if (!h.startsWith("Basic ")) return false;
  const [u, ...p] = Buffer.from(h.slice(6), "base64").toString().split(":");
  const okUser = safeEqual(u, user), okPass = safeEqual(p.join(":"), pass);   // avalia os dois (tempo constante)
  return okUser && okPass;
}

/** Bearer do homelab (busca e confirmação da fila). */
function pullAuthorized(req) {
  const t = process.env.PULL_TOKEN;
  const h = req.headers.authorization || "";
  return Boolean(t) && h.startsWith("Bearer ") && safeEqual(h.slice(7), t);
}

module.exports = { redis, QUEUE, MAX_QUEUE, webhookAuthorized, pullAuthorized };
