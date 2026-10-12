"use client";
import { Children, isValidElement, useMemo, useState, type ReactElement, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Search, X } from "lucide-react";
import { clsx } from "clsx";

/**
 * Tabela padrão do sistema. As linhas continuam vindo prontas da página (servidor ou cliente); aqui ganham, sem mudar a página:
 * - busca no texto de todas as colunas;
 * - ordenação ao clicar no cabeçalho (entende R$ 1.234,56, 12%, números, dd/mm/aaaa [hh:mm] e texto em português);
 * - filtro por coluna nas colunas com poucos valores diferentes (situação, canal, tipo…);
 * - contador "x de y".
 * Linha de uma célula só com colspan (aviso de lista vazia, total) fica fixa no fim. Em listas paginadas no servidor, a ordem e a busca valem
 * para a página aberta (a busca da própria página continua sendo a que procura no banco).
 * `plain` desliga tudo (tabelas de formulário/edição); `sortable={false}` numa coluna via `noSort` (índices).
 */
export interface TableProps {
  head: ReactNode[];
  children: ReactNode;
  plain?: boolean;
  noSort?: number[];
  searchPlaceholder?: string;
  defaultSort?: { col: number; dir: "asc" | "desc" };
}

type Row = { el: ReactElement; cells: string[]; sorts: string[]; pinned: boolean };

function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  if (isValidElement(node)) {
    const p = node.props as { children?: ReactNode; value?: unknown; defaultValue?: unknown; title?: unknown; "data-sort"?: unknown };
    if (p["data-sort"] != null) return String(p["data-sort"]);
    if (p.children !== undefined) return textOf(p.children);
    if (typeof p.value === "string" || typeof p.value === "number") return String(p.value);
    if (typeof p.defaultValue === "string" || typeof p.defaultValue === "number") return String(p.defaultValue);
    return "";
  }
  return "";
}

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

/** Valor comparável: número (R$, %, decimal brasileiro), data (dd/mm/aaaa) ou texto. */
function sortKey(raw: string): { n: number | null; t: string } {
  const s = raw.trim();
  const date = /^(\d{2})\/(\d{2})\/(\d{2,4})(?:,?\s+(\d{2}):(\d{2}))?/.exec(s);
  if (date) {
    const y = date[3].length === 2 ? 2000 + Number(date[3]) : Number(date[3]);
    return { n: Date.UTC(y, Number(date[2]) - 1, Number(date[1]), Number(date[4] ?? 0), Number(date[5] ?? 0)), t: s };
  }
  const num = /^[-−]?\s*(R\$\s*)?[-−]?\d[\d.]*(,\d+)?\s*%?(\s|$)/.exec(s);
  if (num) {
    const neg = /^[-−]/.test(s) || /R\$\s*[-−]/.test(s);
    const v = Number(num[0].replace(/[R$%\s−-]/g, "").replace(/\./g, "").replace(",", "."));
    if (Number.isFinite(v)) return { n: neg ? -v : v, t: s };
  }
  return { n: null, t: norm(s) };
}

