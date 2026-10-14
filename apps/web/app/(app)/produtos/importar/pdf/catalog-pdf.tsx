"use client";
import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { formatBRL, groupCatalogEntries, parseBRNumber, parseCatalogPage, parseCatalogPdf, sameName, suggestPrice, type CatalogPdfEntry } from "@centralops/domain";
import { readPdf, type PdfPhoto } from "@/lib/pdf-reader";
import { Badge, Button, Card, inputClass } from "@/components/ui";
import { addCatalogPhotos, applyCatalogGroup } from "./actions";

interface Product { id: string; reference_code: string; name: string; gender: string }
interface Color { id: string; name: string; code: string | null }
type Gender = "FEM" | "MASC" | "UNISSEX";
interface Row {
  key: string; entry: CatalogPdfEntry & { pages: number[] }; include: boolean;
  product: string; newRef: string; newName: string; gender: Gender;          // product: id ou "NEW"
  color: string; newColor: string; newCode: string;                          // color: id ou "NEW"
  photos: PdfPhoto[]; photoOn: string[];
  status?: { tone: "success" | "danger" | "info"; text: string; productId?: string };
}

/** Catálogo de atacado em PDF → modelo × cor (produto e cor escolhidos ou novos) → variações da grade, atacado, composição e fotos. */
export function CatalogPdfImport({ products, colors, variantPairs, mediaPairs }: { products: Product[]; colors: Color[]; variantPairs: string[]; mediaPairs: string[] }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [backorder, setBackorder] = useState(false);
  const [markup, setMarkup] = useState("2,40");
  const [pending, start] = useTransition();
  const pairs = useMemo(() => new Set(variantPairs), [variantPairs]);
  const withPhotos = useMemo(() => new Set(mediaPairs), [mediaPairs]);
  const colorsOf = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const p of variantPairs) { const [pid, cid] = p.split("|"); if (!m.has(pid)) m.set(pid, new Set()); m.get(pid)!.add(cid); }
    return m;
  }, [variantPairs]);

  const matchColor = (productId: string, name: string) => {
    const cands = colors.filter((c) => sameName(c.name, name));
    return cands.find((c) => pairs.has(`${productId}|${c.id}`)) ?? cands[0];
  };

  const onFile = (f: File | undefined) => {
    if (!f) return;
    setRows([]); setError(null); setFileName(f.name);
    start(async () => {
      try {
        setProgress("Lendo o PDF…");
        const { pages, photos } = await readPdf(f, {
          photos: (n, text) => parseCatalogPage(text, n) !== null,
          onProgress: (d, t) => setProgress(`Lendo página ${d} de ${t}…`),
          onPhotos: (d, t) => setProgress(`Separando as fotos da página ${d} de ${t}…`),
        });
        setProgress(null);
        const groups = groupCatalogEntries(parseCatalogPdf(pages));
        if (!groups.length) { setError("Nenhuma página de produto encontrada. Cada página precisa trazer o nome, a cor e o preço (R$) como texto — PDF só de imagens não dá para ler."); return; }
        setRows(groups.map((e) => {
          const cands = products.filter((p) => sameName(p.name, e.name));
          const prod = cands.find((p) => colors.some((c) => sameName(c.name, e.color) && pairs.has(`${p.id}|${c.id}`)))
            ?? [...cands].sort((a, b) => b.reference_code.localeCompare(a.reference_code))[0];
          const color = prod ? matchColor(prod.id, e.color) : colors.find((c) => sameName(c.name, e.color));
          const seen = new Set<string>();
          const ph = photos.filter((p) => e.pages.includes(p.page) && !seen.has(p.hash) && seen.add(p.hash));
          const hasPhotos = prod && color ? withPhotos.has(`${prod.id}|${color.id}`) : false;
          return {
            key: `${e.name}|${e.color}`, entry: e, include: true,
            product: prod?.id ?? "NEW", newRef: "", newName: e.name, gender: "FEM",
            color: color?.id ?? "NEW", newColor: e.color, newCode: "",
            photos: ph, photoOn: hasPhotos ? [] : ph.map((p) => p.hash),
          };
        }));
      } catch (e) {
        setProgress(null);
        setError(`Não foi possível ler o PDF: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  };

  const set = (key: string, patch: Partial<Row>) => setRows((p) => p.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const chosen = rows.filter((r) => r.include && !r.status?.productId);
  const invalid = (r: Row) => (r.product === "NEW" && (!r.newRef.trim() || r.newName.trim().length < 2)) || (r.color === "NEW" && !r.newColor.trim()) || r.entry.sizes.length === 0;

  const run = () => start(async () => {
    const m = parseBRNumber(markup) ?? 0;
    for (const r of chosen) {
      if (invalid(r)) { set(r.key, { status: { tone: "danger", text: "Complete produto, cor e grade" } }); continue; }
      set(r.key, { status: { tone: "info", text: "Gravando…" } });
      const res = await applyCatalogGroup({
        product: r.product === "NEW" ? { reference: r.newRef, name: r.newName, gender: r.gender } : { id: r.product },
        color: r.color === "NEW" ? { name: r.newColor, code: r.newCode } : { id: r.color },
        sizes: r.entry.sizes, composition: r.entry.composition, wholesale_cost: r.entry.price,
        price: r.entry.price && m > 0 ? suggestPrice(r.entry.price, m) : null, backorder,
        document: `${fileName} · pág. ${r.entry.pages.join(", ")}`,
      });
      if (!res.ok) { set(r.key, { status: { tone: "danger", text: res.error } }); continue; }
      let text = `${res.created} variação(ões) nova(s)`;
      const pics = r.photos.filter((p) => r.photoOn.includes(p.hash));
      if (pics.length) {
        set(r.key, { status: { tone: "info", text: `${text} · enviando ${pics.length} foto(s)…` } });
        const fd = new FormData();
        fd.set("product_id", res.product_id); fd.set("color_id", res.color_id); fd.set("document", `${fileName} · pág. ${r.entry.pages.join(", ")}`);
        for (const p of pics) { fd.append("file", new File([p.blob], `${p.hash}.jpg`, { type: "image/jpeg" })); fd.append("hash", p.hash); }
        const up = await addCatalogPhotos(fd);
        text += up.ok ? ` · ${up.added} foto(s)` : ` · fotos: ${up.error}`;
      }
      if (res.errors.length) text += ` · ${res.errors.join("; ")}`;
      set(r.key, { status: { tone: res.errors.length ? "danger" : "success", text, productId: res.product_id } });
    }
  });

  const done = rows.filter((r) => r.status?.productId).length;

  return (
    <div className="space-y-4">
      <Card title="1. Arquivo do catálogo">
        <input type="file" accept="application/pdf,.pdf" disabled={pending} onChange={(e) => onFile(e.target.files?.[0])} className="text-sm" aria-label="PDF do catálogo" />
        <p className="mt-2 text-xs text-muted">O PDF é lido aqui no navegador (só as fotos escolhidas sobem). Cada página de produto precisa trazer em texto o nome, a composição (%),
          a grade (PP // P // M // G), a cor e o preço de atacado (R$). Capas e páginas só de foto ficam de fora.</p>
        {progress && <p className="mt-2 text-sm text-muted">{progress}</p>}
        {error && <p role="alert" className="mt-2 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
      </Card>

      {rows.length > 0 && (
        <Card title={`2. Conferência · ${rows.length} modelo(s) × cor`}
          action={<Button disabled={pending || chosen.length === 0} onClick={run}>{pending ? "Gravando…" : `Gravar ${chosen.length} no catálogo`}</Button>}>
          <div className="mb-3 flex flex-wrap items-end gap-4 text-sm">
            <label className="flex items-center gap-2"><input type="checkbox" checked={backorder} onChange={(e) => setBackorder(e.target.checked)} />
              Liberar para encomenda (a vendedora pode vender sem estoque; a peça entra no pedido de compra pelo preço de atacado)</label>
            <label className="text-xs text-muted">Markup do preço de venda (só para produto ainda sem preço)
              <input value={markup} onChange={(e) => setMarkup(e.target.value)} className={`${inputClass} mt-1 w-24`} /></label>
            {done > 0 && <span className="text-success">{done} gravado(s)</span>}
          </div>
          <p className="mb-3 text-xs text-muted">O nome do PDF é ligado ao produto de mesmo nome e a cor ao cadastro de cores. O catálogo não traz código: confira as cores com outro nome
            (ex.: «Vermelho» no PDF pode ser «Wine» no site) e, em cor nova, informe o código da marca (3 dígitos da etiqueta) para o SKU bater com a etiqueta.
            Importar antes o pedido em PDF já cadastra as cores com o código.</p>
          <div className="space-y-3">
            {rows.map((r) => {
              const own = r.product !== "NEW" ? colorsOf.get(r.product) ?? new Set<string>() : new Set<string>();
              return (
                <div key={r.key} className={`rounded-xl border border-border p-3 ${r.include ? "" : "opacity-60"}`}>
                  <div className="flex flex-wrap items-start gap-3">
                    <label className="flex items-center gap-2 pt-2"><input type="checkbox" checked={r.include} onChange={(e) => set(r.key, { include: e.target.checked })} aria-label={`Importar ${r.key}`} /></label>
                    <div className="min-w-48 flex-1">
                      <p className="font-medium">{r.entry.name} · {r.entry.color}</p>
                      <p className="text-xs text-muted">pág. {r.entry.pages.join(", ")} · {r.entry.sizes.join(" ") || "sem grade"} · {r.entry.composition ?? "sem composição"} · atacado {r.entry.price ? formatBRL(r.entry.price) : "—"}</p>
                      {r.status && <p className="mt-1"><Badge tone={r.status.tone}>{r.status.text}</Badge>{r.status.productId && <Link className="ml-2 text-xs text-brand" href={`/produtos/${r.status.productId}`}>ver produto</Link>}</p>}
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <select value={r.product} onChange={(e) => { const pid = e.target.value; const c = pid !== "NEW" ? matchColor(pid, r.entry.color) : undefined; set(r.key, { product: pid, ...(c ? { color: c.id } : {}) }); }}
                        className={inputClass} aria-label="Produto">
                        <option value="NEW">+ Produto novo</option>
                        {products.filter((p) => sameName(p.name, r.entry.name)).map((p) => <option key={p.id} value={p.id}>{p.reference_code} · {p.name} (mesmo nome)</option>)}
                        <optgroup label="Todos">{products.map((p) => <option key={p.id} value={p.id}>{p.reference_code} · {p.name}</option>)}</optgroup>
                      </select>
                      <select value={r.color} onChange={(e) => set(r.key, { color: e.target.value })} className={inputClass} aria-label="Cor">
                        <option value="NEW">+ Cor nova</option>
                        {own.size > 0 && <optgroup label="Cores deste produto">{colors.filter((c) => own.has(c.id)).map((c) => <option key={c.id} value={c.id}>{c.name}{c.code ? ` (${c.code})` : ""}</option>)}</optgroup>}
                        <optgroup label="Todas as cores">{colors.map((c) => <option key={c.id} value={c.id}>{c.name}{c.code ? ` (${c.code})` : ""}</option>)}</optgroup>
                      </select>
                      {r.product === "NEW" && <>
                        <input value={r.newRef} onChange={(e) => set(r.key, { newRef: e.target.value })} placeholder="Referência (modelo, ex.: 17046)" className={inputClass} aria-label="Referência do produto novo" />
                        <div className="flex gap-2">
                          <input value={r.newName} onChange={(e) => set(r.key, { newName: e.target.value })} className={inputClass} aria-label="Nome do produto novo" />
                          <select value={r.gender} onChange={(e) => set(r.key, { gender: e.target.value as Gender })} className={`${inputClass} w-28`} aria-label="Linha"><option value="FEM">Fem.</option><option value="MASC">Masc.</option><option value="UNISSEX">Unissex</option></select>
                        </div>
                      </>}
                      {r.color === "NEW" && <>
                        <input value={r.newColor} onChange={(e) => set(r.key, { newColor: e.target.value })} placeholder="Nome da cor" className={inputClass} aria-label="Nome da cor nova" />
                        <input value={r.newCode} onChange={(e) => set(r.key, { newCode: e.target.value.replace(/\s/g, "") })} placeholder="Código da cor na etiqueta (ex.: 390)" maxLength={10} className={inputClass} aria-label="Código da cor nova" />
                      </>}
                    </div>
                  </div>
                  {r.photos.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {r.photos.map((p) => {
                        const on = r.photoOn.includes(p.hash);
                        return (
                          <button key={p.hash} type="button" onClick={() => set(r.key, { photoOn: on ? r.photoOn.filter((h) => h !== p.hash) : [...r.photoOn, p.hash] })}
                            className={`relative overflow-hidden rounded-lg border-2 ${on ? "border-brand" : "border-transparent opacity-40"}`} aria-pressed={on} aria-label={`${on ? "Não usar" : "Usar"} a foto da página ${p.page}`}>
                            {/* eslint-disable-next-line @next/next/no-img-element -- foto local (blob) antes do envio */}
                            <img src={p.url} alt="" className="h-28 w-20 object-cover" />
                          </button>
                        );
                      })}
                      <p className="w-full text-xs text-muted">{r.photoOn.length} de {r.photos.length} foto(s) selecionada(s) · clique para incluir ou tirar{r.photoOn.length === 0 ? " (este produto/cor já tem fotos)" : ""}</p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </div>
  );
}
