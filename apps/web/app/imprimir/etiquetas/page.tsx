import { code128Svg, formatBRL } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { requirePerm } from "@/lib/session";
import { chunks, fetchAll, inChunks } from "@/lib/fetch-all";
import { str, type SP } from "@/lib/context";
import { PrintBar } from "../print-bar";

export const metadata = { title: "Etiquetas" };

const SIZES = { "40x25": { w: 40, h: 25 }, "50x30": { w: 50, h: 30 }, "60x40": { w: 60, h: 40 } } as const;
type SizeKey = keyof typeof SIZES;
const MAX_LABELS = 2000;

/**
 * Folha de etiquetas para impressora térmica (uma etiqueta por página, no tamanho escolhido) ou A4 (grade).
 * Origem: ?i=variante:qtd,…  |  ?contagem=<id> (quantidades contadas)  |  ?estoque=1 (saldo vendável da loja).
 * O código de barras é o EAN quando existe; senão o SKU em Code 128 (o PDV e a contagem acham pelos dois).
 */
export default async function EtiquetasPrint({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("catalog.read");
  const sp = await searchParams;
  const supabase = await createClient();
  const size: SizeKey = (str(sp.tam) as SizeKey) in SIZES ? (str(sp.tam) as SizeKey) : "40x25";
  const a4 = str(sp.folha) === "a4";
  const showPrice = str(sp.preco) !== "0";

  const want = new Map<string, number>();
  for (const part of (str(sp.i) ?? "").split(",")) {
    const [id, q] = part.split(":");
    if (/^[0-9a-f-]{36}$/i.test(id ?? "")) want.set(id, Math.min(500, Math.max(1, Math.trunc(Number(q) || 1))));
  }
  const contagem = str(sp.contagem);
  if (contagem && /^[0-9a-f-]{36}$/i.test(contagem)) {
    const items = await fetchAll((a, b) => supabase.schema("inv").from("count_items").select("variant_id, counted").eq("count_id", contagem).order("variant_id").range(a, b));
    for (const it of items) if (Number(it.counted) > 0) want.set(it.variant_id, Number(it.counted));
  }
  if (str(sp.estoque) === "1" && session.storeId) {
    const stock = await fetchAll((a, b) => supabase.schema("inv").from("v_stock_matrix").select("variant_id, on_hand").eq("store_id", session.storeId!).eq("is_sellable", true)
      .gt("on_hand", 0).order("variant_id").order("location_id").range(a, b));
    for (const s of stock) if (s.variant_id) want.set(s.variant_id, (want.get(s.variant_id) ?? 0) + Number(s.on_hand));
  }
  const ids = [...want.keys()];
  const variants = ids.length ? (await Promise.all(chunks(ids).map((part) =>
    supabase.schema("catalog").from("variants").select("id, sku, gtin, size, product_id, color_id").in("id", part)))).flatMap((r) => r.data ?? []) : [];
  const pids = [...new Set(variants.map((v) => v.product_id))];
  const [{ data: products }, { data: colors }, prices] = await Promise.all([
    inChunks(pids, (part) => supabase.schema("catalog").from("products").select("id, name, reference_code").in("id", part)).then((data) => ({ data })),
    supabase.schema("catalog").from("colors").select("id, name"),
    // preço vigente da lista padrão (de variante, senão do produto), em lote
    pids.length ? (async () => {
      const { data: pl } = await supabase.schema("catalog").from("price_lists").select("id").eq("is_default", true).maybeSingle();
      if (!pl) return [];
      const vids = variants.map((v) => v.id);
      const [byProd, byVar] = await Promise.all([
        inChunks(pids, (part) => supabase.schema("catalog").from("prices").select("product_id, variant_id, price").eq("price_list_id", pl.id).is("valid_to", null).in("product_id", part)),
        inChunks(vids, (part) => supabase.schema("catalog").from("prices").select("product_id, variant_id, price").eq("price_list_id", pl.id).is("valid_to", null).in("variant_id", part)),
      ]);
      return [...byProd, ...byVar];
    })() : Promise.resolve([] as { product_id: string; variant_id: string | null; price: number }[]),
  ]);
  const pmap = new Map((products ?? []).map((p) => [p.id, p])), cname = new Map((colors ?? []).map((c) => [c.id, c.name]));
  const byVariant = new Map(prices.filter((x) => x.variant_id).map((x) => [x.variant_id as string, Number(x.price)]));
  const byProduct = new Map(prices.filter((x) => !x.variant_id).map((x) => [x.product_id, Number(x.price)]));
  const price = new Map(variants.map((v) => [v.id, byVariant.get(v.id) ?? byProduct.get(v.product_id) ?? null]));

  const labels: { key: string; name: string; detail: string; code: string; svg: string | null; price: number | null }[] = [];
  for (const v of variants.sort((a, b) => (pmap.get(a.product_id)?.name ?? "").localeCompare(pmap.get(b.product_id)?.name ?? "") || a.sku.localeCompare(b.sku))) {
    const code = v.gtin || v.sku;
    let svg: string | null = null;
    try { svg = code128Svg(code, 40); } catch { svg = null; }
    const p = pmap.get(v.product_id);
    for (let n = 0; n < (want.get(v.id) ?? 0) && labels.length < MAX_LABELS; n++) {
      labels.push({ key: `${v.id}-${n}`, name: p?.name ?? "", detail: `${v.color_id ? cname.get(v.color_id) ?? "" : ""} · ${v.size}`, code, svg, price: price.get(v.id) ?? null });
    }
  }
  const { w, h } = SIZES[size];

  return (
    <div className="bg-white text-black">
      <style>{a4
        ? `@page { size: A4; margin: 8mm } .labels { display: grid; grid-template-columns: repeat(auto-fill, ${w}mm); gap: 2mm } .label { width: ${w}mm; height: ${h}mm; border: 0.2mm dashed #bbb }`
        : `@page { size: ${w}mm ${h}mm; margin: 0 } .label { width: ${w}mm; height: ${h}mm; page-break-after: always; break-after: page } @media screen { .labels { display: flex; flex-wrap: wrap; gap: 3mm } .label { border: 0.2mm dashed #bbb } }`}
        {`.label { box-sizing: border-box; padding: 1.2mm 1.6mm; overflow: hidden; display: flex; flex-direction: column; font-family: Arial, sans-serif }
          .label .n { font-size: 7.5pt; font-weight: 700; line-height: 1.1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
          .label .d { font-size: 7pt; line-height: 1.1 }
          .label .b { flex: 1; min-height: 0; margin: 0.6mm 0 } .label .b svg { width: 100%; height: 100% }
          .label .f { display: flex; justify-content: space-between; align-items: baseline; font-size: 6.5pt } .label .f b { font-size: 9pt }`}
      </style>
      <PrintBar count={labels.length} capped={labels.length >= MAX_LABELS} size={size} a4={a4} showPrice={showPrice} sizes={Object.keys(SIZES)} />
      {labels.length === 0 ? <p className="p-6 text-sm">Nenhuma etiqueta: escolha as peças em Produtos › Etiquetas.</p> : (
        <div className="labels p-2 print:p-0">
          {labels.map((l) => (
            <div key={l.key} className="label">
              <div className="n">{l.name}</div>
              <div className="d">{l.detail}</div>
              <div className="b">{l.svg ? <span dangerouslySetInnerHTML={{ __html: l.svg }} /> : null}</div>
              <div className="f"><span>{l.code}</span>{showPrice && l.price != null && <b>{formatBRL(l.price)}</b>}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
