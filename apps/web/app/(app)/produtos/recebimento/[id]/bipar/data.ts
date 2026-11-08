import "server-only";
import { createClient } from "@/lib/supabase/server";
import { photoUrl } from "@/lib/photos";
import type { ScanItem } from "./types";

/** Itens da nota com a peça ligada (SKU, nome · cor · tamanho) e a foto da cor, para a tela de bipagem. */
export async function loadScanItems(receiptId: string): Promise<ScanItem[]> {
  const supabase = await createClient();
  const { data: rows } = await supabase.schema("purch").from("receipt_items")
    .select("id, n_item, description, supplier_cprod, cean, qty_nfe, qty_counted, item_total, variant_id").eq("receipt_id", receiptId).order("n_item");
  const varIds = [...new Set((rows ?? []).map((r) => r.variant_id).filter(Boolean) as string[])];
  const { data: variants } = varIds.length
    ? await supabase.schema("catalog").from("variants").select("id, sku, size, product_id, color_id").in("id", varIds)
    : { data: [] as { id: string; sku: string; size: string; product_id: string; color_id: string | null }[] };
  const prodIds = [...new Set((variants ?? []).map((v) => v.product_id))];
  const [{ data: products }, { data: colors }, { data: media }] = await Promise.all([
    prodIds.length ? supabase.schema("catalog").from("products").select("id, name").in("id", prodIds) : Promise.resolve({ data: [] as { id: string; name: string }[] }),
    supabase.schema("catalog").from("colors").select("id, name"),
    prodIds.length
      ? supabase.schema("catalog").from("product_media").select("product_id, color_id, storage_path, position").in("product_id", prodIds).order("position")
      : Promise.resolve({ data: [] as { product_id: string; color_id: string | null; storage_path: string; position: number }[] }),
  ]);
  const vmap = new Map((variants ?? []).map((v) => [v.id, v]));
  const pname = new Map((products ?? []).map((p) => [p.id, p.name]));
  const cname = new Map((colors ?? []).map((c) => [c.id, c.name]));
  const photoOf = (productId: string, colorId: string | null) => {
    const m = (media ?? []).find((x) => x.product_id === productId && x.color_id === colorId) ?? (media ?? []).find((x) => x.product_id === productId);
    return m ? photoUrl(m.storage_path, 160) : null;
  };
  return (rows ?? []).map((r) => {
    const v = r.variant_id ? vmap.get(r.variant_id) : undefined;
    return {
      id: r.id, n_item: r.n_item, description: r.description ?? "", cprod: r.supplier_cprod, cean: r.cean,
      qty_nfe: Number(r.qty_nfe), qty_counted: Number(r.qty_counted ?? 0), item_total: Number(r.item_total), variant_id: r.variant_id,
      sku: v?.sku ?? null,
      label: v ? [pname.get(v.product_id), v.color_id ? cname.get(v.color_id) : null, v.size].filter(Boolean).join(" · ") : null,
      photo: v ? photoOf(v.product_id, v.color_id) : null,
    };
  });
}
