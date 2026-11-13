"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { rpcAny } from "@/lib/rpc";
import type { CompensationCandidate, ExtraResolution, ExtrasOverview, Outcome, ScanExtra } from "./types";

const uuid = z.string().uuid();
const friendly = (m: string) => m.replace(/^ERROR:\s*/, "");
const eventIds = (v: unknown): v is number[] => Array.isArray(v) && v.length >= 1 && v.length <= 500 && v.every((n) => Number.isInteger(n) && n > 0);

async function call<T>(fn: string, args: Record<string, unknown>): Promise<Outcome<T>> {
  try {
    const supabase = await createClient();
    const { data, error } = await rpcAny(supabase, "purch", fn, args);
    if (error) return { ok: false, error: friendly(error.message) };
    revalidatePath("/produtos/recebimento");
    return { ok: true, data: data as T };
  } catch {
    return { ok: false, error: "Sem conexão com o servidor", retry: true };
  }
}

const num = (v: unknown) => Number(v ?? 0);
const normExtra = (x: ScanExtra): ScanExtra => ({ ...x, qty: num(x.qty), reviewed: x.reviewed == null ? undefined : num(x.reviewed) });
const normRes = (r: ExtraResolution): ExtraResolution => ({ ...r, qty: num(r.qty) });

/** Sobras pendentes, o que foi feito com elas e a lixeira (30 dias). receiptIds nulo = todas as notas. */
export async function extrasOverviewAction(receiptIds: string[] | null): Promise<Outcome<ExtrasOverview>> {
  if (receiptIds && (receiptIds.length < 1 || receiptIds.length > 20 || !receiptIds.every((i) => uuid.safeParse(i).success))) return { ok: false, error: "Recebimento inválido" };
  const out = await call<ExtrasOverview>("extras_overview", { p_receipts: receiptIds });
  if (!out.ok) return out;
  const d = out.data;
  return { ok: true, data: { pending: (d.pending ?? []).map(normExtra), trash: (d.trash ?? []).map(normExtra), resolutions: (d.resolutions ?? []).map(normRes) } };
}

export interface ResolveInput { action: "COMPENSATE" | "ENTRY_NO_NF" | "RETURN"; events: number[]; qty: number; variantId?: string | null; targetItemId?: string | null; note?: string }

/** O que fazer com a sobra: compensar com um faltante, dar entrada sem NF ou devolver. */
export async function resolveExtraAction(p: ResolveInput): Promise<Outcome<ExtraResolution>> {
  if (!eventIds(p.events) || !["COMPENSATE", "ENTRY_NO_NF", "RETURN"].includes(p.action) || !Number.isInteger(p.qty) || p.qty < 1) return { ok: false, error: "Dados inválidos" };
  if (p.variantId && !uuid.safeParse(p.variantId).success) return { ok: false, error: "Peça inválida" };
  if (p.targetItemId && !uuid.safeParse(p.targetItemId).success) return { ok: false, error: "Item inválido" };
  const out = await call<ExtraResolution>("resolve_extra", { p: { action: p.action, events: p.events, qty: p.qty, variant_id: p.variantId ?? null, target_item_id: p.targetItemId ?? null, note: (p.note ?? "").slice(0, 300) } });
  return out.ok ? { ok: true, data: normRes(out.data) } : out;
}

export async function reopenResolutionAction(id: string): Promise<Outcome<null>> {
  if (!uuid.safeParse(id).success) return { ok: false, error: "Dados inválidos" };
  return call<null>("reopen_extra_resolution", { p_resolution: id });
}

export async function markReturnedAction(id: string): Promise<Outcome<null>> {
  if (!uuid.safeParse(id).success) return { ok: false, error: "Dados inválidos" };
  return call<null>("mark_extra_returned", { p_resolution: id });
}

/** Entrada sem NF: definir depois (sem prazo) como presente da marca ou NF a lançar. */
export async function defineNoNfAction(id: string, destination: "GIFT" | "NF_LATER", note?: string): Promise<Outcome<null>> {
  if (!uuid.safeParse(id).success || !["GIFT", "NF_LATER"].includes(destination)) return { ok: false, error: "Dados inválidos" };
  return call<null>("define_no_nf_entry", { p_resolution: id, p_destination: destination, p_note: (note ?? "").slice(0, 300) || null });
}

/** Entrada sem NF "a lançar depois": quando a nota chegou, vincula ao item dela. */
export async function linkNoNfAction(id: string, receiptId: string): Promise<Outcome<null>> {
  if (!uuid.safeParse(id).success || !uuid.safeParse(receiptId).success) return { ok: false, error: "Dados inválidos" };
  return call<null>("link_no_nf_entry", { p_resolution: id, p_receipt: receiptId });
}

export async function setExtraQtyAction(events: number[], qty: number): Promise<Outcome<number>> {
  if (!eventIds(events) || !Number.isInteger(qty) || qty < 0) return { ok: false, error: "Quantidade inválida" };
  const out = await call<number>("set_extra_qty", { p_events: events, p_qty: qty });
  return out.ok ? { ok: true, data: num(out.data) } : out;
}

export async function restoreExtrasAction(events: number[]): Promise<Outcome<number>> {
  if (!eventIds(events)) return { ok: false, error: "Dados inválidos" };
  const out = await call<number>("restore_extras", { p_events: events });
  return out.ok ? { ok: true, data: num(out.data) } : out;
}

