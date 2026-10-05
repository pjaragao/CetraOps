"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { Json } from "@centralops/db";
import { createClient } from "@/lib/supabase/server";

const str = (v: FormDataEntryValue | null) => String(v ?? "").trim();

/** Monta {days: {"1": [["09:00","12:00"],["14:00","20:00"]]}, after_hours_ai} a partir do formulário (dia sem faixa = fechado). */
export async function saveBusinessHoursAction(formData: FormData) {
  const id = str(formData.get("id"));
  const days: Record<string, [string, string][]> = {};
  for (let d = 0; d <= 6; d++) {
    const ivs: [string, string][] = [];
    for (const k of [1, 2]) {
      const s = str(formData.get(`s${k}_${d}`)), e = str(formData.get(`e${k}_${d}`));
      if (s && e) ivs.push([s, e]);
    }
    if (ivs.length) days[String(d)] = ivs;
  }
  const p = { days, after_hours_ai: str(formData.get("after_hours_ai")) || "DRAFT_ONLY" };
  const supabase = await createClient();
  const { error } = await supabase.schema("omni").rpc("set_business_hours", { p_id: id, p: p as Json });
  revalidatePath("/configuracoes/integracoes");
  const q = new URLSearchParams(error ? { erro: error.message.replace(/^ERROR:\s*/, "") } : { ok: "Horário salvo" });
  redirect(`/configuracoes/integracoes/horario/${id}?${q}`);
}
