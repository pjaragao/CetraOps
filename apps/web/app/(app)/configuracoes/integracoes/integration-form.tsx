"use client";
import { useRef, useState } from "react";
import { useKeptForm } from "@/components/use-kept-form";
import { Button, inputClass } from "@/components/ui";
import { Field } from "@/components/form";
import { saveIntegrationAction } from "./actions";
import type { ProviderDef, ProviderField, ProviderKey } from "./providers";

/** Arquivo sensível (certificado A1): lido no navegador e enviado em base64 num campo oculto, que é limpo depois do envio como as senhas. */
function SecretFile({ field, required }: { field: ProviderField; required: boolean }) {
  const hidden = useRef<HTMLInputElement>(null);
  const [info, setInfo] = useState<string | null>(null);
  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (hidden.current) hidden.current.value = "";
    setInfo(null);
    if (!file) return;
    if (file.size > 100_000) { setInfo("Arquivo grande demais para um certificado A1 (máx. 100 KB)"); e.target.value = ""; return; }
    const reader = new FileReader();
    reader.onload = () => {
      const b64 = String(reader.result ?? "").split(",", 2)[1] ?? "";
      if (hidden.current) hidden.current.value = b64;
      setInfo(`${file.name} (${Math.ceil(file.size / 1024)} KB) pronto para enviar`);
    };
    reader.readAsDataURL(file);
  };
  return (
    <>
      <input type="file" accept={field.accept} required={required} onChange={onChange} className={`${inputClass} file:mr-3 file:rounded file:border-0 file:bg-surface-2 file:px-2 file:py-1 file:text-xs`} />
      <input type="hidden" name={`secret.${field.key}`} ref={hidden} />
      {info && <span className="mt-0.5 block text-[11px] text-text">{info}</span>}
    </>
  );
}

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
            <input name={`config.${f.key}`} defaultValue={String(config[f.key] ?? "")} required={f.required} placeholder={f.placeholder} className={inputClass} spellCheck={false} />
          )}
        </Field>
      ))}
      {def.secret.map((f) => (
        <Field key={f.key} label={f.label} hint={hasSecret ? `Guardada${secretHint ? ` (${secretHint})` : ""}. Deixe em branco para manter; preencha para trocar.` : f.hint}>
          {f.type === "file" ? <SecretFile field={f} required={!hasSecret && !!f.required} /> : (
            <input name={`secret.${f.key}`} type="password" autoComplete="new-password" required={!hasSecret && f.required} placeholder={hasSecret ? "••••••••••••" : ""} className={inputClass} spellCheck={false} />
          )}
        </Field>
      ))}
      <div className="sm:col-span-2">
        {state && <p role={state.ok ? "status" : "alert"} className={`mb-2 rounded-lg px-3 py-2 text-sm ${state.ok ? "bg-success/10 text-success" : "bg-danger/10 text-danger"}`}>{state.ok ? state.message : state.error}</p>}
        <Button disabled={pending}>{pending ? "Salvando…" : hasSecret ? "Salvar e testar" : "Salvar credencial e testar"}</Button>
      </div>
    </form>
  );
}
