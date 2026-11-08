"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { rpcAny } from "@/lib/rpc";
import type { Outcome, ScanFeed, ScanResult } from "./types";

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

/** Quantidades atuais, leituras novas (o celular do modo assistido ou outra pessoa bipando) e celulares ligados por link. */
export async function feedAction(receiptId: string, after: number): Promise<Outcome<ScanFeed>> {
  if (!uuid.safeParse(receiptId).success) return { ok: false, error: "Recebimento inválido" };
  try {
    const supabase = await createClient();
    const { data, error } = await rpcAny(supabase, "purch", "receipt_scan_feed", { p_receipt: receiptId, p_after: Math.max(0, Math.floor(after) || 0) });
    if (error) return { ok: false, error: friendly(error.message), retry: true };
    return { ok: true, data: data as ScanFeed };
  } catch {
    return { ok: false, error: "Sem conexão com o servidor", retry: true };
  }
}

/** Modo assistido: link temporário para o celular bipar esta nota sem entrar no sistema. */
export async function createScanLinkAction(receiptId: string, label: string, hours: number): Promise<Outcome<{ id: string; token: string; expires_at: string }>> {
  if (!uuid.safeParse(receiptId).success || !Number.isInteger(hours) || hours < 1 || hours > 24) return { ok: false, error: "Dados do link inválidos" };
  const supabase = await createClient();
  const { data, error } = await rpcAny(supabase, "purch", "create_scan_link", { p_receipt: receiptId, p_label: label.trim().slice(0, 80) || null, p_hours: hours });
  if (error) return { ok: false, error: friendly(error.message) };
  return { ok: true, data: data as { id: string; token: string; expires_at: string } };
}

/** Encerra um link (ou todos os da nota). */
export async function revokeScanLinkAction(receiptId: string, linkId: string | null): Promise<Outcome<number>> {
  if (!uuid.safeParse(receiptId).success || (linkId && !uuid.safeParse(linkId).success)) return { ok: false, error: "Link inválido" };
  const supabase = await createClient();
  const { data, error } = await rpcAny(supabase, "purch", "revoke_scan_link", { p_receipt: receiptId, p_link: linkId });
  if (error) return { ok: false, error: friendly(error.message) };
  return { ok: true, data: Number(data) };
}

/** Ao sair da tela: a conferência (e a lista de recebimentos) mostra o que foi bipado. */
export async function refreshReceiptAction(receiptId: string): Promise<void> {
  if (!uuid.safeParse(receiptId).success) return;
  revalidatePath(`/produtos/recebimento/${receiptId}`);
  revalidatePath("/produtos/recebimento");
}
