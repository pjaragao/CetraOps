"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { Json } from "@centralops/db";
import { createClient } from "@/lib/supabase/server";
import { audienceFromForm, type AudiencePreview } from "../audience";

const friendly = (m: string) => m.replace(/^ERROR:\s*/, "");
const str = (v: FormDataEntryValue | null) => String(v ?? "").trim();
const PATH = "/marketing/publicos";

function go(params: Record<string, string | undefined>): never {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString();
  redirect(q ? `${PATH}?${q}` : PATH);
}

/** Contagem ao vivo do construtor de público (não grava nada). */
export async function previewAudienceAction(fd: FormData): Promise<AudiencePreview | { error: string }> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema("mkt").rpc("segment_preview", { p_def: audienceFromForm(fd) as unknown as Json });
  if (error) return { error: friendly(error.message) };
  return data as unknown as AudiencePreview;
}

export async function saveSegmentAction(formData: FormData) {
  const supabase = await createClient();
  const id = str(formData.get("id"));
  const { data, error } = await supabase.schema("mkt").rpc("save_segment", { p: {
    id: id || null, name: str(formData.get("name")), description: str(formData.get("description")), kind: str(formData.get("kind")) || "DYNAMIC", definition: audienceFromForm(formData),
  } as unknown as Json });
  revalidatePath(PATH);
  if (error) go({ erro: friendly(error.message), editar: id || "novo" });
  go({ ok: `Público salvo: ${(data as unknown as { cached_count: number }).cached_count} pessoa(s) hoje.` });
}

export async function deleteSegmentAction(formData: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.schema("mkt").rpc("delete_segment", { p_id: str(formData.get("id")) });
  revalidatePath(PATH);
  go(error ? { erro: friendly(error.message) } : { ok: "Público excluído." });
}

export async function refreshSegmentAction(formData: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.schema("mkt").rpc("refresh_segment", { p_id: str(formData.get("id")) });
  revalidatePath(PATH);
  go(error ? { erro: friendly(error.message) } : { ok: "Contagem atualizada." });
}

/** Cria uma campanha em rascunho já com este público. */
export async function campaignFromSegmentAction(formData: FormData) {
  const supabase = await createClient();
  const segId = str(formData.get("id"));
  const { data: seg } = await supabase.schema("mkt").from("segments").select("name").eq("id", segId).maybeSingle();
  if (!seg) go({ erro: "Público não encontrado." });
  const { data, error } = await supabase.schema("mkt").rpc("save_campaign", { p: { name: `Campanha · ${seg.name}`.slice(0, 120), segment_id: segId, objective: "CUSTOM" } as unknown as Json });
  if (error) go({ erro: friendly(error.message) });
  redirect(`/marketing/campanhas/${(data as unknown as { id: string }).id}/montar?passo=3`);
}

/** Manda o público para a Meta (só sócio). */
export async function sendSegmentToMetaAction(formData: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.schema("mkt").rpc("request_audience_sync", { p: { segment_id: str(formData.get("id")), auto_sync: str(formData.get("auto")) === "1" } as unknown as Json });
  revalidatePath(PATH);
  revalidatePath("/marketing/anuncios");
  go(error ? { erro: friendly(error.message) } : { ok: "Enviando o público para a Meta. Acompanhe em Marketing › Anúncios Meta." });
}
