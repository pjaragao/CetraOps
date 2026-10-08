"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { Json } from "@centralops/db";
import { createClient } from "@/lib/supabase/server";

const str = (v: FormDataEntryValue | null) => String(v ?? "").trim();
const clean = (m: string) => m.replace(/^ERROR:\s*/, "");

function go(path: string, error: { message: string } | null, ok: string): never {
  revalidatePath("/marketing/reguas", "layout");
  const q = new URLSearchParams(error ? { erro: clean(error.message) } : { ok });
  redirect(`${path}?${q}`);
}

export async function saveJourneyAction(formData: FormData) {
  const id = str(formData.get("id"));
  const cfg: Record<string, unknown> = {};
  if (str(formData.get("days"))) cfg.days = Number(formData.get("days"));
  if (str(formData.get("days_before"))) cfg.days_before = Number(formData.get("days_before"));
  if (str(formData.get("after_days"))) cfg.after_days = Number(formData.get("after_days"));
  if (str(formData.get("occasion"))) cfg.occasion = str(formData.get("occasion"));
  if (formData.getAll("roles").length) cfg.roles = formData.getAll("roles").map(String);
  if (formData.has("coupon_percent")) {   // cupom pessoal (réguas de aniversário): vazio = sem cupom
    const percent = str(formData.get("coupon_percent"));
    if (percent) cfg.coupon = { enabled: true, percent: Number(percent.replace(",", ".")), days_after: str(formData.get("coupon_days_after")) === "" ? 20 : Number(formData.get("coupon_days_after")), ...(str(formData.get("coupon_min_order")) ? { min_order: Number(str(formData.get("coupon_min_order")).replace(",", ".")) } : {}) };
  }
  if (formData.has("reasons")) cfg.reasons = str(formData.get("reasons")).split(",").map((x) => x.trim()).filter(Boolean);
  const supabase = await createClient();
  const { data, error } = await supabase.schema("mkt").rpc("save_journey", { p: {
    id: id || null, name: str(formData.get("name")), description: str(formData.get("description")), trigger: str(formData.get("trigger")), trigger_config: cfg,
    holdout_pct: Number(formData.get("holdout_pct") || 10), exit_on_purchase: formData.get("exit_on_purchase") === "on",
  } as Json });
  const newId = (data as unknown as { id?: string } | null)?.id;
  go(`/marketing/reguas/${id || newId || ""}`.replace(/\/$/, ""), error, "Régua salva");
}

export async function toggleJourneyAction(formData: FormData) {
  const id = str(formData.get("id"));
  const supabase = await createClient();
  const { error } = await supabase.schema("mkt").rpc("set_journey_active", { p_id: id, p_active: str(formData.get("active")) === "1" });
  go(str(formData.get("back")) || `/marketing/reguas/${id}`, error, str(formData.get("active")) === "1" ? "Régua ligada" : "Régua desligada");
}

export async function saveStepAction(formData: FormData) {
  const journey = str(formData.get("journey_id"));
  const supabase = await createClient();
  const { error } = await supabase.schema("mkt").rpc("save_journey_step", { p: {
    id: str(formData.get("id")) || null, journey_id: journey, position: Number(formData.get("position")), wait_days: Number(String(formData.get("wait_days") || "0").replace(",", ".")),
    action: str(formData.get("action")), title: str(formData.get("title")), message: str(formData.get("message")), template_id: str(formData.get("template_id")) || null,
    template_vars: str(formData.get("template_vars")).split(",").map((x) => x.trim()).filter(Boolean), due_hours: Number(formData.get("due_hours") || 24),
  } as Json });
  go(`/marketing/reguas/${journey}`, error, "Passo salvo");
}

export async function deleteStepAction(formData: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.schema("mkt").rpc("delete_journey_step", { p_id: str(formData.get("id")) });
  go(`/marketing/reguas/${str(formData.get("journey_id"))}`, error, "Passo removido");
}

export async function saveContactPolicyAction(formData: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.schema("mkt").rpc("save_contact_policy", { p: {
    marketing_per_7d: Number(formData.get("marketing_per_7d")), marketing_per_30d: Number(formData.get("marketing_per_30d")), relationship_per_14d: Number(formData.get("relationship_per_14d")),
    quiet_start: str(formData.get("quiet_start")), quiet_end: str(formData.get("quiet_end")), no_sunday: formData.get("no_sunday") === "on",
  } as Json });
  go("/marketing/reguas", error, "Regras de contato salvas");
}
