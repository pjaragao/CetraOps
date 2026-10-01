"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { Json } from "@sie/db";
import { createClient } from "@/lib/supabase/server";
import { findParty } from "../party-lookup";

const friendly = (m: string) => m.replace(/^ERROR:\s*/, "");
const str = (v: FormDataEntryValue | null) => String(v ?? "").trim();
const PATH = "/clientes/casos";

function go(path: string, error: { message: string } | null, ok: string): never {
  revalidatePath("/clientes", "layout");
  const q = new URLSearchParams(error ? { erro: friendly(error.message) } : { ok });
  redirect(`${path}${path.includes("?") ? "&" : "?"}${q}`);
}

export async function openCaseAction(formData: FormData) {
  const supabase = await createClient();
  let party = str(formData.get("party_id"));
  if (!party) {
    const found = await findParty(supabase, str(formData.get("party")));
    if ("error" in found) go(PATH, { message: found.error }, "");
    party = found.id;
  }
  const { data, error } = await supabase.schema("crm").rpc("open_case", { p: {
    party_id: party, conversation_id: str(formData.get("conversation_id")) || null, kind: str(formData.get("kind")), title: str(formData.get("title")), description: str(formData.get("description")),
  } as Json });
  go(str(formData.get("back")) || PATH, error, `Caso ${(data as unknown as { number?: string } | null)?.number ?? ""} aberto: responda em até 1 hora útil`);
}

export async function assignCaseAction(formData: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.schema("crm").rpc("assign_case", { p_id: str(formData.get("id")), p_member: str(formData.get("member")) || (null as unknown as string) });
  go(PATH, error, "Responsável atualizada");
}

export async function respondedCaseAction(formData: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.schema("crm").rpc("case_responded", { p_id: str(formData.get("id")) });
  go(PATH, error, "Primeira resposta registrada");
}

export async function resolveCaseAction(formData: FormData) {
  const supabase = await createClient();
  const courtesy = Number(str(formData.get("courtesy")).replace(/\./g, "").replace(",", ".")) || 0;
  const { error } = await supabase.schema("crm").rpc("resolve_case", { p_id: str(formData.get("id")), p_solution: str(formData.get("solution")), p_courtesy: courtesy });
  go(PATH, error, courtesy > 0 ? "Caso resolvido, vale de cortesia emitido e retorno agendado para 7 dias" : "Caso resolvido e retorno agendado para 7 dias");
}

export async function reopenCaseAction(formData: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.schema("crm").rpc("reopen_case", { p_id: str(formData.get("id")) });
  go(PATH, error, "Caso reaberto");
}

export async function recordNpsAction(formData: FormData) {
  const id = str(formData.get("party_id"));
  const supabase = await createClient();
  const { error } = await supabase.schema("crm").rpc("record_nps", { p_party: id, p_score: Number(formData.get("score")), p_comment: str(formData.get("comment")) || undefined });
  go(`/clientes/${id}`, error, "NPS registrado");
}
