"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { Json } from "@centralops/db";
import { createClient } from "@/lib/supabase/server";

export type State = { ok: boolean; error?: string } | null;
const friendly = (m: string) => m.replace(/^ERROR:\s*/, "");
const uuid = z.string().uuid();

export interface BackorderHit { id: string; sku: string; label: string; price: number | null; available: number }

/** Peças de produtos liberados para encomenda (com ou sem estoque). */
export async function searchBackorderable(q: string): Promise<BackorderHit[]> {
  const term = q.trim().replace(/[%,()"'\\]/g, " ");
  if (term.length < 2) return [];
  const supabase = await createClient();
  const { data: prods } = await supabase.schema("catalog").from("products").select("id, name").eq("backorder", true)
    .or(`name.ilike.%${term}%,reference_code.ilike.%${term}%`).limit(8);
  const { data: bySku } = await supabase.schema("catalog").from("variants").select("id, product_id").ilike("sku", `%${term}%`).limit(12);
  const pids = [...new Set([...(prods ?? []).map((p) => p.id), ...(bySku ?? []).map((v) => v.product_id)])];
  if (pids.length === 0) return [];
  const [{ data: products }, { data: variants }, { data: colors }] = await Promise.all([
    supabase.schema("catalog").from("products").select("id, name").in("id", pids).eq("backorder", true),
    supabase.schema("catalog").from("variants").select("id, sku, size, product_id, color_id").in("product_id", pids).eq("active", true).order("sku").limit(40),
    supabase.schema("catalog").from("colors").select("id, name"),
  ]);
  const pname = new Map((products ?? []).map((p) => [p.id, p.name])), cname = new Map((colors ?? []).map((c) => [c.id, c.name]));
  const list = (variants ?? []).filter((v) => pname.has(v.product_id));
  const { data: stock } = list.length ? await supabase.schema("inv").from("v_stock_matrix").select("variant_id, available").eq("is_sellable", true).in("variant_id", list.map((v) => v.id)) : { data: [] };
  const avail = new Map<string, number>();
  for (const s of stock ?? []) if (s.variant_id) avail.set(s.variant_id, (avail.get(s.variant_id) ?? 0) + Number(s.available));
  const prices = await Promise.all(list.map(async (v) => (await supabase.schema("catalog").rpc("current_price", { p_variant: v.id })).data as number | null));
  return list.map((v, i) => ({ id: v.id, sku: v.sku, label: `${pname.get(v.product_id)} · ${v.color_id ? cname.get(v.color_id) ?? "" : "—"} · ${v.size}`, price: prices[i], available: avail.get(v.id) ?? 0 }));
}

export interface CostInfo { source: "LAST_COST" | "CATALOG_PRICE" | "ZERO"; cost: number }
/** De onde virá o custo da peça no pedido de compra (para avisar na hora de adicionar). */
export async function backorderCost(variantId: string, storeId: string): Promise<CostInfo | null> {
  if (!uuid.safeParse(variantId).success || !uuid.safeParse(storeId).success) return null;
  const supabase = await createClient();
  const { data } = await supabase.schema("sales").rpc("backorder_cost", { p_variant: variantId, p_store: storeId });
  return (data as unknown as CostInfo) ?? null;
}

const channels = ["POS", "WHATSAPP", "INSTAGRAM", "TELEGRAM", "PAYMENT_LINK", "B2B", "EVENT"] as const;
const schema = z.object({
  store_id: uuid, party_id: uuid, notes: z.string().trim().max(300).optional(),
  channel: z.enum(channels).optional(), coupon_code: z.string().trim().max(40).optional(), idempotency_key: z.string().min(8).max(80).optional(),
  items: z.array(z.object({
    variant_id: uuid.optional(),
    description: z.string().trim().min(1).max(200).optional(),             // item avulso (PDV): sem peça do catálogo
    ncm: z.string().regex(/^\d{8}$/).optional(),
    unit_price: z.number().min(0).max(100000).optional(), list_price: z.number().min(0).max(100000).optional(),
    qty: z.number().int().min(1).max(50),
    discount_amount: z.number().min(0).max(100000).optional(), discount_reason: z.string().max(200).optional(),
  }).refine((i) => Boolean(i.variant_id || i.description), { message: "peça ou descrição", path: ["variant_id"] })).min(1).max(40),
});
type Registered = { ok: true; id: string } | { ok: false; error: string };

async function registerBackorder(raw: unknown): Promise<Registered> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return { ok: false, error: i?.path[0] === "party_id" || i?.path[0] === "items" ? "Escolha a cliente e ao menos uma peça" : `Confira a encomenda: ${i?.path.join(".")} — ${i?.message}` };
  }
  const supabase = await createClient();
  const { data, error } = await supabase.schema("sales").rpc("create_backorder", { p: parsed.data as unknown as Json });
  if (error) return { ok: false, error: friendly(error.message) };
  revalidatePath("/vender", "layout");
  revalidatePath("/produtos/compras");
  return { ok: true, id: (data as unknown as { id: string }).id };
}

