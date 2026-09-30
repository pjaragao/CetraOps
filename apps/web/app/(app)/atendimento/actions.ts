"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

const MODES = ["AI_AUTOPILOT", "AI_COPILOT", "HUMAN", "WAITING_HUMAN"] as const;
export type ConvMode = (typeof MODES)[number];

export async function setMode(conversationId: string, mode: ConvMode, reason?: string) {
  const parsed = z.object({ id: z.string().uuid(), mode: z.enum(MODES) }).safeParse({ id: conversationId, mode });
  if (!parsed.success) return { ok: false, error: "Parâmetros inválidos" };
  const supabase = await createClient();
  const { error } = await supabase.schema("omni").rpc("set_mode", { p_conversation: conversationId, p_mode: mode, p_reason: reason });
  revalidatePath("/atendimento");
  return error ? { ok: false, error: error.message } : { ok: true };
}

export async function sendMessage(conversationId: string, body: string, draftId?: string, edited?: boolean) {
  if (!body.trim()) return { ok: false, error: "Mensagem vazia" };
  const supabase = await createClient();
  const { error } = await supabase.schema("omni").rpc("send_message", {
    p_conversation: conversationId, p_body: body.slice(0, 4000), p_draft: draftId, p_edited: edited ?? false,
  });
  revalidatePath("/atendimento");
  return error ? { ok: false, error: error.message } : { ok: true };
}

export async function discardDraft(draftId: string, reason: string) {
  const supabase = await createClient();
  const { error } = await supabase.schema("omni").rpc("discard_draft", { p_draft: draftId, p_reason: reason });
  revalidatePath("/atendimento");
  return error ? { ok: false, error: error.message } : { ok: true };
}

export async function markRead(conversationId: string) {
  const supabase = await createClient();
  await supabase.schema("omni").rpc("mark_read", { p_conversation: conversationId });
}

/** Envia um template aprovado (vale dentro e fora da janela de 24 h). `params` = valores de {{1}}, {{2}}… */
export async function sendTemplate(conversationId: string, templateId: string, params: string[]) {
  const parsed = z.object({ c: z.string().uuid(), t: z.string().uuid(), p: z.array(z.string().max(200)).max(20) }).safeParse({ c: conversationId, t: templateId, p: params });
  if (!parsed.success) return { ok: false, error: "Parâmetros inválidos" };
  const supabase = await createClient();
  const { error } = await supabase.schema("omni").rpc("send_template", { p_conversation: conversationId, p_template: templateId, p_params: params });
  revalidatePath("/atendimento");
  return error ? { ok: false, error: error.message.replace(/^ERROR:\s*/, "") } : { ok: true };
}

const clean = (m: string) => m.replace(/^ERROR:\s*/, "");

/** Pausa a IA nesta conversa (0 = retomar). A conversa continua no mesmo modo. */
export async function pauseAi(conversationId: string, minutes: number) {
  const parsed = z.object({ c: z.string().uuid(), m: z.number().int().min(0).max(1440) }).safeParse({ c: conversationId, m: minutes });
  if (!parsed.success) return { ok: false, error: "Parâmetros inválidos" };
  const supabase = await createClient();
  const { error } = await supabase.schema("omni").rpc("pause_ai", { p_conversation: conversationId, p_minutes: minutes });
  revalidatePath("/atendimento");
  return error ? { ok: false, error: clean(error.message) } : { ok: true };
}

/** Devolve a conversa para a IA (Copiloto ou Piloto), com uma instrução opcional que a IA segue nas próximas respostas. */
export async function returnToAi(conversationId: string, mode: "AI_COPILOT" | "AI_AUTOPILOT", instruction: string) {
  const parsed = z.object({ c: z.string().uuid(), m: z.enum(["AI_COPILOT", "AI_AUTOPILOT"]), i: z.string().max(500) }).safeParse({ c: conversationId, m: mode, i: instruction });
  if (!parsed.success) return { ok: false, error: "Parâmetros inválidos (a instrução tem no máximo 500 caracteres)" };
  const supabase = await createClient();
  const { error } = await supabase.schema("omni").rpc("return_to_ai", { p_conversation: conversationId, p_mode: mode, ...(instruction.trim() ? { p_instruction: instruction.trim() } : {}) });
  revalidatePath("/atendimento");
  return error ? { ok: false, error: clean(error.message) } : { ok: true };
}

/** Nota interna (nunca vai para a cliente). `mentions` = ids das pessoas avisadas. */
export async function addNote(conversationId: string, body: string, mentions: string[]) {
  const parsed = z.object({ c: z.string().uuid(), b: z.string().min(1).max(2000), m: z.array(z.string().uuid()).max(20) }).safeParse({ c: conversationId, b: body.trim(), m: mentions });
  if (!parsed.success) return { ok: false, error: "Escreva a nota (até 2000 caracteres)" };
  const supabase = await createClient();
  const { error } = await supabase.schema("omni").rpc("add_note", { p_conversation: conversationId, p_body: body.trim(), p_mentions: mentions });
  revalidatePath("/atendimento");
  return error ? { ok: false, error: clean(error.message) } : { ok: true };
}

/** Atribui a conversa a uma pessoa da equipe (vazio = sem dono). */
export async function assignConversation(conversationId: string, memberId: string) {
  const parsed = z.object({ c: z.string().uuid(), m: z.string().uuid().or(z.literal("")) }).safeParse({ c: conversationId, m: memberId });
  if (!parsed.success) return { ok: false, error: "Parâmetros inválidos" };
  const supabase = await createClient();
  const { error } = await supabase.schema("omni").rpc("assign_conversation", { p_conversation: conversationId, ...(memberId ? { p_member: memberId } : {}) });
  revalidatePath("/atendimento");
  return error ? { ok: false, error: clean(error.message) } : { ok: true };
}
