import { createClient } from "@/lib/supabase/server";
import { requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { cn, Empty, inputClass, PageHeader } from "@/components/ui";

export const metadata = { title: "Estoque" };

const SIZE_ORDER = ["PP", "P", "M", "G", "GG", "XGG", "U"];

export default async function EstoquePage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const session = await requirePerm("inv.read");
  const supabase = await createClient();
  const q = (str(sp.q) ?? str(sp.sku) ?? "").replace(/[%,()]/g, " ").trim();

  let query = supabase.schema("inv").from("v_stock_matrix")
    .select("product_id, reference_code, product_name, gender, color, size, sku, on_hand, reserved, available, store_id, location_name")
    .order("product_name").limit(2000);
  if (session.storeId) query = query.eq("store_id", session.storeId);
  if (q) query = query.or(`product_name.ilike.%${q}%,reference_code.ilike.%${q}%,sku.ilike.%${q}%`);
  const { data: rows } = await query;

  // Matriz produto+cor × tamanho (soma dos locais vendáveis e não vendáveis da loja)
  const matrix = new Map<string, { name: string; ref: string; color: string; sizes: Map<string, { on: number; av: number }> }>();
  const sizes = new Set<string>();
  for (const r of rows ?? []) {
    const key = `${r.product_id}|${r.color}`;
    const m = matrix.get(key) ?? { name: r.product_name ?? "", ref: r.reference_code ?? "", color: r.color ?? "", sizes: new Map() };
    const cur = m.sizes.get(r.size ?? "") ?? { on: 0, av: 0 };
    m.sizes.set(r.size ?? "", { on: cur.on + Number(r.on_hand), av: cur.av + Number(r.available) });
    sizes.add(r.size ?? "");
    matrix.set(key, m);
  }
  const cols = [...sizes].sort((a, b) => SIZE_ORDER.indexOf(a) - SIZE_ORDER.indexOf(b));

  return (
    <>
      <PageHeader title="Estoque" description="Disponível por tamanho (em mãos − reservado). Saldo = soma do livro-razão de movimentos." />
      <form className="mb-4"><input name="q" defaultValue={q} placeholder="Produto, referência ou SKU" className={`${inputClass} max-w-sm`} aria-label="Buscar" /></form>
      {matrix.size === 0 ? <Empty title="Sem estoque registrado">O saldo entra pelo recebimento de NF-e ou pela contagem inicial.</Empty> : (
        <div className="overflow-x-auto rounded-xl border border-border bg-surface">
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-xs text-muted">
              <tr><th className="px-3 py-2 text-left">Produto</th><th className="px-3 py-2 text-left">Cor</th>{cols.map((c) => <th key={c} className="px-3 py-2 text-center">{c}</th>)}<th className="px-3 py-2 text-right">Total</th></tr>
            </thead>
            <tbody className="divide-y divide-border">
              {[...matrix.entries()].map(([k, m]) => {
                const total = [...m.sizes.values()].reduce((a, s) => a + s.av, 0);
                return (
                  <tr key={k}>
                    <td className="px-3 py-2"><span className="font-medium">{m.name}</span> <span className="text-xs text-muted">{m.ref}</span></td>
                    <td className="px-3 py-2">{m.color}</td>
                    {cols.map((c) => {
                      const s = m.sizes.get(c);
                      return (
                        <td key={c} className={cn("px-3 py-2 text-center font-medium", !s ? "text-muted/40" : s.av <= 0 ? "bg-danger/10 text-danger" : s.av <= 1 ? "bg-warning/10 text-warning" : "")}
                          title={s ? `em mãos ${s.on} · disponível ${s.av}` : undefined}>
                          {s ? s.av : "—"}
                        </td>
                      );
                    })}
                    <td className="px-3 py-2 text-right font-semibold">{total}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