export function Table({ head, children, plain, noSort = [], searchPlaceholder, defaultSort }: TableProps) {
  const rows: Row[] = useMemo(() => Children.toArray(children).filter(isValidElement).map((el) => {
    const tds = Children.toArray((el.props as { children?: ReactNode }).children).filter(isValidElement) as ReactElement[];
    const pinned = tds.length === 1 && Number((tds[0].props as { colSpan?: number }).colSpan ?? 1) > 1;
    const cells = tds.map((td) => textOf((td.props as { children?: ReactNode }).children).replace(/\s+/g, " ").trim());
    // <td data-sort={…}> manda na ordenação (ex.: faixa de preço ordenada pelo menor valor)
    const sorts = tds.map((td, i) => { const v = (td.props as { "data-sort"?: unknown })["data-sort"]; return v == null ? cells[i] : String(v); });
    return { el: el as ReactElement, cells, sorts, pinned };
  }), [children]);

  const [q, setQ] = useState("");
  const [sort, setSort] = useState<{ col: number; dir: "asc" | "desc" } | null>(defaultSort ?? null);
  const [filters, setFilters] = useState<Record<number, string>>({});

  const data = rows.filter((r) => !r.pinned);
  const enhanced = !plain && data.length > 1;
  const headText = head.map((h) => textOf(h));

  // colunas boas para filtro: 2 a 12 valores diferentes, curtos, em listas com 6+ linhas
  const facets = useMemo(() => {
    if (!enhanced || data.length < 6) return [] as { col: number; values: string[] }[];
    return head.map((_, col) => {
      const vals = [...new Set(data.map((r) => r.cells[col] ?? "").filter(Boolean))];
      return { col, values: vals.sort((a, b) => a.localeCompare(b, "pt-BR")) };
    }).filter((f) => headText[f.col] && f.values.length >= 2 && f.values.length <= 12 && f.values.every((v) => v.length <= 40)
      && f.values.length < data.length && !f.values.every((v) => sortKey(v).n !== null));
  }, [enhanced, data, head, headText]);

  const visible = useMemo(() => {
    let out = data;
    const nq = norm(q);
    if (nq) out = out.filter((r) => nq.split(" ").every((w) => norm(r.cells.join(" ")).includes(w)));
    for (const [col, val] of Object.entries(filters)) if (val) out = out.filter((r) => (r.cells[Number(col)] ?? "") === val);
    if (sort) {
      out = [...out].sort((a, b) => {
        const x = sortKey(a.sorts[sort.col] ?? ""), y = sortKey(b.sorts[sort.col] ?? "");
        let c: number;
        if (x.n !== null && y.n !== null) c = x.n - y.n;
        else if (x.n !== null) c = -1;
        else if (y.n !== null) c = 1;
        else c = x.t.localeCompare(y.t, "pt-BR", { numeric: true });
        return sort.dir === "asc" ? c : -c;
      });
    }
    return out;
  }, [data, q, filters, sort]);

  const toggle = (col: number) => setSort((s) => (s?.col !== col ? { col, dir: "asc" } : s.dir === "asc" ? { col, dir: "desc" } : null));
  const active = q !== "" || Object.values(filters).some(Boolean);

  return (
    <div>
      {enhanced && (data.length > 5 || facets.length > 0) && (
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <label className="relative min-w-48 flex-1 sm:max-w-xs">
            <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" aria-hidden />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={searchPlaceholder ?? "Buscar na lista"} aria-label="Buscar na lista"
              className="w-full rounded-lg border border-border bg-bg py-1.5 pl-8 pr-3 text-sm outline-none focus:ring-2 focus:ring-brand" />
          </label>
          {facets.map((f) => (
            <select key={f.col} value={filters[f.col] ?? ""} onChange={(e) => setFilters((p) => ({ ...p, [f.col]: e.target.value }))} aria-label={`Filtrar por ${headText[f.col]}`}
              className={clsx("rounded-lg border bg-bg px-2 py-1.5 text-sm", filters[f.col] ? "border-brand text-brand" : "border-border")}>
              <option value="">{headText[f.col]}: todos</option>
              {f.values.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          ))}
          {active && <button type="button" onClick={() => { setQ(""); setFilters({}); }} className="inline-flex items-center gap-1 text-xs text-muted hover:text-foreground"><X size={12} /> limpar</button>}
          <span className="ml-auto text-xs text-muted">{visible.length === data.length ? `${data.length} linha(s)` : `${visible.length} de ${data.length}`}</span>
        </div>
      )}
      <div className="overflow-x-auto rounded-xl border border-border bg-surface">
        <table className="w-full text-sm">
          <thead className="bg-surface-2 text-left text-xs text-muted">
            <tr>{head.map((h, i) => {
              const can = enhanced && headText[i] !== "" && !noSort.includes(i);
              const on = sort?.col === i;
              return (
                <th key={i} className="px-3 py-2 font-medium whitespace-nowrap" aria-sort={on ? (sort!.dir === "asc" ? "ascending" : "descending") : undefined}>
                  {can ? (
                    <button type="button" onClick={() => toggle(i)} className={clsx("inline-flex items-center gap-1 hover:text-foreground", on && "text-foreground")}>
                      {h}{on ? (sort!.dir === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} />) : <ArrowUpDown size={12} className="opacity-40" />}
                    </button>
                  ) : h}
                </th>
              );
            })}</tr>
          </thead>
          <tbody className="divide-y divide-border">
            {visible.map((r) => r.el)}
            {enhanced && visible.length === 0 && data.length > 0 && (
              <tr><td colSpan={head.length} className="px-3 py-6 text-center text-sm text-muted">Nada encontrado com essa busca ou filtro.</td></tr>
            )}
            {rows.filter((r) => r.pinned).map((r) => r.el)}
          </tbody>
        </table>
      </div>
    </div>
  );
}
