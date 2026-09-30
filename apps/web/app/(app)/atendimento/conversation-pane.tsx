"use client";
import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { ArrowLeft, Bot, FileText, Send, Sparkles, UserRound } from "lucide-react";
import { canSend, firstName, isValidParam, renderTemplate, serviceWindowRemaining, templatePlaceholders, type MessagingChannel } from "@sie/domain";
import { Badge, Button, cn, inputClass } from "@/components/ui";
import { discardDraft, markRead, sendMessage, sendTemplate, setMode, type ConvMode } from "./actions";

interface Msg { id: string; direction: string; author_type: string; body: string | null; transcript: string | null; type: string; status: string; created_at: string }
interface Draft { id: string; variants: { messages: string[] }[]; confidence: number | null; intent: string | null; needsHuman: boolean }
interface Tpl { id: string; name: string; category: string; body: string; examples: string[] }
interface QuickReply { id: string; shortcut: string; body: string }

const MODES: { value: ConvMode; label: string; icon: typeof Bot }[] = [
  { value: "AI_AUTOPILOT", label: "IA Piloto", icon: Bot },
  { value: "AI_COPILOT", label: "IA Copiloto", icon: Sparkles },
  { value: "HUMAN", label: "Humano", icon: UserRound },
];

export function ConversationPane(props: {
  conversationId: string; mode: ConvMode; channel: MessagingChannel; lastInboundAt: string | null;
  customerName: string; messages: Msg[]; draft: Draft | null; backHref: string; templates: Tpl[]; quickReplies: QuickReply[];
}) {
  const [text, setText] = useState("");
  const [editingDraft, setEditingDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const endRef = useRef<HTMLDivElement>(null);
  const [tplOpen, setTplOpen] = useState(false);
  const [tplId, setTplId] = useState("");
  const [tplParams, setTplParams] = useState<string[]>([]);

  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [props.messages.length]);
  useEffect(() => { void markRead(props.conversationId); }, [props.conversationId, props.messages.length]);

  const last = props.lastInboundAt ? new Date(props.lastInboundAt) : null;
  const window24 = serviceWindowRemaining(last);
  const decision = canSend({ channel: props.channel, author: "HUMAN", lastInboundAt: last });
  const freeForm = decision.allowed && decision.mode !== "TEMPLATE_ONLY";

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) =>
    start(async () => { setError(null); const r = await fn(); if (!r.ok) setError(r.error ?? "Erro"); else after?.(); });

  const draftText = props.draft?.variants?.[0]?.messages?.join("\n\n") ?? "";

  const tpl = props.templates.find((t) => t.id === tplId);
  const tplVars = tpl ? templatePlaceholders(tpl.body).length : 0;
  const pickTemplate = (id: string) => {
    setTplId(id);
    const t = props.templates.find((x) => x.id === id);
    const n = t ? templatePlaceholders(t.body).length : 0;
    setTplParams(Array.from({ length: n }, (_, i) => (i === 0 ? firstName(props.customerName) : "")));   // {{1}} costuma ser o nome da cliente
  };
  const tplReady = !!tpl && tplParams.length === tplVars && tplParams.every(isValidParam);
  const slash = text.startsWith("/") && !text.includes(" ") ? text.slice(1).toLowerCase() : null;
  const suggestions = slash === null ? [] : props.quickReplies.filter((r) => r.shortcut.startsWith(slash)).slice(0, 5);
  const showTemplates = props.channel === "WHATSAPP" && props.templates.length > 0;
  const windowClosed = decision.allowed && decision.mode === "TEMPLATE_ONLY";

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

      {suggestions.length > 0 && (
        <ul className="mx-3 mb-1 overflow-hidden rounded-lg border border-border bg-surface text-sm shadow-sm" aria-label="Respostas rápidas">
          {suggestions.map((r) => (
            <li key={r.id}>
              <button type="button" className="flex w-full gap-2 px-3 py-1.5 text-left hover:bg-surface-2" onClick={() => setText(r.body)}>
                <span className="font-mono text-xs text-brand">/{r.shortcut}</span><span className="truncate text-muted">{r.body}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {showTemplates && (
        <div className="mx-3 mb-2 rounded-xl border border-border bg-surface-2/50 text-sm">
          <button type="button" onClick={() => setTplOpen((o) => !o)} aria-expanded={tplOpen || windowClosed} className="flex w-full items-center gap-2 px-3 py-2 text-left font-medium">
            <FileText size={14} /> Enviar template aprovado
            {windowClosed && <Badge tone="warning">janela fechada: só template</Badge>}
          </button>
          {(tplOpen || windowClosed) && (
            <div className="space-y-2 border-t border-border px-3 py-3">
              <select value={tplId} onChange={(e) => pickTemplate(e.target.value)} className={inputClass} aria-label="Template">
                <option value="">— escolha o template —</option>
                {props.templates.map((t) => <option key={t.id} value={t.id}>{t.name} · {t.category === "MARKETING" ? "marketing" : "utilidade"}</option>)}
              </select>
              {tpl && tplVars > 0 && (
                <div className="grid gap-2 sm:grid-cols-2">
                  {tplParams.map((v, i) => (
                    <label key={i} className="block text-xs text-muted">{`{{${i + 1}}}`}{tpl.examples[i] ? ` (ex.: ${tpl.examples[i]})` : ""}
                      <input value={v} onChange={(e) => setTplParams((prev) => prev.map((x, j) => (j === i ? e.target.value : x)))} className={cn(inputClass, "mt-1")} maxLength={200} />
                    </label>
                  ))}
                </div>
              )}
              {tpl && <p className="whitespace-pre-line rounded-lg bg-surface px-3 py-2 text-sm shadow-sm">{renderTemplate(tpl.body, tplParams)}</p>}
              {tpl?.category === "MARKETING" && <p className="text-xs text-muted">Marketing só sai para quem deu consentimento de marketing no WhatsApp.</p>}
              <Button type="button" disabled={pending || !tplReady}
                onClick={() => run(() => sendTemplate(props.conversationId, tplId, tplParams), () => { setTplId(""); setTplParams([]); setTplOpen(false); })}>Enviar template</Button>
            </div>
          )}
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
      {windowClosed && !showTemplates && props.channel === "WHATSAPP" && (
        <p className="px-3 pb-2 text-xs text-warning">
          Janela de 24h fechada e nenhum template aprovado neste número: crie e envie um para aprovação em <Link className="underline" href="/atendimento/templates">Atendimento › Templates</Link>.
        </p>
      )}
      {error && <p role="alert" className="px-3 pb-2 text-xs text-danger">{error}</p>}
    </section>
  );
}
