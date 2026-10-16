// Recebe o webhook da Stone/Pagar.me. Guarda só o que o homelab precisa para conferir na API da Stone (o corpo não é fonte de verdade).
const { redis, QUEUE, MAX_QUEUE, webhookAuthorized } = require("../lib");

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });
  if (!webhookAuthorized(req)) return res.status(401).json({ error: "unauthorized" });
  const b = typeof req.body === "string" ? safeParse(req.body) : req.body;
  if (!b || typeof b !== "object") return res.status(400).json({ error: "JSON inválido" });
  const d = b.data || {};
  const evt = {
    hook_id: String(b.id || ""),
    type: String(b.type || ""),
    stone_order_id: String((d.order && d.order.id) || ""),
    charge_id: String(d.id || ""),
    received_at: new Date().toISOString(),
    // corpo completo guardado para auditoria/diagnóstico (a Stone documenta payload pequeno)
    body: b,
  };
  try {
    await redis("LPUSH", QUEUE, JSON.stringify(evt));
    await redis("LTRIM", QUEUE, 0, MAX_QUEUE - 1);
  } catch (e) {
    return res.status(500).json({ error: "falha ao enfileirar" });   // a Stone reenvia
  }
  return res.status(200).json({ received: true });
};

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }
