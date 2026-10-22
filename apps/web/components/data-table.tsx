"use client";
import Link from "next/link";
import { Children, cloneElement, isValidElement, useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent, type ReactElement, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { ArrowDown, ArrowUp, ArrowUpDown, Search, X } from "lucide-react";
import { clsx } from "clsx";
import { formatBRL } from "@centralops/domain";

/**
 * Tabela padrão do sistema. As linhas continuam vindo prontas da página (servidor ou cliente); aqui ganham, sem mudar a página:
 * - busca no texto de todas as colunas;
 * - ordenação ao clicar no cabeçalho (entende R$ 1.234,56, 12%, números, dd/mm/aaaa [hh:mm] e texto em português);
 * - filtro por coluna nas colunas com poucos valores diferentes (situação, canal, tipo…);
 * - contador "x de y";
 * - linha de total no rodapé: soma as colunas em R$ (e as de contagem: Qtd, Peças, Pedidos…) do que está visível, ou seja,
 *   respeitando a busca e os filtros. Não soma preço unitário, média, ticket, taxa nem %. `noTotal` tira colunas,
 *   `totals={[i]}` força (ex.: uma contagem com outro nome) e `totals={false}` desliga;
 * - seleção para ação em lote (`bulk`): as linhas com `<tr data-select={id}>` ganham caixinha (shift+clique marca o intervalo),
 *   e uma barra fixa embaixo mostra quantas e quanto somam, com os botões das ações. `data-tags="aprovar pagar"` na linha
 *   diz quais ações valem para ela (ação com `tag`); cada ação recebe os ids marcados em `ids` (FormData) ou no `{ids}` do link.
 * Linha de uma célula só com colspan (aviso de lista vazia) ou com `data-pin` (resultado calculado pela página) fica fixa no fim e
 * fora da soma. Em listas paginadas no servidor, a ordem, a busca e o total valem para a página aberta (use `totalLabel="Total da página"`).
 * `plain` desliga tudo (tabelas de formulário/edição); `noSort` tira a ordenação de colunas (índices).
 * Largura: ocupa o espaço da tela (cresce ao recolher a barra lateral); cabeçalho de várias palavras quebra linha antes de
 * aparecer rolagem lateral, e com 9+ colunas o espaçamento das células fica mais justo (vale sobre o px-3 de cada página).
 */
export interface BulkField { name: string; label: string; type?: "text" | "date"; required?: boolean; minLength?: number; min?: string; placeholder?: string }
export interface BulkAction {
  label: string;
  /** Server action: recebe `ids` (um por linha marcada), os `fields` e os `hidden`. */
  action?: (formData: FormData) => void | Promise<void>;
  /** Alternativa à action: link; `{ids}` vira a lista separada por vírgula. */
  href?: string;
  /** Só vale para as linhas com essa palavra em `data-tags` (sem tag: todas as linhas marcáveis). */
  tag?: string;
  tone?: "primary" | "secondary" | "danger";
  /** Pergunta antes de executar; `{n}` vira a quantidade. */
  confirm?: string;
  /** Campos pedidos antes de executar (motivo da recusa, data de pagamento…): o botão abre os campos e um "Confirmar". */
  fields?: BulkField[];
  hidden?: Record<string, string>;
}
export interface TableProps {
  head: ReactNode[];
  children: ReactNode;
  plain?: boolean;
  noSort?: number[];
  searchPlaceholder?: string;
  defaultSort?: { col: number; dir: "asc" | "desc" };
  totals?: boolean | number[];
  noTotal?: number[];
  totalLabel?: string;
  bulk?: BulkAction[];
}

type Row = { el: ReactElement; cells: string[]; sorts: string[]; pinned: boolean; id: string | null; tags: string[] };

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

// ---- totais -------------------------------------------------------------------------------------------------------

/** Cabeçalhos de valor que não se somam (preço de tabela, média, taxa…). */
const NO_SUM = /pre[çc]o|unit|m[eé]di[oa]|mediana|ticket|\bpor\b|taxa|%|cota[çc][ãa]o|limite|meta\b/i;
/** Cabeçalhos de contagem que se somam quando a coluna só tem inteiros. */
const COUNT = /^(qtd|quantidade|pe[çc]as|pedidos|itens|transa[çc][õo]es|cliques|conversas|leads|usos|vendidas|devolvidas?|total|tentativas|recuperadas|perdidas|compraram|entraram|receberam|clientes|convidadas|confirmadas|compareceram|respostas|mensagens|dias|colab)/i;
const BLANK = /^(—|-|–|)$/;
const isMoney = (s: string) => /R\$/.test(s) && sortKey(s).n !== null;
const isInt = (s: string) => /^[-−]?\d{1,3}(\.\d{3})*$|^[-−]?\d+$/.test(s);
type TotalCol = { col: number; kind: "money" | "count" };

function sumOf(rows: Row[], t: TotalCol) {
  return rows.reduce((a, r) => {
    const s = r.cells[t.col] ?? "";
    if (BLANK.test(s)) return a;
    const n = sortKey(s).n;
    return a + (n ?? 0);
  }, 0);
}
const fmtTotal = (v: number, kind: TotalCol["kind"]) => (kind === "money" ? formatBRL(Math.round(v * 100) / 100) : v.toLocaleString("pt-BR"));

// ---- ações em lote ----------------------------------------------------------------------------------------------

const toneClass = {
  primary: "bg-brand text-brand-contrast hover:opacity-90",
  secondary: "border border-border bg-surface hover:bg-surface-2",
  danger: "bg-danger text-white hover:opacity-90",
} as const;
const btn = "inline-flex items-center justify-center gap-1 rounded-lg px-3 py-1.5 text-sm font-medium transition disabled:opacity-50";

function Submit({ children, tone }: { children: ReactNode; tone: keyof typeof toneClass }) {
  const { pending } = useFormStatus();
  return <button disabled={pending} className={clsx(btn, toneClass[tone])}>{pending ? "Processando…" : children}</button>;
}

function BulkButton({ a, ids, onDone }: { a: BulkAction; ids: string[]; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const tone = a.tone ?? "secondary";
  const label = `${a.label} (${ids.length})`;
  if (a.href) return <Link href={a.href.replace("{ids}", ids.join(","))} className={clsx(btn, toneClass[tone])}>{label}</Link>;
  if (!a.action) return null;
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    if (a.confirm && !window.confirm(a.confirm.replace("{n}", String(ids.length)))) { e.preventDefault(); return; }
    onDone();
  };
  if (a.fields?.length && !open) return <button type="button" onClick={() => setOpen(true)} className={clsx(btn, toneClass[tone])}>{label}</button>;
  return (
    <form action={a.action} onSubmit={onSubmit} className={clsx("flex flex-wrap items-end gap-2", open && "w-full rounded-lg bg-surface-2 p-2 sm:w-auto")}>
      {ids.map((id) => <input key={id} type="hidden" name="ids" value={id} />)}
      {Object.entries(a.hidden ?? {}).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      {open && a.fields?.map((f) => (
        <label key={f.name} className="text-xs text-muted">{f.label}
          <input name={f.name} type={f.type ?? "text"} required={f.required} minLength={f.minLength} min={f.min} placeholder={f.placeholder} autoFocus={f === a.fields![0]}
            className="mt-0.5 block w-56 rounded-lg border border-border bg-bg px-2 py-1.5 text-sm text-text outline-none focus:ring-2 focus:ring-brand" />
        </label>
      ))}
      <Submit tone={tone}>{open ? `Confirmar: ${label}` : label}</Submit>
      {open && <button type="button" onClick={() => setOpen(false)} className="py-1.5 text-xs text-muted hover:text-text">voltar</button>}
    </form>
  );
}

// ---- tabela ------------------------------------------------------------------------------------------------------

export function Table({ head, children, plain, noSort = [], searchPlaceholder, defaultSort, totals = true, noTotal = [], totalLabel, bulk }: TableProps) {
  const rows: Row[] = useMemo(() => Children.toArray(children).filter(isValidElement).map((el) => {
    const props = el.props as { children?: ReactNode; "data-select"?: unknown; "data-tags"?: unknown; "data-pin"?: unknown };
    const tds = Children.toArray(props.children).filter(isValidElement) as ReactElement[];
    const pinned = props["data-pin"] != null && props["data-pin"] !== false
      || (tds.length === 1 && Number((tds[0].props as { colSpan?: number }).colSpan ?? 1) > 1);
    const cells = tds.map((td) => textOf((td.props as { children?: ReactNode }).children).replace(/\s+/g, " ").trim());
    // <td data-sort={…}> manda na ordenação (ex.: faixa de preço ordenada pelo menor valor)
    const sorts = tds.map((td, i) => { const v = (td.props as { "data-sort"?: unknown })["data-sort"]; return v == null ? cells[i] : String(v); });
    const id = props["data-select"] ? String(props["data-select"]) : null;
    const tags = String(props["data-tags"] ?? "").split(/\s+/).filter(Boolean);
    return { el: el as ReactElement, cells, sorts, pinned, id, tags };
  }), [children]);

  const [q, setQ] = useState("");
  const [sort, setSort] = useState<{ col: number; dir: "asc" | "desc" } | null>(defaultSort ?? null);
  const [filters, setFilters] = useState<Record<number, string>>({});
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const last = useRef<string | null>(null);
  // depois de uma ação em lote, a página volta com as linhas atualizadas: aí a seleção recomeça
  const sent = useRef(false);
  useEffect(() => { if (sent.current) { sent.current = false; setPicked(new Set()); } }, [children]);

  const data = useMemo(() => rows.filter((r) => !r.pinned), [rows]);
  const enhanced = !plain && data.length > 1;
  const headText = useMemo(() => head.map((h) => textOf(h)), [head]);
  const selectable = !plain && !!bulk?.length && data.some((r) => r.id);
  // linhas que saíram da lista (aprovadas, pagas…) deixam de contar como marcadas
  const sel = useMemo(() => new Set([...picked].filter((id) => data.some((r) => r.id === id))), [picked, data]);

  // colunas boas para filtro: 2 a 12 valores diferentes, curtos, em listas com 6+ linhas
  const facets = useMemo(() => {
    if (!enhanced || data.length < 6) return [] as { col: number; values: string[] }[];
    return head.map((_, col) => {
      const vals = [...new Set(data.map((r) => r.cells[col] ?? "").filter(Boolean))];
      return { col, values: vals.sort((a, b) => a.localeCompare(b, "pt-BR")) };
    }).filter((f) => headText[f.col] && f.values.length >= 2 && f.values.length <= 12 && f.values.every((v) => v.length <= 40)
      && f.values.length < data.length && !f.values.every((v) => sortKey(v).n !== null));
  }, [enhanced, data, head, headText]);

  // colunas somáveis: decididas sobre todas as linhas (o rodapé não "pula" ao filtrar)
  const totalCols: TotalCol[] = useMemo(() => {
    if (plain || totals === false || data.length < 2) return [];
    const forced = Array.isArray(totals) ? totals : [];
    return head.map((_, col): TotalCol | null => {
      if (noTotal.includes(col)) return null;
      const vals = data.map((r) => r.cells[col] ?? "").filter((s) => !BLANK.test(s));
      if (vals.length === 0) return null;
      const money = vals.every(isMoney);
      if (forced.includes(col)) return { col, kind: money ? "money" : "count" };
      if (NO_SUM.test(headText[col])) return null;
      if (money) return { col, kind: "money" };
      if (COUNT.test(headText[col].trim()) && vals.every(isInt)) return { col, kind: "count" };
      return null;
    }).filter((t): t is TotalCol => t !== null);
  }, [plain, totals, noTotal, data, head, headText]);

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

  const dense = head.length >= 9;
  const toggleSort = (col: number) => setSort((s) => (s?.col !== col ? { col, dir: "asc" } : s.dir === "asc" ? { col, dir: "desc" } : null));
  const active = q !== "" || Object.values(filters).some(Boolean);

  // seleção
  const visibleIds = visible.map((r) => r.id).filter((id): id is string => !!id);
  const allOn = visibleIds.length > 0 && visibleIds.every((id) => sel.has(id));
  const someOn = visibleIds.some((id) => sel.has(id));
  const headBox = useRef<HTMLInputElement>(null);
  useEffect(() => { if (headBox.current) headBox.current.indeterminate = someOn && !allOn; }, [someOn, allOn]);
  const pick = (id: string, e: MouseEvent<HTMLInputElement>) => {
    const on = !sel.has(id);
    let range = [id];
    if (e.shiftKey && last.current) {
      const a = visibleIds.indexOf(last.current), b = visibleIds.indexOf(id);
      if (a >= 0 && b >= 0) range = visibleIds.slice(Math.min(a, b), Math.max(a, b) + 1);
    }
    last.current = id;
    setPicked(() => { const n = new Set(sel); for (const x of range) { if (on) n.add(x); else n.delete(x); } return n; });
  };
  const selRows = data.filter((r) => r.id && sel.has(r.id));
  // valor principal da barra: a coluna "Total"/"Valor"/"Saldo" em R$, senão a primeira em R$
  const mainMoney = totalCols.find((t) => t.kind === "money" && /^total$/i.test(headText[t.col].trim()))
    ?? totalCols.find((t) => t.kind === "money" && /total|valor|saldo|l[ií]quido/i.test(headText[t.col]))
    ?? totalCols.find((t) => t.kind === "money");

  const span = head.length + (selectable ? 1 : 0);
  const withBox = (r: Row) => {
    if (!selectable) return r.el;
    const p = r.el.props as { className?: string; children?: ReactNode };
    const on = !!r.id && sel.has(r.id);
    const box = (
      <td className="w-8 px-3 py-2">
        {r.id && <input type="checkbox" checked={on} onClick={(e) => pick(r.id!, e)} onChange={() => {}} aria-label={`Selecionar ${r.cells.find(Boolean) ?? "linha"}`} />}
      </td>
    );
    return cloneElement(r.el as ReactElement<{ className?: string }>, { className: clsx(p.className, on && "bg-brand/5") }, box, p.children);
  };

  // rodapé de total: rótulo na primeira coluna que não é somada
  const labelCol = head.findIndex((_, i) => !totalCols.some((t) => t.col === i));
  const footRow = (label: string, set: Row[], cls?: string) => (
    <tr className={cls}>
      {selectable && <td />}
      {head.map((_, i) => {
        const t = totalCols.find((c) => c.col === i);
        if (t) return <td key={i} className="whitespace-nowrap px-3 py-2 tabular-nums">{fmtTotal(sumOf(set, t), t.kind)}</td>;
        return <td key={i} className="px-3 py-2 text-xs text-muted">{i === labelCol ? label : null}</td>;
      })}
    </tr>
  );
  const showFoot = enhanced && totalCols.length > 0 && visible.length > 0;
  const filtered = visible.length !== data.length;

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
          {active && <button type="button" onClick={() => { setQ(""); setFilters({}); }} className="inline-flex items-center gap-1 text-xs text-muted hover:text-text"><X size={12} /> limpar</button>}
          <span className="ml-auto text-xs text-muted">{visible.length === data.length ? `${data.length} linha(s)` : `${visible.length} de ${data.length}`}</span>
        </div>
      )}
      <div className="overflow-x-auto rounded-xl border border-border bg-surface">
        <table className={clsx("w-full text-sm", dense && "[&_td]:px-2 [&_th]:px-2")}>
          <thead className="bg-surface-2 text-left text-xs text-muted">
            <tr>
              {selectable && (
                <th className="w-8 px-3 py-2 align-bottom">
                  <input ref={headBox} type="checkbox" checked={allOn} aria-label="Selecionar todas as linhas visíveis"
                    onChange={() => setPicked(() => { const n = new Set(sel); for (const id of visibleIds) { if (allOn) n.delete(id); else n.add(id); } return n; })} />
                </th>
              )}
              {head.map((h, i) => {
                const can = enhanced && headText[i] !== "" && !noSort.includes(i);
                const on = sort?.col === i;
                return (
                  <th key={i} className="px-3 py-2 align-bottom font-medium" aria-sort={on ? (sort!.dir === "asc" ? "ascending" : "descending") : undefined}>
                    {can ? (
                      <button type="button" onClick={() => toggleSort(i)} className={clsx("inline-flex items-center gap-1 text-left hover:text-text", on && "text-text")}>
                        {h}{on ? (sort!.dir === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} />) : <ArrowUpDown size={12} className="opacity-40" />}
                      </button>
                    ) : h}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {visible.map(withBox)}
            {enhanced && visible.length === 0 && data.length > 0 && (
              <tr><td colSpan={span} className="px-3 py-6 text-center text-sm text-muted">Nada encontrado com essa busca ou filtro.</td></tr>
            )}
            {rows.filter((r) => r.pinned).map((r) => (selectable ? cloneElement(r.el, undefined, <td />, (r.el.props as { children?: ReactNode }).children) : r.el))}
          </tbody>
          {showFoot && (
            <tfoot className="border-t-2 border-border bg-surface-2 font-semibold">
              {footRow(`${totalLabel ?? "Total"}${filtered ? ` (${visible.length} de ${data.length})` : ""}`, visible)}
              {selRows.length > 0 && footRow(`Selecionados (${selRows.length})`, selRows, "text-brand")}
            </tfoot>
          )}
        </table>
      </div>
      {selectable && sel.size > 0 && (
        <div role="region" aria-label="Ações em lote" className="sticky bottom-3 z-20 mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-brand/40 bg-surface px-3 py-2 shadow-lg">
          <span className="text-sm">
            <b>{sel.size}</b> selecionado(s){mainMoney && <> · <b className="tabular-nums">{fmtTotal(sumOf(selRows, mainMoney), "money")}</b></>}
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {bulk!.map((a) => {
              const ids = selRows.filter((r) => !a.tag || r.tags.includes(a.tag)).map((r) => r.id!);
              return ids.length > 0 ? <BulkButton key={a.label} a={a} ids={ids} onDone={() => { sent.current = true; }} /> : null;
            })}
            {bulk!.every((a) => !selRows.some((r) => !a.tag || r.tags.includes(a.tag))) && <span className="text-xs text-muted">Nenhuma ação vale para os selecionados.</span>}
            <button type="button" onClick={() => setPicked(new Set())} className="inline-flex items-center gap-1 px-1 text-xs text-muted hover:text-text"><X size={12} /> limpar</button>
          </div>
        </div>
      )}
    </div>
  );
}
