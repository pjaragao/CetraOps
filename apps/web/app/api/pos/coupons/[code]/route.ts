import { dbError, operatorFromRequest, PosError, posRoute, requirePosPerm } from "@/lib/pos-api";

/** Cupom vigente pelo código: o app calcula o desconto como sales.create_pos_order (sobre o subtotal já com os descontos dos itens). */
export const GET = posRoute(async (request: Request, ctx: { params: Promise<{ code: string }> }) => {
  const op = await operatorFromRequest(request);
  requirePosPerm(op, "sales.write");
  const code = decodeURIComponent((await ctx.params).code).trim();
  if (!/^[A-Za-z0-9_-]{2,40}$/.test(code)) throw new PosError("Cupom inválido", 404);
  const now = new Date().toISOString();
  const { data, error } = await op.supabase.schema("sales").from("coupons").select("code, kind, value, min_order, valid_to")
    .ilike("code", code.replace(/[_%]/g, "\\$&")).eq("active", true).lte("valid_from", now).or(`valid_to.is.null,valid_to.gt.${now}`).limit(1).maybeSingle();
  if (error) dbError(error);
  if (!data) throw new PosError("Cupom inválido ou expirado", 404);
  return { code: data.code, kind: data.kind, value: Number(data.value), minOrder: data.min_order === null ? null : Number(data.min_order), validTo: data.valid_to };
});
