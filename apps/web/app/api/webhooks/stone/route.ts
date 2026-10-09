import { createClient } from "@supabase/supabase-js";
import type { Database } from "@centralops/db";

/** Endpoint de postback / webhook do Connect Stone (Pagar.me v5). */
export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const type = String(body.type ?? "").toLowerCase();
  const data = (body.data ?? {}) as Record<string, unknown>;
  const order = (data.order ?? {}) as Record<string, unknown>;

  const stoneOrderId = String(order.id ?? data.id ?? "");
  if (!stoneOrderId) {
    return Response.json({ received: true, ignored: "no order id" });
  }

  // Se o evento é de pagamento confirmado
  if (type === "charge.paid" || type === "order.paid") {
    const meta = (data.metadata ?? order.metadata ?? {}) as Record<string, unknown>;
    const lastTx = (data.last_transaction ?? {}) as Record<string, unknown>;
    const nsu = String(data.code ?? meta.authorization_code ?? meta.initiator_transaction_key ?? lastTx.id ?? "STONE-WEBHOOK");
    const authCode = String(meta.authorization_code ?? meta.authorizationCode ?? "");
    const cardBrand = String(meta.scheme_name ?? meta.schemeName ?? "");

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL || "http://127.0.0.1:55321";
    const serviceKey = process.env.CENTRALOPS_SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

    const supabase = createClient<Database>(url, serviceKey);
    const sales = (supabase as unknown as { schema: (s: string) => { rpc: (name: string, args: Record<string, unknown>) => Promise<unknown> } }).schema("sales");
    await sales.rpc("complete_stone_pos_payment", {
      p_stone_order_id: stoneOrderId,
      p_nsu: nsu,
      p_auth_code: authCode || null,
      p_card_brand: cardBrand || null,
      p_raw: body as unknown as Record<string, unknown>,
    });
  }

  return Response.json({ received: true });
}
