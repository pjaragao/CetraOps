"use server";
import { createServerClient } from "@supabase/ssr";
import { rpcAny } from "@/lib/rpc";
import type { Outcome, ScanFeed, ScanResult } from "@/app/(app)/produtos/recebimento/[id]/bipar/types";

/** Celular do modo assistido: sem login, só com o código do link (o banco confere prazo, nota e quem gerou). */
function anonClient() {
  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { cookies: { getAll: () => [], setAll: () => undefined } });
}
const okToken = (t: string) => /^[A-Za-z0-9_-]{24}$/.test(t);
const friendly = (m: string) => m.replace(/^ERROR:\s*/, "");
const retryable = (code?: string) => !code || code.startsWith("08") || code === "PGRST000";

async function call<T>(fn: string, args: Record<string, unknown>): Promise<Outcome<T>> {
  try {
    const { data, error } = await rpcAny(anonClient(), "public", fn, args);
    if (error) return { ok: false, error: friendly(error.message), retry: retryable(error.code) };
    return { ok: true, data: data as T };
  } catch {
    return { ok: false, error: "Sem conexão com o servidor", retry: true };
  }
}

export async function linkScanAction(token: string, code: string, qty: number): Promise<Outcome<ScanResult>> {
  const c = String(code ?? "").trim();
  if (!okToken(token) || !c || c.length > 80 || !Number.isFinite(qty) || qty <= 0 || qty > 10000) return { ok: false, error: "Leitura inválida" };
  return call<ScanResult>("receipt_link_scan", { p_token: token, p_code: c, p_qty: qty });
}

export async function linkBumpAction(token: string, itemId: string, delta: number): Promise<Outcome<ScanResult>> {
  if (!okToken(token) || !/^[0-9a-f-]{36}$/i.test(itemId) || !Number.isFinite(delta) || delta === 0 || Math.abs(delta) > 10000) return { ok: false, error: "Quantidade inválida" };
  const out = await call<ScanResult>("receipt_link_bump", { p_token: token, p_item: itemId, p_delta: delta });
  return out.ok ? { ok: true, data: { ...out.data, status: "OK" } } : out;
}

export async function linkFeedAction(token: string, after: number): Promise<Outcome<ScanFeed>> {
  if (!okToken(token)) return { ok: false, error: "Link inválido" };
  return call<ScanFeed>("receipt_link_feed", { p_token: token, p_after: Math.max(0, Math.floor(after) || 0) });
}

/** Abre a nota pelo link (usado pela página). */
export async function openLink(token: string) {
  if (!okToken(token)) return { ok: false as const, error: "Link inválido" };
  return call<{ expires_at: string; label: string | null; summary: Record<string, unknown>; notes?: Record<string, unknown>[]; items: Record<string, unknown>[] }>("receipt_link_open", { p_token: token });
}
