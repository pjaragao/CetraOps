"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { Json } from "@centralops/db";
import { createClient } from "@/lib/supabase/server";

const str = (v: FormDataEntryValue | null) => String(v ?? "").trim();
const clean = (m: string) => m.replace(/^ERROR:\s*/, "");

/** Edita o que é seguro numa conta bancária (o saldo de abertura e, se já há movimentos, a conta do plano não mudam). */
export async function updateBankAccountAction(formData: FormData) {
  const id = str(formData.get("id"));
  const supabase = await createClient();
  const { error } = await supabase.schema("fin").rpc("update_bank_account", { p: {
    id, name: str(formData.get("name")), bank_code: str(formData.get("bank_code")), agency: str(formData.get("agency")), number: str(formData.get("number")),
    pix_keys: str(formData.get("pix_keys")).split(/[,\n]/).map((x) => x.trim()).filter(Boolean), store_id: str(formData.get("store_id")) || null,
    chart_account_id: str(formData.get("chart_account_id")) || null, active: formData.get("active") === "on",
  } as Json });
  revalidatePath("/configuracoes/contas-bancarias", "layout");
  revalidatePath("/financeiro", "layout");
  const q = new URLSearchParams(error ? { erro: clean(error.message) } : { ok: "Conta salva" });
  redirect(`/configuracoes/contas-bancarias/${id}?${q}`);
}
