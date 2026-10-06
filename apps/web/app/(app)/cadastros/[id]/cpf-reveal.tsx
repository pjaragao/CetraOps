"use client";
import { useKeptForm } from "@/components/use-kept-form";
import { Button } from "@/components/ui";
import { revealCpfAction } from "../actions";

/** CPF mascarado; quem tem a permissão de dados sensíveis pode ver o completo (a consulta fica registrada na auditoria). */
export function CpfReveal({ id, masked }: { id: string; masked: string }) {
  const { state, pending, formProps } = useKeptForm(revealCpfAction);
  const shown = state?.ok ? state.message : null;
  return (
    <form {...formProps} className="mb-3 flex flex-wrap items-center gap-2 text-sm">
      <input type="hidden" name="id" value={id} />
      <span className="text-xs text-muted">CPF</span>
      <span className="font-mono">{shown ?? masked}</span>
      {shown ? <span className="text-xs text-muted">consulta registrada</span>
        : <Button variant="ghost" className="px-2 py-1 text-xs" disabled={pending}>{pending ? "Abrindo…" : "Ver completo"}</Button>}
      {state && !state.ok && <span role="alert" className="text-xs text-danger">{state.error}</span>}
    </form>
  );
}
