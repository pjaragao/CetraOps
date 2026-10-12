"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { Json } from "@centralops/db";
import { createClient } from "@/lib/supabase/server";

const friendly = (m: string) => m.replace(/^ERROR:\s*/, "");
const back = (store: string, q: string): never => redirect(`/configuracoes/horarios?loja=${store}&${q}`);
const t = (v: FormDataEntryValue | null) => String(v ?? "").trim();

/** Semana: até duas faixas por dia (s1/e1, s2/e2). Dia em branco = fechado. */
export async function saveStoreHoursAction(formData: FormData) {
  const store = t(formData.get("store_id"));
  const days: Record<string, [string, string][]> = {};
  for (let d = 0; d < 7; d++) {
    const iv: [string, string][] = [];
    for (const k of [1, 2]) {
      const s = t(formData.get(`s${k}_${d}`)), e = t(formData.get(`e${k}_${d}`));
      if (s && e) iv.push([s, e]);
      else if (s || e) back(store, `erro=${encodeURIComponent("Preencha abertura e fechamento de cada faixa")}`);
    }
    if (iv.length) days[String(d)] = iv;
  }
  const supabase = await createClient();
  const { error } = await supabase.schema("core").rpc("set_store_hours", { p_store: store, p: { days } as unknown as Json });
  revalidatePath("/configuracoes/horarios");
  revalidatePath("/equipe/escalas");
  back(store, error ? `erro=${encodeURIComponent(friendly(error.message))}` : "ok=Horário%20salvo");
}

export async function saveExceptionAction(formData: FormData) {
  const store = t(formData.get("store_id"));
  const closed = t(formData.get("mode")) === "closed";
  const s = t(formData.get("s")), e = t(formData.get("e"));
  const supabase = await createClient();
  const { error } = await supabase.schema("core").rpc("save_store_hours_exception", { p: {
    store_id: store, day: t(formData.get("day")), closed, hours: closed ? [] : [[s, e]], note: t(formData.get("note")),
  } as unknown as Json });
  revalidatePath("/configuracoes/horarios");
  revalidatePath("/equipe/escalas");
  back(store, error ? `erro=${encodeURIComponent(friendly(error.message))}` : "ok=Data%20especial%20salva");
}

export async function deleteExceptionAction(formData: FormData) {
  const store = t(formData.get("store_id"));
  const supabase = await createClient();
  const { error } = await supabase.schema("core").rpc("delete_store_hours_exception", { p_id: t(formData.get("id")) });
  revalidatePath("/configuracoes/horarios");
  back(store, error ? `erro=${encodeURIComponent(friendly(error.message))}` : "ok=Data%20especial%20removida");
}
