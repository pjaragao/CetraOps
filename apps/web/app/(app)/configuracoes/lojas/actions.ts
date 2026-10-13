"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { Json } from "@centralops/db";
import { createClient } from "@/lib/supabase/server";

const str = (v: FormDataEntryValue | null) => String(v ?? "").trim();
const clean = (m: string) => m.replace(/^ERROR:\s*/, "");

/** Edita a loja (o código e a empresa não mudam: estão em notas, estoque e centro de custo). */
export async function updateStoreAction(formData: FormData) {
  const id = str(formData.get("id"));
  const supabase = await createClient();
  const { error } = await supabase.schema("core").rpc("update_store", { p: {
    id, name: str(formData.get("name")), format: str(formData.get("format")), status: str(formData.get("status")),
    opened_at: str(formData.get("opened_at")), closed_at: str(formData.get("closed_at")), area_m2: str(formData.get("area_m2")).replace(",", "."),
  } as Json });
  revalidatePath("/configuracoes", "layout");
  const q = new URLSearchParams(error ? { erro: clean(error.message) } : { ok: "Loja salva" });
  redirect(`/configuracoes/lojas/${id}?${q}`);
}

const ADDRESS_KEYS = ["street", "number", "complement", "district", "city", "uf", "cep", "reference"] as const;

/** Endereço da loja para as clientes (a IA do atendimento informa este, não o endereço fiscal da empresa). */
export async function updateStoreAddressAction(formData: FormData) {
  const id = str(formData.get("id"));
  const supabase = await createClient();
  const p = Object.fromEntries(ADDRESS_KEYS.map((k) => [k, str(formData.get(k))]));
  const { error } = await supabase.schema("core").rpc("set_store_address", { p_store: id, p: p as Json });
  revalidatePath("/configuracoes", "layout");
  const q = new URLSearchParams(error ? { erro: clean(error.message) } : { ok: "Endereço salvo" });
  redirect(`/configuracoes/lojas/${id}?${q}`);
}
