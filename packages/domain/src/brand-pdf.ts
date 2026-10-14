/**
 * PDFs da marca: pedido de compra (tabela código × descrição × cor × qtd × preço) e catálogo de atacado (uma página por modelo e cor,
 * com nome, composição, grade, preço e fotos). A leitura do arquivo (pdf.js) fica na web; aqui entra só o texto com a posição de cada
 * trecho, para as regras serem testáveis sem o PDF.
 */
import { parseBRNumber } from "./catalog-import";

/** Trecho de texto do PDF: posição do canto inferior esquerdo (y cresce para cima, como no PDF) e altura da fonte. */
export interface PdfTextItem { s: string; x: number; y: number; h: number; w?: number }
export interface PdfRow { y: number; cells: PdfTextItem[] }

/** Junta os trechos da página em linhas (mesmo y, com tolerância), de cima para baixo e da esquerda para a direita. */
export function pdfRows(items: PdfTextItem[], tolerance = 2): PdfRow[] {
  const sorted = items.filter((i) => i.s.trim() !== "").sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: PdfRow[] = [];
  for (const it of sorted) {
    const row = rows.find((r) => Math.abs(r.y - it.y) <= tolerance);
    if (row) row.cells.push(it);
    else rows.push({ y: it.y, cells: [it] });
  }
  for (const r of rows) r.cells.sort((a, b) => a.x - b.x);
  return rows.sort((a, b) => b.y - a.y);
}

const rowText = (r: PdfRow) => r.cells.map((c) => c.s.trim()).join(" ").replace(/\s+/g, " ").trim();
const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

