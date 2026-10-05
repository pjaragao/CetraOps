"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { Json } from "@centralops/db";
import { createClient } from "@/lib/supabase/server";

const friendly = (m: string) => m.replace(/^ERROR:\s*/, "");
const str = (v: FormDataEntryValue | null) => String(v ?? "").trim();
const PATH = "/atendimento/automacoes";

function go(params: Record<string, string | undefined> = {}): never {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString();
  redirect(q ? `${PATH}?${q}` : PATH);
}

export async function saveAutomationAction(formData: FormData) {
  const id = str(formData.get("id"));
  const trigger = str(formData.get("trigger"));
  const keywords = str(formData.get("keywords")).split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  const conditions: Record<string, unknown> = {};
  if (trigger === "KEYWORD" || trigger === "COMMENT_KEYWORD") conditions.keywords = keywords;
  if (trigger === "BIRTHDAY") conditions.days_before = Number(str(formData.get("days_before")) || 0);
  if (trigger === "INACTIVITY") conditions.days = Number(str(formData.get("days")) || 60);

  const actions: Record<string, unknown>[] = [];
  for (let i = 0; i < 3; i++) {
    const type = str(formData.get(`a${i}_type`));
    if (!type) continue;
    const text = str(formData.get(`a${i}_text`)), extra = str(formData.get(`a${i}_extra`)), hours = str(formData.get(`a${i}_hours`));
    if (type === "SEND_TEXT" || type === "PRIVATE_REPLY") actions.push({ type, text });
    else if (type === "ADD_TAG") actions.push({ type, tag: text });
    else if (type === "CREATE_TASK") actions.push({ type, title: text, suggested_message: extra, due_in_hours: hours === "" ? 24 : Number(hours) });
    else if (type === "HANDOFF") actions.push({ type });
  }
  const supabase = await createClient();
  const { error } = await supabase.schema("omni").rpc("save_automation", { p: {
    ...(id ? { id } : {}), name: str(formData.get("name")), trigger, channel_account_id: str(formData.get("channel_account_id")) || null, conditions, actions,
    ...(str(formData.get("cooldown_days")) !== "" ? { cooldown_days: Number(str(formData.get("cooldown_days"))) } : {}),
  } as Json });
  revalidatePath(PATH);
  if (error) go({ erro: friendly(error.message), ...(id ? { editar: id } : { novo: trigger }) });
  go({ ok: id ? "Automação atualizada." : "Automação criada, mas desligada: confira e ligue quando estiver pronta." });
}

export async function toggleAutomationAction(formData: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.schema("omni").rpc("set_automation_active", { p_id: str(formData.get("id")), p_active: str(formData.get("active")) === "1" });
  revalidatePath(PATH);
  go(error ? { erro: friendly(error.message) } : { ok: str(formData.get("active")) === "1" ? "Automação ligada." : "Automação desligada." });
}

export async function deleteAutomationAction(formData: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.schema("omni").rpc("delete_automation", { p_id: str(formData.get("id")) });
  revalidatePath(PATH);
  go(error ? { erro: friendly(error.message) } : { ok: "Automação excluída." });
}

export async function testAutomationAction(formData: FormData) {
  const supabase = await createClient();
  const text = str(formData.get("text"));
  const { data, error } = await supabase.schema("omni").rpc("test_automation", { p_id: str(formData.get("id")), p_text: text });
  go(error ? { erro: friendly(error.message) } : { ok: data ? `Dispararia com: “${text}”` : `Não dispararia com: “${text}”` });
}
