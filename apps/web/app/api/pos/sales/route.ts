import { dbError, jsonBody, operatorFromRequest, PosError, posRoute, requirePosPerm } from "@/lib/pos-api";
import { createPosOrderParam, saleSchema } from "@/lib/pos-sale";
import { inChunks } from "@/lib/fetch-all";

/** Venda de balcão vinda da maquininha: loja e caixa são os da maquininha; cartão e Pix só com a cobrança confirmada pelo Deeplink. */
const appSale = saleSchema.omit({ orderId: true, storeId: true, cashSessionId: true });

export const POST = posRoute(async (request) => {
  const op = await operatorFromRequest(request);
  requirePosPerm(op, "sales.write");
  const raw = (await jsonBody(request)) as Record<string, unknown> | null;
  // o app omite campos nulos (cliente, CPF e cupom são opcionais)
  const parsed = appSale.safeParse({ partyId: null, cpfOnInvoice: null, couponCode: null, ...(raw ?? {}) });
  if (!parsed.success) throw new PosError("Dados da venda inválidos");
  const s = parsed.data;
  if (s.payments.some((p) => ["CREDIT", "DEBIT", "PIX"].includes(p.method) && !p.stoneOrderId?.startsWith("dl_"))) {
    throw new PosError("Cartão e Pix são cobrados pela maquininha");
  }
  const { data: cash } = await op.supabase.schema("sales").from("cash_sessions").select("id").eq("store_id", op.device.storeId).eq("status", "OPEN").maybeSingle();
  if (s.payments.some((p) => p.method === "CASH") && !cash) throw new PosError("Abra o caixa (na tela web) para receber em dinheiro");

  const { data, error } = await op.supabase.schema("sales").rpc("create_pos_order", {
    p: createPosOrderParam({ ...s, orderId: null, storeId: op.device.storeId, cashSessionId: cash?.id ?? null }),
  });
  if (error) dbError(error);
  return { orderId: data.id, number: data.number, total: Number(data.total) };
});

/** Vendas de hoje nesta loja (para reimprimir e conferir). */
export const GET = posRoute(async (request) => {
  const op = await operatorFromRequest(request);
  requirePosPerm(op, "sales.read");
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
  const { data, error } = await op.supabase.schema("sales").from("orders")
    .select("id, number, total, status, created_at, party_id")
    .eq("store_id", op.device.storeId).eq("channel", "POS").gte("created_at", `${today}T00:00:00-03:00`)
    .order("created_at", { ascending: false }).limit(100);
  if (error) dbError(error);
  const partyIds = [...new Set((data ?? []).map((o) => o.party_id).filter((x): x is string => Boolean(x)))];
  const names = new Map<string, string>();
  if (partyIds.length) {
    const parties = await inChunks(partyIds, (part) => op.supabase.schema("crm").from("parties").select("id, display_name").in("id", part));
    for (const p of parties) names.set(p.id, p.display_name);
  }
  return {
    sales: (data ?? []).map((o) => ({
      id: o.id, number: o.number, total: Number(o.total), status: o.status, createdAt: o.created_at,
      customer: o.party_id ? names.get(o.party_id) ?? null : null,
    })),
  };
});
