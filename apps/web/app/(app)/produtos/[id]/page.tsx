import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { formatBRL, sanitizeHtml } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { Flash } from "@/components/form";
import { setBackorderAction } from "../../vender/encomendas/actions";
import { str, type SP } from "@/lib/context";
import { Badge, Button, Card, cn, LinkButton, PageHeader, Table } from "@/components/ui";
import { photoUrl } from "@/lib/photos";

export const metadata = { title: "Produto" };

const SIZE_ORDER = ["PP", "P", "M", "G", "GG", "XG", "XGG", "U", "UN"];

/** Ficha do produto: fotos por cor, textos, guia de tamanho, variantes (preço, estoque, situação no site) e histórico de preço. */
export default async function ProdutoPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SP }) {
  const session = await requirePerm("catalog.read");
  const { id } = await params;
  const sp = await searchParams;
  const supabase = await createClient();
  const { data: p } = await supabase.schema("catalog").from("products")
    .select("id, reference_code, name, description, composition, care, gender, status, ncm, custom_fields, size_chart_id, backorder, brands(name), categories(name), collections(name)")
    .eq("id", id).maybeSingle();
  if (!p) notFound();
  const [{ data: variants }, { data: media }, { data: site }, { data: chart }, { data: changes }] = await Promise.all([
    supabase.schema("catalog").from("variants").select("id, sku, size, color_id, gtin, active").eq("product_id", id),
    supabase.schema("catalog").from("product_media").select("color_id, storage_path, position").eq("product_id", id).order("position"),
    supabase.schema("catalog").from("site_items").select("color_id, url, available, removed_at, compare_at_price, tags, collections").eq("product_id", id),
    p.size_chart_id ? supabase.schema("catalog").from("size_charts").select("name, measurements").eq("id", p.size_chart_id).maybeSingle() : Promise.resolve({ data: null }),
    supabase.schema("catalog").from("price_changes").select("variant_id, old_price, new_price, changed_at, in_stock").eq("product_id", id).order("changed_at", { ascending: false }).limit(50),
  ]);
  const vids = (variants ?? []).map((v) => v.id);
  const [{ data: colors }, { data: stock }, prices] = await Promise.all([
    supabase.schema("catalog").from("colors").select("id, name, code").in("id", [...new Set((variants ?? []).map((v) => v.color_id).filter(Boolean) as string[])].concat(["00000000-0000-0000-0000-000000000000"])),
    vids.length ? supabase.schema("inv").from("v_stock_matrix").select("variant_id, available, is_sellable").in("variant_id", vids) : Promise.resolve({ data: [] as { variant_id: string | null; available: number | null; is_sellable: boolean | null }[] }),
    Promise.all(vids.map(async (v) => [v, (await supabase.schema("catalog").rpc("current_price", { p_variant: v })).data as number | null] as const)),
  ]);
  const cname = new Map((colors ?? []).map((c) => [c.id, c.name]));
  const price = new Map(prices);
  const avail = new Map<string, number>(), out = new Map<string, number>();
  for (const s of stock ?? []) if (s.variant_id) (s.is_sellable ? avail : out).set(s.variant_id, ((s.is_sellable ? avail : out).get(s.variant_id) ?? 0) + Number(s.available));
  const colorIds = [...new Set((variants ?? []).map((v) => v.color_id ?? ""))].filter(Boolean).sort((a, b) => (cname.get(a) ?? "").localeCompare(cname.get(b) ?? ""));
  const selColor = colorIds.includes(str(sp.cor) ?? "") ? str(sp.cor)! : colorIds.find((c) => (media ?? []).some((m) => m.color_id === c)) ?? colorIds[0];
  const photos = (media ?? []).filter((m) => m.color_id === selColor);
  const siteColor = (site ?? []).find((s) => s.color_id === selColor);
  const fit = (p.custom_fields as { site?: { fit?: string } } | null)?.site?.fit;
  const chartHtml = (chart?.measurements as { html?: string } | null)?.html;
  const sorted = [...(variants ?? [])].sort((a, b) => (cname.get(a.color_id ?? "") ?? "").localeCompare(cname.get(b.color_id ?? "") ?? "") || SIZE_ORDER.indexOf(a.size) - SIZE_ORDER.indexOf(b.size));
  const sku = new Map((variants ?? []).map((v) => [v.id, v.sku]));

  return (
    <>
      <PageHeader title={p.name} description={[p.reference_code, p.brands?.name, p.categories?.name, p.collections?.name, p.gender === "MASC" ? "Masculino" : p.gender === "FEM" ? "Feminino" : p.gender].filter(Boolean).join(" · ")}
        actions={<>
          {siteColor?.url && <a href={siteColor.url} target="_blank" rel="noreferrer" className="inline-flex items-center rounded-lg border border-border bg-surface px-3 py-2 text-sm font-medium hover:bg-surface-2">Ver no site</a>}
          <LinkButton href={`/imprimir/etiquetas?i=${sorted.map((v) => `${v.id}:1`).join(",")}`}>Etiquetas</LinkButton>
          <LinkButton href="/produtos">Catálogo</LinkButton>
        </>} />

      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3 text-sm">
        <span>Encomenda: {p.backorder ? <Badge tone="success">aceita encomenda</Badge> : <Badge tone="neutral">não aceita</Badge>}</span>
        <span className="text-xs text-muted">Com encomenda liberada, a cliente pode pedir cor e tamanho que não estão na loja (Vender › Encomendas).</span>
        {can(session, "catalog.write") && (
          <form action={setBackorderAction} className="ml-auto"><input type="hidden" name="product_ids" value={p.id} /><input type="hidden" name="enabled" value={p.backorder ? "0" : "1"} /><input type="hidden" name="back" value={`/produtos/${p.id}`} />
            <Button variant="secondary">{p.backorder ? "Desligar encomenda" : "Liberar encomenda"}</Button></form>
        )}
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card>
          <div className="mb-3 flex flex-wrap gap-2">
            {colorIds.map((c) => (
              <Link key={c} href={`/produtos/${p.id}?cor=${c}`} className={cn("rounded-full border px-3 py-1 text-xs", c === selColor ? "border-brand bg-brand/10 text-brand" : "border-border")}>
                {cname.get(c) ?? "—"}
              </Link>
            ))}
          </div>
          {photos.length === 0 ? <p className="text-sm text-muted">Sem fotos desta cor.</p> : (
            <div className="grid grid-cards gap-2 [--card-min:11rem]">
              {photos.map((m) => (
                <a key={m.storage_path} href={photoUrl(m.storage_path)} target="_blank" rel="noreferrer">
                  <Image src={photoUrl(m.storage_path, 500)} alt={`${p.name} ${cname.get(selColor ?? "") ?? ""}`} width={250} height={333} unoptimized className="aspect-[3/4] w-full rounded-lg object-cover" />
                </a>
              ))}
            </div>
          )}
          {siteColor && (
            <p className="mt-3 text-xs text-muted">
              No site: {siteColor.removed_at ? "fora do site" : siteColor.available ? "à venda" : "esgotado"}
              {siteColor.compare_at_price ? ` · de ${formatBRL(siteColor.compare_at_price)}` : ""}
              {siteColor.tags?.length ? ` · ${siteColor.tags.join(", ")}` : ""}
            </p>
          )}
        </Card>

        <div className="space-y-4">
          <Card title="Descrição">
            <p className="whitespace-pre-line text-sm">{p.description ?? <span className="text-muted">—</span>}</p>
            <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
              <div><dt className="text-xs text-muted">Composição</dt><dd>{p.composition ?? "—"}</dd></div>
              <div><dt className="text-xs text-muted">Cuidados</dt><dd>{p.care ?? "—"}</dd></div>
              {fit && <div><dt className="text-xs text-muted">Modelagem</dt><dd>{fit}</dd></div>}
              <div><dt className="text-xs text-muted">NCM</dt><dd>{p.ncm ?? <span className="text-warning">faltando (cadastre para a NFC-e)</span>}</dd></div>
            </dl>
          </Card>
          {chartHtml && (
            <Card title={`Guia de tamanho · ${(chart?.name ?? "").replace(/^Site: /, "")}`}>
              {/* tabela vinda do site da marca, limpa (só texto e tabela) antes de exibir */}
              <div className="size-chart overflow-x-auto text-sm [&_table]:w-full [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-border [&_th]:px-2 [&_p]:mb-1"
                dangerouslySetInnerHTML={{ __html: sanitizeHtml(chartHtml) }} />
            </Card>
          )}
        </div>
      </div>

      <h2 className="mb-2 mt-6 text-sm font-semibold text-muted">Variantes</h2>
      <Table head={["Cor", "Tamanho", "SKU", "EAN", "Preço", "Disponível na loja", "Fora da loja"]}>
        {sorted.map((v) => (
          <tr key={v.id} className={v.active ? "" : "opacity-50"}>
            <td className="px-3 py-2">{cname.get(v.color_id ?? "") ?? "—"}</td>
            <td className="px-3 py-2">{v.size}</td>
            <td className="px-3 py-2 font-mono text-xs">{v.sku}</td>
            <td className="px-3 py-2 font-mono text-xs">{v.gtin ?? "—"}</td>
            <td className="px-3 py-2">{price.get(v.id) != null ? formatBRL(price.get(v.id)!) : <span className="text-danger">sem preço</span>}</td>
            <td className="px-3 py-2 tabular-nums">{avail.get(v.id) ?? 0}</td>
            <td className="px-3 py-2 tabular-nums">{out.get(v.id) || ""}</td>
          </tr>
        ))}
      </Table>

      {(changes ?? []).length > 0 && (
        <>
          <h2 className="mb-2 mt-6 text-sm font-semibold text-muted">Mudanças de preço no site</h2>
          <Table head={["Data", "SKU", "Antes", "Agora", "Em estoque"]}>
            {(changes ?? []).map((c, i) => (
              <tr key={i}>
                <td className="px-3 py-2 whitespace-nowrap">{new Date(c.changed_at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" })}</td>
                <td className="px-3 py-2 font-mono text-xs">{c.variant_id ? sku.get(c.variant_id) : "—"}</td>
                <td className="px-3 py-2">{c.old_price != null ? formatBRL(c.old_price) : "—"}</td>
                <td className="px-3 py-2 font-medium">{formatBRL(c.new_price)} {c.old_price != null && <Badge tone={c.new_price > c.old_price ? "warning" : "success"}>{c.new_price > c.old_price ? "subiu" : "baixou"}</Badge>}</td>
                <td className="px-3 py-2 tabular-nums">{Number(c.in_stock)}</td>
              </tr>
            ))}
          </Table>
        </>
      )}
    </>
  );
}
