/**
 * Arquivo de recebíveis da adquirente no layout padrão do CentralOps (uma linha por parcela a receber). Serve para qualquer adquirente que exporte
 * relatório: basta ajustar as colunas na planilha. Cada adquirente com API ganha um adaptador próprio depois; este é o caminho comum.
 *
 * Colunas (separador ; ou ,): codigo, nsu, autorizacao, terminal, bandeira, final_cartao, data_hora, forma (PIX|DEBITO|CREDITO), parcelas, valor_bruto,
 * mdr, antecipacao, parcela, previsao, bruto_parcela, mdr_parcela, antecipacao_parcela, liquido_parcela, repasse, data_repasse, valor_repasse
 * Obrigatórias: codigo, data_hora, forma, valor_bruto. Valores aceitam 1.234,56 ou 1234.56; datas dd/mm/aaaa [hh:mm] ou aaaa-mm-dd.
 */
export const ACQUIRER_CSV_HEADER = ["codigo", "nsu", "autorizacao", "terminal", "bandeira", "final_cartao", "data_hora", "forma", "parcelas", "valor_bruto", "mdr", "antecipacao",
  "parcela", "previsao", "bruto_parcela", "mdr_parcela", "antecipacao_parcela", "liquido_parcela", "repasse", "data_repasse", "valor_repasse"] as const;

export interface AcquirerReceivable { n: number; expected_date: string | null; gross: number; mdr_fee: number; anticipation_fee: number; net: number; payout_external_id: string | null }
export interface AcquirerTransaction {
  external_id: string; nsu: string | null; auth_code: string | null; terminal: string | null; brand: string | null; last4: string | null; captured_at: string;
  method: "PIX" | "DEBIT" | "CREDIT"; installments: number; gross: number; mdr_fee: number; anticipation_fee: number; receivables: AcquirerReceivable[];
}
export interface AcquirerPayout { external_id: string; paid_on: string; amount: number }
export interface AcquirerParse { transactions: AcquirerTransaction[]; payouts: AcquirerPayout[]; errors: string[] }

const round2 = (n: number) => Math.round(n * 100) / 100;

export function parseAcquirerMoney(v: string | undefined): number | null {
  const s = (v ?? "").trim().replace(/^R\$\s?/, "");
  if (!s) return null;
  const n = Number(s.includes(",") ? s.replace(/\./g, "").replace(",", ".") : s);
  return Number.isFinite(n) ? n : null;
}

/** dd/mm/aaaa [hh:mm[:ss]] ou aaaa-mm-dd[Thh:mm] → ISO. Sem fuso, vale o horário de Brasília. */
export function parseAcquirerDate(v: string | undefined, dateOnly = false): string | null {
  const s = (v ?? "").trim();
  if (!s) return null;
  let m = /^(\d{2})\/(\d{2})\/(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  let y: string, mo: string, d: string, hh = "00", mi = "00", ss = "00";
  if (m) { [, d, mo, y] = m as unknown as string[]; hh = m[4] ?? "00"; mi = m[5] ?? "00"; ss = m[6] ?? "00"; }
  else {
    m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?(Z|[+-]\d{2}:\d{2})?$/.exec(s);
    if (!m) return null;
    [, y, mo, d] = m as unknown as string[]; hh = m[4] ?? "00"; mi = m[5] ?? "00"; ss = m[6] ?? "00";
    if (m[7]) return dateOnly ? `${y}-${mo}-${d}` : `${y}-${mo}-${d}T${hh}:${mi}:${ss}${m[7]}`;
  }
  if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31) return null;
  return dateOnly ? `${y}-${mo}-${d}` : `${y}-${mo}-${d}T${hh}:${mi}:${ss}-03:00`;
}

