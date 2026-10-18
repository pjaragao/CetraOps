import { can, operatorFromRequest, posRoute, requirePosPerm } from "@/lib/pos-api";

/** Abertura do app: operador, permissões, loja da maquininha, caixa aberto e ambiente da Stone. */
export const GET = posRoute(async (request) => {
  const op = await operatorFromRequest(request);
  requirePosPerm(op, "sales.write");
  const [{ data: cash }, { data: stone }] = await Promise.all([
    op.supabase.schema("sales").from("cash_sessions").select("id").eq("store_id", op.device.storeId).eq("status", "OPEN").maybeSingle(),
    op.supabase.schema("sales").rpc("get_stone_config"),
  ]);
  const cfg = stone as { environment?: string } | null;
  return {
    operator: { name: op.name, canDiscount: can(op, "sales.discount"), canCustomItem: can(op, "sales.custom_item") },
    device: { id: op.device.deviceId, name: op.device.name },
    store: { id: op.device.storeId, name: op.device.storeName },
    cashSessionId: cash?.id ?? null,
    stoneEnvironment: cfg?.environment ?? "producao",
    serverTime: new Date().toISOString(),
  };
});
