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

/** `replyTo`: id da mensagem citada (botão "Responder"); a cliente vê a resposta presa àquela mensagem. */
export async function sendMessage(conversationId: string, body: string, draftId?: string, edited?: boolean, replyTo?: string) {
  if (!body.trim()) return { ok: false, error: "Mensagem vazia" };
  if (replyTo && !z.string().uuid().safeParse(replyTo).success) return { ok: false, error: "Parâmetros inválidos" };
  const supabase = await createClient();
  const { error } = await supabase.schema("omni").rpc("send_message", {
    p_conversation: conversationId, p_body: body.slice(0, 4000), p_draft: draftId, p_edited: edited ?? false, p_reply_to: replyTo,
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

const OUTCOMES = ["PURCHASED", "RESERVED", "RESOLVED", "EXCHANGE", "COMPLAINT", "NO_REPLY", "NOT_CUSTOMER", "SPAM"] as const;

/** Encerra a conversa com o desfecho (uma mensagem nova da cliente abre outra conversa). */
export async function closeConversation(conversationId: string, outcome: string, note: string) {
  const parsed = z.object({ c: z.string().uuid(), o: z.enum(OUTCOMES), n: z.string().max(300) }).safeParse({ c: conversationId, o: outcome, n: note });
  if (!parsed.success) return { ok: false, error: "Escolha o desfecho" };
  const supabase = await createClient();
  const { error } = await supabase.schema("omni").rpc("close_conversation", { p_conversation: conversationId, p_outcome: outcome, p_note: note || undefined });
  revalidatePath("/atendimento");
  return error ? { ok: false, error: clean(error.message) } : { ok: true };
}

const uuid = z.string().uuid();

/** "Sugerir resposta" (qualquer modo) e "Comentar" numa sugestão: a IA prepara um rascunho; nada sai sozinho. */
export async function requestSuggestion(conversationId: string, comment?: string, draftId?: string) {
  if (!uuid.safeParse(conversationId).success || (draftId && !uuid.safeParse(draftId).success)) return { ok: false, error: "Parâmetros inválidos" };
  const supabase = await createClient();
  const { error } = await supabase.schema("omni").rpc("request_ai_suggestion", {
    p_conversation: conversationId, ...(comment?.trim() ? { p_comment: comment.trim().slice(0, 1000) } : {}), ...(draftId ? { p_draft: draftId } : {}),
  });
  revalidatePath("/atendimento");
  return error ? { ok: false, error: clean(error.message) } : { ok: true };
}

/** Peça do carrinho da conversa (o que está sendo mostrado ao cliente). */
export interface CartItem {
  id: string; product_id: string; color_id?: string; name: string; reference: string; color?: string; size?: string; qty: number;
  source: "SHOWN" | "ORDER" | "MANUAL" | "PDV"; price?: number; available?: number; sizes_in_stock?: string[]; photo?: string;
}
export interface CartHit { product_id: string; color_id?: string; name: string; reference: string; gender?: string; color?: string; price?: number; available?: number; photo?: string }

export async function cartSearch(conversationId: string, query: string): Promise<CartHit[]> {
  if (!uuid.safeParse(conversationId).success || query.trim().length < 2) return [];
  const supabase = await createClient();
  const { data } = await supabase.schema("omni").rpc("cart_search", { p_conversation: conversationId, p_query: query.trim().slice(0, 80) });
  return (data as unknown as CartHit[] | null) ?? [];
}

export async function cartAdd(conversationId: string, productId: string, colorId?: string, size?: string) {
  if (!uuid.safeParse(conversationId).success || !uuid.safeParse(productId).success || (colorId && !uuid.safeParse(colorId).success)) return { ok: false, error: "Parâmetros inválidos" };
  const supabase = await createClient();
  const { error } = await supabase.schema("omni").rpc("cart_add", {
    p_conversation: conversationId, p_product: productId, ...(colorId ? { p_color: colorId } : {}), ...(size?.trim() ? { p_size: size.trim() } : {}),
  });
  revalidatePath("/atendimento");
  return error ? { ok: false, error: clean(error.message) } : { ok: true };
}

export async function cartRemove(itemId: string) {
  if (!uuid.safeParse(itemId).success) return { ok: false, error: "Parâmetros inválidos" };
  const supabase = await createClient();
  const { error } = await supabase.schema("omni").rpc("cart_remove", { p_item: itemId });
  revalidatePath("/atendimento");
  return error ? { ok: false, error: clean(error.message) } : { ok: true };
}

/** "Nova conversa": abre (ou acha) a conversa de WhatsApp do cliente. Fora da janela de 24 h, a primeira mensagem é um template. */
export async function openConversation(partyId: string) {
  if (!uuid.safeParse(partyId).success) return { ok: false as const, error: "Cliente inválido" };
  const supabase = await createClient();
  const { data, error } = await supabase.schema("omni").rpc("open_conversation_for", { p_party: partyId });
  revalidatePath("/atendimento");
  return error ? { ok: false as const, error: clean(error.message) } : { ok: true as const, conversationId: String(data) };
}
