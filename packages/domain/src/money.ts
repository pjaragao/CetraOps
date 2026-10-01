const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const pct = new Intl.NumberFormat("pt-BR", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 2 });

/** Formata valor em reais: 1234.5 → "R$ 1.234,50" (espaço não separável normalizado). */
export function formatBRL(value: number | string | null | undefined): string {
  const n = typeof value === "string" ? Number(value) : value ?? 0;
  return brl.format(Number.isFinite(n) ? n : 0).replace(/ /g, " ");
}

/** Formata fração como percentual: 0.0471 → "4,71%". */
export function formatPct(fraction: number): string {
  return pct.format(fraction).replace(/ /g, " ");
}

/** Arredonda em centavos evitando erro de ponto flutuante. */
export function roundCents(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Divide um valor em n parcelas; a diferença de centavos fica na última (mesma regra do banco). */
export function splitInstallments(total: number, n: number): number[] {
  if (n < 1) throw new Error("Número de parcelas inválido");
  const each = roundCents(total / n);
  const parts = Array.from({ length: n }, () => each);
  parts[n - 1] = roundCents(total - each * (n - 1));
  return parts;
}
