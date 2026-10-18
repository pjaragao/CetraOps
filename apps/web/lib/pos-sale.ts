import { z } from "zod";

/** Venda de balcão (PDV web e app da maquininha): o mesmo formato para sales.create_pos_order. */
export const saleSchema = z.object({
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
    ncm: z.string().regex(/^\d{8}$/).nullable().optional(),
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
    authCode: z.string().max(20).optional(),
    brand: z.string().max(30).optional(),
    stoneOrderId: z.string().regex(/^[A-Za-z0-9_-]{4,64}$/).optional(),
  })).min(1),
});

export type SaleInput = z.infer<typeof saleSchema>;

/** Parâmetro de sales.create_pos_order. Pagamento com cobrança da maquininha (inclusive Pix) vai como STONE: o banco confere a cobrança e não deixa usar duas vezes. */
export function createPosOrderParam(s: SaleInput) {
  return {
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
      ncm: i.ncm || null,
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
      acquirer: ["DEBIT", "CREDIT"].includes(p.method) || p.stoneOrderId ? "STONE" : null,
      anticipation_mode: p.method === "CREDIT" ? p.anticipation : null,
      nsu: p.nsu || null,
      auth_code: p.authCode || null,
      brand: p.brand || null,
      external_id: p.stoneOrderId || null,
    })),
  };
}
