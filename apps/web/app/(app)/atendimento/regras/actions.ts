"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { Json } from "@sie/db";
import { createClient } from "@/lib/supabase/server";

const str = (v: FormDataEntryValue | null) => String(v ?? "").trim();
const PATH = "/atendimento/regras";

function back(error: { message: string } | null, ok: string): never {
  revalidatePath(PATH);
  const q = new URLSearchParams(error ? { erro: error.message.replace(/^ERROR:\s*/, "") } : { ok });
  redirect(`${PATH}?${q}`);
}

export async function saveRoutingAction(formData: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.schema("omni").rpc("save_routing_settings", { p: {
    enabled: formData.get("enabled") === "on", use_roster: formData.get("use_roster") === "on",
    max_open_per_member: Number(formData.get("max_open_per_member") || 15), on_call_member_id: str(formData.get("on_call_member_id")),
  } as Json });
  back(error, "Distribuição salva");
}

export async function saveCsatAction(formData: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.schema("omni").rpc("save_csat_settings", { p: {
    enabled: formData.get("enabled") === "on", question: str(formData.get("question")), thanks: str(formData.get("thanks")),
  } as Json });
  back(error, "Pesquisa salva");
}
