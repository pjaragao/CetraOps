"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

const friendly = (m: string) => m.replace(/^ERROR:\s*/, "");
const str = (v: FormDataEntryValue | null) => String(v ?? "").trim();

function back(path: string, params: Record<string, string | undefined>): never {
  const q = Object.entries(params).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v!)}`).join("&");
  redirect(q ? `${path}${path.includes("?") ? "&" : "?"}${q}` : path);
}

/** Gera a guia do DAS do mês como conta a pagar (contabiliza a dedução e entra no calendário). */
export async function postDasAction(formData: FormData) {
  const supabase = await createClient();
  const month = str(formData.get("month"));
  const { error } = await supabase.schema("fiscal").rpc("post_das", { p_entity: str(formData.get("entity")), p_competence: `${month}-01` });
  revalidatePath("/fiscal", "layout");
  revalidatePath("/financeiro", "layout");
  back("/fiscal", { mes: month, entity: str(formData.get("entity")), ...(error ? { erro: friendly(error.message) } : { ok: "Guia do DAS gerada em Contas a pagar" }) });
}

export async function markEsocialExportedAction(formData: FormData) {
  const supabase = await createClient();
  const ids = formData.getAll("ids").map(String).filter(Boolean);
  if (ids.length) await supabase.schema("fiscal").from("esocial_events").update({ status: "EXPORTED" }).in("id", ids).eq("status", "PENDING");
  revalidatePath("/fiscal/esocial");
  back("/fiscal/esocial", { ok: `${ids.length} evento(s) marcados como enviados ao contador` });
}
