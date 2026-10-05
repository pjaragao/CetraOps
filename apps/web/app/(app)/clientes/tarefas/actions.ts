"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { Json } from "@centralops/db";
import { createClient } from "@/lib/supabase/server";
import { dueAt, findParty } from "../party-lookup";

const friendly = (m: string) => m.replace(/^ERROR:\s*/, "");
const str = (v: FormDataEntryValue | null) => String(v ?? "").trim();
const PATH = "/clientes/tarefas";

function back(params: Record<string, string | undefined> = {}): never {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString();
  redirect(q ? `${PATH}?${q}` : PATH);
}

export async function createTaskAction(formData: FormData) {
  const supabase = await createClient();
  const partyText = str(formData.get("party"));
  let party: string | null = null;
  if (partyText) {
    const found = await findParty(supabase, partyText);
    if ("error" in found) back({ erro: found.error, ver: str(formData.get("ver")) });
    party = found.id;
  }
  const { error } = await supabase.schema("crm").rpc("save_task", { p: {
    party_id: party, assignee_member_id: str(formData.get("assignee")) || null, type: str(formData.get("type")) || "FOLLOW_UP", title: str(formData.get("title")),
    body: str(formData.get("body")), suggested_message: str(formData.get("suggested_message")), due_at: dueAt(str(formData.get("due_date")), str(formData.get("due_time"))),
  } as Json });
  revalidatePath(PATH);
  back(error ? { erro: friendly(error.message), ver: str(formData.get("ver")) } : { ok: "Tarefa criada.", ver: str(formData.get("ver")) });
}

export async function setTaskStatusAction(formData: FormData) {
  const supabase = await createClient();
  const status = str(formData.get("status"));
  const { error } = await supabase.schema("crm").rpc("set_task_status", { p_id: str(formData.get("id")), p_status: status });
  revalidatePath(PATH);
  back(error ? { erro: friendly(error.message), ver: str(formData.get("ver")) } : { ok: status === "DONE" ? "Tarefa concluída." : status === "CANCELLED" ? "Tarefa cancelada." : "Tarefa reaberta.", ver: str(formData.get("ver")) });
}

/** Adia por N dias a partir de hoje às 9h (fuso de São Paulo). */
export async function postponeTaskAction(formData: FormData) {
  const days = Math.min(30, Math.max(1, Number(str(formData.get("days"))) || 1));
  const d = new Date(Date.now() + days * 86_400_000 - 3 * 3_600_000);            // "hoje" em São Paulo
  const supabase = await createClient();
  const { error } = await supabase.schema("crm").rpc("reschedule_task", { p_id: str(formData.get("id")), p_due: dueAt(d.toISOString().slice(0, 10)) ?? "" });
  revalidatePath(PATH);
  back(error ? { erro: friendly(error.message), ver: str(formData.get("ver")) } : { ok: `Tarefa adiada em ${days} dia(s).`, ver: str(formData.get("ver")) });
}
