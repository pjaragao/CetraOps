import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { Empty, PageHeader } from "@/components/ui";
import { PosTerminal, type PosProduct } from "./pos-terminal";
import { getOrderDraft } from "./actions";

export const metadata = { title: "PDV" };

export default async function PdvPage({ searchParams }: { searchParams: Promise<{ modo?: string; resume?: string; order_id?: string }> }) {
  const { modo, resume, order_id } = await searchParams;
  const session = await requirePerm("sales.write");
  if (!session.storeId) {
    return (<><PageHeader title="PDV" /><Empty title="Escolha uma loja">O PDV vende numa loja específica. Selecione a loja no topo da tela.</Empty></>);
  }
  const resumeId = resume || order_id;
  const draftOrder = resumeId ? await getOrderDraft(resumeId) : null;
  const supabase = await createClient();

  const [{ data: variants }, { data: prices }, { data: stock }, { data: session_ }] = await Promise.all([
    supabase.schema("catalog").from("variants")
      .select("id, sku, size, gtin, product_id, products!inner(name, reference_code, gender, status), colors(name)")
      .eq("active", true).eq("products.status", "ACTIVE"),
    supabase.schema("catalog").from("prices").select("product_id, variant_id, price").is("valid_to", null),
    supabase.schema("inv").from("v_stock_matrix").select("variant_id, available").eq("store_id", session.storeId),
    supabase.schema("sales").from("cash_sessions").select("id").eq("store_id", session.storeId).eq("status", "OPEN").maybeSingle(),
  ]);

  const priceByVariant = new Map<string, number>();
  const priceByProduct = new Map<string, number>();
  for (const p of prices ?? []) {
    if (p.variant_id) priceByVariant.set(p.variant_id, Number(p.price));
    else if (p.product_id) priceByProduct.set(p.product_id, Number(p.price));
  }
  const avail = new Map<string, number>();
  for (const s of stock ?? []) if (s.variant_id) avail.set(s.variant_id, (avail.get(s.variant_id) ?? 0) + Number(s.available));

  const byProduct = new Map<string, PosProduct>();
  for (const v of variants ?? []) {
    const price = priceByVariant.get(v.id) ?? priceByProduct.get(v.product_id);
    if (price === undefined) continue;
    const key = `${v.product_id}|${v.colors?.name ?? ""}`;
    const prod = byProduct.get(key) ?? {
      key, name: v.products.name, reference: v.products.reference_code, gender: v.products.gender,
      color: v.colors?.name ?? "", variants: [],
    };
    prod.variants.push({ id: v.id, sku: v.sku, size: v.size, gtin: v.gtin, price, available: avail.get(v.id) ?? 0 });
    byProduct.set(key, prod);
  }
  const sizeOrder = ["PP", "P", "M", "G", "GG", "XGG", "U"];
  const products = [...byProduct.values()].map((p) => ({
    ...p, variants: p.variants.sort((a, b) => sizeOrder.indexOf(a.size) - sizeOrder.indexOf(b.size)),
  })).sort((a, b) => a.name.localeCompare(b.name));

  return (
    <>
      <PageHeader title="PDV" description="Nova venda: no balcão (recebe e emite a NFC-e) ou pedido remoto (reserva o estoque até o pagamento)." />
      <PosTerminal
        storeId={session.storeId}
        products={products}
        cashSessionId={session_?.id ?? null}
        initialMode={modo === "remoto" ? "remoto" : "balcao"}
        canDiscount={can(session, "sales.discount")}
        canCustomItem={can(session, "sales.custom_item")}
        initialDraft={draftOrder}
      />
    </>
  );
}
