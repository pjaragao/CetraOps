import "server-only";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@centralops/db";
import type { Session } from "@/lib/session";
import type { ActionCardData, Card } from "./cards";

/** Peças comuns das ferramentas da Central (contexto da rodada, definição, erros, propostas com cartão). */

export interface ToolCtx {
  supabase: SupabaseClient<Database>;
  session: Session;
  storeId: string | null;
  threadId: string;
  addCard(card: Card): void;
  /** Propostas feitas nesta resposta, por ferramenta: uma nova proposta da mesma ferramenta cancela a anterior. */
  proposals: Map<string, string>;
  /** Mensagem da pessoa nesta rodada (para saber se ela mesma escolheu a cliente: "[party_id=…]"). */
  userMessage: string;
  /** Pessoas que apareceram em buscas com mais de um resultado nesta rodada. */
  ambiguousPeople: Set<string>;
}

/** A IA escolheu entre homônimas sem a pessoa escolher? O cartão avisa (a confirmação continua sendo da pessoa). */
export function checkPicked(ctx: ToolCtx, partyId: string | null | undefined, warnings: string[]) {
  if (partyId && ctx.ambiguousPeople.has(partyId) && !ctx.userMessage.includes(`[party_id=${partyId}]`)) {
    warnings.push("Confira a cliente: a busca trouxe mais de uma pessoa com nome parecido.");
  }
}

export interface ToolDef {
  name: string;
  description: string;
  /** Qualquer uma basta (o superusuário tem todas). */
  perms: string[];
  status: string;
  input: z.ZodType;
  run(args: never, ctx: ToolCtx): Promise<unknown>;
}

export function tool<S extends z.ZodType>(d: { name: string; description: string; perms: string[]; status: string; input: S; run(args: z.output<S>, ctx: ToolCtx): Promise<unknown> }): ToolDef {
  return d as unknown as ToolDef;
}

export const id = z.string().regex(/^[0-9a-fA-F-]{36}$/, "UUID").describe("UUID (vem de outra ferramenta ou da escolha da pessoa)");
export const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("data AAAA-MM-DD");

export class ToolError extends Error {}
export const fail = (message: string): never => { throw new ToolError(message); };
export function dbError(error: { message: string } | null) {
  if (error) fail(error.message.replace(/^ERROR:\s*/, ""));
}

export const fmtDate = (iso: string | null | undefined) => (iso ? iso.slice(0, 10).split("-").reverse().join("/") : "—");

export async function storeOf(ctx: ToolCtx) {
  const s = ctx.session.stores.find((x) => x.id === ctx.storeId) ?? (ctx.storeId ? null : ctx.session.stores[0]);
  if (!s) fail("Escolha uma loja no topo da tela antes (a venda precisa de uma loja).");
  return s!;
}

export async function openSession(ctx: ToolCtx, storeId: string) {
  const { data } = await ctx.supabase.schema("sales").from("cash_sessions").select("id, register_id, opened_at, opening_float").eq("store_id", storeId).eq("status", "OPEN").order("opened_at", { ascending: false }).limit(1);
  return data?.[0] ?? null;
}

export async function propose(ctx: ToolCtx, tool: string, args: Record<string, unknown>, preview: Record<string, unknown>, card: Omit<ActionCardData, "id" | "status" | "expires_at" | "tool">) {
  const previous = ctx.proposals.get(tool);
  if (previous) await ctx.supabase.schema("ai").rpc("assistant_cancel", { p_action: previous });
  const { data, error } = await ctx.supabase.schema("ai").rpc("assistant_propose", { p: { thread_id: ctx.threadId, tool, args, preview, summary: card.title } as never });
  dbError(error);
  const a = data as unknown as { id: string; expires_at: string };
  ctx.proposals.set(tool, a.id);
  ctx.addCard({ kind: "acao", action: { ...card, id: a.id, tool, status: "PROPOSED", expires_at: a.expires_at } });
  return { acao_id: a.id, situacao: "cartão pronto: aguardando a pessoa confirmar", avisos: card.warnings };
}

