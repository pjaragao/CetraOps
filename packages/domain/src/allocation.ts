/**
 * Rateio na baixa: um movimento no banco pode quitar várias parcelas e carregar juros, multa, desconto, taxa,
 * retenção, tarifa, adiantamento e uso de crédito. Estas funções são o espelho (para a tela) das regras do banco:
 * quem decide é sempre `fin.settle`; aqui só calculamos totais e sugestões.
 */
import { roundCents } from "./money";

export type SettlementKind =
  | "PRINCIPAL" | "INTEREST" | "FINE" | "CHARGE" | "ADVANCE"
  | "DISCOUNT" | "FEE" | "WITHHOLDING" | "CREDIT_USE";

export type Direction = "PAYABLE" | "RECEIVABLE";

/** Tipos que SOMAM ao movimento no banco; os demais reduzem. */
const POSITIVE: ReadonlySet<SettlementKind> = new Set(["PRINCIPAL", "INTEREST", "FINE", "CHARGE", "ADVANCE"]);

export const SETTLEMENT_KIND_LABEL: Record<SettlementKind, string> = {
  PRINCIPAL: "Principal",
  INTEREST: "Juros",
  FINE: "Multa",
  CHARGE: "Tarifa / encargo",
  ADVANCE: "Adiantamento / sobra",
  DISCOUNT: "Desconto",
  FEE: "Taxa descontada",
  WITHHOLDING: "Retenção de tributo",
  CREDIT_USE: "Uso de crédito",
};

/** Tipos permitidos por direção (espelha as regras de fin.settle). */
export function kindsFor(direction: Direction): SettlementKind[] {
  const all = Object.keys(SETTLEMENT_KIND_LABEL) as SettlementKind[];
  return all.filter((k) => (direction === "PAYABLE" ? k !== "FEE" : k !== "CHARGE"));
}

export interface SettlementLineInput {
  kind: SettlementKind;
  amount: number;
  installment_id?: string;
  chart_account_id?: string;
  cost_center_id?: string;
  credit_id?: string;
  memo?: string;
}

export function cashEffect(kind: SettlementKind, amount: number): number {
  return POSITIVE.has(kind) ? amount : -amount;
}

/** Movimento líquido no banco = soma dos efeitos em caixa dos itens. */
export function netCash(lines: Pick<SettlementLineInput, "kind" | "amount">[]): number {
  return roundCents(lines.reduce((a, l) => a + cashEffect(l.kind, l.amount), 0));
}

export interface OpenItem {
  id: string;
  balance: number;
  due_date: string;
}

/**
 * Distribui um valor pelas parcelas do mais antigo para o mais novo (principal). O que sobrar
 * (`rest`) é adiantamento/sobra a decidir pelo usuário.
 */
export function allocateOldestFirst(target: number, items: OpenItem[]): { byId: Record<string, number>; rest: number } {
  let left = roundCents(target);
  const byId: Record<string, number> = {};
  for (const it of [...items].sort((a, b) => a.due_date.localeCompare(b.due_date) || a.id.localeCompare(b.id))) {
    if (left <= 0) break;
    const take = roundCents(Math.min(left, it.balance));
    if (take > 0) {
      byId[it.id] = take;
      left = roundCents(left - take);
    }
  }
  return { byId, rest: left };
}

const cents = (v: number) => Math.round(v * 100);

/**
 * Acha um subconjunto de parcelas cuja soma é EXATAMENTE o valor do extrato (busca meet-in-the-middle, até 24
 * parcelas — as mais antigas). Entre as soluções, prefere a que usa as parcelas mais antigas. Devolve os ids ou null.
 */
export function findExactCombination(
  target: number,
  items: { id: string; amount: number; due_date: string }[],
  maxItems = 24,
): string[] | null {
  const T = cents(target);
  if (T <= 0) return null;
  const pool = [...items]
    .filter((i) => cents(i.amount) > 0 && cents(i.amount) <= T)
    .sort((a, b) => a.due_date.localeCompare(b.due_date) || a.id.localeCompare(b.id))
    .slice(0, maxItems);
  if (pool.length === 0) return null;

  const half = Math.floor(pool.length / 2);
  const A = pool.slice(0, half);
  const B = pool.slice(half);

  const enumerate = (arr: typeof pool, offset: number) => {
    const out: { sum: number; mask: number; score: number }[] = [];
    for (let m = 0; m < 1 << arr.length; m++) {
      let sum = 0;
      let score = 0;
      for (let i = 0; i < arr.length; i++) {
        if (m & (1 << i)) {
          sum += cents(arr[i].amount);
          score += offset + i; // posição na fila por antiguidade: quanto menor, mais antiga
        }
      }
      if (sum <= T) out.push({ sum, mask: m, score });
    }
    return out;
  };

  const ea = enumerate(A, 0);
  const eb = enumerate(B, A.length);
  const bestB = new Map<number, { mask: number; score: number }>();
  for (const b of eb) {
    const cur = bestB.get(b.sum);
    if (!cur || b.score < cur.score) bestB.set(b.sum, { mask: b.mask, score: b.score });
  }
  let best: { a: number; b: number; score: number; size: number } | null = null;
  for (const a of ea) {
    const b = bestB.get(T - a.sum);
    if (!b) continue;
    const score = a.score + b.score;
    const size = popcount(a.mask) + popcount(b.mask);
    if (size === 0) continue;
    // menos itens "novos" primeiro; empate → menos itens no total
    if (!best || score < best.score || (score === best.score && size < best.size)) best = { a: a.mask, b: b.mask, score, size };
  }
  if (!best) return null;
  const ids: string[] = [];
  A.forEach((it, i) => { if (best!.a & (1 << i)) ids.push(it.id); });
  B.forEach((it, i) => { if (best!.b & (1 << i)) ids.push(it.id); });
  return ids;
}

function popcount(n: number) {
  let c = 0;
  while (n) { c += n & 1; n >>= 1; }
  return c;
}

/**
 * Juros e multa de atraso pelo contrato/boleto: multa fixa (%) + juros simples ao mês (pro rata por dia).
 * Sugestão para preencher a tela; o valor efetivamente pago é o que o usuário confirma.
 */
export function lateCharges(balance: number, daysLate: number, finePct = 2, monthlyInterestPct = 1): { fine: number; interest: number } {
  if (daysLate <= 0) return { fine: 0, interest: 0 };
  return {
    fine: roundCents((balance * finePct) / 100),
    interest: roundCents((balance * monthlyInterestPct * daysLate) / 3000),
  };
}
