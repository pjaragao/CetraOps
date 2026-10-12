import { createClient } from "@/lib/supabase/server";
import { requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { fetchAll } from "@/lib/fetch-all";
import { can } from "@/lib/session";
import { cn, Empty, inputClass, LinkButton, PageHeader, Table } from "@/components/ui";

export const metadata = { title: "Estoque" };

const SIZE_ORDER = ["PP", "P", "M", "G", "GG", "XGG", "U"];

export default async function EstoquePage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const session = await requirePerm("inv.read");
  const supabase = await createClient();
  const q = (str(sp.q) ?? str(sp.sku) ?? "").replace(/[%,()]/g, " ").trim();

  // em páginas (o Supabase Cloud corta em 1.000 linhas por consulta)
  const rows = await fetchAll((a, b) => {
    let query = supabase.schema("inv").from("v_stock_matrix")
      .select("product_id, reference_code, product_name, gender, color, size, sku, on_hand, reserved, available, store_id, location_name, is_sellable, location_kind")
      .order("product_name").order("variant_id").order("location_id").range(a, b);
    if (session.storeId) query = query.eq("store_id", session.storeId);
    if (q) query = query.or(`product_name.ilike.%${q}%,reference_code.ilike.%${q}%,sku.ilike.%${q}%`);
    return query;
  });
  const out = new Map<string, number>();       // peças fora da loja (malinhas e campanhas), por produto+cor
  // Matriz produto+cor × tamanho (só locais vendáveis; malinha e campanha vão para "fora da loja")
  const matrix = new Map<string, { name: string; ref: string; color: string; sizes: Map<string, { on: number; av: number }> }>();
  const sizes = new Set<string>();
  for (const r of rows) {
    const key = `${r.product_id}|${r.color}`;
    if (!r.is_sellable) {
      if ((r.location_kind === "WITH_CUSTOMER" || r.location_kind === "MARKETING") && Number(r.on_hand) > 0) {
        out.set(key, (out.get(key) ?? 0) + Number(r.on_hand));
        if (!matrix.has(key)) matrix.set(key, { name: r.product_name ?? "", ref: r.reference_code ?? "", color: r.color ?? "", sizes: new Map() });
      }
      continue;
    }
    const m = matrix.get(key) ?? { name: r.product_name ?? "", ref: r.reference_code ?? "", color: r.color ?? "", sizes: new Map() };
    const cur = m.sizes.get(r.size ?? "") ?? { on: 0, av: 0 };
    m.sizes.set(r.size ?? "", { on: cur.on + Number(r.on_hand), av: cur.av + Number(r.available) });
    sizes.add(r.size ?? "");
    matrix.set(key, m);
  }
  const cols = [...sizes].sort((a, b) => SIZE_ORDER.indexOf(a) - SIZE_ORDER.indexOf(b));

  return (
    <>
      <PageHeader title="Estoque" description="Disponível para venda por tamanho (em mãos − reservado). Peças em malinha ou em campanha aparecem à parte."
        actions={<>
          {(can(session, "inv.count") || can(session, "inv.write")) && <LinkButton href="/produtos/contagem">Contagem</LinkButton>}
          {can(session, "inv.write") && <LinkButton href="/produtos/estoque/ajuste">Ajuste</LinkButton>}
          <LinkButton href="/produtos/etiquetas">Etiquetas</LinkButton>
        </>} />
      <form className="mb-4"><input name="q" defaultValue={q} placeholder="Produto, referência ou SKU" className={`${inputClass} max-w-sm`} aria-label="Buscar" /></form>
      {matrix.size === 0 ? <Empty title="Sem estoque registrado">O saldo entra pela importação do catálogo com quantidade, pela contagem (Produtos › Contagem) ou pelo recebimento de NF-e.</Empty> : (
        <Table head={["Produto", "Cor", ...cols, "Total", "Fora da loja"]} searchPlaceholder="Filtrar produto, referência ou cor">
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
                    <td className="px-3 py-2 text-right text-muted">{out.get(k) || ""}</td>
                  </tr>
                );
              })}
        </Table>
      )}
    </>
  );
}
