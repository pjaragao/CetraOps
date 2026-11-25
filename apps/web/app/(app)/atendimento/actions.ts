"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { formatBRL } from "@centralops/domain";
import type { Json } from "@centralops/db";
import { getSession } from "@/lib/session";
import { createCheckoutLink } from "@/lib/stone";
import { stoneSecret } from "@/lib/stone-sync";
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
  source: "SHOWN" | "ORDER" | "MANUAL" | "PDV"; price?: number; available?: number; sizes_in_stock?: string[]; photo?: string; variants?: CartVariant[];
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

/** Manda ao cliente as peças escolhidas do carrinho (ou todas): uma linha por peça com a foto. No modo catálogo nativo do WhatsApp
 *  a foto vira o cartão da Meta (com os tamanhos); senão sai como foto com legenda. É uma mensagem da equipe: quem envia assume a conversa. */
export async function cartSend(conversationId: string, itemIds: string[]) {
  if (!uuid.safeParse(conversationId).success || !z.array(uuid).max(30).safeParse(itemIds).success) return { ok: false, error: "Parâmetros inválidos" };
  const supabase = await createClient();
  const { data, error: cartError } = await supabase.schema("omni").rpc("conversation_cart", { p_conversation: conversationId });
  if (cartError) return { ok: false, error: clean(cartError.message) };
  const all = (data as unknown as CartItem[] | null) ?? [];
  const items = itemIds.length ? all.filter((i) => itemIds.includes(i.id)) : all;
  if (!items.length) return { ok: false, error: "Nenhuma peça para enviar" };
  const lines = items.map((i) => {
    const label = [i.name, i.color, i.size ? `tam. ${i.size}` : null].filter(Boolean).join(" · ") + (i.price != null ? ` — ${formatBRL(Number(i.price))}` : "");
    return i.photo ? `${label}: ${i.photo}` : label;
  });
  const { error } = await supabase.schema("omni").rpc("send_message", { p_conversation: conversationId, p_body: lines.join("\n").slice(0, 4000) });
  revalidatePath("/atendimento");
  return error ? { ok: false, error: clean(error.message) } : { ok: true };
}

