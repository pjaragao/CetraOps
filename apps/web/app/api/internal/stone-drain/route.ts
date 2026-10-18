import { timingSafeEqual, createHash } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { syncStoneOrder } from "@/lib/stone-sync";

/**
 * Consome a fila do relay público (Vercel) e confere cada ordem na API da Stone, como o webhook direto faz. Chamado por um cron do homelab.
 * Protegido por CRON_SECRET; sem STONE_RELAY_URL/STONE_RELAY_PULL_TOKEN não faz nada. O corpo do aviso é só uma dica de qual ordem conferir.
 */
const sha = (s: string) => createHash("sha256").update(s).digest();

export async function POST(request: Request) {
  const secret = process.env.CENTRALOPS_CRON_SECRET;
  const got = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
  if (!secret || !timingSafeEqual(sha(got), sha(secret))) return Response.json({ error: "unauthorized" }, { status: 401 });

  const base = process.env.STONE_RELAY_URL?.replace(/\/$/, "");
  const token = process.env.STONE_RELAY_PULL_TOKEN;
  if (!base || !token) return Response.json({ error: "relay não configurado" }, { status: 503 });
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const pulled = await fetch(`${base}/api/pull`, { headers, cache: "no-store" });
  if (!pulled.ok) return Response.json({ error: `relay respondeu ${pulled.status}` }, { status: 502 });
  const { events } = (await pulled.json()) as { events: { stone_order_id?: string; type?: string }[] };

  const admin = createAdminClient();
  let done = 0;
  const results: Record<string, unknown>[] = [];
  for (const ev of events) {
    const id = ev.stone_order_id ?? "";
    if (!/^[A-Za-z0-9_-]{4,64}$/.test(id)) { done++; continue; }
    const { data: row, error } = await admin.schema("sales").from("stone_pos_orders").select("org_id, status, source").eq("stone_order_id", id).maybeSingle();
    if (error) break;                                   // mantém na fila e tenta de novo no próximo ciclo
    // cobrança do app da maquininha (DEEPLINK) não existe no Pagar.me: pula em vez de travar a fila
    if (!row || row.status !== "PENDING" || row.source === "DEEPLINK") { done++; results.push({ id, skipped: row?.status ?? "desconhecida" }); continue; }
    const r = await syncStoneOrder(row.org_id, id);
    if (!r.ok) { results.push({ id, error: r.error }); break; }
    done++;
    results.push({ id, paid: r.paid });
  }
  if (done > 0) await fetch(`${base}/api/pull`, { method: "POST", headers, body: JSON.stringify({ count: done }) });
  return Response.json({ pulled: events.length, confirmed: done, results });
}
