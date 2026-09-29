"use client";
import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { ArrowLeft, Bot, Send, Sparkles, UserRound } from "lucide-react";
import { canSend, serviceWindowRemaining, type MessagingChannel } from "@sie/domain";
import { Badge, Button, cn, inputClass } from "@/components/ui";
import { discardDraft, markRead, sendMessage, setMode, type ConvMode } from "./actions";

interface Msg { id: string; direction: string; author_type: string; body: string | null; transcript: string | null; type: string; status: string; created_at: string }
interface Draft { id: string; variants: { messages: string[] }[]; confidence: number | null; intent: string | null; needsHuman: boolean }

const MODES: { value: ConvMode; label: string; icon: typeof Bot }[] = [
  { value: "AI_AUTOPILOT", label: "IA Piloto", icon: Bot },
  { value: "AI_COPILOT", label: "IA Copiloto", icon: Sparkles },
  { value: "HUMAN", label: "Humano", icon: UserRound },
];

export function ConversationPane(props: {
  conversationId: string; mode: ConvMode; channel: MessagingChannel; lastInboundAt: string | null;
  customerName: string; messages: Msg[]; draft: Draft | null; backHref: string;
}) {
  const [text, setText] = useState("");
  const [editingDraft, setEditingDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [props.messages.length]);
  useEffect(() => { void markRead(props.conversationId); }, [props.conversationId, props.messages.length]);

  const last = props.lastInboundAt ? new Date(props.lastInboundAt) : null;
  const window24 = serviceWindowRemaining(last);
  const decision = canSend({ channel: props.channel, author: "HUMAN", lastInboundAt: last });
  const freeForm = decision.allowed && decision.mode !== "TEMPLATE_ONLY";

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) =>
    start(async () => { setError(null); const r = await fn(); if (!r.ok) setError(r.error ?? "Erro"); else after?.(); });

  const draftText = props.draft?.variants?.[0]?.messages?.join("\n\n") ?? "";

  return (
    <section className="flex h-[75dvh] flex-col rounded-xl border border-border bg-surface">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <Link href={props.backHref} className="rounded p-1 hover:bg-surface-2 lg:hidden" aria-label="Voltar"><ArrowLeft size={18} /></Link>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{props.customerName}</p>
          <p className="text-xs text-muted">
            {props.channel} · {window24 ? `Janela 24h: ${window24}` : props.channel === "WHATSAPP" ? "Janela fechada: só template" : "Fora da janela de 24h"}
          </p>
        </div>
        <div role="radiogroup" aria-label="Quem atende" className="flex rounded-lg border border-border p-0.5">
          {MODES.map((m) => {
            const active = props.mode === m.value || (m.value === "HUMAN" && props.mode === "WAITING_HUMAN");
            return (
              <button key={m.value} role="radio" aria-checked={active} disabled={pending}
                onClick={() => run(() => setMode(props.conversationId, m.value))}
                className={cn("flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium", active ? "bg-brand text-brand-contrast" : "text-muted hover:text-text")}>
                <m.icon size={13} /> {m.label}
              </button>
            );
          })}
        </div>
        {props.mode === "WAITING_HUMAN" && <Badge tone="warning">Cliente aguardando humano</Badge>}
      </header>

      <div className="flex-1 space-y-2 overflow-y-auto px-3 py-3">
        {props.messages.map((m) => (
          <div key={m.id} className={cn("flex", m.direction === "OUT" ? "justify-end" : "justify-start")}>
            <div className={cn("max-w-[80%] rounded-2xl px-3 py-2 text-sm whitespace-pre-line",
              m.direction === "OUT" ? "bg-brand/10" : "bg-surface-2")}>
              {m.body ?? (m.transcript ? `🎙️ ${m.transcript}` : `[${m.type}]`)}
              <span className="mt-1 block text-right text-[10px] text-muted">
                {m.author_type === "AI" ? "IA · " : m.author_type === "ECHO_FROM_APP" ? "pelo app · " : m.author_type === "HUMAN" ? "equipe · " : ""}
                {new Date(m.created_at).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" })}
                {m.direction === "OUT" && ` · ${m.status.toLowerCase()}`}
              </span>
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      {props.draft && props.mode !== "HUMAN" && (
        <div className="mx-3 mb-2 rounded-xl border border-accent/40 bg-accent/10 p-3 text-sm">
          <p className="mb-1 flex items-center gap-2 text-xs font-medium text-muted">
            <Sparkles size={13} /> Sugestão da IA {props.draft.intent && `· ${props.draft.intent}`}
            {props.draft.confidence !== null && ` · confiança ${Math.round(Number(props.draft.confidence) * 100)}%`}
          </p>
          {editingDraft === null ? <p className="whitespace-pre-line">{draftText}</p> : (
            <textarea value={editingDraft} onChange={(e) => setEditingDraft(e.target.value)} rows={4} className={inputClass} aria-label="Editar sugestão" />
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            <Button disabled={pending || !freeForm} onClick={() => run(() => sendMessage(props.conversationId, editingDraft ?? draftText, props.draft!.id, editingDraft !== null && editingDraft !== draftText), () => setEditingDraft(null))}>Enviar</Button>
            {editingDraft === null && <Button variant="secondary" onClick={() => setEditingDraft(draftText)}>Editar</Button>}
            <Button variant="ghost" disabled={pending} onClick={() => run(() => discardDraft(props.draft!.id, "descartado na inbox"))}>Descartar</Button>
          </div>
        </div>
      )}

      <form className="flex items-end gap-2 border-t border-border p-3"
        onSubmit={(e) => { e.preventDefault(); run(() => sendMessage(props.conversationId, text), () => setText("")); }}>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2}
          placeholder={freeForm ? "Escreva uma mensagem (ao enviar, você assume a conversa)" : ("reason" in decision ? decision.reason : "Fora da janela: use um template")}
          disabled={!freeForm || pending} className={cn(inputClass, "resize-none")} aria-label="Mensagem"
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} />
        <Button aria-label="Enviar" disabled={!freeForm || pending || !text.trim()}><Send size={16} /></Button>
      </form>
      {decision.allowed && decision.mode === "TEMPLATE_ONLY" && <p className="px-3 pb-2 text-xs text-warning">Janela de 24h fechada: envie um template aprovado (tela de templates em breve).</p>}
      {error && <p role="alert" className="px-3 pb-2 text-xs text-danger">{error}</p>}
    </section>
  );
}
