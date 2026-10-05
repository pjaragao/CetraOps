"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { Json } from "@centralops/db";
import { createClient } from "@/lib/supabase/server";

export type State = { ok: boolean; error?: string; message?: string } | null;

const friendly = (m: string) => m.replace(/^ERROR:\s*/, "");
const str = (v: FormDataEntryValue | null) => String(v ?? "").trim();
const uuid = z.string().uuid();
const LIST = "/ia/personas";
const MAX_BYTES = 24_000_000;

function back(path: string, params: Record<string, string | undefined> = {}): never {
  const q = Object.entries(params).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v!)}`).join("&");
  redirect(q ? `${path}?${q}` : path);
}
const refresh = () => revalidatePath(LIST, "layout");
const here = (formData: FormData) => `${LIST}/${str(formData.get("persona_id"))}`;

export async function savePersonaAction(formData: FormData) {
  const supabase = await createClient();
  const id = str(formData.get("id"));
  const { data, error } = await supabase.schema("ai").rpc("save_persona", { p: { ...(id ? { id } : {}), name: str(formData.get("name")), member_id: str(formData.get("member_id")) || null } as Json });
  refresh();
  if (error) back(LIST, { erro: friendly(error.message) });
  back(`${LIST}/${(data as unknown as { id: string }).id}`, { ok: id ? "Persona atualizada." : "Persona criada. Envie o histórico de conversas para treiná-la." });
}

/** Histórico de conversas: WhatsApp (.txt exportado) ou Instagram (message_N.json). O arquivo bruto só existe até o worker tratar. */
export async function uploadCorpusAction(_prev: State, formData: FormData): Promise<State> {
  const persona = str(formData.get("persona_id"));
  const kind = str(formData.get("kind"));
  const owner = str(formData.get("owner_name"));
  const parsed = z.object({ persona: uuid, kind: z.enum(["WA_TXT", "IG_JSON"]), owner: z.string().min(1).max(80) }).safeParse({ persona, kind, owner });
  if (!parsed.success) return { ok: false, error: "Escolha o tipo de histórico e informe como o sócio aparece no arquivo." };
  const files = formData.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length === 0) return { ok: false, error: "Escolha o arquivo do histórico." };
  if (files.reduce((n, f) => n + f.size, 0) > MAX_BYTES) return { ok: false, error: "Os arquivos passam de 24 MB: envie em partes." };
  let content: string;
  try {
    if (kind === "WA_TXT") {
      if (files.length > 1) return { ok: false, error: "Envie um arquivo .txt por vez no WhatsApp (cada conversa exportada é um arquivo)." };
      content = await files[0].text();
    } else {
      content = JSON.stringify(await Promise.all(files.map(async (f) => JSON.parse(await f.text()) as unknown)));
    }
  } catch {
    return { ok: false, error: "Não consegui ler o arquivo. No Instagram, envie os arquivos message_1.json (JSON) da pasta da conversa." };
  }
  const supabase = await createClient();
  const { error } = await supabase.schema("ai").rpc("create_corpus_source", { p: { persona_id: persona, kind, owner_name: owner, filename: files.map((f) => f.name).join(", ").slice(0, 200), content } as Json });
  if (error) return { ok: false, error: friendly(error.message) };
  refresh();
  return { ok: true, message: "Histórico recebido. O sistema está tratando (troca nomes e dados pessoais por marcadores e apaga o arquivo original)." };
}

export async function deleteSourceAction(formData: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.schema("ai").rpc("delete_corpus_source", { p_id: str(formData.get("id")) });
  refresh();
  back(here(formData), error ? { erro: friendly(error.message) } : { ok: "Histórico apagado, junto com os diálogos e exemplos que vieram dele." });
}

/** Tira ou devolve diálogos da persona (checkboxes `ids`; botão `include` = 1 ou 0). */
export async function setIncludedAction(formData: FormData) {
  const ids = formData.getAll("ids").map(String).filter((i) => uuid.safeParse(i).success);
  if (ids.length === 0) back(here(formData), { erro: "Marque os diálogos." });
  const include = str(formData.get("include")) === "1";
  const supabase = await createClient();
  const { error } = await supabase.schema("ai").rpc("set_dialogues_included", { p_ids: ids, p_include: include });
  refresh();
  back(here(formData), error ? { erro: friendly(error.message) } : { ok: include ? `${ids.length} diálogo(s) voltaram para a persona.` : `${ids.length} diálogo(s) saíram da persona.` });
}

export async function requestTaskAction(formData: FormData) {
  const supabase = await createClient();
  const action = str(formData.get("action"));
  const { error } = await supabase.schema("ai").rpc("request_corpus_task", { p_persona: str(formData.get("persona_id")), p_action: action });
  refresh();
  back(here(formData), error ? { erro: friendly(error.message) } : { ok: action === "CLASSIFY" ? "Classificação pedida: a IA marca o que é conversa comercial." : "Indexação pedida.", wait: "1" });
}

export async function requestProfileAction(formData: FormData) {
  const lexicon = str(formData.get("lexicon")).split(/[,\n]/).map((s) => s.trim()).filter(Boolean).slice(0, 40);
  const supabase = await createClient();
  const { error } = await supabase.schema("ai").rpc("request_persona_profile", { p_persona: str(formData.get("persona_id")), p_lexicon: lexicon });
  refresh();
  back(here(formData), error ? { erro: friendly(error.message) } : { ok: "Gerando o perfil de estilo: o rascunho aparece em Versões em alguns minutos.", wait: "1" });
}

export async function newVersionAction(formData: FormData) {
  const supabase = await createClient();
  const { data, error } = await supabase.schema("ai").rpc("save_persona_version", { p: { persona_id: str(formData.get("persona_id")) } as Json });
  refresh();
  if (error) back(here(formData), { erro: friendly(error.message) });
  back(here(formData), { v: (data as unknown as { id: string }).id, ok: "Nova versão em branco criada." });
}

export async function saveVersionAction(_prev: State, formData: FormData): Promise<State> {
  const rules = str(formData.get("extra_rules")).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const supabase = await createClient();
  const { error } = await supabase.schema("ai").rpc("save_persona_version", { p: { id: str(formData.get("id")), system_prompt: String(formData.get("system_prompt") ?? ""), guardrails: { extra_rules: rules } } as Json });
  if (error) return { ok: false, error: friendly(error.message) };
  refresh();
  return { ok: true, message: "Rascunho salvo." };
}

export async function approveVersionAction(formData: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.schema("ai").rpc("approve_persona_version", { p_id: str(formData.get("id")) });
  refresh();
  back(here(formData), error ? { erro: friendly(error.message) } : { ok: "Versão aprovada e ativa: as próximas respostas já usam este estilo." });
}