/** Tela de Encomendas: registra e vai para o pedido. */
export async function createBackorderAction(_prev: State, formData: FormData): Promise<State> {
  let raw: unknown;
  try { raw = JSON.parse(String(formData.get("payload") ?? "")); } catch { return { ok: false, error: "Dados inválidos" }; }
  const r = await registerBackorder(raw);
  if (!r.ok) return r;
  redirect(`/vender/pedidos/${r.id}?ok=${encodeURIComponent("Encomenda registrada e incluída no pedido de compra")}`);
}

/** PDV: carrinho com peça sem estoque (de produto liberado), em estoque, avulso, desconto e cupom. A tela decide para onde ir. */
export async function createPdvBackorderAction(raw: unknown): Promise<Registered> {
  return registerBackorder(raw);
}

export async function setSupplierAction(formData: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.schema("sales").rpc("set_backorder_supplier", { p_party: String(formData.get("party_id") ?? "") });
  revalidatePath("/vender/encomendas");
  redirect(`/vender/encomendas?${error ? `erro=${encodeURIComponent(friendly(error.message))}` : "ok=Fornecedor%20definido"}`);
}

/** Liga/desliga encomenda: por produto (lista) ou todos os do site. */
export async function setBackorderAction(formData: FormData) {
  const back = String(formData.get("back") ?? "/produtos");
  const ids = String(formData.get("product_ids") ?? "").split(",").filter((x) => uuid.safeParse(x).success);
  const site = String(formData.get("site") ?? "") === "1";
  const supabase = await createClient();
  const { data, error } = await supabase.schema("catalog").rpc("set_backorder", { p: {
    enabled: String(formData.get("enabled")) === "1", ...(ids.length ? { product_ids: ids } : {}), ...(site ? { site: true } : {}),
  } as unknown as Json });
  revalidatePath("/produtos", "layout");
  redirect(`${back}${back.includes("?") ? "&" : "?"}${error ? `erro=${encodeURIComponent(friendly(error.message))}` : `ok=${encodeURIComponent(`${data} produto(s) atualizados`)}`}`);
}

/** Catálogo: liga/desliga encomenda numa seleção de produtos, sem sair da lista (a tela atualiza com router.refresh). */
export async function setBackorderForProductsAction(productIds: string[], enabled: boolean): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  const ids = z.array(uuid).min(1).max(2000).safeParse(productIds);
  if (!ids.success) return { ok: false, error: "Selecione ao menos um produto" };
  const supabase = await createClient();
  const { data, error } = await supabase.schema("catalog").rpc("set_backorder", { p: { enabled, product_ids: ids.data } as unknown as Json });
  if (error) return { ok: false, error: friendly(error.message) };
  revalidatePath("/produtos", "layout");
  revalidatePath("/vender", "layout");
  return { ok: true, count: Number(data) };
}
