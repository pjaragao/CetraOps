"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

export type State = { ok: boolean; error?: string; message?: string } | null;

const LIST = "/ia/conhecimento";
const friendly = (m: string) => m.replace(/^ERROR:\s*/, "");
const str = (v: FormDataEntryValue | null) => String(v ?? "").trim();
const refresh = () => revalidatePath(LIST, "layout");

function back(path: string, params: Record<string, string | undefined> = {}): never {
  const q = Object.entries(params).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v!)}`).join("&");
  redirect(q ? `${path}?${q}` : path);
}

/** Salva o rascunho (intent=save) ou salva e publica (intent=publish). Só o publicado chega à IA. */
export async function saveKnowledgeAction(_prev: State, formData: FormData): Promise<State> {
  const id = str(formData.get("id"));
  const intent = str(formData.get("intent"));
  const parsed = z.object({
    title: z.string().min(3, "Dê um título de pelo menos 3 letras").max(120, "Título de até 120 caracteres"),
    kind: z.enum(["POLICY", "FAQ", "PRODUCT_CARE", "BRAND", "EVENT", "OTHER"]),
    body: z.string().max(20000, "O texto passa de 20.000 caracteres: divida em dois documentos"),
  }).safeParse({ title: str(formData.get("title")), kind: str(formData.get("kind")), body: String(formData.get("body") ?? "") });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message };
  const supabase = await createClient();
  const { data, error } = await supabase.schema("ai").rpc("save_knowledge_doc", {
    p_id: (id || null) as unknown as string,   // null = documento novo (o tipo gerado não conhece parâmetro anulável sem padrão)
    p_title: parsed.data.title, p_kind: parsed.data.kind, p_body: parsed.data.body,
    ...(str(formData.get("valid_from")) ? { p_valid_from: str(formData.get("valid_from")) } : {}),
    ...(str(formData.get("valid_to")) ? { p_valid_to: str(formData.get("valid_to")) } : {}),
  });
  if (error) return { ok: false, error: friendly(error.message) };
  const doc = data as unknown as { id: string };
  if (intent === "publish") {
    const pub = await supabase.schema("ai").rpc("publish_knowledge_doc", { p_id: doc.id });
    refresh();
    if (pub.error) back(`${LIST}/${doc.id}`, { erro: `Rascunho salvo, mas não publicou: ${friendly(pub.error.message)}` });
    back(`${LIST}/${doc.id}`, { ok: "Publicado. A IA já usa este texto nas próximas respostas." });
  }
  refresh();
  if (!id) back(`${LIST}/${doc.id}`, { ok: "Rascunho criado. Publique quando estiver pronto." });
  return { ok: true, message: "Rascunho salvo. A IA só passa a usar depois de publicar." };
}

export async function archiveKnowledgeAction(formData: FormData) {
  const id = str(formData.get("id"));
  const archive = str(formData.get("archive")) === "1";
  const supabase = await createClient();
  const { error } = await supabase.schema("ai").rpc("archive_knowledge_doc", { p_id: id, p_archive: archive });
  refresh();
  back(`${LIST}/${id}`, error ? { erro: friendly(error.message) } : { ok: archive ? "Arquivado: a IA não usa mais este documento." : "Reativado." });
}

export async function deleteKnowledgeAction(formData: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.schema("ai").rpc("delete_knowledge_doc", { p_id: str(formData.get("id")) });
  refresh();
  back(error ? `${LIST}/${str(formData.get("id"))}` : LIST, error ? { erro: friendly(error.message) } : { ok: "Rascunho apagado." });
}
