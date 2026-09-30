"use client";
import { useKeptForm } from "@/components/use-kept-form";
import { Button, inputClass } from "@/components/ui";
import { Field } from "@/components/form";
import { saveQuickReplyAction } from "./actions";

export function QuickReplyForm({ initial }: { initial?: { id: string; shortcut: string; body: string } }) {
  const { state, pending, formProps } = useKeptForm(saveQuickReplyAction);
  return (
    <form {...formProps} className="grid gap-3 sm:grid-cols-[180px_1fr_auto] sm:items-end">
      {initial && <input type="hidden" name="id" value={initial.id} />}
      <Field label="Atalho" hint="Na conversa, digite / e o atalho"><input name="shortcut" required defaultValue={initial?.shortcut} maxLength={31} placeholder="obrigada" className={inputClass} spellCheck={false} /></Field>
      <Field label="Texto pronto"><textarea name="body" required rows={2} maxLength={1000} defaultValue={initial?.body} className={inputClass} placeholder="Eu que agradeço! Qualquer coisa é só chamar por aqui." /></Field>
      <Button disabled={pending}>{pending ? "Salvando…" : initial ? "Atualizar" : "Adicionar"}</Button>
      {state && <p role={state.ok ? "status" : "alert"} className={`sm:col-span-3 rounded-lg px-3 py-2 text-sm ${state.ok ? "bg-success/10 text-success" : "bg-danger/10 text-danger"}`}>{state.ok ? state.message : state.error}</p>}
    </form>
  );
}
