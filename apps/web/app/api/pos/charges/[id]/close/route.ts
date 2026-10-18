import { z } from "zod";
import type { Json } from "@centralops/db";
import { dbError, jsonBody, operatorFromRequest, PosError, posRoute, requirePosPerm } from "@/lib/pos-api";

const body = z.object({
  status: z.enum(["CANCELLED", "FAILED", "REFUNDED"]),
  code: z.string().max(20).optional(),
  message: z.string().max(200).optional(),
});

/** Desistência/recusa no app de pagamento, ou estorno feito na maquininha de cobrança que não entrou em venda. */
export const POST = posRoute(async (request: Request, ctx: { params: Promise<{ id: string }> }) => {
  const op = await operatorFromRequest(request);
  requirePosPerm(op, "sales.write");
  const { id } = await ctx.params;
  if (!/^dl_[a-f0-9]{32}$/.test(id)) throw new PosError("Cobrança inválida", 404);
  const parsed = body.safeParse(await jsonBody(request));
  if (!parsed.success) throw new PosError("Situação inválida");
  const { data, error } = await op.supabase.schema("sales").rpc("close_stone_deeplink_charge", {
    p_device_token_hash: op.device.tokenHash, p_charge: id, p_status: parsed.data.status,
    p_raw: { code: parsed.data.code ?? null, message: parsed.data.message ?? null } as unknown as Json,
  });
  if (error) dbError(error);
  return data;
});
