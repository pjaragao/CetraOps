"use client";
import { useState } from "react";
import { useKeptForm } from "@/components/use-kept-form";
import { Button, inputClass } from "@/components/ui";
import { Field } from "@/components/form";
import { uploadCorpusAction } from "../actions";

const HELP: Record<string, string> = {
  WA_TXT: "No WhatsApp: abra a conversa › ⋮ › Mais › Exportar conversa › Sem mídia. Envie o arquivo .txt (um por conversa).",
  IG_JSON: "No Instagram: Configurações › Sua atividade › Baixar suas informações › Mensagens (formato JSON). Envie os arquivos message_1.json de cada conversa.",
};

export function UploadForm({ personaId, personaName }: { personaId: string; personaName: string }) {
  const { state, pending, formProps } = useKeptForm(uploadCorpusAction);
  const [kind, setKind] = useState("WA_TXT");
  return (
    <form {...formProps} className="grid gap-3 sm:grid-cols-2">
      <input type="hidden" name="persona_id" value={personaId} />
      <Field label="Origem">
        <select name="kind" value={kind} onChange={(e) => setKind(e.target.value)} className={inputClass}>
          <option value="WA_TXT">WhatsApp (.txt exportado)</option>
          <option value="IG_JSON">Instagram (message_N.json)</option>
        </select>
      </Field>
      <Field label="Nome de quem é a persona, como aparece nas mensagens" hint={`Ex.: ${personaName}. Se não bater, o sistema mostra os nomes que encontrou no arquivo.`}>
        <input name="owner_name" required maxLength={80} defaultValue={personaName} className={inputClass} />
      </Field>
      <Field label="Arquivo(s)" hint={HELP[kind]} className="sm:col-span-2">
        <input name="files" type="file" multiple={kind === "IG_JSON"} accept={kind === "WA_TXT" ? ".txt,text/plain" : ".json,application/json"} required className={inputClass} />
      </Field>
      <div className="sm:col-span-2">
        {state && <p role={state.ok ? "status" : "alert"} className={`mb-2 rounded-lg px-3 py-2 text-sm ${state.ok ? "bg-success/10 text-success" : "bg-danger/10 text-danger"}`}>{state.ok ? state.message : state.error}</p>}
        <Button disabled={pending}>{pending ? "Enviando…" : "Enviar histórico"}</Button>
        <p className="mt-2 text-[11px] text-muted">Só envie conversas que você tem direito de usar. Nomes, telefones, CPF, e-mails, endereços e valores são trocados por marcadores e o arquivo original é apagado depois do tratamento.</p>
      </div>
    </form>
  );
}
