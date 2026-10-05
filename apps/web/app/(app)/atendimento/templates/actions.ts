"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { Json } from "@centralops/db";
import { createClient } from "@/lib/supabase/server";

export type State = { ok: boolean; error?: string; message?: string } | null;

const friendly = (m: string) => m.replace(/^ERROR:\s*/, "");
const str = (v: FormDataEntryValue | null) => String(v ?? "").trim();
const lines = (v: FormDataEntryValue | null) => String(v ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
const PATH = "/atendimento/templates";
const refresh = () => { revalidatePath(PATH); revalidatePath("/atendimento"); };

function back(params: Record<string, string | undefined> = {}): never {
  const q = Object.entries(params).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v!)}`).join("&");
  redirect(q ? `${PATH}?${q}` : PATH);
}

const templateSchema = z.object({
  id: z.string().uuid().optional(), channel_account_id: z.string().uuid(), name: z.string().min(1).max(100), category: z.enum(["MARKETING", "UTILITY"]), language: z.string().default("pt_BR"),
  header: z.string().max(60).optional(), body: z.string().min(1).max(1024), footer: z.string().max(60).optional(), buttons: z.array(z.string()).max(3), examples: z.array(z.string()),
});

export async function saveTemplateAction(_prev: State, formData: FormData): Promise<State> {
  const opt = (k: string) => str(formData.get(k)) || undefined;
  const parsed = templateSchema.safeParse({
    id: opt("id"), channel_account_id: opt("channel_account_id"), name: opt("name"), category: opt("category"), language: opt("language") ?? "pt_BR",
    header: opt("header"), body: str(formData.get("body")), footer: opt("footer"), buttons: lines(formData.get("buttons")), examples: lines(formData.get("examples")),
  });
  if (!parsed.success) return { ok: false, error: `Confira os campos: ${parsed.error.issues[0]?.path.join(".")} — ${parsed.error.issues[0]?.message}` };
  const supabase = await createClient();
  const { error } = await supabase.schema("omni").rpc("save_template", { p: parsed.data as unknown as Json });
  if (error) return { ok: false, error: friendly(error.message) };
  refresh();
  return { ok: true, message: parsed.data.id ? "Rascunho atualizado" : "Rascunho salvo. Envie para aprovação quando estiver pronto." };
}

export async function submitTemplateAction(formData: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.schema("omni").rpc("submit_template", { p_id: str(formData.get("id")) });
  refresh();
  back(error ? { erro: friendly(error.message) } : { ok: "Enviado para aprovação da Meta. A resposta costuma chegar em minutos.", wait: "1" });
}

export async function deleteTemplateAction(formData: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.schema("omni").rpc("delete_template", { p_id: str(formData.get("id")) });
  refresh();
  back(error ? { erro: friendly(error.message) } : { ok: "Template excluído." });
}

export async function syncTemplatesAction(formData: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.schema("omni").rpc("request_template_sync", { p_account: str(formData.get("channel_account_id")) });
  refresh();
  back(error ? { erro: friendly(error.message) } : { ok: "Sincronização pedida: os templates da Meta aparecem em instantes.", wait: "1" });
}

export async function saveQuickReplyAction(_prev: State, formData: FormData): Promise<State> {
  const shortcut = str(formData.get("shortcut"));
  const body = str(formData.get("body"));
  if (!shortcut || !body) return { ok: false, error: "Informe o atalho e o texto." };
  const supabase = await createClient();
  const id = str(formData.get("id"));
  const { error } = await supabase.schema("omni").rpc("save_quick_reply", { p_shortcut: shortcut, p_body: body, ...(id ? { p_id: id } : {}) });
  if (error) return { ok: false, error: friendly(error.message) };
  refresh();
  return { ok: true, message: "Resposta rápida salva" };
}

export async function deleteQuickReplyAction(formData: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.schema("omni").rpc("delete_quick_reply", { p_id: str(formData.get("id")) });
  refresh();
  back(error ? { erro: friendly(error.message) } : { ok: "Resposta rápida excluída." });
}
