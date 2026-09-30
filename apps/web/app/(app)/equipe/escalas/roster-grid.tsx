"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { setRosterCell } from "../actions";

export interface GridDay { date: string; day: number; dow: number; holiday: string | null }
export interface GridShift { id: string; code: string; name: string; color: string }
export type Cell = { kind: "WORK" | "DAY_OFF" | "COMP_TIME"; shiftId: string | null; status: "DRAFT" | "PUBLISHED" };

const DOW = ["D", "S", "T", "Q", "Q", "S", "S"];

/** Grade mensal da escala: clique numa célula para escolher turno, folga ou limpar. Férias e afastamentos vêm bloqueados. */
export function RosterGrid({ employees, days, cells, blocks, shifts, canEdit }: {
  employees: { id: string; name: string; job: string }[]; days: GridDay[];
  cells: Record<string, Record<string, Cell>>; blocks: Record<string, Record<string, string>>; shifts: GridShift[]; canEdit: boolean;
}) {
  const router = useRouter();
  const [local, setLocal] = useState(cells);
  const [pick, setPick] = useState<{ emp: string; date: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const shift = new Map(shifts.map((s) => [s.id, s]));

  const apply = (emp: string, date: string, kind: "WORK" | "DAY_OFF" | "COMP_TIME" | "CLEAR", shiftId?: string) => {
    setPick(null);
    setError(null);
    start(async () => {
      const r = await setRosterCell(emp, date, kind, shiftId);
      if (!r.ok) { setError(r.error ?? "Erro"); return; }
      setLocal((prev) => {
        const next = { ...prev, [emp]: { ...(prev[emp] ?? {}) } };
        if (kind === "CLEAR") delete next[emp][date];
        else next[emp][date] = { kind, shiftId: shiftId ?? null, status: "DRAFT" };
        return next;
      });
      router.refresh();
    });
  };

  const working = (date: string) => employees.filter((e) => local[e.id]?.[date]?.kind === "WORK").length;

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
                  return (
                    <td key={d.date} className={`h-9 border-l border-border p-0.5 text-center ${d.dow === 0 ? "bg-danger/5" : ""}`}>
                      {b === "PRE" ? <span className="block py-1.5 text-muted/30" title="Antes da admissão">–</span> : b ? <span className="block rounded bg-info/15 py-1.5 text-[10px] font-medium text-info" title={b === "VAC" ? "Férias" : "Afastamento"}>{b === "VAC" ? "FÉR" : "AFA"}</span> : (
                        <button type="button" disabled={!canEdit || pending} onClick={() => setPick({ emp: e.id, date: d.date })}
                          aria-label={`${e.name}, dia ${d.day}`}
                          className={`block w-full rounded py-1.5 font-medium transition hover:ring-2 hover:ring-brand disabled:cursor-default ${c?.status === "PUBLISHED" ? "" : "opacity-80"}`}
                          style={c?.kind === "WORK" && sh ? { background: `${sh.color}33`, color: sh.color } : undefined}>
                          {c?.kind === "WORK" ? (sh?.code ?? "•") : c?.kind === "DAY_OFF" ? <span className="text-muted">F</span> : c?.kind === "COMP_TIME" ? <span className="text-muted">C</span> : <span className="text-muted/40">·</span>}
                        </button>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
            <tr className="bg-surface-2 font-medium">
              <th className="sticky left-0 z-10 bg-surface-2 px-3 py-1.5 text-left">Pessoas na loja</th>
              {days.map((d) => <td key={d.date} className="border-l border-border py-1.5 text-center">{working(d.date) || ""}</td>)}
            </tr>
          </tbody>
        </table>
      </div>

      <div className="mt-2 flex flex-wrap gap-3 text-xs text-muted">
        {shifts.map((s) => <span key={s.id}><b style={{ color: s.color }}>{s.code}</b> {s.name}</span>)}
        <span><b>F</b> folga</span><span><b>C</b> compensação</span><span><b>FÉR</b> férias</span><span><b>AFA</b> afastamento</span><span className="opacity-80">células claras = ainda não publicadas</span>
      </div>

      {pick && (
        <div className="fixed inset-0 z-40 grid place-items-center bg-black/40 p-4" role="dialog" aria-modal="true" onClick={() => setPick(null)}>
          <div className="w-full max-w-xs rounded-xl border border-border bg-surface p-4 shadow-xl" onClick={(ev) => ev.stopPropagation()}>
            <p className="mb-2 text-sm font-medium">{employees.find((e) => e.id === pick.emp)?.name} · {pick.date.split("-").reverse().join("/")}</p>
            <div className="grid gap-1.5">
              {shifts.map((s) => (
                <button key={s.id} type="button" className="rounded-lg border border-border px-3 py-2 text-left text-sm hover:bg-surface-2" onClick={() => apply(pick.emp, pick.date, "WORK", s.id)}>
                  <b style={{ color: s.color }}>{s.code}</b> {s.name}
                </button>
              ))}
              <button type="button" className="rounded-lg border border-border px-3 py-2 text-left text-sm hover:bg-surface-2" onClick={() => apply(pick.emp, pick.date, "DAY_OFF")}>Folga</button>
              <button type="button" className="rounded-lg border border-border px-3 py-2 text-left text-sm hover:bg-surface-2" onClick={() => apply(pick.emp, pick.date, "COMP_TIME")}>Compensação de horas</button>
              <button type="button" className="rounded-lg px-3 py-2 text-left text-sm text-danger hover:bg-danger/10" onClick={() => apply(pick.emp, pick.date, "CLEAR")}>Limpar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
