"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { Json } from "@sie/db";
import { createClient } from "@/lib/supabase/server";
import { findParty } from "../party-lookup";

const friendly = (m: string) => m.replace(/^ERROR:\s*/, "");
const str = (v: FormDataEntryValue | null) => String(v ?? "").trim();
const PATH = "/clientes/funis";

function back(pipeline: string, params: Record<string, string | undefined> = {}): never {
  const q = new URLSearchParams(Object.entries({ f: pipeline || undefined, ...params }).filter(([, v]) => v) as [string, string][]).toString();
  redirect(q ? `${PATH}?${q}` : PATH);
}

export async function createDealAction(formData: FormData) {
  const pipeline = str(formData.get("pipeline_id"));
  const supabase = await createClient();
  const party = await findParty(supabase, str(formData.get("party")));
  if ("error" in party) back(pipeline, { erro: party.error });
  const value = str(formData.get("value")).replace(/\./g, "").replace(",", ".");
  const { error } = await supabase.schema("crm").rpc("save_deal", { p: { party_id: party.id, pipeline_id: pipeline, title: str(formData.get("title")), value_estimated: value || null, owner_member_id: str(formData.get("owner")) || null } as Json });
  revalidatePath(PATH);
  back(pipeline, error ? { erro: friendly(error.message) } : { ok: "Oportunidade criada na primeira etapa." });
}

export async function moveDealAction(formData: FormData) {
  const pipeline = str(formData.get("pipeline_id"));
  const supabase = await createClient();
  const { error } = await supabase.schema("crm").rpc("move_deal", { p_deal: str(formData.get("deal_id")), p_stage: str(formData.get("stage_id")), ...(str(formData.get("reason")) ? { p_reason: str(formData.get("reason")) } : {}) });
  revalidatePath(PATH);
  back(pipeline, error ? { erro: friendly(error.message) } : { ok: "Oportunidade movida." });
}

export async function deleteDealAction(formData: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.schema("crm").rpc("delete_deal", { p_id: str(formData.get("deal_id")) });
  revalidatePath(PATH);
  back(str(formData.get("pipeline_id")), error ? { erro: friendly(error.message) } : { ok: "Oportunidade excluída." });
}