/** "MACACÃO ESSENCE" → "Macacão Essence"; preposições curtas ficam minúsculas ("Azul de Prata"). */
export function titleCase(s: string): string {
  const small = new Set(["de", "da", "do", "das", "dos", "e", "com"]);
  return s.trim().toLowerCase().replace(/\s+/g, " ").split(" ")
    .map((w, i) => (i > 0 && small.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(" ");
}

const SIZE_TOKENS = new Set(["PP", "P", "M", "G", "GG", "XG", "XGG", "EG", "EGG", "U", "UN", "UNICO", "ÚNICO"]);
const isSize = (t: string) => SIZE_TOKENS.has(t.toUpperCase()) || /^\d{2}$/.test(t);

/**
 * Código da etiqueta da marca: modelo (5 dígitos) + cor (3 dígitos) + tamanho, como no site (ex.: 17046390P → 17046 · 390 · P).
 * Devolve null se o código não segue o padrão.
 */
export function splitBrandSku(code: string): { model: string; colorCode: string; size: string } | null {
  const m = code.trim().toUpperCase().match(/^(\d{5})(\d{3})([A-Z]{1,3}|\d{2})$/);
  if (!m || !isSize(m[3])) return null;
  return { model: m[1], colorCode: m[2], size: m[3] };
}

// ---------------------------------------------------------------------
// Pedido
// ---------------------------------------------------------------------

export interface OrderPdfLine {
  code: string; description: string; color: string; size: string; qty: number; unitCost: number; total: number | null;
  /** modelo e cor tirados do código (null se o código não segue o padrão da marca) */
  model: string | null; colorCode: string | null;
}
export interface OrderPdf {
  number: string | null; date: string | null; representative: string | null; supplierName: string | null;
  lines: OrderPdfLine[]; totalQty: number; total: number;
  /** total impresso no PDF (para conferir a leitura) */
  printedTotal: number | null; printedQty: number | null;
  warnings: string[];
}

type Col = "code" | "description" | "color" | "size" | "qty" | "unit" | "total";
const HEADERS: [Col, RegExp][] = [
  ["code", /^(c[oó]d(igo)?\.?( (de )?barras)?|refer[eê]ncia|ref\.?|sku|produto c[oó]d\.?)$/i],
  ["description", /^(descri[cç][aã]o( do produto)?|produto|item)$/i],
  ["color", /^(cor|cores)$/i],
  ["size", /^(tam\.?|tamanho)$/i],
  ["qty", /^(qtd\.?|qtde\.?|quant\.?|quantidade)$/i],
  ["unit", /^(pre[cç]o unit[aá]rio|valor unit[aá]rio|unit[aá]rio|pre[cç]o|vl\.? unit\.?|valor)$/i],
  ["total", /^(pre[cç]o total|valor total|total|subtotal)$/i],
];

function headerColumns(row: PdfRow): { col: Col; x: number }[] | null {
  const found: { col: Col; x: number }[] = [];
  for (const c of row.cells) {
    const hit = HEADERS.find(([, re]) => re.test(c.s.trim()));
    if (hit && !found.some((f) => f.col === hit[0])) found.push({ col: hit[0], x: c.x });
  }
  const has = (k: Col) => found.some((f) => f.col === k);
  return has("code") && has("qty") && (has("unit") || has("total")) ? found.sort((a, b) => a.x - b.x) : null;
}

/** Valor ao lado de um rótulo "Rótulo :" na mesma linha. */
function labelValue(rows: PdfRow[], label: RegExp): string | null {
  for (const r of rows) {
    for (let i = 0; i < r.cells.length; i++) {
      const t = r.cells[i].s.trim();
      if (!label.test(t.replace(/\s*:\s*$/, ""))) continue;
      const inline = t.split(":").slice(1).join(":").trim();
      if (inline) return inline;
      // o valor é o trecho seguinte à direita (a ordem do PDF nem sempre segue a leitura)
      const next = r.cells.filter((c) => c.x > r.cells[i].x).sort((a, b) => a.x - b.x)[0];
      if (next && !/:\s*$/.test(next.s.trim())) return next.s.trim();
      return null;
    }
  }
  return null;
}

function isoDate(br: string | null): string | null {
  const m = br?.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

/** Lê o pedido: cabeçalho da tabela define as colunas (pela posição), cada linha com código + quantidade + preço vira item. */
export function parseOrderPdf(pages: PdfTextItem[][]): OrderPdf {
  const lines: OrderPdfLine[] = [];
  const warnings: string[] = [];
  const printed: { total: number | null; qty: number | null } = { total: null, qty: null };
  const firstRows = pdfRows(pages[0] ?? []);

  pages.forEach((items, pageIdx) => {
    const rows = pdfRows(items);
    const hIdx = rows.findIndex((r) => headerColumns(r));
    if (hIdx < 0) { if (items.length) warnings.push(`Página ${pageIdx + 1}: tabela de itens não encontrada`); return; }
    const cols = headerColumns(rows[hIdx])!;
    // cada coluna vai do início do seu título ao início do próximo; números alinhados à direita caem pelo centro do trecho
    const colOf = (c: PdfTextItem) => {
      const mid = c.x + (c.w ?? c.s.length * 4) / 2;
      let pick = cols[0].col;
      for (const k of cols) if (mid >= k.x - 3) pick = k.col;
      return pick;
    };
    for (const r of rows.slice(hIdx + 1)) {
      const cell: Partial<Record<Col, string>> = {};
      for (const c of r.cells) { const k = colOf(c); cell[k] = cell[k] ? `${cell[k]} ${c.s.trim()}` : c.s.trim(); }
      const code = (cell.code ?? "").replace(/\s/g, "").toUpperCase();
      const qty = parseBRNumber(cell.qty);
      const unit = parseBRNumber(cell.unit);
      const total = parseBRNumber(cell.total);
      if (!code || !/^[A-Z0-9./-]{3,}$/.test(code) || qty === null || qty <= 0) {
        // linha de totais: quantidade + valor sem código
        if (!code && qty !== null && total !== null) { printed.qty = qty; printed.total = total; }
        continue;
      }
      const unitCost = unit ?? (total !== null ? Math.round((total / qty) * 100) / 100 : null);
      if (unitCost === null) { warnings.push(`${code}: sem preço`); continue; }
      const sku = splitBrandSku(code);
      const size = (cell.size ?? "").toUpperCase() || sku?.size || "";
      lines.push({
        code, description: (cell.description ?? "").trim(), color: titleCase(cell.color ?? ""), size,
        qty, unitCost, total, model: sku?.model ?? null, colorCode: sku?.colorCode ?? null,
      });
    }
  });

  const totalQty = lines.reduce((s, l) => s + l.qty, 0);
  const total = Math.round(lines.reduce((s, l) => s + l.qty * l.unitCost, 0) * 100) / 100;
  if (printed.qty !== null && printed.qty !== totalQty) warnings.push(`O PDF soma ${printed.qty} peças e a leitura achou ${totalQty}: confira`);
  if (printed.total !== null && Math.abs(printed.total - total) > 0.05) warnings.push(`O PDF totaliza R$ ${printed.total.toFixed(2)} e a leitura R$ ${total.toFixed(2)}: confira`);
  for (const l of lines) if (!l.size) warnings.push(`${l.code}: tamanho não identificado`);

  const rep = labelValue(firstRows, /^representante$/i);
  // o nome grande no topo da página (maior fonte) costuma ser a marca/showroom que emitiu
  const biggest = [...(pages[0] ?? [])].filter((i) => i.s.trim().length > 2 && !/p[aá]gina/i.test(i.s)).sort((a, b) => b.h - a.h)[0];
  return {
    number: labelValue(firstRows, /^(or[cç]amento|pedido|n[uú]mero|n[ºo°]\.?)$/i),
    date: isoDate(labelValue(firstRows, /^(data|emiss[aã]o)$/i)),
    representative: rep, supplierName: biggest?.s.trim() ?? rep,
    lines, totalQty, total, printedTotal: printed.total, printedQty: printed.qty, warnings,
  };
}

// ---------------------------------------------------------------------
// Catálogo de atacado
// ---------------------------------------------------------------------

export interface CatalogPdfEntry {
  page: number; name: string; color: string; composition: string | null; sizes: string[]; price: number | null;
}

/** "90% POLIAMIDA // 10% ELASTANO" → "90% Poliamida / 10% Elastano" (mesmo formato do site). */
export function formatComposition(s: string): string {
  return s.split(/\s*\/{1,2}\s*|\s*,\s*|\s+-\s+/).filter(Boolean).map((p) => titleCase(p).replace(/(\d)\s*%/g, "$1%")).join(" / ");
}

/**
 * Uma página do catálogo → modelo × cor. Reconhece a linha de preço (R$), a de composição (%), a de grade (tamanhos separados por / ou //);
 * o nome é a maior fonte e o que sobra é a cor. Página sem preço (capa, foto de ambiente) não é produto.
 */
export function parseCatalogPage(items: PdfTextItem[], page: number): CatalogPdfEntry | null {
  const rows = pdfRows(items, 4);
  let price: number | null = null, composition: string | null = null, sizes: string[] = [];
  const rest: { text: string; h: number }[] = [];
  for (const r of rows) {
    const text = rowText(r);
    const h = Math.max(...r.cells.map((c) => c.h));
    const priceMatch = text.match(/R\$\s*([\d.]+(?:,\d{1,2})?)/i);
    if (priceMatch && price === null) { price = parseBRNumber(priceMatch[1]); continue; }
    if (/\d+\s*%/.test(text) && composition === null) { composition = formatComposition(text); continue; }
    const tokens = text.split(/\s*[/|·,-]+\s*|\s+/).filter(Boolean);
    if (tokens.length >= 2 && tokens.every(isSize) && sizes.length === 0) { sizes = tokens.map((t) => t.toUpperCase()); continue; }
    rest.push({ text, h });
  }
  if (price === null || rest.length === 0) return null;
  const maxH = Math.max(...rest.map((r) => r.h));
  const nameParts = rest.filter((r) => r.h >= maxH * 0.8);
  const colorParts = rest.filter((r) => r.h < maxH * 0.8);
  const name = titleCase(nameParts.map((r) => r.text).join(" "));
  const color = titleCase(colorParts.map((r) => r.text).join(" "));
  if (!name) return null;
  return { page, name, color: color || "Única", composition, sizes, price };
}

export function parseCatalogPdf(pages: PdfTextItem[][]): CatalogPdfEntry[] {
  return pages.flatMap((items, i) => { const e = parseCatalogPage(items, i + 1); return e ? [e] : []; });
}

/** Junta páginas do mesmo modelo e cor (o catálogo às vezes repete a cor em duas páginas de fotos). */
export function groupCatalogEntries(entries: CatalogPdfEntry[]): (CatalogPdfEntry & { pages: number[] })[] {
  const out = new Map<string, CatalogPdfEntry & { pages: number[] }>();
  for (const e of entries) {
    const key = `${norm(e.name)}|${norm(e.color)}`;
    const cur = out.get(key);
    if (cur) {
      cur.pages.push(e.page);
      cur.sizes = [...new Set([...cur.sizes, ...e.sizes])];
      cur.composition ??= e.composition;
      cur.price ??= e.price;
    } else out.set(key, { ...e, pages: [e.page] });
  }
  return [...out.values()];
}

/** Compara nomes ignorando acento, maiúsculas e o sufixo de código ("Sky (012)" = "Sky"). */
export function sameName(a: string, b: string): boolean {
  const clean = (s: string) => norm(s).replace(/\s*\(\w+\)$/, "").replace(/\s+/g, " ");
  return clean(a) === clean(b);
}
