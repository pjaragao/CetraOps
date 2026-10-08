"use client";
import { useMemo, useState } from "react";
import { formatBRL } from "@centralops/domain";
import { useKeptForm } from "@/components/use-kept-form";
import { Button, inputClass } from "@/components/ui";
import { Field } from "@/components/form";
import { SearchSelect, type SearchOption } from "@/components/search-select";
import { AiReadButton, type FinanceRead } from "@/components/ai-read-button";
import { createLoanAction } from "../plan-actions";

const toNum = (s: string) => Number(String(s).replace(/\./g, "").replace(",", ".")) || 0;
const br = (n: number) => n.toFixed(2).replace(".", ",");
const price = (p: number, i: number, n: number) => (i <= 0 ? p / n : (p * i) / (1 - (1 + i) ** -n));

/** Empréstimo: valor que entrou, parcelas e taxa (ou parcela). Mostra a prévia da tabela Price antes de lançar. */
export function LoanForm({ banks, parties, costCenters, today }: { banks: SearchOption[]; parties: SearchOption[]; costCenters: SearchOption[]; today: string }) {
  const { state, pending, formProps } = useKeptForm(createLoanAction);
  const [f, setF] = useState({ bank: "", party: "", description: "", principal: "", installments: "12", first_due: "", received_on: today, rate: "", pmt: "", cc: "" });
  const [extra, setExtra] = useState<SearchOption[]>([]);
  const set = (k: keyof typeof f, v: string) => setF((p) => ({ ...p, [k]: v }));
  const P = toNum(f.principal), n = Number(f.installments) || 0, rate = toNum(f.rate) / 100, pmtIn = toNum(f.pmt);
  const preview = useMemo(() => {
    if (P <= 0 || n <= 0) return null;
    const pmt = f.rate !== "" ? price(P, rate, n) : pmtIn;
    if (!pmt) return null;
    return { pmt, total: pmt * n, interest: pmt * n - P };
  }, [P, n, rate, pmtIn, f.rate]);
  const fromAi = (d: FinanceRead) => {
    const x = d.fields;
    setF((p) => ({
      ...p, description: x.description ? String(x.description).slice(0, 120) : p.description, principal: typeof x.principal === "number" ? br(x.principal) : p.principal,
      installments: typeof x.installments === "number" ? String(x.installments) : p.installments, pmt: typeof x.installment_amount === "number" ? br(x.installment_amount) : p.pmt,
      rate: typeof x.monthly_rate_pct === "number" ? String(x.monthly_rate_pct).replace(".", ",") : p.rate, first_due: x.first_due ? String(x.first_due) : p.first_due,
      party: d.party?.id ?? p.party,
    }));
    if (d.party) setExtra((e) => [...e, d.party!]);
  };
  const partyOpts = [...extra.filter((e) => !parties.some((p) => p.id === e.id)), ...parties];
  return (
    <form {...formProps} className="grid gap-3 sm:grid-cols-6">
      <div className="sm:col-span-6"><AiReadButton purpose="emprestimo" onRead={fromAi} label="Ler contrato do empréstimo com IA" /></div>
      <Field label="Descrição" className="sm:col-span-3"><input name="description" required minLength={3} maxLength={120} value={f.description} onChange={(e) => set("description", e.target.value)} className={inputClass} placeholder="Ex.: Capital de giro Banco Inter" /></Field>
      <Field label="Banco / credor" className="sm:col-span-3"><SearchSelect name="party_id" options={partyOpts} value={f.party} onChange={(v) => set("party", v)} emptyLabel="—" ariaLabel="Credor" /></Field>
      <Field label="Conta onde o dinheiro entrou" className="sm:col-span-3"><SearchSelect name="bank_account_id" required options={banks} value={f.bank} onChange={(v) => set("bank", v)} ariaLabel="Conta bancária" /></Field>
      <Field label="Valor que entrou (R$)" className="sm:col-span-2"><input name="principal" required inputMode="decimal" value={f.principal} onChange={(e) => set("principal", e.target.value)} className={inputClass} /></Field>
      <Field label="Entrou em"><input name="received_on" type="date" required max={today} value={f.received_on} onChange={(e) => set("received_on", e.target.value)} className={inputClass} /></Field>
      <Field label="Parcelas"><input name="installments" type="number" min={1} max={360} required value={f.installments} onChange={(e) => set("installments", e.target.value)} className={inputClass} /></Field>
      <Field label="1º vencimento"><input name="first_due" type="date" required value={f.first_due} onChange={(e) => set("first_due", e.target.value)} className={inputClass} /></Field>
      <Field label="Juros ao mês (%)" hint="ou informe a parcela"><input name="monthly_rate_pct" inputMode="decimal" value={f.rate} onChange={(e) => set("rate", e.target.value)} className={inputClass} placeholder="1,99" /></Field>
      <Field label="Valor da parcela (R$)" hint="se não souber a taxa"><input name="installment_amount" inputMode="decimal" value={f.pmt} onChange={(e) => set("pmt", e.target.value)} disabled={f.rate !== ""} className={inputClass} /></Field>
      <Field label="Centro de custo dos juros" className="sm:col-span-2"><SearchSelect name="cost_center_id" options={costCenters} value={f.cc} onChange={(v) => set("cc", v)} emptyLabel="—" ariaLabel="Centro de custo" /></Field>
      {preview && (
        <p className="sm:col-span-6 rounded-lg bg-surface-2 px-3 py-2 text-sm">
          {n}x de <b>{formatBRL(preview.pmt)}</b> · total {formatBRL(preview.total)} · juros {formatBRL(preview.interest)}{f.rate === "" && preview.pmt ? " (a taxa é calculada a partir da parcela)" : ""}
        </p>
      )}
      <div className="sm:col-span-6">
        {state && !state.ok && <p className="mb-2 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{state.error}</p>}
        <Button disabled={pending}>{pending ? "Lançando…" : "Lançar empréstimo"}</Button>
        <p className="mt-2 text-xs text-muted">O valor entra na conta como empréstimo (passivo). Cada parcela vira uma conta a pagar já aprovada: a amortização abate o empréstimo e os juros vão para despesa financeira. Exige permissão de aprovação.</p>
      </div>
    </form>
  );
}
