"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

const saleSchema = z.object({
  orderId: z.string().uuid().nullable().optional(),
  idempotencyKey: z.string().uuid(),
  storeId: z.string().uuid(),
  partyId: z.string().uuid().nullable(),
  cashSessionId: z.string().uuid().nullable(),
  cpfOnInvoice: z.string().regex(/^\d{11}$/).nullable(),
  couponCode: z.string().max(40).nullable(),
  items: z.array(z.object({
    variantId: z.string().uuid().nullable().optional(),
    description: z.string().min(1).max(200).nullable().optional(),
    unitPrice: z.number().min(0).optional(),
    listPrice: z.number().min(0).optional(),
    qty: z.number().int().positive(),
    discountAmount: z.number().min(0).optional(),
    discountReason: z.string().max(200).nullable().optional(),
  })).min(1),
  payments: z.array(z.object({
    method: z.enum(["PIX", "DEBIT", "CREDIT", "CASH", "STORE_CREDIT"]),
    amount: z.number().positive(),
    installments: z.number().int().min(1).max(12),
    anticipation: z.enum(["D1", "NATURAL"]),
    nsu: z.string().max(40).optional(),
  })).min(1),
});

export type SaleInput = z.infer<typeof saleSchema>;
export type SaleResult = { ok: true; number: string; total: number } | { ok: false; error: string };

export async function finalizeSale(input: SaleInput): Promise<SaleResult> {
  const parsed = saleSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Dados da venda inválidos" };
  const s = parsed.data;
  const supabase = await createClient();

  const { data, error } = await supabase.schema("sales").rpc("create_pos_order", {
    p: {
      order_id: s.orderId || null,
      idempotency_key: s.idempotencyKey,
      store_id: s.storeId,
      party_id: s.partyId,
      cash_session_id: s.cashSessionId,
      cpf_on_invoice: s.cpfOnInvoice,
      coupon_code: s.couponCode,
      items: s.items.map((i) => ({
        variant_id: i.variantId || null,
        description: i.description || null,
        unit_price: i.unitPrice ?? undefined,
        list_price: i.listPrice ?? undefined,
        qty: i.qty,
        discount_amount: i.discountAmount ?? 0,
        discount_reason: i.discountReason || null,
      })),
      payments: s.payments.map((p) => ({
        method: p.method,
        amount: p.amount,
        installments: p.installments,
        acquirer: ["DEBIT", "CREDIT"].includes(p.method) ? "STONE" : null,
        anticipation_mode: p.method === "CREDIT" ? p.anticipation : null,
        nsu: p.nsu || null,
      })),
    },
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/vender/pdv");
  revalidatePath("/inicio");
  return { ok: true, number: data.number, total: Number(data.total) };
}

export async function identifyCustomer(phone: string, name: string, marketing: boolean) {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 10) return { ok: false as const, error: "Telefone inválido" };
  const supabase = await createClient();
  const { data, error } = await supabase.schema("crm").rpc("quick_customer", {
    p_phone: digits, p_name: name || undefined, p_marketing_whatsapp: marketing,
  });
  if (error) return { ok: false as const, error: error.message };
  const { data: party } = await supabase.schema("crm").from("parties").select("id, display_name, sizes, tier").eq("id", data).single();
  return { ok: true as const, party };
}

/** Cupom pessoal vigente da cliente (ex.: aniversário): entra sozinho no carrinho quando ela é identificada. */
export async function autoCouponFor(partyId: string) {
  const supabase = await createClient();
  const { data } = await supabase.schema("sales").rpc("party_auto_coupon", { p_party: partyId });
  const c = data as unknown as { code: string; kind: string; value: number; valid_to: string | null } | null;
  return c ? { code: c.code, kind: c.kind, value: Number(c.value), validTo: c.valid_to } : null;
}

/** Saldo de vale-troca disponível da cliente para uso no PDV. */
export async function getCustomerStoreCredit(partyId: string): Promise<number> {
  const supabase = await createClient();
  const sales = (supabase as unknown as { schema: (s: string) => { rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }> } }).schema("sales");
  const { data } = await sales.rpc("get_customer_store_credit", { p_party: partyId });
  return Number(data) || 0;
}

