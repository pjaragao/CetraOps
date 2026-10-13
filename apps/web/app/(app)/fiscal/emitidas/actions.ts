"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export type State = { ok: boolean; error?: string; message?: string } | null;

const friendly = (m: string) => m.replace(/^ERROR:\s*/, "");
const str = (v: FormDataEntryValue | null) => String(v ?? "").trim();
const PATH = "/fiscal/emitidas";

/** Emite (ou reenvia, com a mesma referência) a nota de uma venda. A emissão em si é do worker: o resultado aparece na lista em instantes. */
export async function requestEmissionAction(formData: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.schema("fiscal").rpc("request_emission", { p_order: str(formData.get("order_id")) });
  revalidatePath(PATH);
  const q = error ? `erro=${encodeURIComponent(friendly(error.message))}` : `ok=${encodeURIComponent("Emissão pedida: o resultado aparece em instantes.")}&wait=1`;
  redirect(`${PATH}?${q}`);
}

export async function cancelDocumentAction(_prev: State, formData: FormData): Promise<State> {
  const reason = str(formData.get("reason"));
  if (reason.length < 15 || reason.length > 255) return { ok: false, error: "A justificativa precisa ter de 15 a 255 caracteres." };
  const supabase = await createClient();
  const { error } = await supabase.schema("fiscal").rpc("request_cancellation", { p_document: str(formData.get("document_id")), p_reason: reason });
  if (error) return { ok: false, error: friendly(error.message) };
  revalidatePath(PATH);
  return { ok: true, message: "Cancelamento pedido: a SEFAZ responde em instantes." };
}

/** Inutiliza o número de uma NFC-e rejeitada que não vai ser reenviada (emissão direta na SEFAZ). */
export async function voidNumberAction(_prev: State, formData: FormData): Promise<State> {
  const reason = str(formData.get("reason"));
  if (reason.length < 15 || reason.length > 255) return { ok: false, error: "A justificativa precisa ter de 15 a 255 caracteres." };
  const supabase = await createClient();
  const { error } = await supabase.schema("fiscal").rpc("request_number_void", { p_document: str(formData.get("document_id")), p_reason: reason });
  if (error) return { ok: false, error: friendly(error.message) };
  revalidatePath(PATH);
  return { ok: true, message: "Inutilização pedida: a SEFAZ responde em instantes." };
}