/** Itens das notas que faltaram, para compensar com a peça que sobrou (mesmo produto e preço parecido primeiro). */
export async function compensationCandidatesAction(receiptIds: string[], variantId: string | null): Promise<Outcome<CompensationCandidate[]>> {
  if (receiptIds.length < 1 || receiptIds.length > 20 || !receiptIds.every((i) => uuid.safeParse(i).success) || (variantId && !uuid.safeParse(variantId).success)) return { ok: false, error: "Dados inválidos" };
  try {
    const supabase = await createClient();
    const [{ data: items }, { data: rcs }] = await Promise.all([
      supabase.schema("purch").from("receipt_items").select("id, receipt_id, description, qty_nfe, qty_counted, unit_cost_nfe, item_total, variant_id").in("receipt_id", receiptIds),
      supabase.schema("purch").from("receipts").select("id, status, document_id").in("id", receiptIds),
    ]);
    const open = new Map((rcs ?? []).filter((r) => r.status !== "POSTED").map((r) => [r.id, r]));
    const missing = (items ?? []).filter((i) => open.has(i.receipt_id) && Number(i.qty_nfe) - Number(i.qty_counted ?? 0) > 0);
    if (missing.length === 0) return { ok: true, data: [] };
    const docIds = [...open.values()].map((r) => r.document_id).filter(Boolean) as string[];
    const varIds = [...new Set([...(missing.map((i) => i.variant_id).filter(Boolean) as string[]), ...(variantId ? [variantId] : [])])];
    const [{ data: docs }, { data: vars }, { data: costs }] = await Promise.all([
      docIds.length ? supabase.schema("fiscal").from("documents").select("id, number, series").in("id", docIds) : Promise.resolve({ data: [] as { id: string; number: number | null; series: number | null }[] }),
      varIds.length ? supabase.schema("catalog").from("variants").select("id, sku, size, product_id, color_id").in("id", varIds) : Promise.resolve({ data: [] as { id: string; sku: string; size: string; product_id: string; color_id: string | null }[] }),
      variantId ? supabase.schema("inv").from("item_costs").select("last_cost, avg_cost").eq("variant_id", variantId).limit(1) : Promise.resolve({ data: [] as { last_cost: number | null; avg_cost: number }[] }),
    ]);
    const prodIds = [...new Set((vars ?? []).map((v) => v.product_id))];
    const [{ data: products }, { data: colors }] = await Promise.all([
      prodIds.length ? supabase.schema("catalog").from("products").select("id, name").in("id", prodIds) : Promise.resolve({ data: [] as { id: string; name: string }[] }),
      supabase.schema("catalog").from("colors").select("id, name"),
    ]);
    const vmap = new Map((vars ?? []).map((v) => [v.id, v]));
    const pname = new Map((products ?? []).map((p) => [p.id, p.name]));
    const cname = new Map((colors ?? []).map((c) => [c.id, c.name]));
    const dmap = new Map((docs ?? []).map((d) => [d.id, d]));
    const refProduct = variantId ? vmap.get(variantId)?.product_id : undefined;
    const refCost = Number(costs?.[0]?.last_cost ?? costs?.[0]?.avg_cost ?? 0) || null;
    const out: CompensationCandidate[] = missing.map((i) => {
      const v = i.variant_id ? vmap.get(i.variant_id) : undefined;
      const rc = open.get(i.receipt_id)!;
      const d = rc.document_id ? dmap.get(rc.document_id) : undefined;
      const unit = Number(i.item_total) / Number(i.qty_nfe);
      return {
        item_id: i.id, receipt_id: i.receipt_id, nf: d ? String(d.number ?? "") : "—",
        label: v ? [pname.get(v.product_id), v.color_id ? cname.get(v.color_id) : null, v.size].filter(Boolean).join(" · ") : (i.description ?? "Item da nota"),
        sku: v?.sku ?? null, missing: Number(i.qty_nfe) - Number(i.qty_counted ?? 0), unit_cost: Math.round(unit * 100) / 100,
        same_product: !!refProduct && v?.product_id === refProduct, diff_pct: refCost ? Math.round(((unit - refCost) / refCost) * 100) : null,
      };
    });
    out.sort((a, b) => Number(b.same_product) - Number(a.same_product) || Math.abs(a.diff_pct ?? 999) - Math.abs(b.diff_pct ?? 999) || b.missing - a.missing);
    return { ok: true, data: out.slice(0, 40) };
  } catch {
    return { ok: false, error: "Sem conexão com o servidor", retry: true };
  }
}

/** Notas em aberto (para vincular uma entrada sem NF quando a nota chegar). */
export async function linkableReceiptsAction(): Promise<Outcome<{ id: string; label: string }[]>> {
  try {
    const supabase = await createClient();
    const { data: rcs } = await supabase.schema("purch").from("receipts").select("id, number, document_id, nf_total").neq("status", "POSTED").order("created_at", { ascending: false }).limit(60);
    const docIds = (rcs ?? []).map((r) => r.document_id).filter(Boolean) as string[];
    const { data: docs } = docIds.length ? await supabase.schema("fiscal").from("documents").select("id, number, series, counterpart_name").in("id", docIds) : { data: [] as { id: string; number: number | null; series: number | null; counterpart_name: string | null }[] };
    const dmap = new Map((docs ?? []).map((d) => [d.id, d]));
    return { ok: true, data: (rcs ?? []).map((r) => { const d = r.document_id ? dmap.get(r.document_id) : undefined; return { id: r.id, label: `NF ${d?.number ?? "—"}${d?.counterpart_name ? ` · ${d.counterpart_name}` : ""} · ${r.number}` }; }) };
  } catch {
    return { ok: false, error: "Sem conexão com o servidor", retry: true };
  }
}
