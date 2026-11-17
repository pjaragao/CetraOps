import "server-only";
import type { Json } from "@centralops/db";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { cancelPosOrder, getPosOrder } from "@/lib/stone";

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
 * Cancela na Stone (e só então no banco) a cobrança de um pedido. Cobranças do app no terminal (DEEPLINK)
 * não existem no Pagar.me: só o banco é atualizado. Se a Stone não confirmar, o banco não é tocado.
 */
export async function cancelStoneCharge(orgId: string, stoneOrderId: string, source: string | null): Promise<{ ok: true } | { ok: false; error: string }> {
  if (source !== "DEEPLINK") {
    const key = await stoneSecret(orgId);
    if (!key) return { ok: false, error: "Credencial da Stone não encontrada" };
    const r = await cancelPosOrder(key, stoneOrderId);
    if (!r.ok) return { ok: false, error: r.error || "A Stone não confirmou o cancelamento" };
  }
  const supabase = await createClient();
  const { error } = await supabase.schema("sales").rpc("cancel_stone_pos_order", { p_stone_order_id: stoneOrderId });
  return error ? { ok: false, error: error.message } : { ok: true };
}

/** Cancela na maquininha todas as cobranças pendentes de um pedido (use antes de cancelar o pedido). */
export async function cancelStoneChargesForOrder(orgId: string, orderId: string): Promise<{ ok: true; canceled: number } | { ok: false; error: string }> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema("sales").from("stone_pos_orders").select("stone_order_id, source").eq("order_id", orderId).eq("status", "PENDING");
  if (error) return { ok: false, error: error.message };
  let canceled = 0;
  for (const row of data ?? []) {
    const r = await cancelStoneCharge(orgId, row.stone_order_id, row.source ?? null);
    if (!r.ok) return r;
    canceled++;
  }
  return { ok: true, canceled };
}

export interface ReleaseTerminalSummary { released: number; alreadyClosed: number; paid: number; errors: string[] }

/**
 * Libera uma maquininha presa: confere na Stone as cobranças recentes (pendentes ou marcadas como canceladas só no banco)
 * e cancela as que seguem abertas. Se a Stone diz que foi paga, sincroniza em vez de cancelar.
 */
export async function releaseStoneTerminal(orgId: string, serial: string): Promise<{ ok: true; summary: ReleaseTerminalSummary } | { ok: false; error: string }> {
  const key = await stoneSecret(orgId);
  if (!key) return { ok: false, error: "Credencial da Stone não encontrada" };
  const supabase = await createClient();
  const since = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
  const { data, error } = await supabase.schema("sales").from("stone_pos_orders").select("stone_order_id, source")
    .eq("terminal_serial", serial).in("status", ["PENDING", "CANCELLED"]).gte("created_at", since);
  if (error) return { ok: false, error: error.message };
  const summary: ReleaseTerminalSummary = { released: 0, alreadyClosed: 0, paid: 0, errors: [] };
  for (const row of (data ?? []).filter((r) => r.source !== "DEEPLINK")) {
    const id = row.stone_order_id;
    try {
      const cur = await getPosOrder(key, id);
      if (cur.status === "paid") {
        const s = await syncStoneOrder(orgId, id);
        if (s.ok) summary.paid++; else summary.errors.push(`${id}: ${s.error}`);
        continue;
      }
      if (["canceled", "cancelled", "failed"].includes(cur.status) || cur.raw.closed === true) { summary.alreadyClosed++; continue; }
      const r = await cancelPosOrder(key, id);
      if (!r.ok) { summary.errors.push(`${id}: ${r.error || "não cancelou"}`); continue; }
      await supabase.schema("sales").rpc("cancel_stone_pos_order", { p_stone_order_id: id });
      summary.released++;
    } catch (e) {
      summary.errors.push(`${id}: ${(e as Error).message}`);
    }
  }
  return { ok: true, summary };
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
