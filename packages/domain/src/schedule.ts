/** Horas de escala: minutos líquidos de uma jornada (fim menor que o início = vira a meia-noite) e formatação "7h15". */
const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

export function spanMinutes(start: string, end: string): number {
  let m = toMin(end) - toMin(start);
  if (m <= 0) m += 1440;
  return m;
}

/** Jornada líquida (sem o intervalo). Início igual ao fim = 0. */
export function netMinutes(start: string | null, end: string | null, breakMin: number): number {
  if (!start || !end || start.slice(0, 5) === end.slice(0, 5)) return 0;
  return Math.max(0, spanMinutes(start, end) - Math.max(0, breakMin));
}

export function fmtHours(min: number): string {
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return m ? `${h}h${String(m).padStart(2, "0")}` : `${h}h`;
}
