"use client";
import { useKeptForm } from "@/components/use-kept-form";
import { Button, inputClass } from "@/components/ui";
import { importStatementAction } from "../actions";

export function ImportForm({ bank }: { bank: string }) {
  const { state, pending, formProps } = useKeptForm(importStatementAction);
  return (
    <form {...formProps} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="bank" value={bank} />
      <label className="text-xs text-muted">Extrato (OFX ou CSV do Inter, BTG, Mercado Pago)
        <input name="file" type="file" accept=".ofx,.csv,.txt" required className={`${inputClass} file:mr-3 file:rounded file:border-0 file:bg-surface-2 file:px-2 file:py-1`} />
      </label>
      <Button disabled={pending}>{pending ? "Importando…" : "Importar extrato"}</Button>
      {state && <p className={`w-full text-sm ${state.ok ? "text-success" : "text-danger"}`} role="status">{state.ok ? state.message : state.error}</p>}
    </form>
  );
}
