"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { ArrowLeft, Bot, CheckCircle2, FileText, PauseCircle, PlayCircle, Send, Sparkles, StickyNote, Undo2, UserRound } from "lucide-react";
import { canSend, firstName, isValidParam, renderTemplate, serviceWindowRemaining, templatePlaceholders, type MessagingChannel } from "@centralops/domain";
import { Badge, Button, cn, inputClass } from "@/components/ui";
import { addNote, assignConversation, closeConversation, discardDraft, markRead, pauseAi, returnToAi, sendMessage, sendTemplate, setMode, type ConvMode } from "./actions";

interface Msg { id: string; direction: string; author_type: string; body: string | null; transcript: string | null; type: string; status: string; created_at: string }
interface Draft { id: string; variants: { messages: string[] }[]; confidence: number | null; intent: string | null; needsHuman: boolean }
interface Tpl { id: string; name: string; category: string; body: string; examples: string[] }
interface QuickReply { id: string; shortcut: string; body: string }
interface Member { id: string; name: string }
interface Note { id: string; member_id: string | null; body: string; mentions: string[]; created_at: string }
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });

export const OUTCOME_LABEL: Record<string, string> = {
  PURCHASED: "Comprou", RESERVED: "Reservou / armário", RESOLVED: "Dúvida resolvida", EXCHANGE: "Troca ou devolução",
  COMPLAINT: "Reclamação", NO_REPLY: "Sem retorno da cliente", NOT_CUSTOMER: "Não é cliente (fornecedor, parceiro…)", SPAM: "Spam",
};

const MODES: { value: ConvMode; label: string; icon: typeof Bot }[] = [
  { value: "AI_AUTOPILOT", label: "IA Piloto", icon: Bot },
  { value: "AI_COPILOT", label: "IA Copiloto", icon: Sparkles },
  { value: "HUMAN", label: "Humano", icon: UserRound },
];

