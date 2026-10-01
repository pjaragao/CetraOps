"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

const str = (v: FormDataEntryValue | null) => String(v ?? "").trim();
const clean = (m: string) => m.replace(/^ERROR:\s*/, "");

/** Abre (ou acha) a conversa de WhatsApp da cliente e leva a mensagem pronta para a caixa de texto. */
export async function openWithMessageAction(formData: FormData) {
  const supabase = await createClient();
  const { data, error } = await supabase.schema("omni").rpc("open_conversation_for", { p_party: str(formData.get("party_id")) });
  if (error) redirect(`/inicio?${new URLSearchParams({ erro: clean(error.message) })}`);
  const q = new URLSearchParams({ c: String(data), msg: str(formData.get("message")), tarefa: str(formData.get("task_id")) });
  redirect(`/atendimento?${q}`);
}

export async function finishTaskAction(formData: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.schema("crm").rpc("finish_task", { p_id: str(formData.get("task_id")), p_status: str(formData.get("status")), p_note: str(formData.get("note")) || undefined });
  revalidatePath("/inicio");
  redirect(`/inicio?${new URLSearchParams(error ? { erro: clean(error.message) } : { ok: str(formData.get("status")) === "DONE" ? "Feito" : "Pulado" })}`);
}

export async function snoozeTaskAction(formData: FormData) {
  const supabase = await createClient();
  const tomorrow = new Date(Date.now() + 86400000);
  tomorrow.setUTCHours(13, 0, 0, 0);                                        // 10h em Brasília
  const { error } = await supabase.schema("crm").rpc("reschedule_task", { p_id: str(formData.get("task_id")), p_due: tomorrow.toISOString() });
  revalidatePath("/inicio");
  redirect(`/inicio?${new URLSearchParams(error ? { erro: clean(error.message) } : { ok: "Reagendado para amanhã" })}`);
}
