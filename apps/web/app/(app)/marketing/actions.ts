"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { presetByKey } from "@centralops/domain";
import type { Json } from "@centralops/db";
import { createClient } from "@/lib/supabase/server";
import { audienceFromForm } from "./audience";

const friendly = (m: string) => m.replace(/^ERROR:\s*/, "");
const str = (v: FormDataEntryValue | null) => String(v ?? "").trim();
const LIST = "/marketing/campanhas";
const num = (v: FormDataEntryValue | null) => { const t = str(v).replace(",", "."); return t && Number.isFinite(Number(t)) ? Number(t) : null; };
const localDate = (v: FormDataEntryValue | null) => { const t = str(v); return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(t) ? `${t}:00-03:00` : /^\d{4}-\d{2}-\d{2}$/.test(t) ? `${t}T23:59:00-03:00` : null; };

function go(path: string, params: Record<string, string | undefined> = {}): never {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString();
  redirect(q ? `${path}?${q}` : path);
}
const refresh = () => revalidatePath("/marketing", "layout");
const step = (id: string, passo: number, params: Record<string, string | undefined> = {}) => go(`${LIST}/${id}/montar`, { passo: String(passo), ...params });

interface CampaignRow {
  id: string; name: string; description: string | null; objective: string; segment_id: string | null; audience: unknown; audience_scope: string;
  starts_at: string | null; ends_at: string | null; budget: number | null; holdout_pct: number; attribution_days: number; landing_url: string | null;
}

/** save_campaign em rascunho regrava tudo: cada passo parte da campanha atual e troca só o que mudou. */
async function patchCampaign(id: string, patch: Record<string, unknown>) {
  const supabase = await createClient();
  const { data: c } = await supabase.schema("mkt").from("campaigns").select("id, name, description, objective, segment_id, audience, audience_scope, starts_at, ends_at, budget, holdout_pct, attribution_days, landing_url").eq("id", id).maybeSingle();
  if (!c) return { error: "Campanha não encontrada." };
  const cur = c as unknown as CampaignRow;
  const { error } = await supabase.schema("mkt").rpc("save_campaign", { p: { ...cur, ...patch, id } as unknown as Json });
  return { error: error ? friendly(error.message) : undefined };
}

/** Passo 1: escolhe o modelo, cria o rascunho já preenchido e segue para o público. */
export async function startCampaignAction(formData: FormData) {
  const preset = presetByKey(str(formData.get("preset")));
  const name = str(formData.get("name")) || preset.label;
  const supabase = await createClient();
  const { data, error } = await supabase.schema("mkt").rpc("save_campaign", { p: {
    name, objective: preset.objective, audience: preset.audience, audience_scope: preset.scope, holdout_pct: preset.holdout_pct, attribution_days: preset.attribution_days,
  } as unknown as Json });
  if (error) go(`${LIST}/nova`, { erro: friendly(error.message) });
  const id = (data as unknown as { id: string }).id;
  const o = preset.offer;
  let warn: string | undefined;
  if (o.mode !== "NONE") {
    // código único do modelo (ex.: DROP10); se já existir, tenta com sufixo
    const base = `${o.prefix ?? "CMP"}${o.value ?? ""}`.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);
    let lastErr: string | undefined;
    for (const code of o.mode === "SHARED" ? [base, ...Array.from({ length: 3 }, () => base + Math.random().toString(36).slice(2, 5).toUpperCase())] : [undefined]) {
      const { error: e } = await supabase.schema("mkt").rpc("save_campaign_offer", { p: {
        campaign_id: id, mode: o.mode, kind: o.kind, value: o.value, valid_days: o.valid_days, min_order: o.min_order, code_prefix: o.mode === "PERSONAL" ? o.prefix : undefined, code,
      } as unknown as Json });
      lastErr = e ? friendly(e.message) : undefined;
      if (!e) break;
    }
    if (lastErr) warn = `A oferta do modelo não foi aplicada (${lastErr}): ajuste no passo Oferta.`;
  }
  refresh();
  step(id, 2, { preset: preset.key, erro: warn });
}

