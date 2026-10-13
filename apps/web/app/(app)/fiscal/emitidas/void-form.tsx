"use client";
import { useState } from "react";
import { useKeptForm } from "@/components/use-kept-form";
import { Button, inputClass } from "@/components/ui";
import { voidNumberAction } from "./actions";

/** Inutilização do número de NFC-e rejeitada (emissão direta): a SEFAZ exige justificativa de 15 a 255 caracteres. */
export function VoidForm({ documentId, label }: { documentId: string; label: string }) {
  const [open, setOpen] = useState(false);
  const { state, pending, formProps } = useKeptForm(voidNumberAction);
  if (!open) return <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => setOpen(true)}>Inutilizar número</Button>;
  return (
    <form {...formProps} className="w-64 space-y-2 text-left">
      <input type="hidden" name="document_id" value={documentId} />
      <label className="block text-xs text-muted">Justificativa para inutilizar o número {label}
        <textarea name="reason" required minLength={15} maxLength={255} rows={3} className={`${inputClass} mt-1`} placeholder="Ex.: Venda refeita em outra nota após rejeição" />
      </label>
      <p className="text-[11px] text-muted">Use só quando esta venda não vai mais ter nota com este número. Depois de inutilizado, um reenvio usa um número novo.</p>
      {state && <p role={state.ok ? "status" : "alert"} className={`rounded-lg px-2 py-1 text-xs ${state.ok ? "bg-success/10 text-success" : "bg-danger/10 text-danger"}`}>{state.ok ? state.message : state.error}</p>}
      <div className="flex gap-2">
        <Button variant="danger" className="px-2 py-1 text-xs" disabled={pending}>{pending ? "Enviando…" : "Confirmar inutilização"}</Button>
        <Button type="button" variant="ghost" className="px-2 py-1 text-xs" onClick={() => setOpen(false)}>Fechar</Button>
      </div>
    </form>
  );
}
