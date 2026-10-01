"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

/** Pede ao worker para trazer agora os resultados dos anúncios (também roda sozinho todo dia às 6h). */
export async function syncAdsAction() {
  const supabase = await createClient();
  const { error } = await supabase.schema("mkt").rpc("request_ads_sync");
  revalidatePath("/marketing/anuncios");
  const q = error ? `erro=${encodeURIComponent(error.message.replace(/^ERROR:\s*/, ""))}` : `ok=${encodeURIComponent("Atualização pedida. Os números novos aparecem em instantes.")}&wait=1`;
  redirect(`/marketing/anuncios?${q}`);
}
