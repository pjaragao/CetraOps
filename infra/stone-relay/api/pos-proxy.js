// App do PDV na maquininha: repassa /api/pos/* ao CetraOps no homelab (Tailscale Funnel, porta só para /api/pos com o segredo do relay).
// Assim o terminal fala com um único domínio HTTPS (o que entra na lista de URLs liberadas da Stone). Nada é guardado aqui;
// quem autentica é o próprio CetraOps (token da maquininha + JWT do operador).
const UPSTREAM = (process.env.POS_UPSTREAM || "").replace(/\/+$/, "");
const SECRET = process.env.POS_RELAY_SECRET || "";
const FORWARD = ["content-type", "authorization", "x-device-token", "x-app-version", "if-none-match", "accept"];
const BACK = ["content-type", "etag", "cache-control"];

async function rawBody(req) {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  if (req.body !== undefined) {                                  // a Vercel já leu o corpo
    if (Buffer.isBuffer(req.body)) return req.body;
    return Buffer.from(typeof req.body === "string" ? req.body : JSON.stringify(req.body));
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

module.exports = async (req, res) => {
  if (!UPSTREAM || !SECRET) return res.status(503).json({ error: "Relay do PDV não configurado" });
  const url = new URL(req.url, "http://x");
  const path = String(url.searchParams.get("path") || "");
  url.searchParams.delete("path");
  if (!/^[A-Za-z0-9_\-/.%]{1,200}$/.test(path) || path.includes("..")) return res.status(404).json({ error: "Rota inválida" });

  const headers = { "X-Relay-Secret": SECRET };
  for (const h of FORWARD) if (req.headers[h]) headers[h] = req.headers[h];
  const ip = String(req.headers["x-real-ip"] || req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  if (ip) headers["X-Real-IP"] = ip;                             // limite de tentativas do CetraOps é por IP do terminal

  const qs = url.searchParams.toString();
  try {
    const r = await fetch(`${UPSTREAM}/api/pos/${path}${qs ? `?${qs}` : ""}`, {
      method: req.method, headers, body: await rawBody(req), redirect: "manual", signal: AbortSignal.timeout(28_000),
    });
    for (const h of BACK) { const v = r.headers.get(h); if (v) res.setHeader(h, v); }
    if (r.status >= 300 && r.status < 400 && r.status !== 304) return res.status(502).json({ error: "Servidor da loja respondeu com redirecionamento (versão sem o app do PDV?)" });
    res.status(r.status);
    return res.end(r.status === 304 ? undefined : Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    return res.status(504).json({ error: "Servidor da loja fora do ar. Tente de novo em instantes." });
  }
};
