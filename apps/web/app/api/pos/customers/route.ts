import { z } from "zod";
import { dbError, jsonBody, operatorFromRequest, PosError, posRoute, requirePosPerm } from "@/lib/pos-api";

const body = z.object({ phone: z.string().max(30), name: z.string().max(120).optional(), marketing: z.boolean().default(false) });

/** Identifica (ou cadastra rápido) a cliente pelo telefone; devolve o cupom pessoal vigente e o saldo de vale-troca. */
export const POST = posRoute(async (request) => {
  const op = await operatorFromRequest(request);
  requirePosPerm(op, "sales.write");
  const parsed = body.safeParse(await jsonBody(request));
  if (!parsed.success) throw new PosError("Dados da cliente inválidos");
  const digits = parsed.data.phone.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 13) throw new PosError("Telefone inválido");
  const { data: partyId, error } = await op.supabase.schema("crm").rpc("quick_customer", {
    p_phone: digits, p_name: parsed.data.name?.trim() || undefined, p_marketing_whatsapp: parsed.data.marketing,
  });
  if (error) dbError(error);
  const [{ data: party }, { data: coupon }, { data: credit }] = await Promise.all([
    op.supabase.schema("crm").from("parties").select("id, display_name, tier").eq("id", partyId).single(),
    op.supabase.schema("sales").rpc("party_auto_coupon", { p_party: partyId }),
    op.supabase.schema("sales").rpc("get_customer_store_credit", { p_party: partyId }),
  ]);
  const c = coupon as { code: string; kind: string; value: number; valid_to: string | null } | null;
  return {
    party: { id: partyId, name: party?.display_name ?? "", tier: party?.tier ?? null },
    autoCoupon: c ? { code: c.code, kind: c.kind, value: Number(c.value), validTo: c.valid_to } : null,
    storeCredit: Number(credit) || 0,
  };
});
