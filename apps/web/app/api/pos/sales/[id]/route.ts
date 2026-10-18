import { dbError, operatorFromRequest, PosError, posRoute, requirePosPerm } from "@/lib/pos-api";

const METHOD_LABEL: Record<string, string> = { PIX: "Pix", DEBIT: "Débito", CREDIT: "Crédito", CASH: "Dinheiro", STORE_CREDIT: "Vale-troca", PAYMENT_LINK: "Link de pagamento" };

/**
 * Dados para imprimir na maquininha: o pedido (comprovante não fiscal) e, quando a SEFAZ já autorizou, o DANFE NFC-e completo
 * (o app consulta de novo enquanto a nota estiver em processamento).
 */
export const GET = posRoute(async (request: Request, ctx: { params: Promise<{ id: string }> }) => {
  const op = await operatorFromRequest(request);
  requirePosPerm(op, "sales.read");
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new PosError("Venda inválida", 404);
  const sales = op.supabase.schema("sales");
  const { data: o, error } = await sales.from("orders").select("id, number, store_id, subtotal, discount_total, total, paid_total, status, created_at, cpf_on_invoice")
    .eq("id", id).maybeSingle();
  if (error) dbError(error);
  if (!o || o.store_id !== op.device.storeId) throw new PosError("Venda não encontrada nesta loja", 404);

  const [{ data: items }, { data: pays }, { data: fiscal }] = await Promise.all([
    sales.from("order_items").select("description, variant_id, qty, unit_price, discount_amount, total").eq("order_id", id).order("line_no"),
    sales.from("payments").select("method, amount, installments, brand, auth_code, nsu").eq("order_id", id).order("created_at"),
    sales.rpc("get_order_fiscal_doc", { p_order: id }),
  ]);
  const doc = fiscal as { id: string; model: string; status: string; sefaz_msg: string | null; consult_url: string | null } | null;
  let danfe: unknown = null;
  if (doc && doc.model === "65" && ["AUTHORIZED", "CANCELLED"].includes(doc.status)) {
    const { data: p } = await sales.rpc("get_nfce_print", { p_document: doc.id });
    danfe = (p as { danfe?: unknown; protocol?: string; status?: string } | null) ?? null;
  }
  // catálogo é outro schema: sem embed do PostgREST, consulta à parte
  const variantIds = [...new Set((items ?? []).map((i) => i.variant_id).filter((x): x is string => Boolean(x)))];
  const { data: vars } = variantIds.length
    ? await op.supabase.schema("catalog").from("variants").select("id, sku, size, products(name), colors(name)").in("id", variantIds)
    : { data: [] };
  const byId = new Map((vars ?? []).map((v) => [v.id, v]));
  return {
    order: {
      id: o.id, number: o.number, createdAt: o.created_at, status: o.status, cpf: o.cpf_on_invoice,
      subtotal: Number(o.subtotal), discount: Number(o.discount_total), total: Number(o.total), paid: Number(o.paid_total),
      items: (items ?? []).map((i) => {
        const v = i.variant_id ? byId.get(i.variant_id) : undefined;
        return {
          name: v?.products?.name ? [v.products.name, v.colors?.name, v.size].filter(Boolean).join(" ") : (i.description ?? "Item"),
          sku: v?.sku ?? null, qty: Number(i.qty), unitPrice: Number(i.unit_price), discount: Number(i.discount_amount), total: Number(i.total),
        };
      }),
      payments: (pays ?? []).map((p) => ({
        label: `${METHOD_LABEL[p.method] ?? p.method}${p.method === "CREDIT" && p.installments > 1 ? ` ${p.installments}x` : ""}${p.brand ? ` ${p.brand}` : ""}`,
        amount: Number(p.amount), authCode: p.auth_code, nsu: p.nsu,
      })),
    },
    fiscal: doc ? { status: doc.status, message: doc.sefaz_msg, consultUrl: doc.consult_url, nfce: danfe } : null,
  };
});
