"use client";
import { useKeptForm } from "@/components/use-kept-form";
import { Button, inputClass } from "@/components/ui";
import { Field } from "@/components/form";
import { saveIntegrationAction } from "./actions";
import type { ProviderDef, ProviderKey } from "./providers";

/** Configuração (visível) + credencial (campo de senha; vai para o cofre e NUNCA volta para a tela). */
export function IntegrationForm({ providerKey, def, config, hasSecret, secretHint }: {
  providerKey: ProviderKey; def: ProviderDef; config: Record<string, unknown>; hasSecret: boolean; secretHint?: string;
}) {
  const { state, pending, formProps } = useKeptForm(saveIntegrationAction, { clear: def.secret.map((f) => `secret.${f.key}`) });
  return (
    <form {...formProps} className="grid gap-3 sm:grid-cols-2" autoComplete="off">
      <input type="hidden" name="provider" value={providerKey} />
      {def.config.map((f) => (
        <Field key={f.key} label={f.label} hint={f.hint}>
          {f.options ? (
            <select name={`config.${f.key}`} defaultValue={String(config[f.key] ?? f.options[0].value)} className={inputClass}>
              {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          ) : (
            <input name={`config.${f.key}`} defaultValue={String(config[f.key] ?? "")} required={f.required} className={inputClass} spellCheck={false} />
          )}
        </Field>
      ))}
      {def.secret.map((f) => (
        <Field key={f.key} label={f.label} hint={hasSecret ? `Guardada${secretHint ? ` (${secretHint})` : ""}. Deixe em branco para manter; preencha para trocar.` : f.hint}>
          <input name={`secret.${f.key}`} type="password" autoComplete="new-password" required={!hasSecret && f.required} placeholder={hasSecret ? "••••••••••••" : ""} className={inputClass} spellCheck={false} />
        </Field>
      ))}
      <div className="sm:col-span-2">
        {state && <p role={state.ok ? "status" : "alert"} className={`mb-2 rounded-lg px-3 py-2 text-sm ${state.ok ? "bg-success/10 text-success" : "bg-danger/10 text-danger"}`}>{state.ok ? state.message : state.error}</p>}
        <Button disabled={pending}>{pending ? "Salvando…" : hasSecret ? "Salvar e testar" : "Salvar credencial e testar"}</Button>
      </div>
    </form>
  );
}
