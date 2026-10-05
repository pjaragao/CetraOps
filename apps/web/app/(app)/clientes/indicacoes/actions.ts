"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { Json } from "@centralops/db";
import { createClient } from "@/lib/supabase/server";
import { findParty } from "../party-lookup";

const friendly = (m: string) => m.replace(/^ERROR:\s*/, "");
const str = (v: FormDataEntryValue | null) => String(v ?? "").trim();
const PATH = "/clientes/indicacoes";

function go(params: Record<string, string | undefined>): never {
  revalidatePath(PATH);
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString();
  redirect(q ? `${PATH}?${q}` : PATH);
}

export async function saveReferralSettingsAction(formData: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.schema("crm").rpc("save_referral_settings", { p: {
    enabled: formData.get("enabled") === "on", reward_amount: Number(str(formData.get("reward_amount")).replace(",", ".") || 0),
    wait_days: Number(str(formData.get("wait_days")) || 7), monthly_cap: Number(str(formData.get("monthly_cap")) || 5),
  } as Json });
  go(error ? { erro: friendly(error.message) } : { ok: "Regras de indicação salvas" });
}

export async function referralLinkAction(formData: FormData) {
  const supabase = await createClient();
  const found = await findParty(supabase, str(formData.get("party")));
  if ("error" in found) go({ erro: found.error });
  const { data, error } = await supabase.schema("crm").rpc("ensure_referral_link", { p_party: found.id });
  go(error ? { erro: friendly(error.message) } : { ok: "Link pessoal pronto", link: (data as unknown as { id: string }).id });
}
