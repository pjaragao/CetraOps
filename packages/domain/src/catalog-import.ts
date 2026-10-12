/**
 * Planilhas de catálogo e estoque: leitura de CSV (separador ; ou , ; aspas; BOM do Excel), números no formato brasileiro e preço sugerido por markup.
 */

/** Lê CSV com aspas (campos com separador ou quebra de linha dentro de aspas, aspas duplicadas ""), descobrindo o separador pela 1ª linha. */
export function parseDelimited(text: string): string[][] {
  const src = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const firstLine = src.split("\n", 1)[0] ?? "";
  const sep = (firstLine.match(/;/g)?.length ?? 0) >= (firstLine.match(/,/g)?.length ?? 0) && firstLine.includes(";") ? ";"
    : firstLine.includes("\t") && !firstLine.includes(",") ? "\t" : ",";
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell.trim() === "") { quoted = true; cell = ""; }
    else if (ch === sep) { row.push(cell.trim()); cell = ""; }
    else if (ch === "\n") { row.push(cell.trim()); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell.trim()); rows.push(row); }
  return rows.filter((r) => r.some((c) => c !== ""));
}

/** "1.234,56" | "1234.56" | "R$ 99,90" | "" → número (ou null se vazio/ inválido). */
export function parseBRNumber(v: string | null | undefined): number | null {
  const s = String(v ?? "").trim().replace(/^R\$\s*/i, "").replace(/\s/g, "");
  if (!s) return null;
  const normalized = s.includes(",") ? s.replace(/\./g, "").replace(",", ".") : s;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

/**
 * Preço sugerido a partir do custo: custo × markup, arredondado para cima até o final escolhido (ex.: 0,90 → 129,90).
 * `ending` em centavos (90 = ,90; 0 = inteiro). Nunca abaixo de custo × markup.
 */
export function suggestPrice(cost: number, markup: number, ending = 90): number {
  if (!(cost > 0) || !(markup > 0)) return 0;
  const raw = Math.round(cost * markup * 100) / 100;
  const end = Math.max(0, Math.min(99, Math.round(ending))) / 100;
  let price = Math.floor(raw) + end;
  if (price + 1e-9 < raw) price += 1;
  return Math.round(price * 100) / 100;
}
