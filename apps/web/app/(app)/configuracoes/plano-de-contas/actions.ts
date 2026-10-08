"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { Json } from "@centralops/db";
import { createClient } from "@/lib/supabase/server";

const str = (v: FormDataEntryValue | null) => String(v ?? "").trim();
const clean = (m: string) => m.replace(/^ERROR:\s*/, "");
const PATH = "/configuracoes/plano-de-contas";

function go(params: Record<string, string | undefined>): never {
  revalidatePath(PATH);
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString();
  redirect(q ? `${PATH}?${q}` : PATH);
}

export async function saveChartAccountAction(formData: FormData) {
  const id = str(formData.get("id"));
  const supabase = await createClient();
  const { error } = await supabase.schema("fin").rpc("save_chart_account", { p: {
    id: id || null, code: str(formData.get("code")), name: str(formData.get("name")), parent_id: str(formData.get("parent_id")) || null,
    kind: str(formData.get("kind")), nature: str(formData.get("nature")) || null, group: str(formData.get("group")) || null,
    dre_line_id: str(formData.get("dre_line_id")) || null, accountant_code: str(formData.get("accountant_code")),
  } as Json });
  go(error ? { erro: clean(error.message), ...(id ? { editar: id } : { nova: "1" }) } : { ok: id ? "Conta salva" : "Conta criada" });
}

export async function archiveChartAccountAction(formData: FormData) {
  const archive = str(formData.get("archive")) === "1";
  const supabase = await createClient();
  const { error } = await supabase.schema("fin").rpc("set_chart_account_archived", { p_id: str(formData.get("id")), p_archived: archive });
  go(error ? { erro: clean(error.message) } : { ok: archive ? "Conta arquivada" : "Conta reativada" });
}
