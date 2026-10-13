"use client";
import { useMemo, useRef, useState, useTransition } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, ArrowUpDown, Search, X } from "lucide-react";
import { formatBRL } from "@centralops/domain";
import { Badge, Button, cn } from "@/components/ui";
import { setBackorderForProductsAction } from "../vender/encomendas/actions";

export interface CatalogRow {
  id: string; reference: string; name: string; gender: string;
  categoryId: string; category: string; collectionId: string; collection: string;
  colors: number; variants: number; priceMin: number | null; priceMax: number | null; stock: number;
  backorder: boolean; site: "live" | "off" | null; photo: string | null;
}
export interface CatalogFilters { q: string; genero: string; categoria: string; colecao: string; estoque: string }

const GENDER: Record<string, string> = { FEM: "Feminina", MASC: "Masculina", UNISSEX: "Unissex" };
const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

type SortKey = "reference" | "name" | "gender" | "category" | "collection" | "variants" | "price" | "stock" | "backorder" | "site";
const COLUMNS: { key: SortKey; label: string; get: (r: CatalogRow) => string | number }[] = [
  { key: "reference", label: "Referência", get: (r) => r.reference },
  { key: "name", label: "Produto", get: (r) => r.name },
  { key: "gender", label: "Linha", get: (r) => GENDER[r.gender] ?? r.gender },
  { key: "category", label: "Categoria", get: (r) => r.category },
  { key: "collection", label: "Coleção", get: (r) => r.collection },
  { key: "variants", label: "Cores · var.", get: (r) => r.variants },
  { key: "price", label: "Preço", get: (r) => r.priceMin ?? -1 },
  { key: "stock", label: "Estoque", get: (r) => r.stock },
  { key: "backorder", label: "Encomenda", get: (r) => (r.backorder ? 1 : 0) },
  { key: "site", label: "Site", get: (r) => (r.site === "live" ? 2 : r.site === "off" ? 1 : 0) },
];

type Filters = CatalogFilters & { encomenda: string; site: string };
const EMPTY: Filters = { q: "", genero: "", categoria: "", colecao: "", estoque: "", encomenda: "", site: "" };

/**
 * Lista do Catálogo: uma barra só de busca e filtros (tudo na hora, sem botão), ordenação ao clicar no cabeçalho
 * e seleção de vários produtos para liberar/desligar encomenda de uma vez (shift + clique marca um intervalo).
 */
