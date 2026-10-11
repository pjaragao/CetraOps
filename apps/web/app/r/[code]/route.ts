import { NextResponse, type NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { classifyUserAgent, linkDestination, type ResolvedLink } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";

/** Link curto público: conta o clique (sem IP) e leva ao WhatsApp, Telegram ou página da campanha. Link pausado ou inexistente volta para a raiz. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const ua = classifyUserAgent(req.headers.get("user-agent"));
  const sp = req.nextUrl.searchParams;
  const utm: Record<string, string> = {};
  for (const k of ["utm_source", "utm_medium", "utm_campaign", "utm_content"]) { const v = sp.get(k); if (v) utm[k.slice(4)] = v.slice(0, 80); }
  const referrer = req.headers.get("referer");
  let host: string | null = null;
  try { host = referrer ? new URL(referrer).hostname : null; } catch { host = null; }

  // impressão digital curta (IP + navegador + dia, com hash): o mesmo clique repetido conta uma vez; o IP não é guardado
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || req.headers.get("x-real-ip") || "";
  const fingerprint = createHash("sha256").update(`${ip}|${req.headers.get("user-agent") ?? ""}|${new Date().toISOString().slice(0, 10)}`).digest("hex").slice(0, 24);

  const supabase = await createClient();
  const { data, error } = await (supabase as unknown as {
    rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
  }).rpc("resolve_link", {
    p_code: code,
    p_meta: { device: ua === "BOT" ? "OTHER" : ua, referrer_host: host, from_ad: sp.has("fbclid"), utm, fingerprint, bot: ua === "BOT" },
  });
  const link = error ? null : (data as unknown as ResolvedLink | null);
  const dest = link ? linkDestination(link) : null;
  if (!dest) return NextResponse.redirect(new URL("/", req.url), 302);
  return NextResponse.redirect(dest, { status: 302, headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } });
}
