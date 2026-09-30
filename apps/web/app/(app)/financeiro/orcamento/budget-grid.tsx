"use client";
import { useMemo, useState } from "react";
import { formatBRL } from "@sie/domain";
import { useKeptForm } from "@/components/use-kept-form";
import { Button, inputClass } from "@/components/ui";
import { saveBudgetAction } from "../plan-actions";

export interface BudgetAccount { id: string; code: string; name: string; grp: string; nature: string }
const MONTHS = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
const num = (v: string) => Number(v.replace(/\./g, "").replace(",", ".")) || 0;
const show = (n: number) => (n ? String(n).replace(".", ",") : "");

/** Grade conta × mês do orçamento. Receitas somam, despesas subtraem no resultado da última linha. */
export function BudgetGrid({ accounts, initial, budgetId, legalEntityId, year, name, scenario, editable }: {
  accounts: BudgetAccount[]; initial: Record<string, number[]>; budgetId?: string; legalEntityId: string; year: number; name: string; scenario: string; editable: boolean;
}) {
  const { state, pending, formProps } = useKeptForm(saveBudgetAction);
  const [values, setValues] = useState<Record<string, number[]>>(initial);
  const [budgetName, setBudgetName] = useState(name);
  const byId = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const rows = Object.keys(values).map((id) => byId.get(id)).filter(Boolean) as BudgetAccount[];
  rows.sort((a, b) => a.code.localeCompare(b.code));
  const free = accounts.filter((a) => !values[a.id]);

  const setCell = (id: string, m: number, v: number) => setValues((prev) => ({ ...prev, [id]: prev[id].map((x, i) => (i === m ? v : x)) }));
  const result = MONTHS.map((_, m) => rows.reduce((s, a) => s + (a.nature === "CREDIT" ? 1 : -1) * (values[a.id]?.[m] ?? 0), 0));

  const payload = JSON.stringify({
    ...(budgetId ? { id: budgetId } : {}), legal_entity_id: legalEntityId, year, name: budgetName, scenario, replace: true,
    lines: rows.flatMap((a) => (values[a.id] ?? []).map((amount, i) => ({ chart_account_id: a.id, month: i + 1, amount }))),
  });

  return (
    <form {...formProps} className="space-y-3">
      <input type="hidden" name="payload" value={payload} />
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-muted">Nome<input value={budgetName} onChange={(e) => setBudgetName(e.target.value)} disabled={!editable} className={`${inputClass} w-64`} maxLength={80} /></label>
        {editable && (
          <label className="text-xs text-muted">Adicionar conta
            <select className={`${inputClass} w-72`} value="" onChange={(e) => { if (e.target.value) setValues((p) => ({ ...p, [e.target.value]: Array(12).fill(0) })); }}>
              <option value="">Escolha…</option>{free.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
            </select>
          </label>
        )}
      </div>
      <div className="overflow-x-auto rounded-xl border border-border bg-surface">
        <table className="w-max min-w-full text-sm">
          <thead className="bg-surface-2 text-xs text-muted">
            <tr><th className="sticky left-0 bg-surface-2 px-3 py-2 text-left">Conta</th>{MONTHS.map((m) => <th key={m} className="w-24 px-1 py-2 text-right">{m}</th>)}<th className="px-3 py-2 text-right">Ano</th></tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length === 0 && <tr><td colSpan={14} className="px-3 py-6 text-center text-muted">Adicione as contas do orçamento (receitas e despesas).</td></tr>}
            {rows.map((a) => (
              <tr key={a.id}>
                <th className="sticky left-0 whitespace-nowrap bg-surface px-3 py-1 text-left font-normal"><span className="font-mono text-xs text-muted">{a.code}</span> {a.name}</th>
                {MONTHS.map((_, m) => (
                  <td key={m} className="px-1 py-1"><input inputMode="decimal" defaultValue={show(values[a.id][m])} disabled={!editable} onChange={(e) => setCell(a.id, m, num(e.target.value))}
                    className="w-24 rounded border border-border bg-bg px-1.5 py-1 text-right text-sm disabled:opacity-70" aria-label={`${a.code} ${MONTHS[m]}`} /></td>
                ))}
                <td className="px-3 py-1 text-right font-medium">{formatBRL(values[a.id].reduce((s, x) => s + x, 0))}</td>
              </tr>
            ))}
          </tbody>
          {rows.length > 0 && (
            <tfoot className="border-t border-border bg-surface-2 text-sm font-medium">
              <tr><th className="sticky left-0 bg-surface-2 px-3 py-2 text-left">Resultado</th>{result.map((r, i) => <td key={i} className={`px-1 py-2 text-right ${r < 0 ? "text-danger" : ""}`}>{formatBRL(r)}</td>)}
                <td className={`px-3 py-2 text-right ${result.reduce((s, x) => s + x, 0) < 0 ? "text-danger" : ""}`}>{formatBRL(result.reduce((s, x) => s + x, 0))}</td></tr>
            </tfoot>
          )}
        </table>
      </div>
      {state && !state.ok && <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{state.error}</p>}
      {editable && <Button disabled={pending || rows.length === 0}>{pending ? "Salvando…" : budgetId ? "Salvar orçamento" : "Criar orçamento"}</Button>}
    </form>
  );
}
