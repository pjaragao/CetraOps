"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

const saleSchema = z.object({
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
