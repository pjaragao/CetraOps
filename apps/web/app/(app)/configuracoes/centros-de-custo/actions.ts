"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { Json } from "@centralops/db";
import { createClient } from "@/lib/supabase/server";

const str = (v: FormDataEntryValue | null) => String(v ?? "").trim();
const clean = (m: string) => m.replace(/^ERROR:\s*/, "");
const PATH = "/configuracoes/centros-de-custo";

function go(params: Record<string, string | undefined>): never {
  revalidatePath(PATH);
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString();
  redirect(q ? `${PATH}?${q}` : PATH);
}

export async function saveCostCenterAction(formData: FormData) {
  const id = str(formData.get("id"));
  const supabase = await createClient();
  const { error } = await supabase.schema("core").rpc("save_cost_center", { p: {
    id: id || null, code: str(formData.get("code")), name: str(formData.get("name")), kind: str(formData.get("kind")),
    parent_id: str(formData.get("parent_id")) || null, legal_entity_id: str(formData.get("legal_entity_id")) || null,
    store_id: str(formData.get("store_id")) || null, channel: str(formData.get("channel")),
  } as Json });
  go(error ? { erro: clean(error.message), ...(id ? { editar: id } : { novo: "1" }) } : { ok: id ? "Centro de custo salvo" : "Centro de custo criado" });
}

export async function archiveCostCenterAction(formData: FormData) {
  const archive = str(formData.get("archive")) === "1";
  const supabase = await createClient();
  const { error } = await supabase.schema("core").rpc("set_cost_center_archived", { p_id: str(formData.get("id")), p_archived: archive });
  go(error ? { erro: clean(error.message) } : { ok: archive ? "Centro de custo arquivado" : "Centro de custo reativado" });
}
