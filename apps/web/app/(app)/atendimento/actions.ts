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
