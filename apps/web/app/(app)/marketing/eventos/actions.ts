"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { Json } from "@sie/db";
import { createClient } from "@/lib/supabase/server";
import { findParty } from "../../clientes/party-lookup";

const friendly = (m: string) => m.replace(/^ERROR:\s*/, "");
const str = (v: FormDataEntryValue | null) => String(v ?? "").trim();
const num = (v: FormDataEntryValue | null) => str(v).replace(/\./g, "").replace(",", ".");
const LIST = "/marketing/eventos";

function go(path: string, params: Record<string, string | undefined> = {}): never {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString();
  redirect(q ? `${path}?${q}` : path);
}
const refresh = () => revalidatePath(LIST, "layout");
/** "2026-12-10T19:00" digitado no fuso de São Paulo → instante ISO. */
const at = (v: string) => (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v) ? `${v}:00-03:00` : null);

export async function saveEventAction(formData: FormData) {
  const supabase = await createClient();
  const id = str(formData.get("id"));
  const { data, error } = await supabase.schema("mkt").rpc("save_event", { p: {
    ...(id ? { id } : {}), kind: str(formData.get("kind")), name: str(formData.get("name")), store_id: str(formData.get("store_id")) || null, starts_at: at(str(formData.get("starts_at"))), ends_at: at(str(formData.get("ends_at"))),
    venue: str(formData.get("venue")), capacity: str(formData.get("capacity")) || null, target_revenue: num(formData.get("target_revenue")) || null, collection_id: str(formData.get("collection_id")) || null,
    notes: str(formData.get("notes")), create_cost_center: formData.get("create_cost_center") === "on",
  } as Json });
  refresh();
  if (error) go(id ? `${LIST}/${id}` : LIST, { erro: friendly(error.message) });
  go(`${LIST}/${(data as unknown as { id: string }).id}`, { ok: id ? "Evento atualizado." : "Evento criado. Convide as primeiras pessoas." });
}

export async function setEventStatusAction(formData: FormData) {
  const id = str(formData.get("id"));
  const supabase = await createClient();
  const { error } = await supabase.schema("mkt").rpc("set_event_status", { p_id: id, p_status: str(formData.get("status")) });
  refresh();
  go(`${LIST}/${id}`, error ? { erro: friendly(error.message) } : { ok: "Situação do evento atualizada." });
}

export async function inviteOneAction(formData: FormData) {
  const id = str(formData.get("event_id"));
  const supabase = await createClient();
  const party = await findParty(supabase, str(formData.get("party")));
  if ("error" in party) go(`${LIST}/${id}`, { erro: party.error });
  const { data, error } = await supabase.schema("mkt").rpc("invite_guests", { p_event: id, p_parties: [party.id], p_source: str(formData.get("source")) || "MANUAL" });
  refresh();
  go(`${LIST}/${id}`, error ? { erro: friendly(error.message) } : { ok: Number(data) > 0 ? "Convidada adicionada." : "Essa pessoa já estava na lista." });
}

/** Convida um grupo de uma vez (até 200, pelas de maior pontuação). O grupo vem do público do banco: fornecedoras e funcionárias nunca entram. */
export async function inviteGroupAction(formData: FormData) {
  const id = str(formData.get("event_id"));
  const group = str(formData.get("group"));
  const defs: Record<string, Json> = { VIP: { tiers: ["VIP", "VIP_BLACK"] }, CUSTOMER: { lifecycle: ["CUSTOMER", "VIP"] }, HOT_LEADS: { lifecycle: ["LEAD", "PROSPECT"], min_score: 60 } };
  if (!defs[group]) go(`${LIST}/${id}`, { erro: "Escolha o grupo a convidar." });
  const supabase = await createClient();
  const { data, error } = await supabase.schema("mkt").rpc("invite_audience", { p_event: id, p_def: defs[group] });
  refresh();
  go(`${LIST}/${id}`, error ? { erro: friendly(error.message) } : { ok: `${data} pessoa(s) convidada(s) (quem já estava na lista ficou de fora).` });
}

export async function setRsvpAction(formData: FormData) {
  const id = str(formData.get("event_id"));
  const supabase = await createClient();
  const plus = str(formData.get("plus_ones"));
  const { data, error } = await supabase.schema("mkt").rpc("set_rsvp", { p_guest: str(formData.get("guest_id")), p_status: str(formData.get("status")), ...(plus !== "" ? { p_plus_ones: Number(plus) } : {}) });
  refresh();
  const st = (data as unknown as { rsvp_status?: string } | null)?.rsvp_status;
  go(`${LIST}/${id}`, error ? { erro: friendly(error.message) } : { ok: st === "WAITLIST" ? "Evento lotado: ela ficou na lista de espera." : "Situação atualizada." });
}

export async function removeGuestAction(formData: FormData) {
  const id = str(formData.get("event_id"));
  const supabase = await createClient();
  const { error } = await supabase.schema("mkt").rpc("remove_guest", { p_guest: str(formData.get("guest_id")) });
  refresh();
  go(`${LIST}/${id}`, error ? { erro: friendly(error.message) } : { ok: "Convidada removida." });
}

export async function saveBudgetAction(formData: FormData) {
  const id = str(formData.get("event_id"));
  const supabase = await createClient();
  const { error } = await supabase.schema("mkt").rpc("save_budget_line", { p: { event_id: id, category: str(formData.get("category")), planned: num(formData.get("planned")), memo: str(formData.get("memo")) } as Json });
  refresh();
  go(`${LIST}/${id}`, error ? { erro: friendly(error.message) } : { ok: "Linha do orçamento salva." });
}

export async function deleteBudgetAction(formData: FormData) {
  const id = str(formData.get("event_id"));
  const supabase = await createClient();
  const { error } = await supabase.schema("mkt").rpc("delete_budget_line", { p_id: str(formData.get("line_id")) });
  refresh();
  go(`${LIST}/${id}`, error ? { erro: friendly(error.message) } : { ok: "Linha removida." });
}
