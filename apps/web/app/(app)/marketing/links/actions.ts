"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { Json } from "@centralops/db";
import { createClient } from "@/lib/supabase/server";

const friendly = (m: string) => m.replace(/^ERROR:\s*/, "");
const str = (v: FormDataEntryValue | null) => String(v ?? "").trim();
const PATH = "/marketing/links";

function go(params: Record<string, string | undefined>): never {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString();
  redirect(q ? `${PATH}?${q}` : PATH);
}

export async function saveLinkAction(formData: FormData) {
  const supabase = await createClient();
  const id = str(formData.get("id"));
  const { error } = await supabase.schema("mkt").rpc("save_tracking_link", { p: {
    id: id || null, code: str(formData.get("code")), name: str(formData.get("name")), kind: str(formData.get("kind")),
    channel_account_id: str(formData.get("channel_account_id")) || null,
    target_url: str(formData.get("target_url")) || null,
    campaign_id: str(formData.get("campaign_id")) || null,
    prefill_text: str(formData.get("prefill_text")), affiliate_party_id: str(formData.get("affiliate_party_id")) || null, event_id: str(formData.get("event_id")) || null,
  } as Json });
  revalidatePath(PATH);
  go(error ? { erro: friendly(error.message), editar: id || undefined } : { ok: id ? "Link atualizado" : "Link criado: baixe o QR ou copie o endereço" });
}

export async function toggleLinkAction(formData: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.schema("mkt").rpc("set_tracking_link_active", { p_id: str(formData.get("id")), p_active: str(formData.get("active")) === "1" });
  revalidatePath(PATH);
  go(error ? { erro: friendly(error.message) } : { ok: "Link atualizado" });
}

export async function setChannelAddressAction(formData: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.schema("omni").rpc("set_channel_public_address", { p_id: str(formData.get("id")), p_address: str(formData.get("address")) });
  revalidatePath(PATH);
  go(error ? { erro: friendly(error.message) } : { ok: "Endereço do canal salvo" });
}

export async function setPublicUrlAction(formData: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.schema("mkt").rpc("set_public_url", { p_base: str(formData.get("base")) });
  revalidatePath(PATH);
  go(error ? { erro: friendly(error.message) } : { ok: "Endereço público do sistema salvo" });
}

