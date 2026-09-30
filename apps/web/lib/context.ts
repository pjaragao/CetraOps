import "server-only";
import { periodRange, todaySP } from "@sie/domain";

/** Converte o período da URL em limites timestamptz no fuso de São Paulo. */
export function periodBounds(periodo?: string) {
  const r = periodRange(periodo);
  return {
    ...r,
    fromTs: `${r.from}T00:00:00-03:00`,
    toTs: `${r.to}T23:59:59.999-03:00`,
  };
}

export type SP = Promise<Record<string, string | string[] | undefined>>;

export function str(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** Instante ISO daqui a h horas (fora do corpo do componente, que deve ser puro). */
export function isoFromNow(hours = 0): string {
  return new Date(Date.now() + hours * 3600_000).toISOString();
}

/** Dias inteiros desde uma data. */
export function daysSince(date: string | null): number | null {
  return date ? Math.floor((Date.now() - new Date(date).getTime()) / 86400000) : null;
}

/** Data de hoje (yyyy-mm-dd) no fuso de São Paulo. */
export function todayIsoSP(): string {
  return todaySP().toISOString().slice(0, 10);
}
