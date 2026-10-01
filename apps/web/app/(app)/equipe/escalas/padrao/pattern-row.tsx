"use client";
import { useState } from "react";
import { fmtHours, netMinutes } from "@sie/domain";
import { Button } from "@/components/ui";
import { saveWeeklyPatternAction } from "../../actions";

interface Shift { id: string; code: string; start: string; end: string; breakMin: number }
const DAYS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
const ORDER = [1, 2, 3, 4, 5, 6, 0];

/** Uma linha: um turno (ou folga) por dia da semana. O total semanal aparece ao vivo, comparado com as horas contratadas. */
export function PatternRow({ employeeId, name, job, weeklyHours, shifts, initial, canEdit, back }: {
  employeeId: string; name: string; job: string; weeklyHours: number; shifts: Shift[]; initial: Record<string, string>; canEdit: boolean; back: string;
}) {
  const [v, setV] = useState<Record<string, string>>(initial);
  const byId = new Map(shifts.map((s) => [s.id, s]));
  const total = ORDER.reduce((a, d) => { const s = byId.get(v[String(d)] ?? ""); return a + (s ? netMinutes(s.start, s.end, s.breakMin) : 0); }, 0);
  const contracted = weeklyHours * 60;
  const over = total > contracted;
  const workDays = ORDER.filter((d) => byId.has(v[String(d)] ?? "")).length;

  return (
    <tr className="align-top">
      <th className="px-3 py-2 text-left font-medium">{name}<span className="block text-[11px] font-normal text-muted">{job}</span></th>
      {ORDER.map((d) => (
        <td key={d} className="px-1 py-2">
          <select form={`pat-${employeeId}`} name={`d${d}`} value={v[String(d)] ?? ""} disabled={!canEdit} aria-label={`${name}, ${DAYS[d]}`}
            onChange={(e) => setV({ ...v, [String(d)]: e.target.value })} className="w-full min-w-[5.5rem] rounded-lg border border-border bg-bg px-1.5 py-1 text-xs">
            <option value="">—</option><option value="OFF">Folga</option>
            {shifts.map((s) => <option key={s.id} value={s.id}>{s.code} {s.start}–{s.end}</option>)}
          </select>
        </td>
      ))}
      <td className="px-3 py-2 text-xs tabular-nums">
        <span className={over ? "font-semibold text-warning" : "font-semibold"}>{fmtHours(total)}</span> / {weeklyHours} h
        <span className="block text-muted">{workDays} dia(s) de trabalho</span>
        {over && <span className="block text-warning">acima do contratado</span>}
      </td>
      <td className="px-3 py-2">
        {canEdit && (
          <form id={`pat-${employeeId}`} action={saveWeeklyPatternAction}>
            <input type="hidden" name="employee" value={employeeId} /><input type="hidden" name="back" value={back} />
            <Button variant="secondary" className="px-2 py-1 text-xs">Salvar</Button>
          </form>
        )}
      </td>
    </tr>
  );
}
