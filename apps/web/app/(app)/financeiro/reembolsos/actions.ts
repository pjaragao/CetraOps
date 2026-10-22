"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { Json } from "@centralops/db";
import { createClient } from "@/lib/supabase/server";
import { getSession } from "@/lib/session";
import { bulkFlash, bulkIds, runBulk } from "@/lib/bulk";

const friendly = (m: string) => m.replace(/^ERROR:\s*/, "");
const str = (v: FormDataEntryValue | null) => String(v ?? "").trim();
const BASE = "/financeiro/reembolsos";
type State = { ok: boolean; error?: string } | null;

function go(path: string, params: Record<string, string | undefined>): never {
  revalidatePath(BASE, "layout");
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString();
  redirect(q ? `${path}?${q}` : path);
}

/**
 * Cria ou edita o rascunho (itens inteiros no payload JSON). Os comprovantes vão no mesmo envio (`file_<n>`, um por despesa,
 * na ordem da tela) e o botão "Enviar para aprovação" (`then=submit`) salva e já envia, num passo só.
 */
export async function saveReimbursementAction(_prev: State, formData: FormData): Promise<State> {
  let p: unknown;
  try { p = JSON.parse(str(formData.get("payload"))); } catch { return { ok: false, error: "Dados inválidos" }; }
  const files = (p as { items?: unknown[] }).items?.map((_, i) => formData.get(`file_${i}`)) ?? [];
  for (const f of files) if (f instanceof File && f.size > MAX_FILE) return { ok: false, error: `${f.name}: arquivo maior que 10 MB, tire uma foto menor ou envie o PDF` };
  const supabase = await createClient();
  const { data, error } = await supabase.schema("fin").rpc("save_reimbursement", { p: p as Json });
  if (error) return { ok: false, error: friendly(error.message) };
  const id = (data as unknown as { id: string }).id;

  // a despesa n da tela é a posição n no banco
  const problems: string[] = [];
  if (files.some((f) => f instanceof File && f.size > 0)) {
    const session = await getSession();
    const { data: items } = await supabase.schema("fin").from("reimbursement_items").select("id, position").eq("reimbursement_id", id).order("position");
    for (const [i, f] of files.entries()) {
      const item = (items ?? []).find((x) => x.position === i + 1);
      if (!(f instanceof File) || f.size === 0 || !item) continue;
      const err = await storeAttachment(session.orgId, id, item.id, f);
      if (err) problems.push(`despesa ${i + 1}: ${err}`);
    }
  }
  if (problems.length) go(`${BASE}/${id}`, { erro: `Salvo, mas o comprovante não subiu (${problems.join("; ")})` });
  if (str(formData.get("then")) === "submit") {
    const { error: e2 } = await supabase.schema("fin").rpc("submit_reimbursement", { p_id: id });
    go(`${BASE}/${id}`, e2 ? { erro: `Salvo, mas ainda não dá para enviar: ${friendly(e2.message)}` } : { ok: "Enviado para aprovação. Você é avisado quando decidirem." });
  }
  go(`${BASE}/${id}`, { ok: "Reembolso salvo. Confira os comprovantes e envie para aprovação." });
}

const MAX_FILE = 10 * 1024 * 1024;

/** Guarda a foto/PDF no Storage (bucket privado fin-docs, pasta da empresa) e liga à despesa. Devolve o erro, se houver. */
async function storeAttachment(orgId: string, reimbursementId: string, itemId: string, f: File): Promise<string | null> {
  const safe = f.name.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-zA-Z0-9._-]+/g, "-").slice(-80) || "comprovante";
  const path = `${orgId}/reembolsos/${reimbursementId}/${itemId}-${Date.now()}-${safe}`;
  const supabase = await createClient();
  const up = await supabase.storage.from("fin-docs").upload(path, f, { contentType: f.type || "application/octet-stream", upsert: false });
  if (up.error) return `não consegui guardar o arquivo: ${up.error.message}`;
  const { error } = await supabase.schema("fin").rpc("set_reimbursement_attachment", { p_item: itemId, p_path: path, p_name: f.name });
  return error ? friendly(error.message) : null;
}