/** Tamanho (e quantidade) de uma peça do carrinho, escolhido pelo atendente */
export async function cartSetSize(itemId: string, size: string, qty?: number) {
  if (!uuid.safeParse(itemId).success || !size.trim() || size.length > 10) return { ok: false, error: "Parâmetros inválidos" };
  const supabase = await createClient();
  const { error } = await supabase.schema("omni").rpc("cart_set_size", { p_item: itemId, p_size: size, ...(qty ? { p_qty: qty } : {}) });
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

/** Uma peça do carrinho com as variantes (tamanhos) para escolher ao fechar o pedido. */
export interface CartVariant { id: string; size: string; price?: number; available: number }

const FULFILLMENT = { STORE_PICKUP: "Retirada na loja", MOTOBOY: "Entrega por motoboy", CARRIER: "Envio por transportadora/Correios" } as const;
export type Fulfillment = keyof typeof FULFILLMENT;

const checkoutSchema = z.object({
  items: z.array(z.object({ variant_id: z.string().uuid(), qty: z.number().int().min(1).max(10) })).min(1).max(20),
  fulfillment: z.enum(["STORE_PICKUP", "MOTOBOY", "CARRIER"]),
  shipping: z.number().min(0).max(500),
  maxInstallments: z.number().int().min(1).max(6),
  notes: z.string().max(300).optional(),
  send: z.boolean(),
});

interface CheckoutOrder {
  order_id: string; number: string; total: number; shipping: number; discount: number; fulfillment_type: Fulfillment; expires_at: string | null;
  items: { name: string; color?: string; size: string; qty: number; total: number }[]; party_name: string | null; party_phone: string | null; store_phone: string | null;
}

/** Texto do resumo do pedido para o cliente, com o link de pagamento (quando houver). */
function orderMessage(o: CheckoutOrder, url: string | null, maxInstallments: number): string {
  const first = (o.party_name ?? "").split(" ")[0];
  const lines = o.items.map((i) => `• ${Number(i.qty) > 1 ? `${Number(i.qty)}× ` : ""}${i.name}${i.color ? ` (${i.color})` : ""} · tam. ${i.size} · ${formatBRL(Number(i.total))}`);
  const extra = [Number(o.shipping) > 0 && `Frete: ${formatBRL(Number(o.shipping))}`, Number(o.discount) > 0 && `Desconto: −${formatBRL(Number(o.discount))}`].filter(Boolean);
  const until = o.expires_at ? new Date(o.expires_at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : null;
  return [
    `${first ? `${first}, s` : "S"}eu pedido ${o.number} está separado ✨`, "", ...lines, ...extra, `*Total: ${formatBRL(Number(o.total))}*`, `${FULFILLMENT[o.fulfillment_type] ?? ""}`, "",
    url ? `Para pagar por Pix ou cartão${maxInstallments > 1 ? ` (até ${maxInstallments}x sem juros)` : ""}, é só tocar no link:\n${url}` : "Te mando o link de pagamento em seguida.",
    until ? `As peças ficam reservadas pra você até ${until}.` : "",
    "Assim que o pagamento cair, te confirmo por aqui. 💛",
  ].filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n").trim();
}

export type CloseOrderResult =
  | { ok: true; number: string; total: number; url: string | null; linkError?: string; sent: boolean; sendError?: string; message: string }
  | { ok: false; error: string };

/**
 * "Fechar pedido" no carrinho da conversa: cria o pedido (estoque reservado por 24 h), gera o link da Stone (Pix ou cartão) e manda o
 * resumo ao cliente. O pagamento dá baixa sozinho (aviso da Stone) e o cliente recebe "pagamento confirmado". Se o link falhar, o pedido
 * fica criado e o atendente gera o link ou registra o pagamento em Vender › Pedidos.
 */
export async function closeOrder(conversationId: string, input: z.input<typeof checkoutSchema>): Promise<CloseOrderResult> {
  const parsed = checkoutSchema.safeParse(input);
  if (!uuid.safeParse(conversationId).success || !parsed.success) return { ok: false, error: "Confira tamanhos, quantidades e entrega" };
  const p = parsed.data;
  const session = await getSession();
  const supabase = await createClient();
  const { data, error } = await supabase.schema("omni").rpc("cart_checkout", {
    p_conversation: conversationId,
    p: { items: p.items, fulfillment_type: p.fulfillment, shipping_total: p.fulfillment === "STORE_PICKUP" ? 0 : p.shipping, notes: p.notes } as unknown as Json,
  });
  if (error) return { ok: false, error: clean(error.message) };
  const order = data as unknown as CheckoutOrder;

  let url: string | null = null;
  let linkError: string | undefined;
  try {
    const key = await stoneSecret(session.orgId);
    if (!key) throw new Error("Stone não configurada (Configurações › Integrações)");
    const link = await createCheckoutLink(key, {
      code: order.number, amountCents: Math.round(Number(order.total) * 100), description: `Pedido ${order.number}`, maxInstallments: p.maxInstallments,
      customer: { name: order.party_name ?? "Cliente", phone: order.party_phone },
      successUrl: order.store_phone ? `https://wa.me/${order.store_phone}?text=${encodeURIComponent(`Paguei o pedido ${order.number}`)}` : null,
    });
    const { error: e2 } = await supabase.schema("sales").rpc("attach_stone_link", { p_order: order.order_id, p_stone_order_id: link.id, p_url: link.url, p_max_installments: p.maxInstallments });
    if (e2) throw new Error(clean(e2.message));
    url = link.url;
  } catch (e) {
    linkError = (e as Error).message;
  }

  const message = orderMessage(order, url, p.maxInstallments);
  let sent = false;
  let sendError: string | undefined;
  if (p.send && url) {
    const { error: e3 } = await supabase.schema("omni").rpc("send_message", { p_conversation: conversationId, p_body: message.slice(0, 4000) });
    if (e3) sendError = clean(e3.message); else sent = true;
  }
  revalidatePath("/atendimento");
  revalidatePath("/vender/pedidos");
  return { ok: true, number: order.number, total: Number(order.total), url, linkError, sent, sendError, message };
}
