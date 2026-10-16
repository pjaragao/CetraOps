// Homelab: GET lista (sem remover) os eventos mais antigos; POST {"count":n} confirma e remove os n mais antigos.
const { redis, QUEUE, pullAuthorized } = require("../lib");

module.exports = async (req, res) => {
  if (!pullAuthorized(req)) return res.status(401).json({ error: "unauthorized" });
  try {
    if (req.method === "GET") {
      const raw = await redis("LRANGE", QUEUE, -50, -1);          // cauda = mais antigos
      const events = raw.map((s) => JSON.parse(s)).reverse();      // do mais antigo ao mais novo
      return res.status(200).json({ events });
    }
    if (req.method === "POST") {
      const raw = Buffer.isBuffer(req.body) ? req.body.toString() : req.body;
      const body = typeof raw === "string" ? JSON.parse(raw || "{}") : raw || {};
      const n = Math.max(0, Math.min(50, Number(body.count) || 0));
      if (n > 0) await redis("RPOP", QUEUE, n);
      return res.status(200).json({ removed: n });
    }
    return res.status(405).json({ error: "method not allowed" });
  } catch (e) {
    return res.status(500).json({ error: "falha na fila" });
  }
};
