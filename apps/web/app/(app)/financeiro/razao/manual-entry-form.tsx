"use client";
import { useState } from "react";
import { useKeptForm } from "@/components/use-kept-form";
import { formatBRL } from "@centralops/domain";
import { Button, inputClass } from "@/components/ui";
import { manualEntryAction } from "../actions";

interface Opt { id: string; label: string }
const toNum = (s: string) => Number(String(s).replace(/\./g, "").replace(",", ".")) || 0;

/** Lançamento contábil manual (ajustes do contador): partidas dobradas com conferência de débito × crédito. */
export function ManualEntryForm({ entities, accounts, costCenters, today }: { entities: Opt[]; accounts: Opt[]; costCenters: Opt[]; today: string }) {
  const { state, pending, formProps } = useKeptForm(manualEntryAction);
  const [vals, setVals] = useState<{ d: string; c: string }[]>(Array.from({ length: 6 }, () => ({ d: "", c: "" })));
  const deb = vals.reduce((a, v) => a + toNum(v.d), 0);
  const cred = vals.reduce((a, v) => a + toNum(v.c), 0);
  const ok = deb > 0 && Math.abs(deb - cred) < 0.005;
  return (
    <form {...formProps} className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-4">
        <label className="text-xs text-muted">Empresa<select name="entity" className={inputClass} required>{entities.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}</select></label>
        <label className="text-xs text-muted">Data<input name="date" type="date" defaultValue={today} className={inputClass} required /></label>
        <label className="text-xs text-muted sm:col-span-2">Histórico<input name="description" className={inputClass} required maxLength={200} placeholder="Ex.: Ajuste de depreciação" /></label>
      </div>
      <div className="space-y-1.5">
        <div className="grid grid-cols-[1fr_1fr_6.5rem_6.5rem] gap-2 text-xs text-muted"><span>Conta</span><span>Centro de custo</span><span>Débito</span><span>Crédito</span></div>
        {vals.map((v, i) => (
          <div key={i} className="grid grid-cols-[1fr_1fr_6.5rem_6.5rem] gap-2">
            <select name={`account_${i}`} className={inputClass} aria-label={`Conta ${i + 1}`}><option value="">—</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}</select>
            <select name={`cc_${i}`} className={inputClass} aria-label={`Centro de custo ${i + 1}`}><option value="">—</option>{costCenters.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select>
            <input name={`debit_${i}`} className={inputClass} inputMode="decimal" value={v.d} onChange={(e) => setVals(vals.map((x, j) => (j === i ? { ...x, d: e.target.value } : x)))} aria-label={`Débito ${i + 1}`} />
            <input name={`credit_${i}`} className={inputClass} inputMode="decimal" value={v.c} onChange={(e) => setVals(vals.map((x, j) => (j === i ? { ...x, c: e.target.value } : x)))} aria-label={`Crédito ${i + 1}`} />
          </div>
        ))}
      </div>
      <p className={`text-sm ${ok ? "text-success" : "text-muted"}`}>Débitos {formatBRL(deb)} · Créditos {formatBRL(cred)} {ok ? "— fecha" : deb || cred ? "— não fecha" : ""}</p>
      {state && <p className={`rounded-lg px-3 py-2 text-sm ${state.ok ? "bg-success/10 text-success" : "bg-danger/10 text-danger"}`} role="status">{state.ok ? state.message : state.error}</p>}
      <Button disabled={pending || !ok}>{pending ? "Lançando…" : "Lançar"}</Button>
    </form>
  );
}
