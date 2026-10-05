"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { Json } from "@centralops/db";
import { createClient } from "@/lib/supabase/server";

const LIST = "/ia/avaliacoes";
const friendly = (m: string) => m.replace(/^ERROR:\s*/, "");
const str = (v: FormDataEntryValue | null) => String(v ?? "").trim();
const lines = (v: FormDataEntryValue | null) => String(v ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
const csv = (v: FormDataEntryValue | null) => String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

function back(params: Record<string, string | undefined> = {}): never {
  const q = Object.entries(params).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v!)}`).join("&");
  redirect(q ? `${LIST}?${q}` : LIST);
}

/** Pede a avaliação dos modelos (o worker roda um caso por vez; demora e custa tokens). */
export async function requestEvalAction(formData: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.schema("ai").rpc("request_eval", { p_models: csv(formData.get("models")) });
  revalidatePath(LIST);
  back(error ? { erro: friendly(error.message) } : { ok: "Avaliação pedida. Acompanhe o andamento abaixo; leva alguns minutos." });
}

/** "Cliente: …" e "IA: …" (uma fala por linha) viram os turnos do caso; a última tem de ser da cliente. */
export async function saveCaseAction(formData: FormData) {
  const turns = lines(formData.get("turns")).map((l) => {
    const m = /^(ia|assistente)\s*:\s*(.*)$/i.exec(l);
    return m ? { role: "assistant", text: m[2] } : { role: "user", text: l.replace(/^cliente\s*:\s*/i, "") };
  });
  const expect: Record<string, Json> = {};
  const outcomes = formData.getAll("outcome_in").map(String);
  if (outcomes.length) expect.outcome_in = outcomes;
  if (csv(formData.get("tools_any")).length) expect.tools_any = csv(formData.get("tools_any"));
  if (lines(formData.get("must_match_any")).length) expect.must_match_any = lines(formData.get("must_match_any"));
  if (lines(formData.get("must_not_match")).length) expect.must_not_match = lines(formData.get("must_not_match"));
  if (formData.get("no_flags") === "on") expect.no_flags = true;
  const supabase = await createClient();
  const { error } = await supabase.schema("ai").rpc("save_eval_case", { p: { key: str(formData.get("key")), title: str(formData.get("title")), turns, expect } as Json });
  revalidatePath(LIST);
  back(error ? { erro: friendly(error.message) } : { ok: "Caso salvo." });
}

export async function deleteCaseAction(formData: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.schema("ai").rpc("delete_eval_case", { p_id: str(formData.get("id")) });
  revalidatePath(LIST);
  back(error ? { erro: friendly(error.message) } : { ok: "Caso apagado." });
}
