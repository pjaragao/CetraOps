"use client";
import { useKeptForm } from "@/components/use-kept-form";
import { Button, inputClass } from "@/components/ui";
import { Field } from "@/components/form";
import { saveKnowledgeAction } from "./actions";
import { KINDS } from "./kinds";

export interface DocValues { id: string; title: string; kind: string; body: string; validFrom: string; validTo: string }

/** Editor do documento: "Salvar rascunho" não muda o que a IA lê; "Publicar" sim. */
export function DocForm({ doc, archived }: { doc: DocValues; archived: boolean }) {
  const { state, pending, formProps } = useKeptForm(saveKnowledgeAction);
  return (
    <form {...formProps} className="space-y-3">
      <input type="hidden" name="id" value={doc.id} />
      <div className="grid gap-3 sm:grid-cols-[1fr_220px]">
        <Field label="Título"><input name="title" defaultValue={doc.title} required minLength={3} maxLength={120} disabled={archived} className={inputClass} placeholder="Ex.: Como lavar as peças" /></Field>
        <Field label="Tipo">
          <select name="kind" defaultValue={doc.kind} disabled={archived} className={inputClass}>
            {Object.entries(KINDS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </Field>
      </div>
      <Field label="Texto (Markdown)" hint="Separe os assuntos com um título (# Prazo, # Como pedir) e linhas em branco. Cada assunto vira um trecho que a IA encontra sozinho. Escreva como explicaria para uma cliente.">
        <textarea name="body" defaultValue={doc.body} rows={16} maxLength={20000} disabled={archived} className={inputClass} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Vale a partir de (opcional)"><input type="date" name="valid_from" defaultValue={doc.validFrom} disabled={archived} className={inputClass} /></Field>
        <Field label="Vale até (opcional)" hint="Depois dessa data a IA deixa de usar, sem precisar arquivar."><input type="date" name="valid_to" defaultValue={doc.validTo} disabled={archived} className={inputClass} /></Field>
      </div>
      {state && <p role={state.ok ? "status" : "alert"} className={`rounded-lg px-3 py-2 text-sm ${state.ok ? "bg-success/10 text-success" : "bg-danger/10 text-danger"}`}>{state.ok ? state.message : state.error}</p>}
      {!archived && (
        <div className="flex flex-wrap gap-2">
          <Button name="intent" value="save" variant="secondary" disabled={pending}>{pending ? "Salvando…" : "Salvar rascunho"}</Button>
          <Button name="intent" value="publish" disabled={pending}>Salvar e publicar</Button>
        </div>
      )}
    </form>
  );
}
