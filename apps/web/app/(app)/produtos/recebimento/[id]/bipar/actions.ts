"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { rpcAny } from "@/lib/rpc";
import type { Outcome, ScanFeed, ScanResult } from "./types";

const eventIds = (ids: number[]) => Array.isArray(ids) && ids.length >= 1 && ids.length <= 500 && ids.every((i) => Number.isInteger(i) && i > 0);

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

const uuidList = (ids: string[]) => Array.isArray(ids) && ids.length >= 1 && ids.length <= 20 && ids.every((i) => uuid.safeParse(i).success);

/** Várias notas bipadas juntas: o banco distribui a peça na nota que ainda precisa dela. */
export async function scanGroupAction(receiptIds: string[], code: string, qty: number, cid?: string): Promise<Outcome<ScanResult>> {
  const c = String(code ?? "").trim();
  if (!uuidList(receiptIds) || !c || c.length > 80 || !Number.isFinite(qty) || qty <= 0 || qty > 10000 || (cid != null && !uuid.safeParse(cid).success)) return { ok: false, error: "Leitura inválida" };
  try {
    const supabase = await createClient();
    const { data, error } = await rpcAny(supabase, "purch", "scan_receipts_code", { p_receipts: receiptIds, p_code: c, p_qty: qty, p_client: cid ?? null });
    if (error) return { ok: false, error: friendly(error.message), retry: !error.code || error.code.startsWith("08") || error.code === "PGRST000" };
    return { ok: true, data: data as unknown as ScanResult };
  } catch {
    return { ok: false, error: "Sem conexão com o servidor", retry: true };
  }
}

/** Quantidades e leituras novas de todas as notas juntas. */
export async function feedGroupAction(receiptIds: string[], after: number): Promise<Outcome<ScanFeed>> {
  if (!uuidList(receiptIds)) return { ok: false, error: "Recebimento inválido" };
  try {
    const supabase = await createClient();
    const { data, error } = await rpcAny(supabase, "purch", "receipts_scan_feed", { p_receipts: receiptIds, p_after: Math.max(0, Math.floor(after) || 0) });
    if (error) return { ok: false, error: friendly(error.message), retry: true };
    return { ok: true, data: data as ScanFeed };
  } catch {
    return { ok: false, error: "Sem conexão com o servidor", retry: true };
  }
}

/** Modo assistido: link temporário para o celular bipar esta nota sem entrar no sistema. */
export async function createScanLinkAction(receiptId: string, label: string, hours: number, extraReceiptIds: string[] = []): Promise<Outcome<{ id: string; token: string; expires_at: string }>> {
  if (!uuid.safeParse(receiptId).success || !Number.isInteger(hours) || hours < 1 || hours > 24 || (extraReceiptIds.length > 0 && !uuidList(extraReceiptIds))) return { ok: false, error: "Dados do link inválidos" };
  const supabase = await createClient();
  const { data, error } = await rpcAny(supabase, "purch", "create_scan_link", { p_receipt: receiptId, p_label: label.trim().slice(0, 80) || null, p_hours: hours, p_extra: extraReceiptIds });
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
  // várias notas juntas: os números vêm separados por vírgula
  const ids = String(receiptId ?? "").split(",").filter((i) => uuid.safeParse(i).success).slice(0, 20);
  for (const id of ids) revalidatePath(`/produtos/recebimento/${id}`);
  revalidatePath("/produtos/recebimento");
}

/** Resolve sobras: marca as leituras como resolvidas (engano, nota complementar pedida, peça devolvida). */
export async function discardExtrasAction(events: number[]): Promise<Outcome<number>> {
  if (!eventIds(events)) return { ok: false, error: "Leituras inválidas" };
  try {
    const supabase = await createClient();
    const { data, error } = await rpcAny(supabase, "purch", "discard_scan_extras", { p_events: events });
    if (error) return { ok: false, error: friendly(error.message), retry: !error.code || error.code.startsWith("08") };
    return { ok: true, data: Number(data) };
  } catch {
    return { ok: false, error: "Sem conexão com o servidor", retry: true };
  }
}

