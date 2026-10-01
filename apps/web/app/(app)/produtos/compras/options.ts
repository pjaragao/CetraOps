import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { PoItem } from "./po-editor";

/** Listas usadas pelo editor de pedidos e pela importação de NF-e (empresas, locais, fornecedores, condições, coleções). */
export async function loadPurchaseOptions() {
  const supabase = await createClient();
  const [{ data: entities }, { data: locations }, { data: roles }, { data: terms }, { data: collections }] = await Promise.all([
    supabase.schema("core").from("legal_entities").select("id, razao_social, nome_fantasia").order("razao_social"),
    supabase.schema("inv").from("locations").select("id, name, legal_entity_id, kind").in("kind", ["SALES_FLOOR", "BACKROOM"]).order("name"),
    supabase.schema("crm").from("party_roles").select("party_id").eq("role", "SUPPLIER"),
    supabase.schema("purch").from("payment_terms").select("id, name").eq("active", true).order("name"),
    supabase.schema("catalog").from("collections").select("id, name").order("name"),
  ]);
  const ids = (roles ?? []).map((r) => r.party_id);
  const { data: parties } = ids.length ? await supabase.schema("crm").from("parties").select("id, display_name").in("id", ids).order("display_name") : { data: [] as { id: string; display_name: string }[] };
  return {
    entities: (entities ?? []).map((e) => ({ id: e.id, name: e.nome_fantasia ?? e.razao_social })),
    locations: (locations ?? []).map((l) => ({ id: l.id, name: l.name, legal_entity_id: l.legal_entity_id })),
    suppliers: (parties ?? []).map((p) => ({ id: p.id, name: p.display_name })),
    terms: terms ?? [],
    collections: collections ?? [],
  };
}

/** Resolve rótulos de variantes para itens vindos por URL/pedido. */
export async function resolveItems(rows: { variant_id: string; qty: number; unit_cost: number }[]): Promise<PoItem[]> {
  if (rows.length === 0) return [];
  const supabase = await createClient();
  const { data: variants } = await supabase.schema("catalog").from("variants").select("id, sku, size, product_id, color_id").in("id", rows.map((r) => r.variant_id));
  const productIds = [...new Set((variants ?? []).map((v) => v.product_id))];
  const [{ data: products }, { data: colors }] = await Promise.all([
    productIds.length ? supabase.schema("catalog").from("products").select("id, name").in("id", productIds) : Promise.resolve({ data: [] as { id: string; name: string }[] }),
    supabase.schema("catalog").from("colors").select("id, name"),
  ]);
  const pname = new Map((products ?? []).map((p) => [p.id, p.name]));
  const cname = new Map((colors ?? []).map((c) => [c.id, c.name]));
  const vmap = new Map((variants ?? []).map((v) => [v.id, v]));
  return rows.flatMap((r) => {
    const v = vmap.get(r.variant_id);
    return v ? [{ variant_id: v.id, sku: v.sku, label: `${pname.get(v.product_id) ?? ""} · ${v.color_id ? cname.get(v.color_id) ?? "" : "—"} · ${v.size}`, qty: r.qty, unit_cost: r.unit_cost }] : [];
  });
}
