/** Seletor de período global (persistido na URL como ?periodo=mes). Datas em America/Sao_Paulo. */
export type PeriodKey = "hoje" | "7d" | "mes" | "mes-anterior" | "trimestre" | "ano";

export const PERIODS: { key: PeriodKey; label: string }[] = [
  { key: "hoje", label: "Hoje" },
  { key: "7d", label: "Últimos 7 dias" },
  { key: "mes", label: "Mês atual" },
  { key: "mes-anterior", label: "Mês anterior" },
  { key: "trimestre", label: "Trimestre" },
  { key: "ano", label: "Ano" },
];

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Data "hoje" no fuso de São Paulo (sem depender do fuso do servidor). */
export function todaySP(now = new Date()): Date {
  const s = now.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
  return new Date(`${s}T00:00:00Z`);
}

/** Intervalo [from, to] inclusivo em datas ISO (yyyy-mm-dd). */
export function periodRange(key: PeriodKey | string | undefined, now = new Date()): { from: string; to: string; key: PeriodKey } {
  const t = todaySP(now);
  const y = t.getUTCFullYear();
  const m = t.getUTCMonth();
  switch (key) {
    case "hoje":
      return { from: iso(t), to: iso(t), key: "hoje" };
    case "7d":
      return { from: iso(new Date(Date.UTC(y, m, t.getUTCDate() - 6))), to: iso(t), key: "7d" };
    case "mes-anterior":
      return { from: iso(new Date(Date.UTC(y, m - 1, 1))), to: iso(new Date(Date.UTC(y, m, 0))), key: "mes-anterior" };
    case "trimestre": {
      const q = Math.floor(m / 3) * 3;
      return { from: iso(new Date(Date.UTC(y, q, 1))), to: iso(t), key: "trimestre" };
    }
    case "ano":
      return { from: `${y}-01-01`, to: iso(t), key: "ano" };
    default:
      return { from: iso(new Date(Date.UTC(y, m, 1))), to: iso(t), key: "mes" };
  }
}
