"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import type { ItemCount, Outcome, ScanResult } from "./types";

const uuid = z.string().uuid();
const friendly = (m: string) => m.replace(/^ERROR:\s*/, "");

/** Uma leitura do leitor: o banco acha o item da nota e soma (sem passar da nota). */
export async function scanCodeAction(receiptId: string, code: string, qty: number): Promise<Outcome<ScanResult>> {
  const c = String(code ?? "").trim();
  if (!uuid.safeParse(receiptId).success || !c || c.length > 80 || !Number.isFinite(qty) || qty <= 0 || qty > 10000) return { ok: false, error: "Leitura inválida" };
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.schema("purch").rpc("scan_receipt_code", { p_receipt: receiptId, p_code: c, p_qty: qty });
    if (error) return { ok: false, error: friendly(error.message), retry: !error.code || error.code.startsWith("08") || error.code === "PGRST000" };
    return { ok: true, data: data as unknown as ScanResult };
  } catch {
    return { ok: false, error: "Sem conexão com o servidor", retry: true };
  }
}

/** +/− na tela ou desfazer uma leitura (soma relativa, entre 0 e a quantidade da nota). */
export async function bumpItemAction(itemId: string, delta: number): Promise<Outcome<ScanResult>> {
  if (!uuid.safeParse(itemId).success || !Number.isFinite(delta) || delta === 0 || Math.abs(delta) > 10000) return { ok: false, error: "Quantidade inválida" };
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.schema("purch").rpc("bump_receipt_item", { p_item: itemId, p_delta: delta });
    if (error) return { ok: false, error: friendly(error.message) };
    return { ok: true, data: { ...(data as unknown as ScanResult), status: "OK" } };
  } catch {
    return { ok: false, error: "Sem conexão com o servidor", retry: true };
  }
}

/** Quantidades atuais (outra pessoa pode estar bipando a mesma nota em outro aparelho). */
export async function itemCountsAction(receiptId: string): Promise<Outcome<{ status: string; items: ItemCount[] }>> {
  if (!uuid.safeParse(receiptId).success) return { ok: false, error: "Recebimento inválido" };
  try {
    const supabase = await createClient();
    const [{ data: rc }, { data, error }] = await Promise.all([
      supabase.schema("purch").from("receipts").select("status").eq("id", receiptId).maybeSingle(),
      supabase.schema("purch").from("receipt_items").select("id, qty_counted, qty_nfe").eq("receipt_id", receiptId),
    ]);
    if (error || !rc) return { ok: false, error: error ? friendly(error.message) : "Recebimento não encontrado", retry: true };
    return { ok: true, data: { status: rc.status, items: (data ?? []).map((r) => ({ item_id: r.id, qty_counted: Number(r.qty_counted ?? 0), qty_nfe: Number(r.qty_nfe) })) } };
  } catch {
    return { ok: false, error: "Sem conexão com o servidor", retry: true };
  }
}

/** Ao sair da tela: a conferência (e a lista de recebimentos) mostra o que foi bipado. */
export async function refreshReceiptAction(receiptId: string): Promise<void> {
  if (!uuid.safeParse(receiptId).success) return;
  revalidatePath(`/produtos/recebimento/${receiptId}`);
  revalidatePath("/produtos/recebimento");
}
