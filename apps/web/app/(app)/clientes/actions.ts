"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { Json } from "@sie/db";
import { createClient } from "@/lib/supabase/server";

const friendly = (m: string) => m.replace(/^ERROR:\s*/, "");
const str = (v: FormDataEntryValue | null) => String(v ?? "").trim();

function back(path: string, params: Record<string, string | undefined>): never {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString();
  redirect(q ? `${path}${path.includes("?") ? "&" : "?"}${q}` : path);
}

/** Ficha editável: só envia o que o formulário tem (campo vazio apaga). */
export async function updateProfileAction(formData: FormData) {
  const id = str(formData.get("id"));
  const list = (k: string) => str(formData.get(k)).split(",").map((x) => x.trim()).filter(Boolean);
  const p: Record<string, unknown> = {
    display_name: str(formData.get("display_name")), birth_date: str(formData.get("birth_date")), city: str(formData.get("city")), uf: str(formData.get("uf")),
    profession: str(formData.get("profession")), instagram_handle: str(formData.get("instagram_handle")), email: str(formData.get("email")),
    sizes: { top: str(formData.get("size_top")), bottom: str(formData.get("size_bottom")), bra: str(formData.get("size_bra")), shoe: str(formData.get("size_shoe")) },
    activities: list("activities"), notes: str(formData.get("notes")), joy_member_status: str(formData.get("joy_member_status")) || "UNKNOWN",
    relationship_owner_member_id: str(formData.get("owner")), home_store_id: str(formData.get("home_store")), tags: list("tags"),
  };
  const tier = str(formData.get("tier"));
  if (tier) p.tier = tier;
  const supabase = await createClient();
  const { error } = await supabase.schema("crm").rpc("update_profile", { p_party: id, p: p as Json });
  revalidatePath(`/clientes/${id}`);
  if (error) back(`/clientes/${id}/editar`, { erro: friendly(error.message) });
  back(`/clientes/${id}`, { ok: "Ficha atualizada" });
}

export async function setConsentAction(formData: FormData) {
  const id = str(formData.get("id"));
  const supabase = await createClient();
  const { error } = await supabase.schema("crm").rpc("set_consent", {
    p_party: id, p_purpose: str(formData.get("purpose")) as "MARKETING_WHATSAPP", p_granted: str(formData.get("granted")) === "1",
    p_channel: str(formData.get("channel")), p_text_version: "v1",
  });
  revalidatePath(`/clientes/${id}`);
  back(`/clientes/${id}`, error ? { erro: friendly(error.message) } : { ok: str(formData.get("granted")) === "1" ? "Aceite registrado" : "Recusa registrada" });
}

export async function refreshLifecycleAction(formData: FormData) {
  const id = str(formData.get("id"));
  const path = str(formData.get("back")) || (id ? `/clientes/${id}` : "/clientes/ciclo-de-vida");
  const supabase = await createClient();
  const { data, error } = await supabase.schema("crm").rpc("refresh_lifecycle", { p_party: id || undefined });
  revalidatePath("/clientes", "layout");
  back(path, error ? { erro: friendly(error.message) } : { ok: id ? "Recalculado" : `Recalculado: ${data ?? 0} mudança(s) de estágio ou nível` });
}

export async function saveLifecycleSettingsAction(formData: FormData) {
  const keys = ["vip_min_revenue_12m", "vip_min_orders_12m", "at_risk_factor", "at_risk_single_days", "inactive_days", "lost_days", "prospect_min_score"];
  const p: Record<string, number> = {};
  for (const k of keys) {
    const v = str(formData.get(k)).replace(",", ".");
    if (v) p[k] = Number(v);
  }
  const supabase = await createClient();
  const { error } = await supabase.schema("crm").rpc("save_lifecycle_settings", { p: p as Json });
  revalidatePath("/clientes", "layout");
  back("/clientes/ciclo-de-vida", error ? { erro: friendly(error.message) } : { ok: "Regras salvas e base recalculada" });
}

export async function addInterestAction(formData: FormData) {
  const id = str(formData.get("id"));
  const supabase = await createClient();
  const { error } = await supabase.schema("crm").rpc("add_interest", { p_party: id, p_product: str(formData.get("product_id")), p_size: str(formData.get("size")), p_note: str(formData.get("note")) || undefined });
  revalidatePath(`/clientes/${id}`);
  back(`/clientes/${id}`, error ? { erro: friendly(error.message) } : { ok: "Avise-me registrado: quando o tamanho chegar, ela é avisada" });
}

export async function cancelInterestAction(formData: FormData) {
  const id = str(formData.get("id"));
  const supabase = await createClient();
  const { error } = await supabase.schema("crm").rpc("cancel_interest", { p_id: str(formData.get("alert_id")) });
  revalidatePath(`/clientes/${id}`);
  back(`/clientes/${id}`, error ? { erro: friendly(error.message) } : { ok: "Avise-me cancelado" });
}
