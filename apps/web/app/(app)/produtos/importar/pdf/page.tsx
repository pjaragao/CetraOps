import { createClient } from "@/lib/supabase/server";
import { requirePerm } from "@/lib/session";
import { fetchAll } from "@/lib/fetch-all";
import { LinkButton, PageHeader } from "@/components/ui";
import { CatalogPdfImport } from "./catalog-pdf";

export const metadata = { title: "Catálogo da marca (PDF)" };

export default async function CatalogoPdfPage() {
  await requirePerm("catalog.write");
  const supabase = await createClient();
  const [products, { data: colors }, variants, media] = await Promise.all([
    fetchAll<{ id: string; reference_code: string; name: string; gender: string }>((a, b) => supabase.schema("catalog").from("products").select("id, reference_code, name, gender").order("reference_code").range(a, b)),
    supabase.schema("catalog").from("colors").select("id, name, code").order("name"),
    fetchAll<{ product_id: string; color_id: string | null }>((a, b) => supabase.schema("catalog").from("variants").select("product_id, color_id").eq("active", true).order("id").range(a, b)),
    fetchAll<{ product_id: string; color_id: string | null }>((a, b) => supabase.schema("catalog").from("product_media").select("product_id, color_id").order("id").range(a, b)),
  ]);
  const pairs = (rows: { product_id: string; color_id: string | null }[]) => [...new Set(rows.flatMap((r) => (r.color_id ? [`${r.product_id}|${r.color_id}`] : [])))];
  return (
    <>
      <PageHeader title="Catálogo da marca (PDF)" description="Envie o catálogo de atacado que a marca manda em PDF: cada página de produto vira modelo × cor com grade, composição, preço de atacado e fotos. O site continua sendo a fonte de textos e preços de venda; o PDF completa o que falta."
        actions={<LinkButton href="/produtos/importar">Voltar</LinkButton>} />
      <CatalogPdfImport products={products} colors={colors ?? []} variantPairs={pairs(variants)} mediaPairs={pairs(media)} />
    </>
  );
}
