"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { MessageSquarePlus, UserPlus, X } from "lucide-react";
import { Button } from "@/components/ui";
import { PartyPicker, type PartyHit } from "../vender/pickers";
import { QuickCustomerDialog } from "../vender/pdv/quick-customer-dialog";
import { openConversation } from "./actions";

/** Abre uma conversa de WhatsApp com um cliente (prospecção pessoal): busca no cadastro ou cadastra na hora.
 *  Se já houver conversa aberta com ele, vai para ela. Fora da janela de 24 h, a primeira mensagem é um template aprovado. */
export function NewConversationButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    if (!open || creating) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, creating]);

  const go = (p: PartyHit) => start(async () => {
    setError(null);
    const r = await openConversation(p.id);
    if (!r.ok) { setError(r.error); return; }
    setOpen(false);
    setCreating(false);
    router.push(`/atendimento?c=${r.conversationId}`);
  });

  return (
    <>
      <Button variant="secondary" onClick={() => { setOpen(true); setError(null); }}><MessageSquarePlus size={15} /> Nova conversa</Button>
      {open && !creating && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label="Nova conversa">
          <div className="w-full max-w-md rounded-t-2xl border border-border bg-surface p-4 shadow-xl sm:rounded-2xl">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-base font-semibold">Nova conversa no WhatsApp</h2>
              <button type="button" onClick={() => setOpen(false)} className="rounded p-1 hover:bg-surface-2" aria-label="Fechar"><X size={16} /></button>
            </div>
            <PartyPicker onPick={go} placeholder="Buscar cliente por nome ou telefone" />
            <button type="button" onClick={() => setCreating(true)} className="mt-2 inline-flex items-center gap-1 text-sm text-brand"><UserPlus size={14} /> Cliente novo: cadastrar</button>
            {pending && <p className="mt-2 text-sm text-muted" role="status">Abrindo a conversa…</p>}
            {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
            <p className="mt-3 text-xs text-muted">Se o cliente não falou com a loja nas últimas 24 horas, o WhatsApp só deixa começar com um template aprovado (escolha no campo de mensagem). Depois que ele responder, a conversa segue livre.</p>
          </div>
        </div>
      )}
      {open && creating && <QuickCustomerDialog onCreated={go} onClose={() => setCreating(false)} />}
    </>
  );
}
