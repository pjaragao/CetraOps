"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

const friendly = (m: string) => m.replace(/^ERROR:\s*/, "");
const str = (v: FormDataEntryValue | null) => String(v ?? "").trim();
const PATH = "/clientes/prospeccao";

function back(params: Record<string, string | undefined> = {}): never {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString();
  redirect(q ? `${PATH}?${q}` : PATH);
}

export async function generateOutreachAction() {
  const supabase = await createClient();
  const { data, error } = await supabase.schema("crm").rpc("generate_outreach", {});
  revalidatePath(PATH);
  back(error ? { erro: friendly(error.message) } : { ok: Number(data) > 0 ? `${data} ${Number(data) === 1 ? "pessoa entrou" : "pessoas entraram"} na lista de hoje. As mensagens de DM são redigidas em instantes.` : "Ninguém novo para abordar agora: quem tem passo pendente ou fez um passo hoje fica de fora.", wait: Number(data) > 0 ? "1" : undefined });
}

export async function setOutreachStatusAction(formData: FormData) {
  const supabase = await createClient();
  const status = str(formData.get("status"));
  const { error } = await supabase.schema("crm").rpc("set_outreach_status", { p_id: str(formData.get("id")), p_status: status, ...(str(formData.get("note")) ? { p_note: str(formData.get("note")) } : {}) });
  revalidatePath(PATH);
  back({ ver: str(formData.get("ver")), ...(error ? { erro: friendly(error.message) } : { ok: status === "SENT_MANUALLY" ? "Anotado como feito." : status === "SKIPPED" ? "Item pulado." : "Mensagem aprovada." }) });
}

export async function saveOutreachMessageAction(formData: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.schema("crm").rpc("save_outreach_message", { p_id: str(formData.get("id")), p_message: str(formData.get("message")) });
  revalidatePath(PATH);
  back({ ver: str(formData.get("ver")), ...(error ? { erro: friendly(error.message) } : { ok: "Mensagem salva." }) });
}
