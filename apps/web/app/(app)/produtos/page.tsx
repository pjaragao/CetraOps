import { formatBRL } from "@sie/domain";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { Badge, Empty, inputClass, LinkButton, PageHeader, Table } from "@/components/ui";

export const metadata = { title: "Catálogo" };

export default async function ProdutosPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const session = await requirePerm("catalog.read");
  const supabase = await createClient();
  const q = (str(sp.q) ?? str(sp.ref) ?? "").replace(/[%,()]/g, " ").trim();
  const genero = str(sp.genero);

  let query = supabase.schema("catalog").from("products")
    .select("id, reference_code, name, gender, status, assortment_class, ncm, categories(name), variants(count), prices(price, valid_to)")
    .order("name").limit(300);
  if (q) query = query.or(`name.ilike.%${q}%,reference_code.ilike.%${q}%`);
  if (genero === "FEM" || genero === "MASC" || genero === "UNISSEX") query = query.eq("gender", genero);
  const { data: products } = await query;

  return (
    <>
      <PageHeader title="Catálogo" description="Produtos das linhas feminina e masculina, com grade por cor e tamanho."
        actions={can(session, "catalog.write") ? <LinkButton href="/produtos/importar" variant="primary">Importar planilha</LinkButton> : undefined} />
      <form className="mb-4 flex flex-wrap gap-2">
        <input name="q" defaultValue={q} placeholder="Nome ou referência" className={`${inputClass} max-w-xs`} aria-label="Buscar" />
        <select name="genero" defaultValue={genero ?? ""} className={`${inputClass} max-w-[160px]`} aria-label="Linha">
          <option value="">Todas as linhas</option><option value="FEM">Feminina</option><option value="MASC">Masculina</option><option value="UNISSEX">Unissex</option>
        </select>
        <button className="rounded-lg border border-border px-3 text-sm">Filtrar</button>
      </form>
      {(products ?? []).length === 0 ? (
        <Empty title="Catálogo vazio">Importe a planilha do catálogo real em Produtos › Importar catálogo.</Empty>
      ) : (
        <Table head={["Referência", "Produto", "Linha", "Categoria", "Variantes", "Preço", "NCM", "Status"]}>
          {(products ?? []).map((p) => {
            const price = (p.prices ?? []).find((x) => x.valid_to === null)?.price;
            return (
              <tr key={p.id}>
                <td className="px-3 py-2 font-mono text-xs">{p.reference_code}</td>
                <td className="px-3 py-2 font-medium">{p.name}</td>
                <td className="px-3 py-2"><Badge tone={p.gender === "MASC" ? "info" : "brand"}>{p.gender}</Badge></td>
                <td className="px-3 py-2">{p.categories?.name ?? "—"}</td>
                <td className="px-3 py-2">{p.variants?.[0]?.count ?? 0}</td>
                <td className="px-3 py-2">{price !== undefined ? formatBRL(price) : <span className="text-danger">sem preço</span>}</td>
                <td className="px-3 py-2">{p.ncm ?? <span className="text-warning">faltando</span>}</td>
                <td className="px-3 py-2"><Badge tone={p.status === "ACTIVE" ? "success" : "neutral"}>{p.status}</Badge></td>
              </tr>
            );
          })}
        </Table>
      )}
    </>
  );
}
