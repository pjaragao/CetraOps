"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

const friendly = (m: string) => m.replace(/^ERROR:\s*/, "");
const str = (v: FormDataEntryValue | null) => String(v ?? "").trim();

function go(params: Record<string, string | undefined> = {}): never {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString();
  redirect(q ? `/ia?${q}` : "/ia");
}

export async function decideSuggestionAction(formData: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.schema("ai").rpc("decide_suggestion", { p_id: str(formData.get("id")), p_status: str(formData.get("status")), ...(str(formData.get("note")) ? { p_note: str(formData.get("note")) } : {}) });
  revalidatePath("/ia");
  go(error ? { erro: friendly(error.message), ver: str(formData.get("ver")) } : { ok: str(formData.get("status")) === "ACCEPTED" ? "Marcada como resolvida." : "Sugestão ignorada.", ver: str(formData.get("ver")) });
}

export async function runDetectorsAction() {
  const supabase = await createClient();
  const { data, error } = await supabase.schema("ai").rpc("run_detectors", {});
  revalidatePath("/ia");
  go(error ? { erro: friendly(error.message) } : { ok: Number(data) > 0 ? `${data} ponto(s) novo(s) de atenção.` : "Verificado: nada novo." });
}