export async function decideReimbursementAction(formData: FormData) {
  const id = str(formData.get("id"));
  const approve = str(formData.get("decision")) === "approve";
  const supabase = await createClient();
  const { error } = await supabase.schema("fin").rpc("decide_reimbursement", {
    p_id: id, p_approve: approve, p_reason: str(formData.get("reason")) || undefined, p_due_date: str(formData.get("due_date")) || undefined,
  });
  go(`${BASE}/${id}`, error ? { erro: friendly(error.message) } : { ok: approve ? "Aprovado: virou conta a pagar para a pessoa." : "Recusado: a pessoa foi avisada para corrigir." });
}

export async function classifyItemAction(formData: FormData) {
  const id = str(formData.get("reimbursement_id"));
  const supabase = await createClient();
  const { error } = await supabase.schema("fin").rpc("classify_reimbursement_item", {
    p_item: str(formData.get("item_id")), p_account: (str(formData.get("account")) || null) as string, p_cost_center: (str(formData.get("cost_center")) || null) as string,
  });
  go(`${BASE}/${id}`, error ? { erro: friendly(error.message) } : { ok: "Classificação salva" });
}

export async function cancelReimbursementAction(formData: FormData) {
  const id = str(formData.get("id"));
  const supabase = await createClient();
  const { error } = await supabase.schema("fin").rpc("cancel_reimbursement", { p_id: id });
  go(error ? `${BASE}/${id}` : BASE, error ? { erro: friendly(error.message) } : { ok: "Reembolso cancelado" });
}

// ---- em lote (lista de reembolsos) ----

/** Número de cada reembolso, para a mensagem de erro do lote dizer qual falhou. */
async function numbers(ids: string[]) {
  const supabase = await createClient();
  const { data } = await supabase.schema("fin").from("reimbursements").select("id, number").in("id", ids);
  const m = new Map((data ?? []).map((r) => [r.id, r.number as string]));
  return (id: string) => m.get(id) ?? "";
}

function goList(formData: FormData, flash: { ok?: string; erro?: string }): never {
  return go(BASE, { filtro: str(formData.get("filtro")) || undefined, ...flash });
}

export async function approveManyReimbursementsAction(formData: FormData) {
  const ids = bulkIds(formData);
  const supabase = await createClient();
  const due = str(formData.get("due_date")) || undefined;
  const r = await runBulk(ids, (id) => supabase.schema("fin").rpc("decide_reimbursement", { p_id: id, p_approve: true, p_due_date: due }), await numbers(ids));
  goList(formData, bulkFlash(r, (n) => `${n} reembolso(s) aprovado(s): viraram contas a pagar para as pessoas.`));
}

export async function rejectManyReimbursementsAction(formData: FormData) {
  const ids = bulkIds(formData);
  const supabase = await createClient();
  const reason = str(formData.get("reason"));
  const r = await runBulk(ids, (id) => supabase.schema("fin").rpc("decide_reimbursement", { p_id: id, p_approve: false, p_reason: reason }), await numbers(ids));
  goList(formData, bulkFlash(r, (n) => `${n} reembolso(s) recusado(s): as pessoas foram avisadas para corrigir.`));
}

export async function submitManyReimbursementsAction(formData: FormData) {
  const ids = bulkIds(formData);
  const supabase = await createClient();
  const r = await runBulk(ids, (id) => supabase.schema("fin").rpc("submit_reimbursement", { p_id: id }), await numbers(ids));
  goList(formData, bulkFlash(r, (n) => `${n} reembolso(s) enviado(s) para aprovação.`));
}

export async function cancelManyReimbursementsAction(formData: FormData) {
  const ids = bulkIds(formData);
  const supabase = await createClient();
  const r = await runBulk(ids, (id) => supabase.schema("fin").rpc("cancel_reimbursement", { p_id: id }), await numbers(ids));
  goList(formData, bulkFlash(r, (n) => `${n} reembolso(s) cancelado(s).`));
}
