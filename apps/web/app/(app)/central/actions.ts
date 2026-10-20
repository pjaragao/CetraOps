"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import type { ActionStatus, Card, StoredMessage } from "@/lib/central/cards";

const uuid = z.string().uuid();

export type ActionOutcome = { status: ActionStatus; result?: { text: string; href?: string } | null; error?: string | null };

/** A pessoa confirmou o cartão: o banco executa exatamente o que foi proposto (uma vez, dentro da validade). */
export async function confirmCentralAction(actionId: string): Promise<ActionOutcome> {
  if (!uuid.safeParse(actionId).success) return { status: "FAILED", error: "Ação inválida" };
  const supabase = await createClient();
  const { data, error } = await supabase.schema("ai").rpc("assistant_execute", { p_action: actionId });
  if (error) return { status: "FAILED", error: error.message.replace(/^ERROR:\s*/, "") };
  const r = data as unknown as { ok: boolean; already?: boolean; error?: string; code?: string; result?: Record<string, unknown> };
  if (!r.ok) return { status: r.code === "EXPIRED" ? "EXPIRED" : "FAILED", error: r.error ?? "Não foi possível executar" };
  const res = r.result ?? {};
  const text = res.number ? `Feito: ${String(res.number)}` : "Feito.";
  revalidatePath("/", "layout");
  return { status: "EXECUTED", result: { text, href: typeof res.href === "string" ? res.href : undefined } };
}

export async function cancelCentralAction(actionId: string): Promise<ActionOutcome> {
  if (!uuid.safeParse(actionId).success) return { status: "FAILED", error: "Ação inválida" };
  const supabase = await createClient();
  const { error } = await supabase.schema("ai").rpc("assistant_cancel", { p_action: actionId });
  if (error) return { status: "FAILED", error: error.message };
  return { status: "CANCELLED" };
}

export interface ThreadSummary { id: string; title: string | null; updated_at: string }

export async function listCentralThreads(): Promise<ThreadSummary[]> {
  const supabase = await createClient();
  const { data } = await supabase.schema("ai").from("assistant_threads").select("id, title, updated_at").is("archived_at", null).order("updated_at", { ascending: false }).limit(200);
  return data ?? [];
}

/** Mensagens de uma conversa, com o estado atual de cada cartão de ação (confirmado, expirado…). */
export async function loadCentralThread(threadId: string): Promise<StoredMessage[]> {
  if (!uuid.safeParse(threadId).success) return [];
  const supabase = await createClient();
  const [{ data: msgs }, { data: actions }] = await Promise.all([
    supabase.schema("ai").from("assistant_messages").select("id, role, content, created_at").eq("thread_id", threadId).in("role", ["user", "assistant"]).order("created_at").limit(200),
    supabase.schema("ai").from("assistant_actions").select("id, status, result, error, expires_at").eq("thread_id", threadId),
  ]);
  const byId = new Map((actions ?? []).map((a) => [a.id, a]));
  return (msgs ?? []).map((m) => {
    const c = (m.content ?? {}) as { text?: string; cards?: Card[] };
    const cards = (c.cards ?? []).map((card): Card => {
      if (card.kind !== "acao") return card;
      const a = byId.get(card.action.id);
      if (!a) return card;
      const res = a.result as Record<string, unknown> | null;
      const expired = a.status === "PROPOSED" && new Date(a.expires_at) < new Date();
      return { kind: "acao", action: { ...card.action, status: expired ? "EXPIRED" : (a.status as ActionStatus), error: a.error,
               result: a.status === "EXECUTED" ? { text: res?.number ? `Feito: ${String(res.number)}` : "Feito.", href: typeof res?.href === "string" ? res.href : undefined } : null } };
    });
    return { id: m.id, role: m.role as "user" | "assistant", text: c.text ?? "", cards, created_at: m.created_at };
  });
}

export async function archiveCentralThread(threadId: string): Promise<void> {
  if (!uuid.safeParse(threadId).success) return;
  const supabase = await createClient();
  await supabase.schema("ai").from("assistant_threads").update({ archived_at: new Date().toISOString() }).eq("id", threadId);
}
