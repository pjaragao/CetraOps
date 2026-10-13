import { cdnImage } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { chunks, fetchAll } from "@/lib/fetch-all";
import { can, requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { Empty, LinkButton, PageHeader } from "@/components/ui";
import { Flash } from "@/components/form";
import { CatalogTable, type CatalogRow } from "./catalog-table";

export const metadata = { title: "Catálogo" };

export default async function ProdutosPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const session = await requirePerm("catalog.read");
  const supabase = await createClient();
  // filtros que chegam por link (?ref=, ?q=, ?genero=…) só preenchem a barra da lista; quem filtra é a própria lista
  const initial = {
    q: (str(sp.q) ?? str(sp.ref) ?? "").trim(),
    genero: ["FEM", "MASC", "UNISSEX"].includes(str(sp.genero) ?? "") ? str(sp.genero)! : "",
    categoria: str(sp.categoria) ?? "",
    colecao: str(sp.colecao) ?? "",
    estoque: ["com", "sem"].includes(str(sp.estoque) ?? "") ? str(sp.estoque)! : "",
  };

  const [products, { data: cats }, { data: colls }] = await Promise.all([
    fetchAll((a, b) => supabase.schema("catalog").from("products")
      .select("id, reference_code, name, gender, status, ncm, backorder, category_id, collection_id, categories(name), collections(name)")
      .order("name").order("id").range(a, b)),
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
  const rows: CatalogRow[] = products.map((p) => {
    const r = range.get(p.id), s = onSite.get(p.id), img = photo.get(p.id);
    return {
      id: p.id, reference: p.reference_code, name: p.name, gender: p.gender,
      categoryId: p.category_id ?? "", category: p.categories?.name ?? "", collectionId: p.collection_id ?? "", collection: p.collections?.name ?? "",
      colors: colors.get(p.id)?.size ?? 0, variants: nVar.get(p.id) ?? 0, priceMin: r?.[0] ?? null, priceMax: r?.[1] ?? null,
      stock: qty.get(p.id) ?? 0, backorder: p.backorder, site: s ? (s.live ? "live" : "off") : null, ncm: p.ncm, photo: img ? cdnImage(img, 240) : null,
    };
  });

  return (
    <>
      <PageHeader title="Catálogo" description="Modelos com fotos, cores e tamanhos. Os produtos da marca vêm do site oficial (Produtos › Site da marca); peças de outras marcas entram pela planilha."
        actions={<>
          <LinkButton href="/produtos/site">Site da marca</LinkButton>
          {can(session, "catalog.write") && <LinkButton href="/produtos/importar" variant="primary">Importar planilha</LinkButton>}
        </>} />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      {rows.length === 0 ? (
        <Empty title="Nenhum produto">Traga o catálogo do site em Produtos › Site da marca ou importe uma planilha.</Empty>
      ) : (
        <CatalogTable rows={rows} categories={cats ?? []} collections={colls ?? []} initial={initial} canWrite={can(session, "catalog.write")} />
      )}
    </>
  );
}
