import { z } from "zod";
import { dbError, jsonBody, operatorFromRequest, PosError, posRoute, requirePosPerm } from "@/lib/pos-api";

const body = z.object({
  amount: z.number().positive().max(999999.99),
  method: z.enum(["CREDIT", "DEBIT", "PIX"]),
  installments: z.number().int().min(1).max(12).default(1),
});

/** Abre a cobrança antes de chamar o app de pagamento da Stone (valor e forma ficam gravados no servidor). */
export const POST = posRoute(async (request) => {
  const op = await operatorFromRequest(request);
  requirePosPerm(op, "sales.write");
  const parsed = body.safeParse(await jsonBody(request));
  if (!parsed.success) throw new PosError("Cobrança inválida");
  const { data, error } = await op.supabase.schema("sales").rpc("open_stone_deeplink_charge", {
    p_device_token_hash: op.device.tokenHash, p_amount: Math.round(parsed.data.amount * 100) / 100, p_method: parsed.data.method, p_installments: parsed.data.installments,
  });
  if (error) dbError(error);
  const r = data as { charge_id: string; amount: number; method: string; installments: number };
  return { chargeId: r.charge_id, amount: Number(r.amount), method: r.method, installments: r.installments };
});
