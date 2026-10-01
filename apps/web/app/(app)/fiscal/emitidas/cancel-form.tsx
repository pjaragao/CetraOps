"use client";
import { useState } from "react";
import { useKeptForm } from "@/components/use-kept-form";
import { Button, inputClass } from "@/components/ui";
import { cancelDocumentAction } from "./actions";

/** Cancelamento de nota autorizada: abre um campo de justificativa (15 a 255 caracteres, exigência da SEFAZ). */
export function CancelForm({ documentId, label }: { documentId: string; label: string }) {
  const [open, setOpen] = useState(false);
  const { state, pending, formProps } = useKeptForm(cancelDocumentAction);
  if (!open) return <Button variant="ghost" className="px-2 py-1 text-xs text-danger" onClick={() => setOpen(true)}>Cancelar nota</Button>;
  return (
    <form {...formProps} className="w-64 space-y-2 text-left">
      <input type="hidden" name="document_id" value={documentId} />
      <label className="block text-xs text-muted">Justificativa do cancelamento da nota {label}
        <textarea name="reason" required minLength={15} maxLength={255} rows={3} className={`${inputClass} mt-1`} placeholder="Ex.: Venda cancelada a pedido da cliente antes da retirada" />
      </label>
      <p className="text-[11px] text-muted">Cancelar a nota não desfaz a venda: estoque, comissão e contabilidade se corrigem pela devolução ou pelo cancelamento do pedido.</p>
      {state && <p role={state.ok ? "status" : "alert"} className={`rounded-lg px-2 py-1 text-xs ${state.ok ? "bg-success/10 text-success" : "bg-danger/10 text-danger"}`}>{state.ok ? state.message : state.error}</p>}
      <div className="flex gap-2">
        <Button variant="danger" className="px-2 py-1 text-xs" disabled={pending}>{pending ? "Enviando…" : "Confirmar cancelamento"}</Button>
        <Button type="button" variant="ghost" className="px-2 py-1 text-xs" onClick={() => setOpen(false)}>Fechar</Button>
      </div>
    </form>
  );
}
