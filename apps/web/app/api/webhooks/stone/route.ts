import { createAdminClient } from "@/lib/supabase/admin";
import { syncStoneOrder } from "@/lib/stone-sync";

/**
 * Aviso (postback) da Stone / Pagar.me. O corpo NÃO é fonte de verdade: só diz qual ordem conferir. A situação é lida na API da Stone
 * com a chave da empresa dona da ordem; um aviso falso, no máximo, provoca uma conferência a mais. Ordem desconhecida é ignorada.
 */
export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "JSON inválido" }, { status: 400 });
  }
  const data = (body.data ?? {}) as Record<string, unknown>;
  const order = (data.order ?? {}) as Record<string, unknown>;
  const stoneOrderId = String(order.id ?? data.id ?? "");
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(stoneOrderId)) return Response.json({ received: true, ignored: "sem ordem" });

  const admin = createAdminClient();
  const { data: row, error } = await admin.schema("sales").from("stone_pos_orders").select("org_id, status, source").eq("stone_order_id", stoneOrderId).maybeSingle();
  if (error) return Response.json({ error: "falha ao consultar" }, { status: 500 });          // a Stone reenvia
  if (!row) return Response.json({ received: true, ignored: "ordem desconhecida" });
  if (row.source === "DEEPLINK") return Response.json({ received: true, ignored: "cobrança do app da maquininha" });   // não existe no Pagar.me
  if (row.status !== "PENDING") return Response.json({ received: true, status: row.status });

  const res = await syncStoneOrder(row.org_id, stoneOrderId);
  if (!res.ok) return Response.json({ received: true, error: res.error }, { status: 500 });
  return Response.json({ received: true, paid: res.paid });
}
