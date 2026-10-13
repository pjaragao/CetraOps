import Image from "next/image";
import Link from "next/link";
import { cdnImage, formatBRL } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { chunks, fetchAll } from "@/lib/fetch-all";
import { can, requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { Badge, Button, Empty, inputClass, LinkButton, PageHeader, Table } from "@/components/ui";
import { Flash } from "@/components/form";
import { setBackorderAction } from "../vender/encomendas/actions";

export const metadata = { title: "Catálogo" };

const GENDER: Record<string, string> = { FEM: "Feminina", MASC: "Masculina", UNISSEX: "Unissex" };

export default async function ProdutosPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const session = await requirePerm("catalog.read");
  const supabase = await createClient();
  const q = (str(sp.q) ?? str(sp.ref) ?? "").replace(/[%,()]/g, " ").trim();
  const genero = str(sp.genero);
  const categoria = str(sp.categoria);
  const colecao = str(sp.colecao);
  const estoque = str(sp.estoque);

  const [products, { data: cats }, { data: colls }] = await Promise.all([
    fetchAll((a, b) => {
      let query = supabase.schema("catalog").from("products")
        .select("id, reference_code, name, gender, status, ncm, backorder, category_id, collection_id, categories(name), collections(name)")
        .order("name").order("id").range(a, b);
      if (q) query = query.or(`name.ilike.%${q}%,reference_code.ilike.%${q}%`);
      if (genero === "FEM" || genero === "MASC" || genero === "UNISSEX") query = query.eq("gender", genero);
      if (categoria) query = query.eq("category_id", categoria);
      if (colecao) query = query.eq("collection_id", colecao);
      return query;
    }),
    supabase.schema("catalog").from("categories").select("id, name").order("name"),
    supabase.schema("catalog").from("collections").select("id, name").order("name"),
  ]);
  const ids = products.map((p) => p.id);
  const idChunks = chunks(ids);
  const [variants, media, prices, site, stock] = await Promise.all([
    Promise.all(idChunks.map((c) => fetchAll((a, b) => supabase.schema("catalog").from("variants").select("id, product_id, color_id").in("product_id", c).order("id").range(a, b)))).then((r) => r.flat()),
    Promise.all(idChunks.map((c) => fetchAll((a, b) => supabase.schema("catalog").from("product_media").select("product_id, storage_path, position").in("product_id", c).order("position").order("id").range(a, b)))).then((r) => r.flat()),
    fetchAll((a, b) => supabase.schema("catalog").from("prices").select("product_id, variant_id, price").is("valid_to", null).order("id").range(a, b)),
    Promise.all(idChunks.map((c) => supabase.schema("catalog").from("site_items").select("product_id, url, available, removed_at").in("product_id", c))).then((r) => r.flatMap((x) => x.data ?? [])),
    fetchAll((a, b) => supabase.schema("inv").from("v_stock_matrix").select("product_id, available").eq("is_sellable", true).order("variant_id").order("location_id").range(a, b)),
  ]);

  const varOf = new Map(variants.map((v) => [v.id, v.product_id]));
  const colors = new Map<string, Set<string>>(), nVar = new Map<string, number>();
  for (const v of variants) { nVar.set(v.product_id, (nVar.get(v.product_id) ?? 0) + 1); if (v.color_id) (colors.get(v.product_id) ?? colors.set(v.product_id, new Set()).get(v.product_id)!).add(v.color_id); }
  const photo = new Map<string, string>();
  for (const m of media) if (!photo.has(m.product_id) && m.storage_path.startsWith("http")) photo.set(m.product_id, m.storage_path);
  const range = new Map<string, [number, number]>();
  for (const p of prices) {
    const pid = p.product_id ?? (p.variant_id ? varOf.get(p.variant_id) : undefined);
    if (!pid) continue;
    const r = range.get(pid), v = Number(p.price);
    range.set(pid, r ? [Math.min(r[0], v), Math.max(r[1], v)] : [v, v]);
  }
  const onSite = new Map<string, { url: string; live: boolean }>();
  for (const s of site) if (s.product_id) { const cur = onSite.get(s.product_id); if (!cur || (!cur.live && !s.removed_at)) onSite.set(s.product_id, { url: s.url ?? "", live: !s.removed_at && s.available }); }
  const qty = new Map<string, number>();
  for (const s of stock) if (s.product_id) qty.set(s.product_id, (qty.get(s.product_id) ?? 0) + Number(s.available));
  const rows = products.filter((p) => estoque === "com" ? (qty.get(p.id) ?? 0) > 0 : estoque === "sem" ? (qty.get(p.id) ?? 0) <= 0 : true);

  return (
    <>
      <PageHeader title="Catálogo" description="Modelos com fotos, cores e tamanhos. Os produtos da marca vêm do site oficial (Produtos › Site da marca); peças de outras marcas entram pela planilha."
        actions={<>
          <LinkButton href="/produtos/site">Site da marca</LinkButton>
          {can(session, "catalog.write") && <LinkButton href="/produtos/importar" variant="primary">Importar planilha</LinkButton>}
        </>} />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      <form className="mb-4 flex flex-wrap gap-2">
        <input name="q" defaultValue={q} placeholder="Nome ou referência" className={`${inputClass} max-w-xs`} aria-label="Buscar" />
        <select name="genero" defaultValue={genero ?? ""} className={`${inputClass} max-w-[160px]`} aria-label="Linha">
          <option value="">Todas as linhas</option><option value="FEM">Feminina</option><option value="MASC">Masculina</option><option value="UNISSEX">Unissex</option>
        </select>
        <select name="categoria" defaultValue={categoria ?? ""} className={`${inputClass} max-w-[180px]`} aria-label="Categoria">
          <option value="">Todas as categorias</option>{(cats ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select name="colecao" defaultValue={colecao ?? ""} className={`${inputClass} max-w-[180px]`} aria-label="Coleção">
          <option value="">Todas as coleções</option>{(colls ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select name="estoque" defaultValue={estoque ?? ""} className={`${inputClass} max-w-[170px]`} aria-label="Estoque">
          <option value="">Com e sem estoque</option><option value="com">Com estoque</option><option value="sem">Sem estoque</option>
        </select>
        <button className="rounded-lg border border-border px-3 text-sm">Filtrar</button>
      </form>
      {rows.length === 0 ? (
        <Empty title="Nenhum produto">Traga o catálogo do site em Produtos › Site da marca ou importe uma planilha.</Empty>
      ) : (
        <>
        {can(session, "catalog.write") && (
          <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted">Encomenda nos {rows.length} produto(s) listados:</span>
            {(["1", "0"] as const).map((en) => (
              <form key={en} action={setBackorderAction}><input type="hidden" name="product_ids" value={rows.map((r) => r.id).join(",")} /><input type="hidden" name="enabled" value={en} />
                <input type="hidden" name="back" value={`/produtos?${new URLSearchParams(Object.entries({ q, genero, categoria, colecao, estoque }).filter((e): e is [string, string] => Boolean(e[1]))).toString()}`} />
                <Button variant="secondary" className="px-2 py-1 text-xs">{en === "1" ? "liberar" : "desligar"}</Button></form>
            ))}
          </div>
        )}
        <Table head={["", "Referência", "Produto", "Linha", "Categoria", "Coleção", "Cores", "Variantes", "Preço", "Estoque", "Encomenda", "Site", "NCM"]} noSort={[0]}>
          {rows.map((p) => {
            const r = range.get(p.id), s = onSite.get(p.id), img = photo.get(p.id);
            return (
              <tr key={p.id}>
                <td className="px-3 py-1.5">{img ? <Image src={cdnImage(img, 120)} alt="" width={40} height={52} unoptimized className="h-13 w-10 rounded object-cover" /> : <span className="block h-13 w-10 rounded bg-surface-2" />}</td>
                <td className="px-3 py-2 font-mono text-xs">{p.reference_code}</td>
                <td className="px-3 py-2 font-medium"><Link href={`/produtos/${p.id}`} className="hover:underline">{p.name}</Link></td>
                <td className="px-3 py-2">{GENDER[p.gender] ?? p.gender}</td>
                <td className="px-3 py-2">{p.categories?.name ?? "—"}</td>
                <td className="px-3 py-2">{p.collections?.name ?? "—"}</td>
                <td className="px-3 py-2 tabular-nums">{colors.get(p.id)?.size ?? 0}</td>
                <td className="px-3 py-2 tabular-nums">{nVar.get(p.id) ?? 0}</td>
                <td className="px-3 py-2 whitespace-nowrap" data-sort={r?.[0] ?? -1}>{r ? (r[0] === r[1] ? formatBRL(r[0]) : `${formatBRL(r[0])} – ${formatBRL(r[1])}`) : <span className="text-danger">sem preço</span>}</td>
                <td className="px-3 py-2 tabular-nums">{qty.get(p.id) ?? 0}</td>
                <td className="px-3 py-2">{p.backorder ? <Badge tone="success">aceita</Badge> : <span className="text-muted">não</span>}</td>
                <td className="px-3 py-2">{s ? (s.live ? <Badge tone="success">no site</Badge> : <Badge tone="neutral">fora do site</Badge>) : "—"}</td>
                <td className="px-3 py-2">{p.ncm ?? <span className="text-warning">faltando</span>}</td>
              </tr>
            );
          })}
        </Table>
        </>
      )}
    </>
  );
}