export function CatalogTable({ rows, categories, collections, initial, canWrite }: {
  rows: CatalogRow[]; categories: { id: string; name: string }[]; collections: { id: string; name: string }[];
  initial: CatalogFilters; canWrite: boolean;
}) {
  const router = useRouter();
  const [f, setF] = useState<Filters>({ ...EMPTY, ...initial });
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [flash, setFlash] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [pending, start] = useTransition();
  const anchor = useRef<number | null>(null);

  const visible = useMemo(() => {
    const words = norm(f.q).split(" ").filter(Boolean);
    let out = rows.filter((r) => {
      if (words.length && !words.every((w) => norm(`${r.name} ${r.reference}`).includes(w))) return false;
      if (f.genero && r.gender !== f.genero) return false;
      if (f.categoria && r.categoryId !== f.categoria) return false;
      if (f.colecao && r.collectionId !== f.colecao) return false;
      if (f.estoque === "com" && r.stock <= 0) return false;
      if (f.estoque === "sem" && r.stock > 0) return false;
      if (f.encomenda === "sim" && !r.backorder) return false;
      if (f.encomenda === "nao" && r.backorder) return false;
      if (f.site === "live" && r.site !== "live") return false;
      if (f.site === "off" && r.site !== "off") return false;
      if (f.site === "none" && r.site !== null) return false;
      return true;
    });
    if (sort) {
      const get = COLUMNS.find((c) => c.key === sort.key)!.get;
      out = [...out].sort((a, b) => {
        const x = get(a), y = get(b);
        const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), "pt-BR", { numeric: true });
        return sort.dir === "asc" ? c : -c;
      });
    }
    return out;
  }, [rows, f, sort]);

  // só vale a seleção do que está na lista (mudou o filtro, o que sumiu não entra na ação)
  const chosen = visible.filter((r) => selected.has(r.id));
  const allChosen = visible.length > 0 && chosen.length === visible.length;
  const filtersOn = Object.values(f).some(Boolean);
  const set = (k: keyof Filters, v: string) => setF((p) => ({ ...p, [k]: v }));

  const toggleRow = (idx: number, shift: boolean) => {
    const from = anchor.current;
    anchor.current = idx;
    setSelected((prev) => {
      const next = new Set(prev);
      const on = !prev.has(visible[idx].id);
      const [a, b] = shift && from !== null ? [Math.min(from, idx), Math.max(from, idx)] : [idx, idx];
      for (let i = a; i <= b; i++) { if (on) next.add(visible[i].id); else next.delete(visible[i].id); }
      return next;
    });
  };
  const toggleAll = () => setSelected((prev) => {
    const next = new Set(prev);
    for (const r of visible) { if (allChosen) next.delete(r.id); else next.add(r.id); }
    return next;
  });
  const toggleSort = (key: SortKey) => setSort((s) => (s?.key !== key ? { key, dir: "asc" } : s.dir === "asc" ? { key, dir: "desc" } : null));

  const apply = (enabled: boolean) => start(async () => {
    setFlash(null);
    const r = await setBackorderForProductsAction(chosen.map((x) => x.id), enabled);
    if (!r.ok) { setFlash({ tone: "danger", text: r.error }); return; }
    setFlash({ tone: "success", text: `${r.count} produto(s): encomenda ${enabled ? "liberada" : "desligada"}.` });
    setSelected(new Set());
    router.refresh();
  });

  const select = (key: keyof Filters, label: string, options: [string, string][]) => (
    <select value={f[key]} onChange={(e) => set(key, e.target.value)} aria-label={label}
      className={cn("rounded-lg border bg-bg px-2 py-1.5 text-sm", f[key] ? "border-brand text-brand" : "border-border")}>
      <option value="">{label}: todos</option>
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label className="relative min-w-56 flex-1 sm:max-w-sm">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" aria-hidden />
          <input value={f.q} onChange={(e) => set("q", e.target.value)} placeholder="Buscar por nome ou referência" aria-label="Buscar produto"
            className="w-full rounded-lg border border-border bg-bg py-1.5 pl-8 pr-3 text-sm outline-none focus:ring-2 focus:ring-brand" />
        </label>
        {select("genero", "Linha", Object.entries(GENDER))}
        {select("categoria", "Categoria", categories.map((c) => [c.id, c.name]))}
        {select("colecao", "Coleção", collections.map((c) => [c.id, c.name]))}
        {select("estoque", "Estoque", [["com", "Com estoque"], ["sem", "Sem estoque"]])}
        {select("encomenda", "Encomenda", [["sim", "Aceita encomenda"], ["nao", "Não aceita"]])}
        {select("site", "Site", [["live", "No site"], ["off", "Fora do site"], ["none", "Sem vínculo"]])}
        {filtersOn && <button type="button" onClick={() => setF(EMPTY)} className="inline-flex items-center gap-1 text-xs text-muted hover:text-text"><X size={12} /> limpar filtros</button>}
        <span className="ml-auto text-xs text-muted">{visible.length === rows.length ? `${rows.length} produto(s)` : `${visible.length} de ${rows.length}`}</span>
      </div>

      {flash && <p role="status" className={cn("mb-3 rounded-lg px-3 py-2 text-sm", flash.tone === "success" ? "bg-success/10 text-success" : "bg-danger/10 text-danger")}>{flash.text}</p>}
      {canWrite && (chosen.length > 0 ? (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-brand/40 bg-brand/10 px-3 py-2 text-sm">
          <b>{chosen.length} selecionado(s)</b>
          <Button type="button" variant="secondary" className="px-2.5 py-1 text-xs" disabled={pending} onClick={() => apply(true)}>Liberar encomenda</Button>
          <Button type="button" variant="secondary" className="px-2.5 py-1 text-xs" disabled={pending} onClick={() => apply(false)}>Desligar encomenda</Button>
          {pending && <span className="text-xs text-muted">Salvando…</span>}
          <button type="button" onClick={() => setSelected(new Set())} className="ml-auto text-xs text-muted hover:text-text">limpar seleção</button>
        </div>
      ) : <p className="mb-2 text-xs text-muted">Marque os produtos (shift + clique marca um intervalo) para liberar ou desligar encomenda de uma vez.</p>)}

      <div className="overflow-x-auto rounded-xl border border-border bg-surface">
        <table className="w-full text-sm">
          <thead className="bg-surface-2 text-left text-xs text-muted">
            <tr>
              {canWrite && (
                <th className="w-8 px-2 py-2">
                  <input type="checkbox" checked={allChosen} onChange={toggleAll} disabled={visible.length === 0} aria-label="Marcar todos os produtos da lista"
                    ref={(el) => { if (el) el.indeterminate = chosen.length > 0 && !allChosen; }} />
                </th>
              )}
              <th className="px-2 py-2"><span className="sr-only">Foto</span></th>
              {COLUMNS.map((c) => {
                const on = sort?.key === c.key;
                return (
                  <th key={c.key} className="px-2 py-2 align-bottom font-medium" aria-sort={on ? (sort!.dir === "asc" ? "ascending" : "descending") : undefined}>
                    <button type="button" onClick={() => toggleSort(c.key)} className={cn("inline-flex items-center gap-1 text-left hover:text-text", on && "text-text")}>
                      {c.label}{on ? (sort!.dir === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} />) : <ArrowUpDown size={12} className="opacity-40" />}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {visible.map((r, idx) => {
              const on = selected.has(r.id);
              return (
                <tr key={r.id} className={cn(on && "bg-brand/5")}>
                  {canWrite && (
                    <td className="w-8 px-2 py-2">
                      <input type="checkbox" checked={on} onChange={() => {}} onClick={(e) => toggleRow(idx, e.shiftKey)} aria-label={`Marcar ${r.name}`} />
                    </td>
                  )}
                  <td className="w-[88px] min-w-[88px] px-2 py-2">
                    <Link href={`/produtos/${r.id}`} className="block h-24 w-[72px] overflow-hidden rounded-lg bg-surface-2" aria-label={`Abrir ${r.name}`}>
                      {r.photo && <Image src={r.photo} alt="" width={72} height={96} unoptimized className="h-full w-full object-cover" />}
                    </Link>
                  </td>
                  <td className="px-2 py-2 font-mono text-xs">{r.reference}</td>
                  <td className="min-w-[140px] px-2 py-2 font-medium"><Link href={`/produtos/${r.id}`} className="hover:underline">{r.name}</Link></td>
                  <td className="px-2 py-2">{GENDER[r.gender] ?? r.gender}</td>
                  <td className="px-2 py-2">{r.category || "—"}</td>
                  <td className="px-2 py-2">{r.collection || "—"}</td>
                  <td className="whitespace-nowrap px-2 py-2 tabular-nums">{r.colors} {r.colors === 1 ? "cor" : "cores"} · {r.variants}</td>
                  <td className="px-2 py-2">
                    {r.priceMin === null ? <span className="text-danger">sem preço</span>
                      : r.priceMin === r.priceMax ? <span className="whitespace-nowrap">{formatBRL(r.priceMin)}</span>
                        : <><span className="whitespace-nowrap">{formatBRL(r.priceMin)}</span> – <span className="whitespace-nowrap">{formatBRL(r.priceMax ?? r.priceMin)}</span></>}
                  </td>
                  <td className="px-2 py-2 tabular-nums">{r.stock}</td>
                  <td className="whitespace-nowrap px-2 py-2">{r.backorder ? <Badge tone="success">aceita</Badge> : <span className="text-muted">não</span>}</td>
                  <td className="whitespace-nowrap px-2 py-2">{r.site ? (r.site === "live" ? <Badge tone="success">no site</Badge> : <Badge tone="neutral">fora do site</Badge>) : "—"}</td>
                </tr>
              );
            })}
            {visible.length === 0 && (
              <tr><td colSpan={COLUMNS.length + (canWrite ? 2 : 1)} className="px-2 py-8 text-center text-sm text-muted">
                Nenhum produto com essa busca ou filtro.{filtersOn && <> <button type="button" onClick={() => setF(EMPTY)} className="text-brand hover:underline">Limpar filtros</button></>}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
