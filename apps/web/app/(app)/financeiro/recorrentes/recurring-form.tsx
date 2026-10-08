"use client";
import { useState } from "react";
import Link from "next/link";
import { useKeptForm } from "@/components/use-kept-form";
import { Button, inputClass } from "@/components/ui";
import { Field } from "@/components/form";
import { SearchSelect, type SearchOption } from "@/components/search-select";
import { AiReadButton, type FinanceRead } from "@/components/ai-read-button";
import { saveRecurringAction } from "../plan-actions";

export interface RecurringValues {
  id?: string; description: string; direction: string; amount: string; day_of_month: number; legal_entity_id: string; party_id: string;
  chart_account_id: string; cost_center_id: string; start_date: string; end_date: string; auto_approve: boolean; active?: boolean;
}

/** Criar ou editar recorrência (com leitura do contrato/fatura por IA para preencher). */
export function RecurringForm({ entities, parties, accounts, costCenters, initial }: {
  entities: SearchOption[]; parties: SearchOption[]; accounts: SearchOption[]; costCenters: SearchOption[]; initial: RecurringValues;
}) {
  const { state, pending, formProps } = useKeptForm(saveRecurringAction);
  const [v, setV] = useState(initial);
  const [extra, setExtra] = useState<SearchOption[]>([]);
  const set = <K extends keyof RecurringValues>(k: K, x: RecurringValues[K]) => setV((p) => ({ ...p, [k]: x }));
  const fromAi = (d: FinanceRead) => {
    const f = d.fields;
    setV((p) => ({
      ...p,
      description: f.description ? String(f.description).slice(0, 120) : p.description,
      amount: typeof f.amount === "number" ? f.amount.toFixed(2).replace(".", ",") : p.amount,
      day_of_month: typeof f.day_of_month === "number" ? f.day_of_month : p.day_of_month,
      start_date: f.start_date ? String(f.start_date) : p.start_date,
      end_date: f.end_date ? String(f.end_date) : p.end_date,
      party_id: d.party?.id ?? p.party_id,
    }));
    if (d.party) setExtra((x) => [...x, d.party!]);
  };
  const partyOpts = [...extra.filter((e) => !parties.some((p) => p.id === e.id)), ...parties];
  return (
    <form {...formProps} className="grid gap-3 sm:grid-cols-6">
      {v.id && <input type="hidden" name="id" value={v.id} />}
      {v.id && <input type="hidden" name="active" value={v.active === false ? "0" : "1"} />}
      {!v.id && <div className="sm:col-span-6"><AiReadButton purpose="recorrencia" onRead={fromAi} label="Ler contrato ou fatura com IA" /></div>}
      <Field label="Descrição" className="sm:col-span-3"><input name="description" required maxLength={120} className={inputClass} value={v.description} onChange={(e) => set("description", e.target.value)} placeholder="Ex.: Aluguel do depósito" /></Field>
      <Field label="Tipo" className="sm:col-span-1"><select name="direction" className={inputClass} value={v.direction} onChange={(e) => set("direction", e.target.value)} disabled={Boolean(v.id)}><option value="PAYABLE">A pagar</option><option value="RECEIVABLE">A receber</option></select></Field>
      <Field label="Valor (R$)" className="sm:col-span-1"><input name="amount" required inputMode="decimal" className={inputClass} value={v.amount} onChange={(e) => set("amount", e.target.value)} /></Field>
      <Field label="Dia do vencimento" className="sm:col-span-1"><input name="day_of_month" type="number" min={1} max={28} required className={inputClass} value={v.day_of_month} onChange={(e) => set("day_of_month", Number(e.target.value))} /></Field>
      <Field label="Empresa" className="sm:col-span-2"><SearchSelect name="legal_entity_id" required options={entities} value={v.legal_entity_id} onChange={(x) => set("legal_entity_id", x)} disabled={Boolean(v.id)} ariaLabel="Empresa" /></Field>
      <Field label="Fornecedor / cliente" className="sm:col-span-2"><SearchSelect name="party_id" options={partyOpts} value={v.party_id} onChange={(x) => set("party_id", x)} emptyLabel="—" ariaLabel="Fornecedor" /></Field>
      <Field label="Conta contábil" className="sm:col-span-2"><SearchSelect name="chart_account_id" options={accounts} value={v.chart_account_id} onChange={(x) => set("chart_account_id", x)} emptyLabel="Despesas a classificar" ariaLabel="Conta contábil" /></Field>
      <Field label="Centro de custo" className="sm:col-span-2"><SearchSelect name="cost_center_id" options={costCenters} value={v.cost_center_id} onChange={(x) => set("cost_center_id", x)} emptyLabel="—" ariaLabel="Centro de custo" /></Field>
      <Field label="Início" className="sm:col-span-1"><input name="start_date" type="date" required className={inputClass} value={v.start_date} onChange={(e) => set("start_date", e.target.value)} disabled={Boolean(v.id)} />{v.id && <input type="hidden" name="start_date" value={v.start_date} />}</Field>
      <Field label="Fim (opcional)" className="sm:col-span-1"><input name="end_date" type="date" className={inputClass} value={v.end_date} onChange={(e) => set("end_date", e.target.value)} /></Field>
      <label className="flex items-center gap-2 text-sm sm:col-span-2 sm:self-end"><input type="checkbox" name="auto_approve" checked={v.auto_approve} onChange={(e) => set("auto_approve", e.target.checked)} /> Aprovar automaticamente (senão vira rascunho)</label>
      {v.id && <><input type="hidden" name="direction" value={v.direction} /><input type="hidden" name="legal_entity_id" value={v.legal_entity_id} /></>}
      <div className="sm:col-span-6">
        {state && <p role={state.ok ? "status" : "alert"} className={`mb-2 rounded-lg px-3 py-2 text-sm ${state.ok ? "bg-success/10 text-success" : "bg-danger/10 text-danger"}`}>{state.ok ? state.message : state.error}</p>}
        <div className="flex items-center gap-3">
          <Button disabled={pending}>{pending ? "Salvando…" : v.id ? "Salvar recorrência" : "Criar recorrência"}</Button>
          {v.id && <Link href="/financeiro/recorrentes" className="text-sm text-muted">Cancelar</Link>}
        </div>
        {v.id && <p className="mt-2 text-xs text-muted">A mudança vale para os próximos meses gerados. Contas já geradas se ajustam em Contas a pagar/receber.</p>}
      </div>
    </form>
  );
}
