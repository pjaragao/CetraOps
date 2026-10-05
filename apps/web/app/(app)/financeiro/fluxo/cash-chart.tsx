import { formatBRL } from "@centralops/domain";

export interface FlowDay { day: string; inn: number; out: number; projected: boolean; balance: number }

/** Barras de entradas/saídas por dia e linha do saldo. SVG puro (sem biblioteca), acessível por título e tabela ao lado. */
export function CashChart({ days, today }: { days: FlowDay[]; today: string }) {
  const W = 960, H = 260, padL = 64, padR = 12, padT = 12, padB = 26;
  const iw = W - padL - padR, ih = H - padT - padB;
  const maxBar = Math.max(1, ...days.map((d) => Math.max(d.inn, d.out)));
  const bals = days.map((d) => d.balance);
  const minB = Math.min(0, ...bals), maxB = Math.max(1, ...bals);
  const span = maxB - minB || 1;
  const x = (i: number) => padL + (days.length <= 1 ? iw / 2 : (i / (days.length - 1)) * iw);
  const yB = (v: number) => padT + ih - ((v - minB) / span) * ih;
  const barH = (v: number) => (v / maxBar) * (ih * 0.32);
  const bw = Math.max(2, Math.min(14, iw / Math.max(days.length, 1) - 2));
  const zeroY = yB(0);
  const path = days.map((d, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${yB(d.balance).toFixed(1)}`).join(" ");
  const ticks = [minB, minB + span / 2, maxB];
  const todayIdx = days.findIndex((d) => d.day === today);
  const label = (iso: string) => iso.slice(8, 10) + "/" + iso.slice(5, 7);

  return (
    <figure>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Fluxo de caixa diário: entradas, saídas e saldo" className="w-full">
        <title>Fluxo de caixa diário: entradas, saídas e saldo</title>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={padL} x2={W - padR} y1={yB(t)} y2={yB(t)} stroke="currentColor" opacity={0.12} />
            <text x={padL - 6} y={yB(t) + 4} textAnchor="end" fontSize="10" fill="currentColor" opacity={0.6}>{formatBRL(Math.round(t))}</text>
          </g>
        ))}
        {minB < 0 && <line x1={padL} x2={W - padR} y1={zeroY} y2={zeroY} stroke="var(--color-danger, #c0392b)" opacity={0.5} strokeDasharray="4 3" />}
        {todayIdx >= 0 && <line x1={x(todayIdx)} x2={x(todayIdx)} y1={padT} y2={H - padB} stroke="currentColor" opacity={0.3} strokeDasharray="2 3" />}
        {days.map((d, i) => (
          <g key={d.day} opacity={d.projected ? 0.55 : 1}>
            {d.inn > 0 && <rect x={x(i) - bw / 2} y={H - padB - barH(d.inn)} width={bw} height={barH(d.inn)} fill="var(--color-success, #2e8b57)"><title>{`${label(d.day)} entradas ${formatBRL(d.inn)}`}</title></rect>}
            {d.out > 0 && <rect x={x(i) - bw / 2} y={H - padB - barH(d.out) - (d.inn > 0 ? barH(d.inn) : 0)} width={bw} height={barH(d.out)} fill="var(--color-danger, #c0392b)"><title>{`${label(d.day)} saídas ${formatBRL(d.out)}`}</title></rect>}
          </g>
        ))}
        <path d={path} fill="none" stroke="var(--color-brand, #7b2d3b)" strokeWidth={2} />
        {days.filter((_, i) => i % Math.ceil(days.length / 8) === 0).map((d) => (
          <text key={d.day} x={x(days.indexOf(d))} y={H - 8} textAnchor="middle" fontSize="10" fill="currentColor" opacity={0.6}>{label(d.day)}</text>
        ))}
      </svg>
      <figcaption className="mt-1 flex flex-wrap gap-4 text-xs text-muted">
        <span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-success" />entradas</span>
        <span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-danger" />saídas</span>
        <span><span className="mr-1 inline-block h-0.5 w-4 bg-brand align-middle" />saldo</span>
        <span>barras claras = projetado a partir das parcelas em aberto · linha pontilhada = hoje</span>
      </figcaption>
    </figure>
  );
}
