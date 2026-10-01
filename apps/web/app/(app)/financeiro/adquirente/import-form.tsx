"use client";
import { useKeptForm } from "@/components/use-kept-form";
import { Button, inputClass } from "@/components/ui";
import { Field } from "@/components/form";
import { importAcquirerAction } from "./actions";

export function ImportForm({ banks }: { banks: { id: string; name: string }[] }) {
  const { state, pending, formProps } = useKeptForm(importAcquirerAction);
  return (
    <form {...formProps} className="grid gap-3 sm:grid-cols-3">
      <Field label="Adquirente"><input name="acquirer" required defaultValue="STONE" maxLength={30} className={inputClass} /></Field>
      <Field label="Conta que recebe os repasses" hint="Pode deixar em branco e escolher ao baixar o repasse.">
        <select name="bank_account_id" className={inputClass} defaultValue="">
          <option value="">—</option>
          {banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      </Field>
      <Field label="Arquivo CSV de recebíveis"><input name="file" type="file" accept=".csv,text/csv" required className={inputClass} /></Field>
      <div className="sm:col-span-3">
        {state && <p role={state.ok ? "status" : "alert"} className={`mb-2 rounded-lg px-3 py-2 text-sm ${state.ok ? "bg-success/10 text-success" : "bg-danger/10 text-danger"}`}>{state.ok ? state.message : state.error}</p>}
        <Button disabled={pending}>{pending ? "Importando…" : "Importar arquivo"}</Button>
      </div>
    </form>
  );
}