/** Passo 2: público (filtros ou público salvo), escopo, grupo de controle e janela. */
export async function saveAudienceStepAction(formData: FormData) {
  const id = str(formData.get("id"));
  const audience = audienceFromForm(formData);
  const supabase = await createClient();
  const asName = str(formData.get("save_as"));
  if (asName) {
    const { error } = await supabase.schema("mkt").rpc("save_segment", { p: { name: asName, definition: audience, kind: "DYNAMIC" } as unknown as Json });
    if (error) step(id, 2, { erro: friendly(error.message) });
  }
  const r = await patchCampaign(id, {
    audience, segment_id: (audience as { segment_id?: string }).segment_id || null, audience_scope: str(formData.get("audience_scope")) || "LOCAL",
    holdout_pct: num(formData.get("holdout_pct")) ?? 0, attribution_days: num(formData.get("attribution_days")) ?? 7,
  });
  refresh();
  if (r.error) step(id, 2, { erro: r.error });
  step(id, 3);
}

/** Passo 3: oferta + período e página da campanha. */
export async function saveOfferStepAction(formData: FormData) {
  const id = str(formData.get("id"));
  const mode = str(formData.get("mode")) || "NONE";
  const r = await patchCampaign(id, { name: str(formData.get("name")), starts_at: localDate(formData.get("starts_at")), ends_at: localDate(formData.get("ends_at")), budget: num(formData.get("budget")), landing_url: str(formData.get("landing_url")) || null });
  if (r.error) step(id, 3, { erro: r.error });
  const supabase = await createClient();
  const { error } = await supabase.schema("mkt").rpc("save_campaign_offer", { p: {
    campaign_id: id, mode, kind: str(formData.get("kind")) || "PERCENT", value: num(formData.get("value")), min_order: num(formData.get("min_order")), per_customer_limit: num(formData.get("per_customer_limit")),
    max_uses: num(formData.get("max_uses")), valid_days: num(formData.get("valid_days")), valid_to: localDate(formData.get("valid_to")), code: str(formData.get("code")), code_prefix: str(formData.get("code_prefix")),
  } as unknown as Json });
  refresh();
  if (error) step(id, 3, { erro: friendly(error.message) });
  step(id, 4);
}

/** Passo 4 (e aba Canais): grava um disparo de WhatsApp. */
export async function saveDispatchAction(formData: FormData) {
  const id = str(formData.get("id"));
  const back = str(formData.get("back")) === "page" ? `${LIST}/${id}` : `${LIST}/${id}/montar`;
  const params = back.endsWith("montar") ? { passo: "4" } : { aba: "canais" };
  const n = Number(str(formData.get("var_count"))) || 0;
  const variables = Array.from({ length: n }, (_, i) => { const source = str(formData.get(`var_${i}_source`)) || "FIRST_NAME"; return { source, ...(source === "TEXT" ? { text: str(formData.get(`var_${i}_text`)) } : {}) }; });
  const supabase = await createClient();
  const { error } = await supabase.schema("mkt").rpc("save_dispatch", { p: {
    campaign_id: id, id: str(formData.get("dispatch_id")) || undefined, label: str(formData.get("label")), channel_account_id: str(formData.get("channel_account_id")), template_id: str(formData.get("template_id")),
    variables, filter: str(formData.get("filter")) || "ALL", scheduled_at: localDate(formData.get("scheduled_at")), frequency_cap_days: num(formData.get("frequency_cap_days")) ?? 7, daily_limit: num(formData.get("daily_limit")) ?? 250,
  } as unknown as Json });
  // campanha já ativa: o novo lembrete precisa ser agendado
  let activeErr: string | undefined;
  if (!error && str(formData.get("activate")) === "1") {
    const { data: d } = await supabase.schema("mkt").from("campaign_dispatches").select("id").eq("campaign_id", id).eq("status", "DRAFT").order("seq", { ascending: false }).limit(1).maybeSingle();
    if (d) { const r = await supabase.schema("mkt").rpc("activate_dispatch", { p_id: d.id }); activeErr = r.error ? friendly(r.error.message) : undefined; }
  }
  refresh();
  go(back, { ...params, ...(error || activeErr ? { erro: error ? friendly(error.message) : activeErr } : { ok: "Disparo salvo." }) });
}

