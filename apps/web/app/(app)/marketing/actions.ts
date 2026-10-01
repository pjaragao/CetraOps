"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { templateParts, templatePlaceholders, type TemplateComponent } from "@sie/domain";
import type { Json } from "@sie/db";
import { createClient } from "@/lib/supabase/server";

const friendly = (m: string) => m.replace(/^ERROR:\s*/, "");
const str = (v: FormDataEntryValue | null) => String(v ?? "").trim();
const list = (v: FormDataEntryValue | null) => str(v).split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
const LIST = "/marketing";

function go(path: string, params: Record<string, string | undefined> = {}): never {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString();
  redirect(q ? `${path}?${q}` : path);
}
const refresh = () => revalidatePath(LIST, "layout");

/** Começa o rascunho: nome + template (o número vem do template). As variáveis entram com o primeiro nome e o público com clientes; tudo editável depois. */
export async function createCampaignAction(formData: FormData) {
  const supabase = await createClient();
  const { data: tpl } = await supabase.schema("omni").from("templates").select("id, channel_account_id, components").eq("id", str(formData.get("template_id"))).maybeSingle();
  if (!tpl) go(LIST, { erro: "Escolha um template aprovado." });
  const n = templatePlaceholders(templateParts(tpl.components as unknown as TemplateComponent[]).body).length;
  const { data, error } = await supabase.schema("mkt").rpc("save_campaign", { p: {
    name: str(formData.get("name")), channel_account_id: tpl.channel_account_id, template_id: tpl.id, variables: Array.from({ length: n }, () => ({ source: "FIRST_NAME" })), audience: { lifecycle: ["CUSTOMER", "VIP"] },
  } as Json });
  refresh();
  if (error) go(LIST, { erro: friendly(error.message) });
  go(`${LIST}/campanhas/${(data as unknown as { id: string }).id}`, { ok: "Rascunho criado. Defina o público e as variáveis e confira a prévia." });
}

export async function saveCampaignAction(formData: FormData) {
  const id = str(formData.get("id"));
  const supabase = await createClient();
  const n = Number(str(formData.get("var_count"))) || 0;
  const variables = Array.from({ length: n }, (_, i) => ({ source: str(formData.get(`var_${i}_source`)) || "FIRST_NAME", ...(str(formData.get(`var_${i}_source`)) === "TEXT" ? { text: str(formData.get(`var_${i}_text`)) } : {}) }));
  const audience: Record<string, unknown> = {};
  const put = (k: string, v: unknown) => { if (Array.isArray(v) ? v.length > 0 : v !== "" && v != null) audience[k] = v; };
  put("lifecycle", formData.getAll("lifecycle").map(String));
  put("tiers", formData.getAll("tiers").map(String));
  put("min_score", str(formData.get("min_score")) ? Number(str(formData.get("min_score"))) : "");
  put("inactive_days", str(formData.get("inactive_days")) ? Number(str(formData.get("inactive_days"))) : "");
  put("birthday_month", str(formData.get("birthday_month")) ? Number(str(formData.get("birthday_month"))) : "");
  put("cities", list(formData.get("cities")));
  put("tags", list(formData.get("tags")));
  put("event_id", str(formData.get("event_id")));
  put("rsvp", formData.getAll("rsvp").map(String));
  const at = str(formData.get("scheduled_at"));
  const { error } = await supabase.schema("mkt").rpc("save_campaign", { p: {
    id, name: str(formData.get("name")), channel_account_id: str(formData.get("channel_account_id")), template_id: str(formData.get("template_id")), variables, audience,
    frequency_cap_days: str(formData.get("frequency_cap_days")) || 7, daily_limit: str(formData.get("daily_limit")) || 250, scheduled_at: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(at) ? `${at}:00-03:00` : null,
  } as Json });
  refresh();
  go(`${LIST}/campanhas/${id}`, error ? { erro: friendly(error.message) } : { ok: "Rascunho salvo." });
}

export async function launchCampaignAction(formData: FormData) {
  const id = str(formData.get("id"));
  const supabase = await createClient();
  const { error } = await supabase.schema("mkt").rpc("launch_campaign", { p_id: id });
  refresh();
  go(`${LIST}/campanhas/${id}`, error ? { erro: friendly(error.message) } : { ok: "Campanha lançada. O envio segue em lotes, respeitando o limite diário do número.", wait: "1" });
}

export async function cancelCampaignAction(formData: FormData) {
  const id = str(formData.get("id"));
  const supabase = await createClient();
  const { error } = await supabase.schema("mkt").rpc("cancel_campaign", { p_id: id });
  refresh();
  go(`${LIST}/campanhas/${id}`, error ? { erro: friendly(error.message) } : { ok: "Campanha cancelada: quem ainda não recebeu não receberá." });
}

export async function deleteCampaignAction(formData: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.schema("mkt").rpc("delete_campaign", { p_id: str(formData.get("id")) });
  refresh();
  go(LIST, error ? { erro: friendly(error.message) } : { ok: "Rascunho excluído." });
}