/** Conferência da nota: botão "Resolver" de uma sobra. */
export async function resolveExtraFormAction(formData: FormData) {
  const receiptId = String(formData.get("receipt_id") ?? "");
  const events = String(formData.get("events") ?? "").split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (!uuid.safeParse(receiptId).success) redirect("/produtos/recebimento");
  if (!eventIds(events)) redirect(`/produtos/recebimento/${receiptId}?erro=${encodeURIComponent("Leituras inválidas")}`);
  const supabase = await createClient();
  const { error } = await rpcAny(supabase, "purch", "discard_scan_extras", { p_events: events });
  revalidatePath(`/produtos/recebimento/${receiptId}`);
  revalidatePath("/produtos/recebimento");
  redirect(`/produtos/recebimento/${receiptId}?${error ? `erro=${encodeURIComponent(friendly(error.message))}` : "ok=" + encodeURIComponent("Sobra marcada como resolvida")}`);
}

/** Revisão: bipa de novo para conferir o que foi lançado (uma ou várias notas). Não muda a contagem. */
export async function reviewGroupAction(receiptIds: string[], code: string, qty: number, cid?: string): Promise<Outcome<ScanResult>> {
  const c = String(code ?? "").trim();
  if (!uuidList(receiptIds) || !c || c.length > 80 || !Number.isFinite(qty) || qty <= 0 || qty > 10000 || (cid != null && !uuid.safeParse(cid).success)) return { ok: false, error: "Leitura inválida" };
  try {
    const supabase = await createClient();
    const { data, error } = await rpcAny(supabase, "purch", "review_receipts_code", { p_receipts: receiptIds, p_code: c, p_qty: qty, p_client: cid ?? null });
    if (error) return { ok: false, error: friendly(error.message), retry: !error.code || error.code.startsWith("08") || error.code === "PGRST000" };
    return { ok: true, data: data as unknown as ScanResult };
  } catch {
    return { ok: false, error: "Sem conexão com o servidor", retry: true };
  }
}

/** Revisão: zera o que já foi conferido para revisar de novo. */
export async function resetReviewAction(receiptIds: string[]): Promise<Outcome<number>> {
  if (!uuidList(receiptIds)) return { ok: false, error: "Recebimento inválido" };
  try {
    const supabase = await createClient();
    const { data, error } = await rpcAny(supabase, "purch", "reset_receipts_review", { p_receipts: receiptIds });
    if (error) return { ok: false, error: friendly(error.message), retry: !error.code || error.code.startsWith("08") };
    return { ok: true, data: Number(data) };
  } catch {
    return { ok: false, error: "Sem conexão com o servidor", retry: true };
  }
}

/** Lote de várias NF-e: marca como finalizado (some da lista de recebimentos). */
export async function finishBatchAction(batchId: string): Promise<Outcome<true>> {
  if (!uuid.safeParse(batchId).success) return { ok: false, error: "Lote inválido" };
  try {
    const supabase = await createClient();
    const { error } = await rpcAny(supabase, "purch", "finish_receipt_batch", { p_batch: batchId });
    if (error) return { ok: false, error: friendly(error.message) };
    revalidatePath("/produtos/recebimento");
    return { ok: true, data: true };
  } catch {
    return { ok: false, error: "Sem conexão com o servidor", retry: true };
  }
}

/** Lista de recebimentos: finalizar um lote. */
export async function finishBatchFormAction(formData: FormData) {
  const id = String(formData.get("batch_id") ?? "");
  if (uuid.safeParse(id).success) {
    const supabase = await createClient();
    await rpcAny(supabase, "purch", "finish_receipt_batch", { p_batch: id });
  }
  revalidatePath("/produtos/recebimento");
  redirect("/produtos/recebimento?ok=" + encodeURIComponent("Lote finalizado"));
}
