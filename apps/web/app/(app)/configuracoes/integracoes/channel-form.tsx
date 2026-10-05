"use client";
import { useState } from "react";
import { useKeptForm } from "@/components/use-kept-form";
import { Button, inputClass } from "@/components/ui";
import { Field } from "@/components/form";
import { saveChannelAction } from "./actions";
import { CHANNEL_PROVIDER, MODE_LABEL } from "./providers";

export interface ConnOption { id: string; provider: string; label: string; suggestedAccountId?: string }

/** Cadastro de canal: escolhe a conexão (credencial) e o identificador do canal (ID do número / do bot / da conta) sugerido pela verificação. */
export function ChannelForm({ connections, stores, personas }: { connections: ConnOption[]; stores: { id: string; label: string }[]; personas: { id: string; label: string }[] }) {
  const { state, pending, formProps } = useKeptForm(saveChannelAction);
  const [channel, setChannel] = useState<"WHATSAPP" | "INSTAGRAM" | "TELEGRAM">("WHATSAPP");
  const [conn, setConn] = useState("");
  const [accountId, setAccountId] = useState("");
  const options = connections.filter((c) => c.provider === CHANNEL_PROVIDER[channel]);
  const pick = (id: string) => {
    setConn(id);
    const s = connections.find((c) => c.id === id)?.suggestedAccountId;
    if (s && !accountId) setAccountId(s);
  };
  return (
    <form {...formProps} className="grid gap-3 sm:grid-cols-3">
      <Field label="Canal">
        <select name="channel" value={channel} onChange={(e) => { setChannel(e.target.value as typeof channel); setConn(""); }} className={inputClass}>
          <option value="WHATSAPP">WhatsApp</option><option value="INSTAGRAM">Instagram</option><option value="TELEGRAM">Telegram</option>
        </select>
      </Field>
      <Field label="Conexão (credencial)" hint={options.length === 0 ? "Configure primeiro a conexão deste provedor acima." : undefined}>
        <select name="connection_id" value={conn} onChange={(e) => pick(e.target.value)} className={inputClass}>
          <option value="">— escolha —</option>
          {options.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
      </Field>
      <Field label={channel === "WHATSAPP" ? "ID do número de telefone" : channel === "TELEGRAM" ? "ID do bot" : "ID da conta do Instagram"} hint="É o identificador que o provedor envia em cada webhook">
        <input name="provider_account_id" required value={accountId} onChange={(e) => setAccountId(e.target.value)} className={inputClass} spellCheck={false} />
      </Field>
      <Field label="Nome (aparece na caixa de entrada)"><input name="display_name" required maxLength={120} className={inputClass} placeholder="WhatsApp — Loja Centro" /></Field>
      <Field label="Loja"><select name="store_id" defaultValue="" className={inputClass}><option value="">—</option>{stores.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select></Field>
      <Field label="Quando chega uma conversa nova" hint="Continua podendo mudar conversa a conversa">
        <select name="default_ai_mode" defaultValue="AI_COPILOT" className={inputClass}>
          {Object.entries(MODE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </Field>
      <Field label="Persona padrão"><select name="default_persona_id" defaultValue="" className={inputClass}><option value="">Concierge (padrão)</option>{personas.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select></Field>
      <div className="sm:col-span-3">
        {state && <p role={state.ok ? "status" : "alert"} className={`mb-2 rounded-lg px-3 py-2 text-sm ${state.ok ? "bg-success/10 text-success" : "bg-danger/10 text-danger"}`}>{state.ok ? state.message : state.error}</p>}
        <Button disabled={pending}>{pending ? "Salvando…" : "Cadastrar canal"}</Button>
      </div>
    </form>
  );
}
