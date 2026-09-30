/**
 * Leitura de extratos bancários (OFX v1/v2 e CSV de Inter, BTG, Mercado Pago e genéricos) para a conciliação.
 * Funções puras: recebem o texto do arquivo e devolvem linhas normalizadas (valor com sinal do ponto de vista do banco).
 */

export interface StatementLineInput {
  posted_on: string; // yyyy-mm-dd
  amount: number; // + crédito · − débito
  description: string;
  external_id?: string;
  e2e_id?: string;
  counterpart_name?: string;
  counterpart_doc?: string;
  balance_after?: number;
}

export interface ParsedStatement {
  source: "OFX" | "CSV";
  lines: StatementLineInput[];
  period_start?: string;
  period_end?: string;
  opening_balance?: number;
  closing_balance?: number;
  warnings: string[];
}

const E2E_RE = /\b[ED]\d{8}\d{12}[A-Za-z0-9]{11}\b/;
const DOC_RE = /\b(\d{14}|\d{11}|\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}|\d{3}\.\d{3}\.\d{3}-\d{2})\b/;

/** "1.234,56" · "-1234.56" · "R$ 1.234,56" · "(1.234,56)" → número. */
export function parseMoney(raw: string): number | null {
  let s = raw.trim().replace(/R\$|\s/g, "");
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (s.startsWith("-")) { neg = !neg; s = s.slice(1); } else if (s.startsWith("+")) s = s.slice(1);
  if (s.endsWith("-")) { neg = !neg; s = s.slice(0, -1); }
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  else if ((s.match(/\./g) ?? []).length > 1) s = s.replace(/\./g, "");
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.round((neg ? -n : n) * 100) / 100;
}

