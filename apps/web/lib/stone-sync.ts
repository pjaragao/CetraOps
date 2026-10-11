import "server-only";
import type { Json } from "@centralops/db";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPosOrder } from "@/lib/stone";

export type StoneSyncResult =
  | { ok: true; paid: true; nsu: string | null; method: "CREDIT" | "DEBIT" | "PIX"; installments: number; amount: number; authCode?: string; cardBrand?: string; orderId: string | null }
  | { ok: true; paid: false; canceled?: boolean; status: string }
  | { ok: false; error: string };

/** Chave secreta da Stone da empresa (só no servidor). */
export async function stoneSecret(orgId: string): Promise<string | null> {
  const { data } = await createAdminClient().schema("sales").rpc("stone_secret", { p_org: orgId });
  return (data as string | null) || process.env.CENTRALOPS_STONE_SECRET_KEY || null;
}

/**
 * Confere a cobrança na API da Stone (fonte da verdade) e grava o resultado. Usado pelo PDV (consulta periódica) e pelo webhook:
 * nenhum dos dois confia no que chega do navegador ou do corpo do aviso.
 */
export async function syncStoneOrder(orgId: string, stoneOrderId: string): Promise<StoneSyncResult> {
  const key = await stoneSecret(orgId);
  if (!key) return { ok: false, error: "Credencial da Stone não encontrada" };
  const admin = createAdminClient();
  const res = await getPosOrder(key, stoneOrderId);
  if (res.status === "paid" || res.charge?.paid) {
    const c = res.charge!;
    const { data, error } = await admin.schema("sales").rpc("complete_stone_pos_payment", {
      p_org: orgId, p_stone_order_id: stoneOrderId, p_paid_amount: (c.amountCents ?? 0) / 100, p_method: c.method ?? "CREDIT", p_installments: c.installments ?? 1,
      p_nsu: c.nsu ?? "", p_auth_code: c.authCode ?? undefined, p_card_brand: c.cardBrand ?? undefined, p_raw: res.raw as unknown as Json,
    });
    if (error) return { ok: false, error: error.message };
    const r = data as unknown as { ok: boolean; error?: string; nsu: string | null; method: "CREDIT" | "DEBIT" | "PIX"; installments: number; amount: number; order_id: string | null };
    if (!r.ok) return { ok: false, error: r.error ?? "Pagamento não confirmado" };
    return { ok: true, paid: true, nsu: r.nsu, method: r.method, installments: Number(r.installments), amount: Number(r.amount), authCode: c.authCode, cardBrand: c.cardBrand, orderId: r.order_id };
  }
  if (["canceled", "cancelled", "failed"].includes(res.status)) {
    const { error } = await admin.schema("sales").rpc("fail_stone_pos_order", { p_org: orgId, p_stone_order_id: stoneOrderId, p_status: res.status === "failed" ? "FAILED" : "CANCELLED" });
    if (error) return { ok: false, error: error.message };
    return { ok: true, paid: false, canceled: true, status: res.status };
  }
  return { ok: true, paid: false, status: res.status };
}
