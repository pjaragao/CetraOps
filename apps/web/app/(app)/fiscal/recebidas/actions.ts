"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

const LIST = "/fiscal/recebidas";
const friendly = (m: string) => m.replace(/^ERROR:\s*/, "");
const str = (v: FormDataEntryValue | null) => String(v ?? "").trim();

function back(params: Record<string, string | undefined> = {}): never {
  const q = Object.entries(params).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v!)}`).join("&");
  redirect(q ? `${LIST}?${q}` : LIST);
}

/** Pede ao worker a varredura de notas emitidas contra o CNPJ (também roda sozinha a cada 2 h). */
export async function syncDfeAction() {
  const supabase = await createClient();
  const { error } = await supabase.schema("fiscal").rpc("request_dfe_sync");
  revalidatePath(LIST);
  back(error ? { erro: friendly(error.message) } : { ok: "Busca pedida. As notas novas aparecem em instantes.", wait: "1" });
}

/** Manifestação do destinatário: tem efeito legal, por isso é sempre uma decisão da pessoa. */
export async function manifestAction(formData: FormData) {
  const supabase = await createClient();
  const reason = str(formData.get("reason"));
  const { error } = await supabase.schema("fiscal").rpc("request_manifest", { p_id: str(formData.get("id")), p_type: str(formData.get("type")), ...(reason ? { p_reason: reason } : {}) });
  revalidatePath(LIST);
  back(error ? { erro: friendly(error.message) } : { ok: "Manifestação enviada à SEFAZ. O resultado aparece em instantes.", wait: "1" });
}
