"use client";
import { useKeptForm } from "@/components/use-kept-form";
import { Button, inputClass } from "@/components/ui";
import { Field } from "@/components/form";
import { approveVersionAction, saveVersionAction } from "../actions";

/** Edita o rascunho (prompt e regras extras) e aprova. Versão já aprovada aparece só para leitura. */
export function VersionEditor({ personaId, versionId, prompt, rules, approved }: { personaId: string; versionId: string; prompt: string; rules: string[]; approved: boolean }) {
  const { state, pending, formProps } = useKeptForm(saveVersionAction);
  return (
    <div className="space-y-3">
      <form {...formProps} className="space-y-3">
        <input type="hidden" name="id" value={versionId} />
        <Field label="Instruções da persona (prompt)" hint="O texto que a IA recebe antes de cada conversa. As regras de segurança do sistema (preço só por consulta, sem desconto, transferir reclamação) sempre valem por cima.">
          <textarea name="system_prompt" defaultValue={prompt} rows={14} maxLength={12000} disabled={approved} className={inputClass} />
        </Field>
        <Field label="Regras extras (uma por linha)" hint="Ex.: Sempre chamar a cliente de amiga. Evite: barato.">
          <textarea name="extra_rules" defaultValue={rules.join("\n")} rows={4} disabled={approved} className={inputClass} />
        </Field>
        {state && <p role={state.ok ? "status" : "alert"} className={`rounded-lg px-3 py-2 text-sm ${state.ok ? "bg-success/10 text-success" : "bg-danger/10 text-danger"}`}>{state.ok ? state.message : state.error}</p>}
        {!approved && <Button variant="secondary" disabled={pending}>{pending ? "Salvando…" : "Salvar rascunho"}</Button>}
      </form>
      {!approved && (
        <form action={approveVersionAction}>
          <input type="hidden" name="id" value={versionId} /><input type="hidden" name="persona_id" value={personaId} />
          <Button>Aprovar e ativar esta versão</Button>
          <span className="ml-2 text-[11px] text-muted">Salve o rascunho antes. A partir da aprovação, as respostas novas usam este estilo.</span>
        </form>
      )}
    </div>
  );
}