const draftSchema = z.object({
  orderId: z.string().uuid().optional().nullable(),
  storeId: z.string().uuid(),
  partyId: z.string().uuid().optional().nullable(),
  channel: z.enum(["POS", "WHATSAPP", "INSTAGRAM", "TELEGRAM", "PAYMENT_LINK", "B2B", "EVENT"]).default("POS"),
  fulfillmentType: z.enum(["MOTOBOY", "CARRIER", "STORE_PICKUP", "LOCKER_PICKUP", "TAKEAWAY"]).default("TAKEAWAY"),
  shippingTotal: z.number().min(0).default(0),
  notes: z.string().max(500).optional().nullable(),
  items: z.array(z.object({
    variantId: z.string().uuid().optional().nullable(),
    description: z.string().min(1).max(200).optional().nullable(),
    unitPrice: z.number().min(0).default(0),
    listPrice: z.number().min(0).optional(),
    qty: z.number().positive().default(1),
    discountAmount: z.number().min(0).default(0),
    discountReason: z.string().max(200).optional().nullable(),
  })).min(1),
});

export type DraftInput = z.infer<typeof draftSchema>;
export type DraftResult = { ok: true; id: string; number: string; total: number } | { ok: false; error: string };

/** Salva rascunho de pedido diretamente no banco de dados (sales.orders com status DRAFT) */
export async function saveOrderDraft(input: DraftInput): Promise<DraftResult> {
  const parsed = draftSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Dados do pedido inválidos" };
  const d = parsed.data;
  const supabase = await createClient();

  const sales = (supabase as unknown as {
    schema: (s: string) => {
      rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>
    }
  }).schema("sales");

  const { data, error } = await sales.rpc("save_order_draft", {
    p: {
      order_id: d.orderId || null,
      store_id: d.storeId,
      party_id: d.partyId || null,
      channel: d.channel,
      fulfillment_type: d.fulfillmentType,
      shipping_total: d.shippingTotal,
      notes: d.notes || null,
      items: d.items.map((i) => ({
        variant_id: i.variantId || null,
        description: i.description || null,
        unit_price: i.unitPrice,
        list_price: i.listPrice ?? i.unitPrice,
        qty: i.qty,
        discount_amount: i.discountAmount,
        discount_reason: i.discountReason || null,
      })),
    },
  });

  if (error) return { ok: false, error: error.message };
  const row = data as { id: string; number: string; total: number };
  revalidatePath("/vender/pedidos");
  revalidatePath("/vender/pdv");
  return { ok: true, id: row.id, number: row.number, total: Number(row.total) };
}

/** Carrega pedido em andamento (DRAFT) para ser continuado no PDV */
export async function getOrderDraft(orderId: string) {
  const supabase = await createClient();
  const { data: order } = await supabase.schema("sales").from("orders").select("id, number, store_id, party_id, channel, fulfillment_type, shipping_total, notes, status").eq("id", orderId).maybeSingle();
  if (!order || order.status !== "DRAFT") return null;

  const [{ data: items }, { data: party }, { data: phoneContact }] = await Promise.all([
    supabase.schema("sales").from("order_items").select("id, variant_id, description, qty, unit_price, list_price, discount_amount, discount_reason, total").eq("order_id", orderId),
    order.party_id ? supabase.schema("crm").from("parties").select("id, display_name").eq("id", order.party_id).maybeSingle() : Promise.resolve({ data: null }),
    order.party_id ? supabase.schema("crm").from("party_contact_points").select("value_display").eq("party_id", order.party_id).in("type", ["PHONE", "WHATSAPP"]).limit(1).maybeSingle() : Promise.resolve({ data: null }),
  ]);

  return {
    order,
    party: party ? { id: party.id, name: party.display_name, phone: phoneContact?.value_display ?? null } : null,
    items: items ?? [],
  };
}
