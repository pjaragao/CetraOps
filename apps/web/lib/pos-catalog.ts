import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@centralops/db";
import { fetchAll } from "@/lib/fetch-all";
import type { PosProduct } from "@/lib/pos-types";

const SIZE_ORDER = ["PP", "P", "M", "G", "GG", "XGG", "U"];

/**
 * O que dá para vender na loja: variantes ativas de produto ativo com preço vigente, agrupadas por produto e cor, com o estoque vendável
 * (malinha e campanha ficam de fora). Em páginas: o Supabase Cloud devolve no máximo 1.000 linhas por consulta.
 */
export async function loadPosCatalog(supabase: SupabaseClient<Database>, storeId: string): Promise<PosProduct[]> {
  const [variants, prices, stock] = await Promise.all([
    fetchAll((a, b) => supabase.schema("catalog").from("variants")
      .select("id, sku, size, gtin, product_id, products!inner(name, reference_code, gender, status, backorder), colors(name)")
      .eq("active", true).eq("products.status", "ACTIVE").order("id").range(a, b)),
    fetchAll((a, b) => supabase.schema("catalog").from("prices").select("product_id, variant_id, price").is("valid_to", null).order("id").range(a, b)),
    fetchAll((a, b) => supabase.schema("inv").from("v_stock_matrix").select("variant_id, available").eq("store_id", storeId).eq("is_sellable", true)
      .order("location_id").order("variant_id").range(a, b)),
  ]);

  const priceByVariant = new Map<string, number>();
  const priceByProduct = new Map<string, number>();
  for (const p of prices) {
    if (p.variant_id) priceByVariant.set(p.variant_id, Number(p.price));
    else if (p.product_id) priceByProduct.set(p.product_id, Number(p.price));
  }
  const avail = new Map<string, number>();
  for (const s of stock) if (s.variant_id) avail.set(s.variant_id, (avail.get(s.variant_id) ?? 0) + Number(s.available));

  const byProduct = new Map<string, PosProduct>();
  for (const v of variants) {
    const price = priceByVariant.get(v.id) ?? priceByProduct.get(v.product_id);
    if (price === undefined) continue;
    const key = `${v.product_id}|${v.colors?.name ?? ""}`;
    const prod = byProduct.get(key) ?? {
      key, name: v.products.name, reference: v.products.reference_code, gender: v.products.gender,
      color: v.colors?.name ?? "", backorder: v.products.backorder, variants: [],
    };
    prod.variants.push({ id: v.id, sku: v.sku, size: v.size, gtin: v.gtin, price, available: avail.get(v.id) ?? 0 });
    byProduct.set(key, prod);
  }
  return [...byProduct.values()].map((p) => ({
    ...p, variants: p.variants.sort((a, b) => SIZE_ORDER.indexOf(a.size) - SIZE_ORDER.indexOf(b.size)),
  })).sort((a, b) => a.name.localeCompare(b.name));
}
