"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { Json } from "@centralops/db";
import { createClient } from "@/lib/supabase/server";
import { getSession } from "@/lib/session";

const friendly = (m: string) => m.replace(/^ERROR:\s*/, "");
const str = (v: FormDataEntryValue | null) => String(v ?? "").trim();
const BASE = "/financeiro/reembolsos";
type State = { ok: boolean; error?: string } | null;

function go(path: string, params: Record<string, string | undefined>): never {
  revalidatePath(BASE, "layout");
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString();
  redirect(q ? `${path}?${q}` : path);
}

/** Cria ou edita o rascunho (itens inteiros no payload JSON). */
export async function saveReimbursementAction(_prev: State, formData: FormData): Promise<State> {
  let p: unknown;
  try { p = JSON.parse(str(formData.get("payload"))); } catch { return { ok: false, error: "Dados inválidos" }; }
  const supabase = await createClient();
  const { data, error } = await supabase.schema("fin").rpc("save_reimbursement", { p: p as Json });
  if (error) return { ok: false, error: friendly(error.message) };
  const id = (data as unknown as { id: string }).id;
  go(`${BASE}/${id}`, { ok: "Reembolso salvo. Anexe as notas/recibos e envie para aprovação." });
}

/** Foto ou PDF do comprovante: vai para o Storage (bucket privado fin-docs, pasta da empresa) e fica ligado à despesa. */
export async function uploadAttachmentAction(formData: FormData) {
  const id = str(formData.get("reimbursement_id"));
  const item = str(formData.get("item_id"));
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) go(`${BASE}/${id}`, { erro: "Escolha a foto ou o PDF do comprovante" });
  const f = file as File;
  if (f.size > 10 * 1024 * 1024) go(`${BASE}/${id}`, { erro: "Arquivo maior que 10 MB: tire uma foto menor ou envie o PDF" });
  const session = await getSession();
  const safe = f.name.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-zA-Z0-9._-]+/g, "-").slice(-80) || "comprovante";
  const path = `${session.orgId}/reembolsos/${id}/${item}-${Date.now()}-${safe}`;
  const supabase = await createClient();
  const up = await supabase.storage.from("fin-docs").upload(path, f, { contentType: f.type || "application/octet-stream", upsert: false });
  if (up.error) go(`${BASE}/${id}`, { erro: `Não consegui guardar o arquivo: ${up.error.message}` });
  const { error } = await supabase.schema("fin").rpc("set_reimbursement_attachment", { p_item: item, p_path: path, p_name: f.name });
  go(`${BASE}/${id}`, error ? { erro: friendly(error.message) } : { ok: "Comprovante anexado" });
}

export async function submitReimbursementAction(formData: FormData) {
  const id = str(formData.get("id"));
  const supabase = await createClient();
  const { error } = await supabase.schema("fin").rpc("submit_reimbursement", { p_id: id });
  go(`${BASE}/${id}`, error ? { erro: friendly(error.message) } : { ok: "Enviado para aprovação. Você é avisado quando decidirem." });
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
