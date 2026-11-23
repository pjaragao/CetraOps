// Webhook da Meta (WhatsApp Cloud API e Instagram): repassa na hora ao CetraOps no homelab (Tailscale Funnel → nginx → /api/webhooks/meta),
// pelo mesmo caminho e segredo do app do PDV (POS_UPSTREAM + POS_RELAY_SECRET). Nada é guardado nem conferido aqui: quem confere a
// assinatura (X-Hub-Signature-256) e o token do handshake é o CetraOps. Se o homelab não responder, devolve 5xx e a Meta reenvia.
//
// Usa a assinatura Web (Request → Response) e lê os BYTES do corpo: o handler clássico da Vercel entrega o JSON já interpretado, e
// remontá-lo muda os bytes (a Meta escapa é e \/) — a assinatura deixaria de bater.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const env: Record<string, string | undefined> = (globalThis as any).process?.env ?? {};

const FORWARD = ["content-type", "x-hub-signature-256", "user-agent"];

export async function handle(request: Request, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const upstream = (env.META_UPSTREAM || env.POS_UPSTREAM || "").replace(/\/+$/, "");
  const secret = env.META_RELAY_SECRET || env.POS_RELAY_SECRET || "";
  if (!upstream || !secret) return Response.json({ error: "relay da Meta não configurado" }, { status: 503 });
  if (request.method !== "GET" && request.method !== "POST") return Response.json({ error: "method not allowed" }, { status: 405 });

  const headers: Record<string, string> = { "X-Relay-Secret": secret };
  for (const h of FORWARD) {
    const v = request.headers.get(h);
    if (v) headers[h] = v;
  }
  const qs = new URL(request.url).search;                                       // hub.mode / hub.verify_token / hub.challenge no handshake
  try {
    const r = await fetchImpl(`${upstream}/api/webhooks/meta${qs}`, {
      method: request.method,
      headers,
      body: request.method === "POST" ? await request.arrayBuffer() : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    if (r.status >= 300 && r.status < 400) return Response.json({ error: "servidor da loja respondeu com redirecionamento" }, { status: 502 });
    return new Response(await r.arrayBuffer(), { status: r.status, headers: { "content-type": r.headers.get("content-type") ?? "text/plain" } });
  } catch {
    return Response.json({ error: "servidor da loja fora do ar" }, { status: 504 });   // a Meta reenvia
  }
}

export function GET(request: Request) {
  return handle(request);
}

export function POST(request: Request) {
  return handle(request);
}
