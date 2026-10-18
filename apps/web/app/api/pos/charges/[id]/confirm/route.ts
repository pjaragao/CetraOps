import { z } from "zod";
import type { Json } from "@centralops/db";
import { dbError, jsonBody, operatorFromRequest, PosError, posRoute, requirePosPerm } from "@/lib/pos-api";

/** Retorno do Deeplink de pagamento (pay-response) já lido pelo app: valores em centavos, como a Stone devolve. */
const body = z.object({
  amountCents: z.number().int().positive(),
  atk: z.string().min(4).max(64),
  itk: z.string().max(80).optional(),
  authorizationCode: z.string().max(20).optional(),
  brand: z.string().max(30).optional(),
  installmentCount: z.number().int().min(0).max(99).optional(),
  type: z.string().max(30).optional(),
  pan: z.string().max(30).optional(),
  entryMode: z.string().max(30).optional(),
  authorizationDateTime: z.string().max(40).optional(),
});

/** O app de pagamento aprovou: grava (o banco confere maquininha, valor e ATK único). */
export const POST = posRoute(async (request: Request, ctx: { params: Promise<{ id: string }> }) => {
  const op = await operatorFromRequest(request);
  requirePosPerm(op, "sales.write");
  const { id } = await ctx.params;
  if (!/^dl_[a-f0-9]{32}$/.test(id)) throw new PosError("Cobrança inválida", 404);
  const parsed = body.safeParse(await jsonBody(request));
  if (!parsed.success) throw new PosError("Retorno da Stone incompleto");
  const r = parsed.data;
  const { data, error } = await op.supabase.schema("sales").rpc("confirm_stone_deeplink_charge", {
    p_device_token_hash: op.device.tokenHash, p_charge: id, p_paid_amount: r.amountCents / 100, p_atk: r.atk, p_itk: r.itk ?? "",
    p_auth_code: r.authorizationCode ?? "", p_brand: r.brand ?? "", p_installments: Math.max(1, r.installmentCount ?? 1),
    p_raw: { ...r, pan: r.pan ? r.pan.replace(/\d(?=\d{4})/g, "*") : undefined } as unknown as Json,      // só os 4 últimos dígitos
  });
  if (error) dbError(error);
  const out = data as { ok: boolean; error?: string; nsu?: string; auth_code?: string; brand?: string; installments?: number; amount?: number };
  if (!out.ok) throw new PosError(out.error ?? "Pagamento não confirmado", 422);
  return { ok: true, nsu: out.nsu, authCode: out.auth_code, brand: out.brand, installments: out.installments, amount: Number(out.amount) };
});