export function ConversationPane(props: {
  conversationId: string; mode: ConvMode; channel: MessagingChannel; lastInboundAt: string | null;
  customerName: string; messages: Msg[]; draft: Draft | null; backHref: string; templates: Tpl[]; quickReplies: QuickReply[];
  aiPausedUntil: string | null; aiInstruction: string | null; assigneeId: string | null; meId: string; members: Member[]; notes: Note[];
  suggestedOutcome: string | null; initialText?: string;
}) {
  const router = useRouter();
  const [closeOpen, setCloseOpen] = useState(false);
  const [outcome, setOutcome] = useState(props.suggestedOutcome ?? "RESOLVED");
  const [outcomeNote, setOutcomeNote] = useState("");
  const [text, setText] = useState(props.initialText ?? "");   // mensagem pronta vinda da lista do dia
  const [editingDraft, setEditingDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const endRef = useRef<HTMLDivElement>(null);
  const [tplOpen, setTplOpen] = useState(false);
  const [tplId, setTplId] = useState("");
  const [tplParams, setTplParams] = useState<string[]>([]);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [returnOpen, setReturnOpen] = useState(false);
  const [instruction, setInstruction] = useState("");

  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [props.messages.length, props.notes.length]);
  useEffect(() => { void markRead(props.conversationId); }, [props.conversationId, props.messages.length]);

  const last = props.lastInboundAt ? new Date(props.lastInboundAt) : null;
  const window24 = serviceWindowRemaining(last);
  const decision = canSend({ channel: props.channel, author: "HUMAN", lastInboundAt: last });
  const freeForm = decision.allowed && decision.mode !== "TEMPLATE_ONLY";

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) =>
    start(async () => { setError(null); const r = await fn(); if (!r.ok) setError(r.error ?? "Erro"); else after?.(); });

  const [now] = useState(() => Date.now());
  const paused = props.aiPausedUntil !== null && new Date(props.aiPausedUntil).getTime() > now;
  const aiMode = props.mode === "AI_AUTOPILOT" || props.mode === "AI_COPILOT";
  const who = new Map(props.members.map((m) => [m.id, m.name]));
  const thread = [
    ...props.messages.map((m) => ({ kind: "msg" as const, at: m.created_at, m })),
    ...props.notes.map((n) => ({ kind: "note" as const, at: n.created_at, n })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  const mentionIds = props.members.filter((m) => note.includes(`@${m.name}`)).map((m) => m.id);

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

      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-1.5 text-xs">
        <label className="flex items-center gap-1 text-muted">Responsável
          <select value={props.assigneeId ?? ""} disabled={pending} aria-label="Responsável"
            onChange={(e) => run(() => assignConversation(props.conversationId, e.target.value))}
            className="rounded-md border border-border bg-surface px-1.5 py-1 text-text">
            <option value="">Sem dono</option>
            {props.members.map((m) => <option key={m.id} value={m.id}>{m.name}{m.id === props.meId ? " (eu)" : ""}</option>)}
          </select>
        </label>
        {aiMode && (paused ? (
          <Button type="button" variant="secondary" className="px-2 py-1 text-xs" disabled={pending} onClick={() => run(() => pauseAi(props.conversationId, 0))}>
            <PlayCircle size={13} /> IA pausada até {hhmm(props.aiPausedUntil!)} · Retomar
          </Button>
        ) : (
          <Button type="button" variant="ghost" className="px-2 py-1 text-xs" disabled={pending} onClick={() => run(() => pauseAi(props.conversationId, 120))}>
            <PauseCircle size={13} /> Pausar IA 2 h
          </Button>
        ))}
        {(props.mode === "HUMAN" || props.mode === "WAITING_HUMAN") && (
          <Button type="button" variant="ghost" className="px-2 py-1 text-xs" aria-expanded={returnOpen} onClick={() => setReturnOpen((o) => !o)}>
            <Undo2 size={13} /> Devolver para a IA
          </Button>
        )}
        <Button type="button" variant="ghost" className="ml-auto px-2 py-1 text-xs" aria-expanded={noteOpen} onClick={() => setNoteOpen((o) => !o)}>
          <StickyNote size={13} /> Nota interna
        </Button>
        <Button type="button" variant="ghost" className="px-2 py-1 text-xs" aria-expanded={closeOpen} onClick={() => setCloseOpen((o) => !o)}>
          <CheckCircle2 size={13} /> Encerrar
        </Button>
      </div>
      {closeOpen && (
        <form className="space-y-2 border-b border-border bg-surface-2/50 px-3 py-2 text-sm"
          onSubmit={(e) => { e.preventDefault(); run(() => closeConversation(props.conversationId, outcome, outcomeNote), () => router.push(props.backHref)); }}>
          <div className="grid gap-2 sm:grid-cols-[14rem_1fr]">
            <label className="text-xs text-muted">Como terminou
              <select value={outcome} onChange={(e) => setOutcome(e.target.value)} className={cn(inputClass, "mt-1")} aria-label="Desfecho">
                {Object.entries(OUTCOME_LABEL).map(([k, v]) => <option key={k} value={k}>{v}{k === props.suggestedOutcome ? " (sugerido)" : ""}</option>)}
              </select>
            </label>
            <label className="text-xs text-muted">Observação (opcional)
              <input value={outcomeNote} onChange={(e) => setOutcomeNote(e.target.value)} maxLength={300} className={cn(inputClass, "mt-1")} placeholder="Ex.: levou a legging M" aria-label="Observação do desfecho" />
            </label>
          </div>
          <Button disabled={pending}>Encerrar conversa</Button>
          <span className="ml-2 text-xs text-muted">Se a cliente escrever de novo, abre uma conversa nova.</span>
        </form>
      )}
      {aiMode && props.aiInstruction && <p className="border-b border-border bg-accent/10 px-3 py-1 text-xs"><span className="font-medium">Instrução para a IA:</span> {props.aiInstruction}</p>}
      {returnOpen && (
        <div className="space-y-2 border-b border-border bg-surface-2/50 px-3 py-2 text-sm">
          <label className="block text-xs text-muted">Instrução para a IA (opcional, vale até alguém assumir de novo)
            <textarea value={instruction} onChange={(e) => setInstruction(e.target.value)} rows={2} maxLength={500} placeholder="Ex.: confirme o endereço e envie o link de pagamento" className={cn(inputClass, "mt-1 resize-none")} />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={pending} onClick={() => run(() => returnToAi(props.conversationId, "AI_COPILOT", instruction), () => { setInstruction(""); setReturnOpen(false); })}>Devolver em Copiloto</Button>
            <Button type="button" variant="secondary" disabled={pending} onClick={() => run(() => returnToAi(props.conversationId, "AI_AUTOPILOT", instruction), () => { setInstruction(""); setReturnOpen(false); })}>Devolver em Piloto</Button>
          </div>
        </div>
      )}

      <div className="flex-1 space-y-2 overflow-y-auto px-3 py-3">
        {thread.map((t) => t.kind === "note" ? (
          <div key={t.n.id} className="mx-auto max-w-[90%] rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
            <p className="mb-0.5 font-medium text-muted"><StickyNote size={11} className="mr-1 inline" />Nota interna (a cliente não vê) · {t.n.member_id ? who.get(t.n.member_id) ?? "equipe" : "sistema"} · {hhmm(t.n.created_at)}</p>
            <p className="whitespace-pre-line">{t.n.body}</p>
          </div>
        ) : (
          <div key={t.m.id} className={cn("flex", t.m.direction === "OUT" ? "justify-end" : "justify-start")}>
            <div className={cn("max-w-[80%] rounded-2xl px-3 py-2 text-sm whitespace-pre-line",
              t.m.direction === "OUT" ? "bg-brand/10" : "bg-surface-2")}>
              {t.m.body ?? (t.m.transcript ? `🎙️ ${t.m.transcript}` : `[${t.m.type}]`)}
              <span className="mt-1 block text-right text-[10px] text-muted">
                {t.m.author_type === "AI" ? "IA · " : t.m.author_type === "ECHO_FROM_APP" ? "pelo app · " : t.m.author_type === "HUMAN" ? "equipe · " : ""}
                {new Date(t.m.created_at).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" })}
                {t.m.direction === "OUT" && ` · ${t.m.status.toLowerCase()}`}
              </span>
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      {noteOpen && (
        <form className="mx-3 mb-2 space-y-2 rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm"
          onSubmit={(e) => { e.preventDefault(); run(() => addNote(props.conversationId, note, mentionIds), () => { setNote(""); setNoteOpen(false); }); }}>
          <label className="block text-xs text-muted">Nota interna: só a equipe vê. Use @nome para avisar alguém.
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={2000} className={cn(inputClass, "mt-1 resize-none")} aria-label="Nota interna" />
          </label>
          <div className="flex flex-wrap items-center gap-1.5">
            {props.members.filter((m) => m.id !== props.meId).map((m) => (
              <button key={m.id} type="button" className="rounded-full border border-border px-2 py-0.5 text-xs hover:bg-surface-2"
                onClick={() => setNote((t) => `${t}${t && !t.endsWith(" ") ? " " : ""}@${m.name} `)}>@{m.name}</button>
            ))}
            <Button className="ml-auto" disabled={pending || !note.trim()}>Salvar nota</Button>
          </div>
        </form>
      )}

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