/** "20260930" · "20260930120000[-3:BRT]" · "30/09/2026" · "2026-09-30T10:00:00Z" → yyyy-mm-dd. */
export function parseDate(raw: string): string | null {
  const s = raw.trim();
  let m = s.match(/^(\d{4})(\d{2})(\d{2})(?:\d{0,6})(?:\.\d+)?(?:\[.*\])?$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  return null;
}

// ---------------------------------------------------------------------
// OFX
// ---------------------------------------------------------------------
export function parseOfx(text: string): ParsedStatement {
  const warnings: string[] = [];
  const body = text.replace(/\r/g, "");
  const lines: StatementLineInput[] = [];

  const blocks = body.split(/<STMTTRN>/i).slice(1);
  for (const raw of blocks) {
    const block = raw.split(/<\/STMTTRN>/i)[0];
    const tags: Record<string, string> = {};
    for (const m of block.matchAll(/<([A-Z0-9.]+)>([^<\n]*)/gi)) tags[m[1].toUpperCase()] = m[2].trim();
    const date = tags.DTPOSTED ? parseDate(tags.DTPOSTED) : null;
    const amount = tags.TRNAMT ? parseMoney(tags.TRNAMT) : null;
    if (!date || amount === null || amount === 0) {
      if (amount !== 0) warnings.push(`Lançamento ignorado (data/valor inválidos): ${block.trim().slice(0, 60)}`);
      continue;
    }
    const memo = [tags.NAME, tags.MEMO].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(" · ") || tags.TRNTYPE || "Lançamento";
    const hay = `${memo} ${tags.REFNUM ?? ""} ${tags.FITID ?? ""}`;
    lines.push({
      posted_on: date,
      amount,
      description: memo.slice(0, 240),
      external_id: tags.FITID || undefined,
      e2e_id: hay.match(E2E_RE)?.[0],
      counterpart_doc: memo.match(DOC_RE)?.[1]?.replace(/\D/g, ""),
      counterpart_name: tags.NAME || undefined,
    });
  }
  if (lines.length === 0) warnings.push("Nenhum lançamento encontrado no arquivo OFX.");

  const dt = (tag: string) => body.match(new RegExp(`<${tag}>\\s*([0-9]{8})`, "i"))?.[1];
  const ledger = body.match(/<LEDGERBAL>[\s\S]*?<BALAMT>\s*([^<\n]+)/i)?.[1];
  const sorted = lines.map((l) => l.posted_on).sort();
  return {
    source: "OFX",
    lines,
    period_start: (dt("DTSTART") && parseDate(dt("DTSTART")!)) || sorted[0],
    period_end: (dt("DTEND") && parseDate(dt("DTEND")!)) || sorted[sorted.length - 1],
    closing_balance: ledger ? parseMoney(ledger) ?? undefined : undefined,
    warnings,
  };
}

// ---------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------
function splitCsvLine(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q;
    } else if (c === delim && !q) { out.push(cur); cur = ""; } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

export function parseBankCsv(text: string): ParsedStatement {
  const warnings: string[] = [];
  const rows = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim() !== "");
  // O cabeçalho pode vir depois de linhas de resumo (Inter): primeira linha que tenha "data" e "valor".
  const headerIdx = rows.findIndex((l) => {
    const n = norm(l);
    return /(data|date)/.test(n) && /(valor|amount|debito|credito|value)/.test(n);
  });
  if (headerIdx < 0) return { source: "CSV", lines: [], warnings: ["Cabeçalho não reconhecido: esperado colunas de data e valor."] };
  const delim = (rows[headerIdx].match(/;/g) ?? []).length >= (rows[headerIdx].match(/,/g) ?? []).length ? ";" : ",";
  const header = splitCsvLine(rows[headerIdx], delim).map(norm);
  const find = (re: RegExp) => header.findIndex((h) => re.test(h));

  const iDate = find(/^(data|date|release date|data lancamento|data movimentacao)/);
  const iDebit = find(/debito|debit/);
  const iCredit = find(/credito|credit/);
  const iAmount = find(/^(valor|amount|transaction net amount|value)/);
  const iBalance = find(/saldo|balance/);
  const iId = find(/reference id|id da transacao|documento|numero|refer/);
  const iDescs = header.map((h, i) => (/(descri|historico|memo|transaction type|lancamento$|detalhe|nome)/.test(h) ? i : -1)).filter((i) => i >= 0);
  if (iDate < 0 || (iAmount < 0 && iDebit < 0 && iCredit < 0)) {
    return { source: "CSV", lines: [], warnings: ["Colunas de data/valor não encontradas no CSV."] };
  }

  const lines: StatementLineInput[] = [];
  for (const raw of rows.slice(headerIdx + 1)) {
    const c = splitCsvLine(raw, delim);
    const date = parseDate(c[iDate] ?? "");
    let amount: number | null = null;
    if (iAmount >= 0) amount = parseMoney(c[iAmount] ?? "");
    else {
      const d = iDebit >= 0 ? parseMoney(c[iDebit] ?? "") ?? 0 : 0;
      const cr = iCredit >= 0 ? parseMoney(c[iCredit] ?? "") ?? 0 : 0;
      amount = Math.round((cr - Math.abs(d)) * 100) / 100;
    }
    if (!date || amount === null || amount === 0) {
      if (date && amount === null) warnings.push(`Linha ignorada (valor inválido): ${raw.slice(0, 60)}`);
      continue;
    }
    const description = iDescs.map((i) => c[i]).filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(" · ") || "Lançamento";
    const external = iId >= 0 ? c[iId] || undefined : undefined;
    lines.push({
      posted_on: date,
      amount,
      description: description.slice(0, 240),
      external_id: external,
      e2e_id: `${description} ${external ?? ""}`.match(E2E_RE)?.[0],
      counterpart_doc: description.match(DOC_RE)?.[1]?.replace(/\D/g, ""),
      balance_after: iBalance >= 0 ? parseMoney(c[iBalance] ?? "") ?? undefined : undefined,
    });
  }
  if (lines.length === 0) warnings.push("Nenhum lançamento encontrado no CSV.");
  const dates = lines.map((l) => l.posted_on).sort();
  return { source: "CSV", lines, period_start: dates[0], period_end: dates[dates.length - 1], warnings };
}

/** Escolhe o parser pelo conteúdo/extensão. */
export function parseStatement(filename: string, text: string): ParsedStatement {
  if (/\.ofx$/i.test(filename) || /<OFX>|OFXHEADER/i.test(text.slice(0, 2000))) return parseOfx(text);
  return parseBankCsv(text);
}
