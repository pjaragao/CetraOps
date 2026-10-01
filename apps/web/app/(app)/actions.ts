"use server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { getSession, STORE_COOKIE } from "@/lib/session";

export async function setStoreContext(storeId: string) {
  const s = await getSession();
  const allowed = storeId === "ALL" ? s.isSuperuser : s.stores.some((st) => st.id === storeId);
  if (!allowed) return;
  (await cookies()).set(STORE_COOKIE, storeId, { path: "/", sameSite: "lax", httpOnly: true, maxAge: 60 * 60 * 24 * 365 });
}

export interface SearchHit { kind: string; title: string; href: string }

/** Busca global (RLS aplicado): clientes por nome/telefone, produtos por nome/referência/SKU/EAN, pedidos por número. */
export async function globalSearch(q: string): Promise<SearchHit[]> {
  const term = q.trim().replace(/[%,()"'\\]/g, " ");
  if (term.length < 2) return [];
  const supabase = await createClient();
  const digits = term.replace(/\D/g, "");

  const [parties, contacts, products, variants, orders] = await Promise.all([
    supabase.schema("crm").from("parties").select("id, display_name, city").ilike("display_name", `%${term}%`).limit(5),
    digits.length >= 4
      ? supabase.schema("crm").from("party_contact_points").select("party_id, value_display").ilike("value_normalized", `%${digits}%`).limit(5)
      : Promise.resolve({ data: [] as { party_id: string; value_display: string }[] }),
    supabase.schema("catalog").from("products").select("id, name, reference_code").or(`name.ilike.%${term}%,reference_code.ilike.%${term}%`).limit(5),
    supabase.schema("catalog").from("variants").select("product_id, sku, gtin").or(`sku.ilike.%${term}%,gtin.eq.${digits || "0"}`).limit(5),
    supabase.schema("sales").from("orders").select("id, number, total").ilike("number", `%${term}%`).limit(5),
  ]);

  return [
    ...(parties.data ?? []).map((p) => ({ kind: "Cliente", title: `${p.display_name}${p.city ? ` · ${p.city}` : ""}`, href: `/clientes/${p.id}` })),
    ...(contacts.data ?? []).map((c) => ({ kind: "Contato", title: c.value_display, href: `/clientes/${c.party_id}` })),
    ...(products.data ?? []).map((p) => ({ kind: "Produto", title: `${p.reference_code} · ${p.name}`, href: `/produtos?ref=${p.reference_code}` })),
    ...(variants.data ?? []).map((v) => ({ kind: "SKU", title: v.sku, href: `/produtos/estoque?sku=${v.sku}` })),
    ...(orders.data ?? []).map((o) => ({ kind: "Pedido", title: `${o.number} · R$ ${o.total}`, href: `/vender/pedidos?n=${o.number}` })),
  ].filter((h, i, arr) => arr.findIndex((x) => x.href === h.href) === i);
}
