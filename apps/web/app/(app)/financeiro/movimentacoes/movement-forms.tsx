"use client";

import { Button, inputClass } from "@/components/ui";
import { useKeptForm } from "@/components/use-kept-form";
import { cashMovementAction, transferAction, type State } from "../actions";

interface Opt { id: string; label: string }

function Msg({ state }: { state: State }) {
  if (!state) return null;
  return <p className={`sm:col-span-6 rounded-lg px-3 py-2 text-sm ${state.ok ? "bg-success/10 text-success" : "bg-danger/10 text-danger"}`} role="status">{state.ok ? state.message : state.error}</p>;
}

export function TransferForm({ banks, today }: { banks: Opt[]; today: string }) {
  const { state, pending, formProps } = useKeptForm(transferAction);
  return (
    <form {...formProps} className="mt-3 grid gap-2 sm:grid-cols-6">
      <label className="text-xs text-muted sm:col-span-2">De
        <select name="from" className={inputClass} required defaultValue="">{[<option key="" value="" disabled>Conta de origem…</option>, ...banks.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)]}</select>
      </label>
      <label className="text-xs text-muted sm:col-span-2">Para
        <select name="to" className={inputClass} required defaultValue="">{[<option key="" value="" disabled>Conta de destino…</option>, ...banks.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)]}</select>
      </label>
      <label className="text-xs text-muted">Valor (R$)<input name="amount" className={inputClass} inputMode="decimal" required placeholder="0,00" /></label>
      <label className="text-xs text-muted">Tarifa (R$)<input name="fee" className={inputClass} inputMode="decimal" placeholder="0,00" /></label>
      <label className="text-xs text-muted">Data<input name="date" type="date" className={inputClass} defaultValue={today} max={today} required /></label>
      <label className="text-xs text-muted sm:col-span-4">Descrição<input name="description" className={inputClass} placeholder="Ex.: Repasse Stone → Inter" maxLength={200} /></label>
      <div className="sm:col-span-1 self-end"><Button disabled={pending}>{pending ? "…" : "Transferir"}</Button></div>
      <p className="sm:col-span-6 text-xs text-muted">Transferência entre contas do mesmo CNPJ não é receita nem despesa: o sistema lança as duas pontas e concilia cada extrato.</p>
      <Msg state={state} />
    </form>
  );
}

const KINDS: [string, string, "IN" | "OUT" | "ANY"][] = [
  ["BANK_FEE", "Tarifa bancária", "OUT"],
  ["INTEREST_INCOME", "Rendimento de aplicação", "IN"],
  ["OWNER_CONTRIBUTION", "Aporte de sócio", "IN"],
  ["PROFIT_DISTRIBUTION", "Distribuição de lucros", "OUT"],
  ["LOAN", "Empréstimo / financiamento", "IN"],
  ["ADJUSTMENT", "Ajuste (informe a conta)", "ANY"],
  ["OTHER", "Outro (informe a conta)", "ANY"],
];

export function MovementForm({ banks, accounts, costCenters, today }: { banks: Opt[]; accounts: Opt[]; costCenters: Opt[]; today: string }) {
  const { state, pending, formProps } = useKeptForm(cashMovementAction);
  return (
    <form {...formProps} className="mt-3 grid gap-2 sm:grid-cols-6">
      <label className="text-xs text-muted sm:col-span-2">Conta
        <select name="bank" className={inputClass} required defaultValue="">{[<option key="" value="" disabled>Conta…</option>, ...banks.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)]}</select>
      </label>
      <label className="text-xs text-muted sm:col-span-2">Tipo
        <select name="kind" className={inputClass} required defaultValue="BANK_FEE">{KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
      </label>
      <label className="text-xs text-muted">Sentido
        <select name="direction" className={inputClass} defaultValue="OUT"><option value="OUT">Saída</option><option value="IN">Entrada</option></select>
      </label>
      <label className="text-xs text-muted">Valor (R$)<input name="amount" className={inputClass} inputMode="decimal" required placeholder="0,00" /></label>
      <label className="text-xs text-muted">Data<input name="date" type="date" className={inputClass} defaultValue={today} max={today} required /></label>
      <label className="text-xs text-muted sm:col-span-2">Conta contábil (opcional nos tipos padrão)
        <select name="account" className={inputClass} defaultValue=""><option value="">Padrão do tipo</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}</select>
      </label>
      <label className="text-xs text-muted sm:col-span-2">Centro de custo
        <select name="cc" className={inputClass} defaultValue=""><option value="">—</option>{costCenters.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select>
      </label>
      <label className="text-xs text-muted sm:col-span-4">Descrição<input name="description" className={inputClass} maxLength={200} /></label>
      <div className="self-end"><Button disabled={pending}>{pending ? "…" : "Lançar"}</Button></div>
      <p className="sm:col-span-6 text-xs text-muted">Distribuição de lucros, aportes, empréstimos e ajustes exigem permissão de aprovação.</p>
      <Msg state={state} />
    </form>
  );
}
