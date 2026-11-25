"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Check, Plus } from "lucide-react";
import { cartAdd } from "@/app/(app)/atendimento/actions";

/** "+" de uma sugestão do "Para ela agora": põe a peça (cor e tamanho dela) no carrinho da conversa. */
export function ForHerAdd({ conversationId, productId, colorId, size, name, inCart }: {
  conversationId: string; productId: string; colorId?: string; size: string; name: string; inCart: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  if (inCart) return <span className="shrink-0 p-0.5 text-success" title="Já está no carrinho" aria-label={`${name} já está no carrinho`}><Check size={13} /></span>;
  return (
    <button type="button" disabled={pending} title={error ?? "Pôr no carrinho"} aria-label={`Pôr ${name} no carrinho`}
      onClick={() => start(async () => { setError(null); const r = await cartAdd(conversationId, productId, colorId, size); if (r.ok) router.refresh(); else setError(r.error ?? "Não foi possível"); })}
      className={`shrink-0 rounded p-0.5 hover:bg-surface-2 ${error ? "text-danger" : "text-brand"} disabled:opacity-50`}>
      <Plus size={13} />
    </button>
  );
}
