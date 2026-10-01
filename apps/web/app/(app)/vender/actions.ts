"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { Json } from "@sie/db";
import { createClient } from "@/lib/supabase/server";
import { getSession } from "@/lib/session";

export type State = { ok: boolean; error?: string; message?: string } | null;

const friendly = (m: string) => m.replace(/^ERROR:\s*/, "");
const str = (v: FormDataEntryValue | null) => String(v ?? "").trim();
const num = (v: FormDataEntryValue | null) => Number(String(v ?? "").replace(/\./g, "").replace(",", "."));
const uuid = z.string().uuid();

function back(path: string, params: Record<string, string | undefined> = {}): never {
  const q = Object.entries(params).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v!)}`).join("&");
  redirect(q ? `${path}${path.includes("?") ? "&" : "?"}${q}` : path);
}
const refresh = () => { revalidatePath("/vender", "layout"); revalidatePath("/financeiro", "layout"); revalidatePath("/produtos", "layout"); revalidatePath("/marketing", "layout"); };

// ---------------------------------------------------------------------
// Buscas (seletores)
// ---------------------------------------------------------------------
export async function searchParties(q: string): Promise<{ id: string; name: string; phone: string | null }[]> {
  const term = q.trim().replace(/[%,()"'\\]/g, " ");
  if (term.length < 2) return [];
  const supabase = await createClient();
  const digits = term.replace(/\D/g, "");
  const [byName, byPhone] = await Promise.all([
    supabase.schema("crm").from("parties").select("id, display_name").ilike("display_name", `%${term}%`).is("merged_into_id", null).is("anonymized_at", null).limit(8),
    digits.length >= 4 ? supabase.schema("crm").from("party_contact_points").select("party_id, value_display").ilike("value_normalized", `%${digits}%`).limit(8)
      : Promise.resolve({ data: [] as { party_id: string; value_display: string }[] }),
  ]);
  const ids = [...new Set([...(byName.data ?? []).map((p) => p.id), ...(byPhone.data ?? []).map((c) => c.party_id)])];
  if (ids.length === 0) return [];
  const [{ data: parties }, { data: phones }] = await Promise.all([
    supabase.schema("crm").from("parties").select("id, display_name").in("id", ids),
    supabase.schema("crm").from("party_contact_points").select("party_id, value_display").in("party_id", ids).in("type", ["PHONE", "WHATSAPP"]),
  ]);
  const phone = new Map((phones ?? []).map((p) => [p.party_id, p.value_display]));
  return (parties ?? []).map((p) => ({ id: p.id, name: p.display_name, phone: phone.get(p.id) ?? null }));
}

export interface SellableHit { id: string; sku: string; label: string; price: number | null; available: number }

/** Variantes vendáveis (SKU, EAN ou nome) com preço vigente e saldo disponível no local. */
export async function searchSellable(q: string, locationId?: string): Promise<SellableHit[]> {
  const term = q.trim().replace(/[%,()"'\\]/g, " ");
  if (term.length < 2) return [];
  const supabase = await createClient();
  const digits = term.replace(/\D/g, "");
  const [bySku, prods] = await Promise.all([
    supabase.schema("catalog").from("variants").select("id, sku, size, product_id, color_id").eq("active", true).or(digits.length >= 8 ? `sku.ilike.%${term}%,gtin.eq.${digits}` : `sku.ilike.%${term}%`).limit(12),
    supabase.schema("catalog").from("products").select("id").or(`name.ilike.%${term}%,reference_code.ilike.%${term}%`).limit(6),
  ]);
  const { data: byProduct } = (prods.data ?? []).length
    ? await supabase.schema("catalog").from("variants").select("id, sku, size, product_id, color_id").eq("active", true).in("product_id", (prods.data ?? []).map((p) => p.id)).limit(20)
    : { data: [] as { id: string; sku: string; size: string; product_id: string; color_id: string | null }[] };
  const variants = [...new Map([...(bySku.data ?? []), ...(byProduct ?? [])].map((v) => [v.id, v])).values()].slice(0, 20);
  if (variants.length === 0) return [];
  const [{ data: products }, { data: colors }, { data: stock }] = await Promise.all([
    supabase.schema("catalog").from("products").select("id, name").in("id", [...new Set(variants.map((v) => v.product_id))]),
    supabase.schema("catalog").from("colors").select("id, name"),
    (locationId ? supabase.schema("inv").from("stock_levels").select("variant_id, available").eq("location_id", locationId).in("variant_id", variants.map((v) => v.id))
      : supabase.schema("inv").from("stock_levels").select("variant_id, available").in("variant_id", variants.map((v) => v.id))),
  ]);
  const pname = new Map((products ?? []).map((p) => [p.id, p.name])), cname = new Map((colors ?? []).map((c) => [c.id, c.name]));
  const avail = new Map<string, number>();
  for (const s of stock ?? []) avail.set(s.variant_id, (avail.get(s.variant_id) ?? 0) + Number(s.available));
  const prices = await Promise.all(variants.map(async (v) => (await supabase.schema("catalog").rpc("current_price", { p_variant: v.id })).data as number | null));
  return variants.map((v, i) => ({ id: v.id, sku: v.sku, label: `${pname.get(v.product_id) ?? ""} · ${v.color_id ? cname.get(v.color_id) ?? "" : "—"} · ${v.size}`, price: prices[i], available: avail.get(v.id) ?? 0 }));
}

// ---------------------------------------------------------------------
// Pedido remoto
// ---------------------------------------------------------------------
const remoteSchema = z.object({
  store_id: uuid, party_id: uuid, channel: z.enum(["WHATSAPP", "INSTAGRAM", "TELEGRAM", "PAYMENT_LINK", "B2B", "EVENT"]), fulfillment_type: z.enum(["MOTOBOY", "CARRIER", "STORE_PICKUP", "LOCKER_PICKUP", "TAKEAWAY"]),
  shipping_total: z.number().min(0).max(10000).default(0), coupon_code: z.string().max(40).optional(), hold_hours: z.number().int().min(1).max(168).default(24), notes: z.string().max(500).optional(),
  items: z.array(z.object({ variant_id: uuid, qty: z.number().positive().max(1000) })).min(1).max(100), idempotency_key: z.string().min(8).max(80),
});

export async function createRemoteOrderAction(_prev: State, formData: FormData): Promise<State> {
  let raw: unknown;
  try { raw = JSON.parse(String(formData.get("payload") ?? "")); } catch { return { ok: false, error: "Dados inválidos" }; }
  const parsed = remoteSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: `Confira o pedido: ${parsed.error.issues[0]?.path.join(".")} — ${parsed.error.issues[0]?.message}` };
  const supabase = await createClient();
  const { data, error } = await supabase.schema("sales").rpc("create_remote_order", { p: parsed.data as unknown as Json });
  if (error) return { ok: false, error: friendly(error.message) };
  refresh();
  return back(`/vender/pedidos/${(data as unknown as { id: string }).id}`, { ok: "Pedido criado: estoque reservado, aguardando pagamento" });
}

export async function registerPaymentAction(formData: FormData) {
  const id = str(formData.get("order_id"));
  const method = str(formData.get("method"));
  const supabase = await createClient();
  const { error } = await supabase.schema("sales").rpc("register_payment", { p: {
    order_id: id, method, amount: num(formData.get("amount")), installments: Number(str(formData.get("installments")) || 1),
    acquirer: str(formData.get("acquirer")) || (method === "PIX" ? "INTER" : undefined), nsu: str(formData.get("nsu")) || undefined, external_id: str(formData.get("external_id")) || undefined,
  } as unknown as Json });
  refresh();
  back(`/vender/pedidos/${id}`, error ? { erro: friendly(error.message) } : { ok: "Pagamento registrado" });
}

export async function createLinkAction(formData: FormData) {
  const id = str(formData.get("order_id"));
  const supabase = await createClient();
  const { error } = await supabase.schema("sales").rpc("create_payment_link", { p_order: id, p_max_installments: Number(str(formData.get("max_installments")) || 1), p_provider: str(formData.get("provider")) || "MERCADOPAGO" });
  refresh();
  back(`/vender/pedidos/${id}`, error ? { erro: friendly(error.message) } : { ok: "Link solicitado ao provedor (aparece aqui quando a integração responder)" });
}

export async function cancelOrderAction(formData: FormData) {
  const id = str(formData.get("order_id"));
  const supabase = await createClient();
  const { error } = await supabase.schema("sales").rpc("cancel_order", { p_order: id, p_reason: str(formData.get("reason")) || "sem motivo informado" });
  refresh();
  back(`/vender/pedidos/${id}`, error ? { erro: friendly(error.message) } : { ok: "Pedido cancelado e estoque liberado" });
}

export async function setOrderStatusAction(formData: FormData) {
  const id = str(formData.get("order_id"));
  const supabase = await createClient();
  const { error } = await supabase.schema("sales").rpc("set_order_status", { p_order: id, p_status: str(formData.get("status")) });
  refresh();
  back(`/vender/pedidos/${id}`, error ? { erro: friendly(error.message) } : { ok: "Situação atualizada" });
}

export async function saveShipmentAction(formData: FormData) {
  const id = str(formData.get("order_id"));
  const supabase = await createClient();
  const { error } = await supabase.schema("sales").rpc("save_shipment", { p: {
    order_id: id, shipment_id: str(formData.get("shipment_id")) || undefined, carrier: str(formData.get("carrier")), tracking: str(formData.get("tracking")) || undefined,
    cost: num(formData.get("cost")) || 0, charged: num(formData.get("charged")) || 0, status: str(formData.get("status")) || "PENDING", notes: str(formData.get("notes")) || undefined,
  } as unknown as Json });
  refresh();
  back(str(formData.get("return_to")) || `/vender/pedidos/${id}`, error ? { erro: friendly(error.message) } : { ok: "Entrega atualizada" });
}

// ---------------------------------------------------------------------
// Trocas e devoluções
// ---------------------------------------------------------------------
const returnSchema = z.object({
  order_id: uuid, type: z.enum(["RETURN_REFUND", "EXCHANGE", "STORE_CREDIT"]), reason: z.enum(["SIZE", "DEFECT", "REGRET_7D", "OTHER"]),
  refund_method: z.enum(["STORE_CREDIT", "CASH", "PIX", "CARD"]).optional(), cash_session_id: uuid.optional(), notes: z.string().max(300).optional(),
  items: z.array(z.object({ order_item_id: uuid, qty: z.number().positive(), restock_location_id: uuid.optional() })).min(1),
});

export async function createReturnAction(_prev: State, formData: FormData): Promise<State> {
  let raw: unknown;
  try { raw = JSON.parse(String(formData.get("payload") ?? "")); } catch { return { ok: false, error: "Dados inválidos" }; }
  const parsed = returnSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: `Confira a devolução: ${parsed.error.issues[0]?.path.join(".")} — ${parsed.error.issues[0]?.message}` };
  const supabase = await createClient();
  const { data, error } = await supabase.schema("sales").rpc("create_return", { p: parsed.data as unknown as Json });
  if (error) return { ok: false, error: friendly(error.message) };
  refresh();
  const r = data as unknown as { id: string; number: string };
  return back("/vender/trocas", { ok: `${parsed.data.type === "EXCHANGE" ? "Troca" : "Devolução"} ${r.number} registrada` });
}

// ---------------------------------------------------------------------
// Reservas e Armário VIP
// ---------------------------------------------------------------------
const lockerSchema = z.object({
  store_id: uuid, locker_id: uuid, party_id: uuid, hold_hours: z.number().int().min(1).max(168).default(48), notes: z.string().max(300).optional(),
  items: z.array(z.object({ variant_id: uuid, qty: z.number().positive().max(20) })).min(1).max(12),
});

export async function prepareLockerAction(_prev: State, formData: FormData): Promise<State> {
  let raw: unknown;
  try { raw = JSON.parse(String(formData.get("payload") ?? "")); } catch { return { ok: false, error: "Dados inválidos" }; }
  const parsed = lockerSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: `Confira o armário: ${parsed.error.issues[0]?.path.join(".")} — ${parsed.error.issues[0]?.message}` };
  const supabase = await createClient();
  const { error } = await supabase.schema("sales").rpc("prepare_locker", { p: parsed.data as unknown as Json });
  if (error) return { ok: false, error: friendly(error.message) };
  refresh();
  return back("/vender/reservas", { ok: "Armário preparado: as peças ficam reservadas até o prazo" });
}

export async function closeLockerAction(formData: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.schema("sales").rpc("close_locker_drop", { p_drop: str(formData.get("drop_id")), p_outcome: str(formData.get("outcome")) });
  refresh();
  back("/vender/reservas", error ? { erro: friendly(error.message) } : { ok: "Armário encerrado e peças liberadas" });
}

export async function releaseReservationAction(formData: FormData) {
  const supabase = await createClient();
  await supabase.schema("inv").rpc("release_reservation", { p_reservation: str(formData.get("id")) });
  refresh();
  back("/vender/reservas", { ok: "Reserva liberada" });
}

export async function ensureLockersAction(formData: FormData) {
  const supabase = await createClient();
  const { data, error } = await supabase.schema("inv").rpc("ensure_lockers", { p_store: str(formData.get("store_id")), p_count: Number(str(formData.get("count")) || 6) });
  refresh();
  back("/vender/reservas", error ? { erro: friendly(error.message) } : { ok: `${data} armário(s) cadastrado(s)` });
}

// ---------------------------------------------------------------------
// Cupons
// ---------------------------------------------------------------------
const couponSchema = z.object({
  code: z.string().min(3).max(30).regex(/^[A-Za-z0-9_-]+$/, "use letras, números, - ou _"), kind: z.enum(["PERCENT", "AMOUNT"]), value: z.number().positive(),
  max_uses: z.number().int().positive().optional(), per_customer_limit: z.number().int().positive().optional(), min_order: z.number().positive().optional(),
  valid_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), affiliate_party_id: uuid.optional(),
});

export async function saveCouponAction(_prev: State, formData: FormData): Promise<State> {
  const session = await getSession();
  const opt = (k: string) => str(formData.get(k)) || undefined;
  const optNum = (k: string) => (str(formData.get(k)) ? num(formData.get(k)) : undefined);
  const parsed = couponSchema.safeParse({ code: opt("code"), kind: opt("kind"), value: num(formData.get("value")), max_uses: optNum("max_uses"), per_customer_limit: optNum("per_customer_limit"),
    min_order: optNum("min_order"), valid_to: opt("valid_to"), affiliate_party_id: opt("affiliate_party_id") });
  if (!parsed.success) return { ok: false, error: `Confira o cupom: ${parsed.error.issues[0]?.path.join(".")} — ${parsed.error.issues[0]?.message}` };
  if (parsed.data.kind === "PERCENT" && parsed.data.value > 100) return { ok: false, error: "Percentual acima de 100%" };
  const supabase = await createClient();
  const p = parsed.data;
  const { error } = await supabase.schema("sales").from("coupons").insert({
    org_id: session.orgId, code: p.code.toUpperCase(), kind: p.kind, value: p.value, max_uses: p.max_uses ?? null, per_customer_limit: p.per_customer_limit ?? null,
    min_order: p.min_order ?? null, valid_to: p.valid_to ? `${p.valid_to}T23:59:59-03:00` : null, affiliate_party_id: p.affiliate_party_id ?? null,
  });
  if (error) return { ok: false, error: error.code === "23505" ? "Já existe um cupom com esse código" : friendly(error.message) };
  refresh();
  return { ok: true, message: `Cupom ${p.code.toUpperCase()} criado` };
}

export async function toggleCouponAction(formData: FormData) {
  const supabase = await createClient();
  await supabase.schema("sales").from("coupons").update({ active: formData.get("active") === "1" }).eq("id", str(formData.get("id")));
  refresh();
  back("/marketing/cupons", { ok: "Cupom atualizado" });
}
