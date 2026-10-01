/**
 * CSV para o contador (Excel em português): separador ";", decimais com vírgula, datas dd/mm/aaaa, BOM UTF-8 e quebra de linha CRLF.
 * Texto que começa com = + - @ ganha uma aspa na frente: o Excel não executa como fórmula o que veio de um nome de cliente ou descrição.
 */
export type CsvCell = string | number | boolean | null | undefined;
export interface CsvColumn<T> { header: string; get: (row: T) => CsvCell; kind?: "text" | "money" | "date" }

const FORMULA = /^[=+\-@\t\r]/;

function cell(v: CsvCell, kind: CsvColumn<unknown>["kind"]): string {
  if (v === null || v === undefined || v === "") return "";
  let s: string;
  let numeric = false;
  if (kind === "money" && (typeof v === "number" || (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))))) { s = Number(v).toFixed(2).replace(".", ","); numeric = true; }
  else if (kind === "date" && typeof v === "string") s = /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10).split("-").reverse().join("/") : v;
  else if (typeof v === "boolean") s = v ? "sim" : "não";
  else s = String(v);
  if (!numeric && FORMULA.test(s)) s = `'${s}`;
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const head = columns.map((c) => cell(c.header, "text")).join(";");
  const body = rows.map((r) => columns.map((c) => cell(c.get(r), c.kind)).join(";"));
  return "﻿" + [head, ...body].join("\r\n") + "\r\n";
}

/** "2026-09" → limites do mês em horário de Brasília (início inclusivo, fim exclusivo) e as datas de negócio. */
export function monthBounds(ym: string): { from: string; to: string; fromDate: string; toDate: string; label: string } | null {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(ym);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const ny = mo === 12 ? y + 1 : y;
  const nm = mo === 12 ? 1 : mo + 1;
  const pad = (n: number) => String(n).padStart(2, "0");
  const fromDate = `${y}-${pad(mo)}-01`;
  const toDate = `${ny}-${pad(nm)}-01`;
  return { from: `${fromDate}T00:00:00-03:00`, to: `${toDate}T00:00:00-03:00`, fromDate, toDate, label: `${pad(mo)}/${y}` };
}