function splitLine(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (c === sep && !q) { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

const METHOD: Record<string, AcquirerTransaction["method"]> = { PIX: "PIX", DEBITO: "DEBIT", DÉBITO: "DEBIT", DEBIT: "DEBIT", CREDITO: "CREDIT", CRÉDITO: "CREDIT", CREDIT: "CREDIT" };

export function parseAcquirerCsv(text: string): AcquirerParse {
  const errors: string[] = [];
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) return { transactions: [], payouts: [], errors: ["O arquivo está vazio ou só tem o cabeçalho."] };
  const sep = (lines[0].match(/;/g)?.length ?? 0) >= (lines[0].match(/,/g)?.length ?? 0) ? ";" : ",";
  const head = splitLine(lines[0], sep).map((h) => h.toLowerCase());
  const col = (name: string) => head.indexOf(name);
  for (const req of ["codigo", "data_hora", "forma", "valor_bruto"]) if (col(req) < 0) errors.push(`Falta a coluna obrigatória “${req}”.`);
  if (errors.length) return { transactions: [], payouts: [], errors };

  const byCode = new Map<string, AcquirerTransaction>();
  const payoutRows = new Map<string, { paid_on: string | null; explicit: number | null; net: number }>();
  lines.slice(1).forEach((line, idx) => {
    const row = splitLine(line, sep);
    const get = (name: string) => (col(name) >= 0 ? row[col(name)] ?? "" : "");
    const at = `Linha ${idx + 2}`;
    const code = get("codigo");
    if (!code) { errors.push(`${at}: sem código da transação.`); return; }
    let tx = byCode.get(code);
    if (!tx) {
      const captured = parseAcquirerDate(get("data_hora"));
      const method = METHOD[get("forma").toUpperCase()];
      const gross = parseAcquirerMoney(get("valor_bruto"));
      if (!captured) { errors.push(`${at}: data_hora inválida (use dd/mm/aaaa hh:mm).`); return; }
      if (!method) { errors.push(`${at}: forma “${get("forma")}” inválida (PIX, DEBITO ou CREDITO).`); return; }
      if (gross === null || gross <= 0) { errors.push(`${at}: valor_bruto inválido.`); return; }
      tx = { external_id: code, nsu: get("nsu") || null, auth_code: get("autorizacao") || null, terminal: get("terminal") || null, brand: get("bandeira") || null, last4: get("final_cartao") || null,
        captured_at: captured, method, installments: Math.max(1, Math.min(24, Number(get("parcelas")) || 1)), gross: round2(gross), mdr_fee: parseAcquirerMoney(get("mdr")) ?? 0,
        anticipation_fee: parseAcquirerMoney(get("antecipacao")) ?? 0, receivables: [] };
      byCode.set(code, tx);
    }
    const n = Number(get("parcela"));
    if (n) {
      const gross = parseAcquirerMoney(get("bruto_parcela"));
      if (gross === null) { errors.push(`${at}: bruto_parcela inválido.`); return; }
      const mdr = parseAcquirerMoney(get("mdr_parcela")) ?? 0;
      const ant = parseAcquirerMoney(get("antecipacao_parcela")) ?? 0;
      const net = parseAcquirerMoney(get("liquido_parcela")) ?? round2(gross - mdr - ant);
      const payout = get("repasse") || null;
      tx.receivables.push({ n, expected_date: parseAcquirerDate(get("previsao"), true), gross: round2(gross), mdr_fee: round2(mdr), anticipation_fee: round2(ant), net: round2(net), payout_external_id: payout });
      if (payout) {
        const p = payoutRows.get(payout) ?? { paid_on: null, explicit: null, net: 0 };
        p.paid_on = p.paid_on ?? parseAcquirerDate(get("data_repasse"), true);
        p.explicit = p.explicit ?? parseAcquirerMoney(get("valor_repasse"));
        p.net = round2(p.net + net);
        payoutRows.set(payout, p);
      }
    }
  });
  const payouts: AcquirerPayout[] = [];
  for (const [code, p] of payoutRows) {
    if (!p.paid_on) { errors.push(`Repasse ${code}: falta data_repasse.`); continue; }
    payouts.push({ external_id: code, paid_on: p.paid_on, amount: round2(p.explicit ?? p.net) });
  }
  // sem totais de taxa na linha da transação, soma o das parcelas
  for (const tx of byCode.values()) {
    if (tx.receivables.length > 0 && tx.mdr_fee === 0) tx.mdr_fee = round2(tx.receivables.reduce((a, r) => a + r.mdr_fee, 0));
    if (tx.receivables.length > 0 && tx.anticipation_fee === 0) tx.anticipation_fee = round2(tx.receivables.reduce((a, r) => a + r.anticipation_fee, 0));
  }
  return { transactions: [...byCode.values()], payouts, errors };
}

export function acquirerCsvTemplate(): string {
  const example = ["ST-0001", "123456", "A1B2C3", "T-01", "VISA", "4242", "30/09/2026 14:32", "CREDITO", "2", "300,00", "5,10", "0,00", "1", "30/10/2026", "150,00", "2,55", "0,00", "147,45", "REP-2026-10-30", "30/10/2026", ""];
  const example2 = ["ST-0001", "123456", "A1B2C3", "T-01", "VISA", "4242", "30/09/2026 14:32", "CREDITO", "2", "300,00", "5,10", "0,00", "2", "29/11/2026", "150,00", "2,55", "0,00", "147,45", "REP-2026-11-29", "29/11/2026", ""];
  return "﻿" + [ACQUIRER_CSV_HEADER.join(";"), example.join(";"), example2.join(";")].join("\r\n") + "\r\n";
}
