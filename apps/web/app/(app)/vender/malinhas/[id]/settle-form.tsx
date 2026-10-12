"use client";
import { useState } from "react";
import { formatBRL } from "@centralops/domain";
import { useKeptForm } from "@/components/use-kept-form";
import { Button, inputClass } from "@/components/ui";
import { settleLoanAction } from "../actions";

type Outcome = "returned" | "sold" | "lost" | "damaged" | "gifted";
export interface SettleLine { id: string; sku: string; label: string; price: number | null; qty: number; done: Record<Outcome, number> }

const LABEL: Record<Outcome, string> = { returned: "Voltou", sold: "Vendida", lost: "Não voltou", damaged: "Avariada", gifted: "Brinde/permuta" };

export function SettleForm({ loanId, kind, lines, editable }: { loanId: string; kind: "TRY_ON" | "CAMPAIGN"; lines: SettleLine[]; editable: boolean }) {
  const { state, pending, formProps } = useKeptForm(settleLoanAction);
  const outcomes: Outcome[] = kind === "CAMPAIGN" ? ["returned", "sold", "lost", "damaged", "gifted"] : ["returned", "sold", "lost", "damaged"];
  const [now, setNow] = useState<Record<string, Record<Outcome, number>>>({});
  const pendingOf = (l: SettleLine) => l.qty - Object.values(l.done).reduce((a, b) => a + b, 0);
  const val = (id: string, o: Outcome) => now[id]?.[o] ?? 0;
  const set = (l: SettleLine, o: Outcome, n: number) => setNow((p) => {
    const cur: Record<Outcome, number> = p[l.id] ?? { returned: 0, sold: 0, lost: 0, damaged: 0, gifted: 0 };
    const others = Object.entries(cur).filter(([k]) => k !== o).reduce((a, [, v]) => a + v, 0);
    return { ...p, [l.id]: { ...cur, [o]: Math.max(0, Math.min(n, pendingOf(l) - others)) } };
  });
  const allBack = () => setNow(Object.fromEntries(lines.map((l) => [l.id, { returned: pendingOf(l), sold: 0, lost: 0, damaged: 0, gifted: 0 }])));
  const payload = JSON.stringify(lines.map((l) => ({ item_id: l.id, ...{ returned: 0, sold: 0, lost: 0, damaged: 0, gifted: 0 }, ...now[l.id] })));
  const soldValue = lines.reduce((a, l) => a + val(l.id, "sold") * (l.price ?? 0), 0);
  const any = Object.values(now).some((r) => Object.values(r).some((v) => v > 0));

  return (
    <form {...formProps} className="space-y-3">
      <input type="hidden" name="loan_id" value={loanId} />
      <input type="hidden" name="payload" value={payload} />
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs text-muted"><tr><th className="py-1 text-left">Peça</th><th className="py-1 text-right">Levou</th><th className="py-1 text-left pl-3">Já acertado</th>{editable && outcomes.map((o) => <th key={o} className="py-1 text-center">{LABEL[o]}</th>)}</tr></thead>
          <tbody className="divide-y divide-border">
            {lines.map((l) => {
              const pend = pendingOf(l);
              const done = (Object.entries(l.done) as [Outcome, number][]).filter(([, v]) => v > 0).map(([k, v]) => `${v} ${LABEL[k].toLowerCase()}`).join(", ");
              return (
                <tr key={l.id}>
                  <td className="py-1.5"><span className="font-mono text-xs text-muted">{l.sku}</span> {l.label}<span className="block text-xs text-muted">{l.price != null ? formatBRL(l.price) : "sem preço"}</span></td>
                  <td className="py-1.5 text-right tabular-nums">{l.qty}</td>
                  <td className="py-1.5 pl-3 text-xs text-muted">{done || "—"}{pend > 0 && <span className="block font-medium text-warning">{pend} pendente(s)</span>}</td>
                  {editable && outcomes.map((o) => (
                    <td key={o} className="py-1.5 text-center">
                      {pend > 0 ? <input type="number" min={0} max={pend} value={val(l.id, o)} onChange={(e) => set(l, o, Math.trunc(Number(e.target.value) || 0))} className={`${inputClass} mx-auto w-16 text-center`} aria-label={`${LABEL[o]}: ${l.sku}`} /> : null}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {editable && (
        <>
          <input name="notes" maxLength={300} className={inputClass} placeholder="Observação do acerto (opcional)" />
          {state && !state.ok && <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{state.error}</p>}
          {state?.ok && <p role="status" className="rounded-lg bg-success/10 px-3 py-2 text-sm text-success">{state.message}</p>}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="secondary" onClick={allBack}>Voltou tudo</Button>
            <Button disabled={pending || !any}>{pending ? "Registrando…" : soldValue > 0 ? `Registrar e vender (${formatBRL(soldValue)}) no PDV` : "Registrar acerto"}</Button>
            <span className="text-xs text-muted">Voltou e vendida retornam ao estoque da loja; a venda baixa no PDV. Não voltou/avariada{kind === "CAMPAIGN" ? "/brinde" : ""} saem do estoque.</span>
          </div>
        </>
      )}
    </form>
  );
}
