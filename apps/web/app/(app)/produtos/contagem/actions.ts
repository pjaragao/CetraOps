"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { Json } from "@centralops/db";
import { createClient } from "@/lib/supabase/server";

export type State = { ok: boolean; error?: string; message?: string } | null;
const friendly = (m: string) => m.replace(/^ERROR:\s*/, "");
const uuid = z.string().uuid();
const refresh = () => { revalidatePath("/produtos", "layout"); revalidatePath("/vender/pdv"); };

export interface CodeHit { id: string; sku: string; label: string }

/** Código bipado (EAN ou SKU, inclusive o Code128 da etiqueta) → peça do catálogo. */
export async function lookupCodes(codes: string[]): Promise<{ found: Record<string, CodeHit>; missing: string[] }> {
  const clean = [...new Set(codes.map((c) => c.trim()).filter((c) => c && c.length <= 60))].slice(0, 200);
  if (clean.length === 0) return { found: {}, missing: [] };
  const supabase = await createClient();
  const digits = clean.filter((c) => /^\d{8,14}$/.test(c));
  const [bySku, byGtin] = await Promise.all([
    supabase.schema("catalog").from("variants").select("id, sku, gtin, size, product_id, color_id").in("sku", clean.map((c) => c.toUpperCase())),
    digits.length ? supabase.schema("catalog").from("variants").select("id, sku, gtin, size, product_id, color_id").in("gtin", digits) : Promise.resolve({ data: [] as never[] }),
  ]);
  const variants = [...(bySku.data ?? []), ...(byGtin.data ?? [])];
  const [{ data: products }, { data: colors }] = await Promise.all([
    variants.length ? supabase.schema("catalog").from("products").select("id, name").in("id", [...new Set(variants.map((v) => v.product_id))]) : Promise.resolve({ data: [] as { id: string; name: string }[] }),
    supabase.schema("catalog").from("colors").select("id, name"),
  ]);
  const pname = new Map((products ?? []).map((p) => [p.id, p.name])), cname = new Map((colors ?? []).map((c) => [c.id, c.name]));
  const found: Record<string, CodeHit> = {};
  for (const c of clean) {
    const v = variants.find((x) => x.sku.toUpperCase() === c.toUpperCase() || x.gtin === c);
    if (v) found[c] = { id: v.id, sku: v.sku, label: `${pname.get(v.product_id) ?? ""} · ${v.color_id ? cname.get(v.color_id) ?? "" : "—"} · ${v.size}` };
  }
  return { found, missing: clean.filter((c) => !found[c]) };
}

export async function startCountAction(formData: FormData) {
  const location = String(formData.get("location_id") ?? "");
  const kind = String(formData.get("kind") ?? "FULL");
  if (!uuid.safeParse(location).success) redirect("/produtos/contagem?erro=" + encodeURIComponent("Escolha o local"));
  const supabase = await createClient();
  const { data, error } = await supabase.schema("inv").rpc("start_count", { p_location: location, p_kind: kind, p_notes: String(formData.get("notes") ?? "") || undefined });
  if (error) redirect("/produtos/contagem?erro=" + encodeURIComponent(friendly(error.message)));
  refresh();
  redirect(`/produtos/contagem/${(data as { id: string }).id}`);
}

/** Bipe (soma) ou correção (fixa). Devolve a quantidade contada da peça. */
export async function countItem(countId: string, variantId: string, qty: number, mode: "ADD" | "SET", unitCost?: number | null): Promise<{ ok: true; counted: number } | { ok: false; error: string }> {
  if (!uuid.safeParse(countId).success || !uuid.safeParse(variantId).success || !Number.isInteger(qty)) return { ok: false, error: "Dados inválidos" };
  const supabase = await createClient();
  const { data, error } = await supabase.schema("inv").rpc("count_item", { p_count: countId, p_variant: variantId, p_qty: qty, p_mode: mode, p_unit_cost: unitCost ?? undefined });
  if (error) return { ok: false, error: friendly(error.message) };
  return { ok: true, counted: Number((data as { counted?: number } | null)?.counted ?? 0) };
}

export async function postCountAction(formData: FormData) {
  const id = String(formData.get("count_id") ?? "");
  const supabase = await createClient();
  const { data, error } = await supabase.schema("inv").rpc("post_count", { p_count: id });
  refresh();
  if (error) redirect(`/produtos/contagem/${id}?erro=${encodeURIComponent(friendly(error.message))}`);
  redirect(`/produtos/contagem/${id}?ok=${encodeURIComponent(`Contagem lançada: ${data} peça(s) ajustada(s)`)}`);
}

export async function cancelCountAction(formData: FormData) {
  const id = String(formData.get("count_id") ?? "");
  const supabase = await createClient();
  const { error } = await supabase.schema("inv").rpc("cancel_count", { p_count: id });
  refresh();
  redirect(error ? `/produtos/contagem/${id}?erro=${encodeURIComponent(friendly(error.message))}` : "/produtos/contagem?ok=Contagem%20cancelada");
}

const adjustSchema = z.object({
  location_id: uuid, reason: z.enum(["LOSS", "DAMAGE", "MARKETING_GIFT", "CORRECTION"]), notes: z.string().trim().min(3).max(300),
  items: z.array(z.object({ variant_id: uuid, qty: z.number().int().refine((n) => n !== 0) })).min(1).max(200),
});
export async function adjustStockAction(_prev: State, formData: FormData): Promise<State> {
  let raw: unknown;
  try { raw = JSON.parse(String(formData.get("payload") ?? "")); } catch { return { ok: false, error: "Dados inválidos" }; }
  const parsed = adjustSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: `Confira o ajuste: ${parsed.error.issues[0]?.path.join(".")} — ${parsed.error.issues[0]?.message}` };
  const supabase = await createClient();
  const { data, error } = await supabase.schema("inv").rpc("adjust_stock", { p: parsed.data as unknown as Json });
  if (error) return { ok: false, error: friendly(error.message) };
  refresh();
  redirect(`/produtos/estoque/ajuste?ok=${encodeURIComponent(`Ajuste lançado em ${data} peça(s)`)}`);
}
