"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { Json } from "@centralops/db";
import { parseMoney } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { bulkFlash, bulkIds, runBulk } from "@/lib/bulk";

const BASE = "/financeiro/documentos";
const str = (v: FormDataEntryValue | null) => String(v ?? "").trim();
const friendly = (m: string) => m.replace(/^ERROR:\s*/, "");

function go(params: Record<string, string | undefined>): never {
  revalidatePath(BASE);
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString();
  redirect(q ? `${BASE}?${q}` : BASE);
}

/** Lança um documento no destino escolhido, com os campos corrigidos na linha (valor em "1.234,56", datas do campo date). */
export async function confirmDocAction(formData: FormData) {
  const id = str(formData.get("id"));
  const fields: Record<string, string | number> = {};
  const desc = str(formData.get("descricao"));
  if (desc) fields.descricao = desc;
  const amount = parseMoney(str(formData.get("valor")));
  if (amount !== null) fields.valor = amount;
  for (const k of ["vencimento", "data"]) if (/^\d{4}-\d{2}-\d{2}$/.test(str(formData.get(k)))) fields[k] = str(formData.get(k));
  const supabase = await createClient();
  const { data, error } = await supabase.schema("fin").rpc("doc_inbox_confirm", {
    p_id: id, p: { destination: str(formData.get("destination")), fields, force: str(formData.get("force")) === "1" } as Json,
  });
  go(error ? { erro: friendly(error.message) } : { ok: `Lançado: ${data.target_label}` });
}

/** Descarta e apaga o arquivo guardado. */
export async function discardDocAction(formData: FormData) {
  const supabase = await createClient();
  const { data: path, error } = await supabase.schema("fin").rpc("doc_inbox_discard", { p_id: str(formData.get("id")) });
  if (!error && path) await supabase.storage.from("fin-docs").remove([path]);
  go(error ? { erro: friendly(error.message) } : { ok: "Documento descartado" });
}

/** "Lançar os prontos": cada um no destino sugerido, com os campos lidos. O que falhar fica na fila com o motivo. */
export async function confirmManyDocsAction(formData: FormData) {
  const ids = bulkIds(formData);
  const supabase = await createClient();
  const { data: rows } = await supabase.schema("fin").from("doc_inbox").select("id, label").in("id", ids);
  const label = new Map((rows ?? []).map((r) => [r.id, r.label]));
  const r = await runBulk(ids, (id) => supabase.schema("fin").rpc("doc_inbox_confirm", { p_id: id }), (id) => label.get(id) ?? "");
  go(bulkFlash(r, (n) => `${n} documento(s) lançado(s)`));
}
