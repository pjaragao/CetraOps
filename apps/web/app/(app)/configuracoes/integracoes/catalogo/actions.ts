"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { Json } from "@centralops/db";
import { createClient } from "@/lib/supabase/server";

const str = (v: FormDataEntryValue | null) => String(v ?? "").trim();
const back = (id: string, q: Record<string, string>) => redirect(`/configuracoes/integracoes/catalogo/${id}?${new URLSearchParams(q)}`);
const clean = (msg: string) => msg.replace(/^ERROR:\s*/, "");

/** Modo de envio de produtos do canal + ID do catálogo da Meta. Com catálogo, já pede a primeira sincronização. */
export async function saveProductSettingsAction(formData: FormData) {
  const id = str(formData.get("id"));
  const p = { product_send_mode: str(formData.get("product_send_mode")) || "NATIVE_CATALOG", meta_catalog_id: str(formData.get("meta_catalog_id")) };
  const supabase = await createClient();
  const { error } = await supabase.schema("omni").rpc("set_product_settings", { p_id: id, p: p as Json });
  revalidatePath("/configuracoes/integracoes");
  back(id, error ? { erro: clean(error.message) } : { ok: p.meta_catalog_id ? "Salvo. A sincronização com o catálogo da Meta começou." : "Salvo" });
}

export async function syncMetaCatalogAction(formData: FormData) {
  const id = str(formData.get("id"));
  const supabase = await createClient();
  const { error } = await supabase.schema("omni").rpc("request_meta_catalog_sync", { p_id: id });
  back(id, error ? { erro: clean(error.message) } : { ok: "Sincronização pedida. Atualize a página em 1 ou 2 minutos para ver o resultado." });
}
