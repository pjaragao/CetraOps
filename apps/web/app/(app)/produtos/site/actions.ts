"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

const friendly = (m: string) => m.replace(/^ERROR:\s*/, "");

export async function requestSiteSyncAction(formData: FormData) {
  const kind = String(formData.get("kind") ?? "FULL") === "PRICES" ? "PRICES" : "FULL";
  const supabase = await createClient();
  const { error } = await supabase.schema("catalog").rpc("request_site_sync", { p_kind: kind });
  revalidatePath("/produtos/site");
  redirect(`/produtos/site?${error ? `erro=${encodeURIComponent(friendly(error.message))}`
    : `ok=${encodeURIComponent(kind === "FULL" ? "Sincronização pedida: o catálogo completo leva uns 4 minutos" : "Atualização de preços pedida")}`}`);
}

export async function setSiteSyncAction(formData: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.schema("catalog").rpc("set_site_sync", { p_enabled: String(formData.get("enabled")) === "1" });
  revalidatePath("/produtos/site");
  redirect(`/produtos/site?${error ? `erro=${encodeURIComponent(friendly(error.message))}` : "ok=Configuração%20salva"}`);
}
