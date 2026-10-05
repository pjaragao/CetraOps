"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { fmtHours, netMinutes } from "@centralops/domain";
import { setRosterCell, setRosterHours } from "../actions";

export interface GridDay { date: string; day: number; dow: number; holiday: string | null }
export interface GridShift { id: string; code: string; name: string; color: string; start: string; end: string; breakMin: number }
export type Cell = {
  kind: "WORK" | "DAY_OFF" | "COMP_TIME"; shiftId: string | null; status: "DRAFT" | "PUBLISHED";
  start: string | null; end: string | null; breakMin: number; notes: string | null;
};

const DOW = ["D", "S", "T", "Q", "Q", "S", "S"];
/** "09:00" → "9", "10:15" → "10:15": cabe na célula da grade */
const short = (t: string | null) => (!t ? "" : t.endsWith(":00") ? String(Number(t.slice(0, 2))) : `${Number(t.slice(0, 2))}:${t.slice(3, 5)}`);
const inputCls = "w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-sm";

/** Grade mensal da escala: clique numa célula para escolher um turno pronto, lançar qualquer horário, folga ou limpar. Férias e afastamentos vêm bloqueados. */
export function RosterGrid({ employees, days, cells, blocks, shifts, canEdit, minBreak }: {
  employees: { id: string; name: string; job: string; weeklyHours: number }[]; days: GridDay[];
  cells: Record<string, Record<string, Cell>>; blocks: Record<string, Record<string, string>>; shifts: GridShift[]; canEdit: boolean; minBreak: number;
}) {
  const router = useRouter();
  const [local, setLocal] = useState(cells);
  const [pick, setPick] = useState<{ emp: string; date: string } | null>(null);
  const [free, setFree] = useState({ start: "09:00", end: "15:00", breakMin: String(minBreak), notes: "" });
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const shift = new Map(shifts.map((s) => [s.id, s]));

  const open = (emp: string, date: string) => {
    const c = local[emp]?.[date];
    setFree(c?.kind === "WORK" && c.start && c.end
      ? { start: c.start, end: c.end, breakMin: String(c.breakMin), notes: c.notes ?? "" }
      : { start: "09:00", end: "15:00", breakMin: String(minBreak), notes: "" });
    setError(null);
    setPick({ emp, date });
  };

  const save = (emp: string, date: string, next: Cell | null, call: () => Promise<{ ok: boolean; error?: string }>) => {
    setPick(null);
    setError(null);
    start(async () => {
      const r = await call();
      if (!r.ok) { setError(r.error ?? "Erro"); return; }
      setLocal((prev) => {
        const copy = { ...prev, [emp]: { ...(prev[emp] ?? {}) } };
        if (next) copy[emp][date] = next; else delete copy[emp][date];
        return copy;
      });
      router.refresh();
    });
  };

  const applyShift = (emp: string, date: string, s: GridShift) =>
    save(emp, date, { kind: "WORK", shiftId: s.id, status: "DRAFT", start: s.start, end: s.end, breakMin: s.breakMin, notes: null }, () => setRosterCell(emp, date, "WORK", s.id));
  const applyKind = (emp: string, date: string, kind: "DAY_OFF" | "COMP_TIME" | "CLEAR") =>
    save(emp, date, kind === "CLEAR" ? null : { kind, shiftId: null, status: "DRAFT", start: null, end: null, breakMin: 0, notes: null }, () => setRosterCell(emp, date, kind));
  const applyFree = (emp: string, date: string) => {
    const b = Number(free.breakMin || 0);
    save(emp, date, { kind: "WORK", shiftId: null, status: "DRAFT", start: free.start, end: free.end, breakMin: b, notes: free.notes || null },
      () => setRosterHours(emp, date, free.start, free.end, b, free.notes));
  };

  const working = (date: string) => employees.filter((e) => local[e.id]?.[date]?.kind === "WORK").length;
  /** Minutos líquidos trabalhados de uma célula (turno ou horário livre). */
  const cellMin = (c: Cell | undefined) => (c?.kind === "WORK" ? netMinutes(c.start, c.end, c.breakMin) : 0);
  const monthMin = (emp: string) => days.reduce((a, d) => a + cellMin(local[emp]?.[d.date]), 0);
  /** Semana (segunda a domingo) da data escolhida, só com os dias deste mês. */
  const weekDays = (date: string) => {
    const d = new Date(`${date}T12:00:00Z`);
    const mon = new Date(d); mon.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    const set = new Set(Array.from({ length: 7 }, (_, i) => { const x = new Date(mon); x.setUTCDate(mon.getUTCDate() + i); return x.toISOString().slice(0, 10); }));
    return days.filter((x) => set.has(x.date)).map((x) => x.date);
  };
  const pickedCell = pick ? local[pick.emp]?.[pick.date] : undefined;

  return (
    <div>
      {error && <p role="alert" className="mb-2 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
      <div className="overflow-x-auto rounded-xl border border-border bg-surface">
        <table className="w-max min-w-full border-collapse text-xs">
          <thead>
            <tr className="bg-surface-2">
              <th className="sticky left-0 z-10 min-w-40 bg-surface-2 px-3 py-2 text-left font-medium">Colaborador</th>
              {days.map((d) => (
                <th key={d.date} title={d.holiday ?? undefined}
                  className={`w-11 min-w-11 px-1 py-1 text-center font-medium ${d.holiday ? "bg-warning/15 text-warning" : d.dow === 0 ? "bg-danger/10 text-danger" : ""}`}>
                  <span className="block text-[10px] opacity-70">{DOW[d.dow]}</span>{d.day}
                </th>
              ))}
              <th className="min-w-20 bg-surface-2 px-2 py-1 text-center font-medium" title="Horas trabalhadas no mês (presença menos intervalo)">Mês</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {employees.map((e) => (
              <tr key={e.id}>
                <th className="sticky left-0 z-10 bg-surface px-3 py-1.5 text-left font-medium">{e.name}<span className="block text-[10px] font-normal text-muted">{e.job}</span></th>
                {days.map((d) => {
                  const c = local[e.id]?.[d.date];
                  const b = blocks[e.id]?.[d.date];
                  const sh = c?.shiftId ? shift.get(c.shiftId) : undefined;
                  const hours = c?.kind === "WORK" && c.start && c.end ? `${c.start}–${c.end}${c.breakMin ? ` (intervalo ${c.breakMin} min)` : ""}` : "";
                  const title = [sh ? `${sh.code} ${sh.name}` : hours, c?.notes].filter(Boolean).join(" · ") || undefined;
                  return (
                    <td key={d.date} className={`h-9 border-l border-border p-0.5 text-center ${d.dow === 0 ? "bg-danger/5" : ""}`}>
                      {b === "PRE" ? <span className="block py-1.5 text-muted/30" title="Antes da admissão">–</span> : b ? <span className="block rounded bg-info/15 py-1.5 text-[10px] font-medium text-info" title={b === "VAC" ? "Férias" : "Afastamento"}>{b === "VAC" ? "FÉR" : "AFA"}</span> : (
                        <button type="button" disabled={!canEdit || pending} onClick={() => open(e.id, d.date)} title={title}
                          aria-label={`${e.name}, dia ${d.day}${title ? `: ${title}` : ""}`}
                          className={`relative block w-full rounded py-1.5 font-medium transition hover:ring-2 hover:ring-brand disabled:cursor-default ${c?.status === "PUBLISHED" ? "" : "opacity-80"} ${c?.kind === "WORK" && !sh ? "bg-brand/15 text-brand" : ""}`}
                          style={c?.kind === "WORK" && sh ? { background: `${sh.color}33`, color: sh.color } : undefined}>
                          {c?.kind === "WORK" ? (sh ? sh.code : <span className="block text-[9px] leading-tight">{short(c.start)}<br />{short(c.end)}</span>)
                            : c?.kind === "DAY_OFF" ? <span className="text-muted">F</span> : c?.kind === "COMP_TIME" ? <span className="text-muted">C</span> : <span className="text-muted/40">·</span>}
                          {c?.notes && <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-warning" aria-hidden="true" />}
                        </button>
                      )}
                    </td>
                  );
                })}
                <td className="border-l border-border px-2 text-center text-xs font-semibold tabular-nums">{fmtHours(monthMin(e.id))}</td>
              </tr>
            ))}
            <tr className="bg-surface-2 font-medium">
              <th className="sticky left-0 z-10 bg-surface-2 px-3 py-1.5 text-left">Pessoas na loja</th>
              {days.map((d) => <td key={d.date} className="border-l border-border py-1.5 text-center">{working(d.date) || ""}</td>)}
              <td className="border-l border-border" />
            </tr>
          </tbody>
        </table>
      </div>

      <div className="mt-2 flex flex-wrap gap-3 text-xs text-muted">
        {shifts.map((s) => <span key={s.id}><b style={{ color: s.color }}>{s.code}</b> {s.name}</span>)}
        <span><b>9 / 15</b> horário livre</span><span><b>F</b> folga</span><span><b>C</b> compensação</span><span><b>FÉR</b> férias</span><span><b>AFA</b> afastamento</span>
        <span><span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-warning" />com observação</span><span className="opacity-80">células claras = ainda não publicadas</span>
      </div>

      {pick && (
        <div className="fixed inset-0 z-40 grid place-items-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label="Editar dia da escala" onClick={() => setPick(null)}>
          <div className="max-h-[90dvh] w-full max-w-sm overflow-y-auto rounded-xl border border-border bg-surface p-4 shadow-xl" onClick={(ev) => ev.stopPropagation()}>
            <p className="mb-1 text-sm font-medium">{employees.find((e) => e.id === pick.emp)?.name} · {pick.date.split("-").reverse().join("/")}</p>
            {(() => {
              const emp = employees.find((e) => e.id === pick.emp);
              const wd = weekDays(pick.date);
              const week = wd.reduce((a, dt) => a + cellMin(local[pick.emp]?.[dt]), 0);
              const contracted = (emp?.weeklyHours ?? 0) * 60;
              return (
                <p className="mb-2 text-xs text-muted">Hoje: <b>{fmtHours(cellMin(pickedCell))}</b> · Semana{wd.length < 7 ? " (no mês)" : ""}: <b className={contracted && week > contracted ? "text-warning" : ""}>{fmtHours(week)}</b>{contracted ? ` de ${emp?.weeklyHours} h contratadas` : ""} · Mês: <b>{fmtHours(monthMin(pick.emp))}</b></p>
              );
            })()}
            {shifts.length > 0 && <p className="mb-1 text-xs font-medium text-muted">Turnos prontos</p>}
            <div className="grid gap-1.5">
              {shifts.map((s) => (
                <button key={s.id} type="button" className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 text-left text-sm hover:bg-surface-2" onClick={() => applyShift(pick.emp, pick.date, s)}>
                  <span><b style={{ color: s.color }}>{s.code}</b> {s.name}</span><span className="text-xs tabular-nums text-muted">{fmtHours(netMinutes(s.start, s.end, s.breakMin))}</span>
                </button>
              ))}
            </div>

            <form className="mt-3 rounded-lg border border-border p-3" onSubmit={(ev) => { ev.preventDefault(); applyFree(pick.emp, pick.date); }}>
              <p className="mb-2 text-xs font-medium text-muted">Horário livre neste dia</p>
              <div className="grid grid-cols-3 gap-2">
                <label className="text-xs text-muted">Início<input type="time" required value={free.start} onChange={(ev) => setFree({ ...free, start: ev.target.value })} className={`${inputCls} mt-1`} /></label>
                <label className="text-xs text-muted">Fim<input type="time" required value={free.end} onChange={(ev) => setFree({ ...free, end: ev.target.value })} className={`${inputCls} mt-1`} /></label>
                <label className="text-xs text-muted">Intervalo<input type="number" min={0} max={240} required value={free.breakMin} onChange={(ev) => setFree({ ...free, breakMin: ev.target.value })} className={`${inputCls} mt-1`} aria-label="Intervalo em minutos" /></label>
              </div>
              <label className="mt-2 block text-xs text-muted">Observação (opcional)<input maxLength={200} value={free.notes} onChange={(ev) => setFree({ ...free, notes: ev.target.value })} className={`${inputCls} mt-1`} placeholder="ex.: cobre a folga da Ana" /></label>
              <p className="mt-2 text-sm" aria-live="polite">Total trabalhado neste dia: <b>{netMinutes(free.start, free.end, Number(free.breakMin) || 0) > 0 ? fmtHours(netMinutes(free.start, free.end, Number(free.breakMin) || 0)) : "—"}</b></p>
              <button type="submit" className="mt-2 w-full rounded-lg bg-brand px-3 py-2 text-sm font-medium text-brand-contrast">Usar este horário</button>
              {pickedCell?.kind === "WORK" && pickedCell.shiftId && <p className="mt-1 text-[11px] text-muted">Substitui o turno pronto só neste dia.</p>}
            </form>

            <div className="mt-3 grid gap-1.5">
              <button type="button" className="rounded-lg border border-border px-3 py-2 text-left text-sm hover:bg-surface-2" onClick={() => applyKind(pick.emp, pick.date, "DAY_OFF")}>Folga</button>
              <button type="button" className="rounded-lg border border-border px-3 py-2 text-left text-sm hover:bg-surface-2" onClick={() => applyKind(pick.emp, pick.date, "COMP_TIME")}>Compensação de horas</button>
              <button type="button" className="rounded-lg px-3 py-2 text-left text-sm text-danger hover:bg-danger/10" onClick={() => applyKind(pick.emp, pick.date, "CLEAR")}>Limpar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
