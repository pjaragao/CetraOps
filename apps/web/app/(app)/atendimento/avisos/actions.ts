"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { Json } from "@sie/db";
import { createClient } from "@/lib/supabase/server";

const str = (v: FormDataEntryValue | null) => String(v ?? "").trim();

export async function saveNoticeAction(formData: FormData) {
  const supabase = await createClient();
  const vars = str(formData.get("template_vars")).split(",").map((x) => x.trim()).filter(Boolean);
  const { error } = await supabase.schema("omni").rpc("save_notice_rule", { p: {
    event: str(formData.get("event")), active: formData.get("active") === "on", channel_account_id: str(formData.get("channel_account_id")) || null,
    free_text: str(formData.get("free_text")), template_id: str(formData.get("template_id")) || null, template_vars: vars, task_fallback: formData.get("task_fallback") === "on",
  } as Json });
  revalidatePath("/atendimento/avisos");
  const q = new URLSearchParams(error ? { erro: error.message.replace(/^ERROR:\s*/, ""), editar: str(formData.get("event")) } : { ok: "Aviso salvo" });
  redirect(`/atendimento/avisos?${q}`);
}
