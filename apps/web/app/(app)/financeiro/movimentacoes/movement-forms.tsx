"use client";

import { useState } from "react";
import { Button, inputClass } from "@/components/ui";
import { SearchSelect } from "@/components/search-select";
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

const KINDS: { v: string; label: string; dir: "IN" | "OUT" | "ANY"; help: string }[] = [
  { v: "BANK_FEE", label: "Tarifa bancária", dir: "OUT", help: "Cobrança do banco que saiu direto da conta (manutenção, TED, boleto emitido). Vai para Tarifas bancárias. Se a tarifa veio no extrato, prefira lançar pela Conciliação." },
  { v: "INTEREST_INCOME", label: "Rendimento de aplicação", dir: "IN", help: "Juros que a aplicação ou a conta remunerada pagou. Entra como receita financeira." },
  { v: "OWNER_CONTRIBUTION", label: "Aporte de sócio", dir: "IN", help: "Dinheiro que um sócio colocou na empresa (não é receita nem empréstimo): aumenta o capital. Exige permissão de aprovação." },
  { v: "PROFIT_DISTRIBUTION", label: "Distribuição de lucros", dir: "OUT", help: "Retirada de lucro pelos sócios (não é despesa nem pró-labore). Sai do patrimônio. Pró-labore é pela folha. Exige permissão de aprovação." },
  { v: "ADJUSTMENT", label: "Ajuste (escolha a conta)", dir: "ANY", help: "Corrige uma diferença do saldo contra uma conta que você escolhe (ex.: diferença de caixa). Exige permissão de aprovação." },
  { v: "OTHER", label: "Outro (escolha a conta)", dir: "ANY", help: "Qualquer outra entrada ou saída sem conta a pagar/receber: escolha a conta do plano e o centro de custo." },
];

export function MovementForm({ banks, accounts, costCenters, today }: { banks: Opt[]; accounts: Opt[]; costCenters: Opt[]; today: string }) {
  const { state, pending, formProps } = useKeptForm(cashMovementAction);
  const [kind, setKind] = useState("BANK_FEE");
  const k = KINDS.find((x) => x.v === kind)!;
  const [dir, setDir] = useState("OUT");
  const direction = k.dir === "ANY" ? dir : k.dir;
  return (
    <form {...formProps} className="mt-3 grid gap-2 sm:grid-cols-6">
      <label className="text-xs text-muted sm:col-span-2">Conta
        <SearchSelect name="bank" required options={banks} placeholder="Conta…" ariaLabel="Conta bancária" />
      </label>
      <label className="text-xs text-muted sm:col-span-2">Tipo
        <select name="kind" className={inputClass} required value={kind} onChange={(e) => setKind(e.target.value)}>{KINDS.map((x) => <option key={x.v} value={x.v}>{x.label}</option>)}</select>
      </label>
      <label className="text-xs text-muted">Sentido
        <select name="direction" className={inputClass} value={direction} disabled={k.dir !== "ANY"} onChange={(e) => setDir(e.target.value)}><option value="OUT">Saída</option><option value="IN">Entrada</option></select>
        {k.dir !== "ANY" && <input type="hidden" name="direction" value={k.dir} />}
      </label>
      <label className="text-xs text-muted">Valor (R$)<input name="amount" className={inputClass} inputMode="decimal" required placeholder="0,00" /></label>
      <p className="sm:col-span-6 rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">{k.help}</p>
      <label className="text-xs text-muted">Data<input name="date" type="date" className={inputClass} defaultValue={today} max={today} required /></label>
      <label className="text-xs text-muted sm:col-span-2">Conta contábil {k.dir === "ANY" ? "(obrigatória)" : "(opcional: já tem padrão)"}
        <SearchSelect name="account" options={accounts} emptyLabel="Padrão do tipo" required={k.dir === "ANY"} ariaLabel="Conta contábil" />
      </label>
      <label className="text-xs text-muted sm:col-span-3">Centro de custo
        <SearchSelect name="cc" options={costCenters} emptyLabel="—" ariaLabel="Centro de custo" />
      </label>
      <label className="text-xs text-muted sm:col-span-5">Descrição<input name="description" className={inputClass} maxLength={200} /></label>
      <div className="self-end"><Button disabled={pending}>{pending ? "…" : "Lançar"}</Button></div>
      <p className="sm:col-span-6 text-xs text-muted">Empréstimos e financiamentos ficam em Contratos e recorrências › Empréstimos: lá o dinheiro que entra e as parcelas (com juros) são lançados juntos.</p>
      <Msg state={state} />
    </form>
  );
}
