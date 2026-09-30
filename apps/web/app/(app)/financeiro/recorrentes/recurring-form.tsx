"use client";
import { useKeptForm } from "@/components/use-kept-form";
import { Button, inputClass } from "@/components/ui";
import { Field } from "@/components/form";
import { saveRecurringAction } from "../plan-actions";

interface Opt { id: string; label: string }

export function RecurringForm({ entities, parties, accounts, costCenters, today }: { entities: Opt[]; parties: Opt[]; accounts: Opt[]; costCenters: Opt[]; today: string }) {
  const { state, pending, formProps } = useKeptForm(saveRecurringAction);
  return (
    <form {...formProps} className="grid gap-3 sm:grid-cols-6">
      <Field label="Descrição" className="sm:col-span-3"><input name="description" required maxLength={120} className={inputClass} placeholder="Ex.: Aluguel do depósito" /></Field>
      <Field label="Tipo" className="sm:col-span-1"><select name="direction" className={inputClass}><option value="PAYABLE">A pagar</option><option value="RECEIVABLE">A receber</option></select></Field>
      <Field label="Valor (R$)" className="sm:col-span-1"><input name="amount" required inputMode="decimal" className={inputClass} /></Field>
      <Field label="Dia do vencimento" className="sm:col-span-1"><input name="day_of_month" type="number" min={1} max={28} defaultValue={10} required className={inputClass} /></Field>
      <Field label="Empresa" className="sm:col-span-2"><select name="legal_entity_id" required className={inputClass}>{entities.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}</select></Field>
      <Field label="Fornecedor / cliente" className="sm:col-span-2"><select name="party_id" defaultValue="" className={inputClass}><option value="">—</option>{parties.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select></Field>
      <Field label="Conta contábil" className="sm:col-span-2"><select name="chart_account_id" defaultValue="" className={inputClass}><option value="">Despesas a classificar</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}</select></Field>
      <Field label="Centro de custo" className="sm:col-span-2"><select name="cost_center_id" defaultValue="" className={inputClass}><option value="">—</option>{costCenters.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select></Field>
      <Field label="Início" className="sm:col-span-1"><input name="start_date" type="date" defaultValue={today} required className={inputClass} /></Field>
      <Field label="Fim (opcional)" className="sm:col-span-1"><input name="end_date" type="date" className={inputClass} /></Field>
      <label className="flex items-center gap-2 text-sm sm:col-span-2 sm:self-end"><input type="checkbox" name="auto_approve" /> Aprovar automaticamente (senão vira rascunho)</label>
      <div className="sm:col-span-6">
        {state && <p role={state.ok ? "status" : "alert"} className={`mb-2 rounded-lg px-3 py-2 text-sm ${state.ok ? "bg-success/10 text-success" : "bg-danger/10 text-danger"}`}>{state.ok ? state.message : state.error}</p>}
        <Button disabled={pending}>{pending ? "Salvando…" : "Criar recorrência"}</Button>
      </div>
    </form>
  );
}