export async function deleteDispatchAction(formData: FormData) {
  const id = str(formData.get("id"));
  const supabase = await createClient();
  const { error } = await supabase.schema("mkt").rpc("delete_dispatch", { p_id: str(formData.get("dispatch_id")) });
  refresh();
  step(id, 4, error ? { erro: friendly(error.message) } : { ok: "Disparo removido." });
}

export async function cancelDispatchAction(formData: FormData) {
  const id = str(formData.get("id"));
  const supabase = await createClient();
  const { error } = await supabase.schema("mkt").rpc("cancel_dispatch", { p_id: str(formData.get("dispatch_id")) });
  refresh();
  go(`${LIST}/${id}`, { aba: "canais", ...(error ? { erro: friendly(error.message) } : { ok: "Disparo cancelado: quem ainda não recebeu não receberá." }) });
}

export async function launchCampaignAction(formData: FormData) {
  const id = str(formData.get("id"));
  const supabase = await createClient();
  const { error } = await supabase.schema("mkt").rpc("launch_campaign", { p_id: id });
  refresh();
  if (error) step(id, 5, { erro: friendly(error.message) });
  go(`${LIST}/${id}`, { ok: "Campanha lançada. O envio segue em lotes, respeitando o limite diário do número.", wait: "1" });
}

export async function endCampaignAction(formData: FormData) {
  const id = str(formData.get("id"));
  const supabase = await createClient();
  const { error } = await supabase.schema("mkt").rpc("end_campaign", { p_id: id });
  refresh();
  go(`${LIST}/${id}`, error ? { erro: friendly(error.message) } : { ok: "Campanha encerrada. O resultado continua sendo contado na janela de atribuição." });
}

export async function cancelCampaignAction(formData: FormData) {
  const id = str(formData.get("id"));
  const supabase = await createClient();
  const { error } = await supabase.schema("mkt").rpc("cancel_campaign", { p_id: id });
  refresh();
  go(`${LIST}/${id}`, error ? { erro: friendly(error.message) } : { ok: "Campanha cancelada: quem ainda não recebeu não receberá." });
}

export async function deleteCampaignAction(formData: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.schema("mkt").rpc("delete_campaign", { p_id: str(formData.get("id")) });
  refresh();
  go(LIST, error ? { erro: friendly(error.message) } : { ok: "Rascunho excluído." });
}

/** Configuração da campanha ativa: descrição, fim e orçamento. */
export async function updateActiveCampaignAction(formData: FormData) {
  const id = str(formData.get("id"));
  const r = await patchCampaign(id, { name: str(formData.get("name")), ends_at: localDate(formData.get("ends_at")), budget: num(formData.get("budget")) });
  refresh();
  go(`${LIST}/${id}`, { aba: "config", ...(r.error ? { erro: r.error } : { ok: "Configuração salva." }) });
}

/** Aba Canais: escolhe à mão quais campanhas da Meta pertencem a esta campanha (a tag [c:codigo] liga sozinha). */
export async function linkAdsAction(formData: FormData) {
  const id = str(formData.get("id"));
  const supabase = await createClient();
  const { error } = await supabase.schema("mkt").rpc("link_campaign_ads", { p_campaign: id, p_meta_ids: formData.getAll("meta_ids").map(String) });
  refresh();
  go(`${LIST}/${id}`, { aba: "canais", ...(error ? { erro: friendly(error.message) } : { ok: "Anúncios vinculados." }) });
}

/** Aba Canais: manda (ou atualiza) o público da campanha na Meta — só quem está no tratamento e aceitou anúncios. Só sócio. */
export async function sendCampaignAudienceAction(formData: FormData) {
  const id = str(formData.get("id"));
  const supabase = await createClient();
  const { error } = await supabase.schema("mkt").rpc("request_audience_sync", { p: { campaign_id: id, auto_sync: true } as unknown as Json });
  refresh();
  go(`${LIST}/${id}`, { aba: "canais", ...(error ? { erro: friendly(error.message) } : { ok: "Enviando o público para a Meta." }) });
}
