"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Loader2, Mic, Paperclip, ScanBarcode, SendHorizontal, Sparkles, Square } from "lucide-react";
import { ASSISTANT_NAME, classifyCode, parseNfeKey } from "@centralops/domain";
import { Button, cn } from "@/components/ui";
import { loadCentralThread } from "@/app/(app)/central/actions";
import type { Card, CentralEvent } from "@/lib/central/cards";
import { documentFromCode, type ReadDocument } from "@/lib/central/codes";
import { CentralCard } from "./central-cards";
import { BarcodeScanner, summarizeCodes, type ScannedCode } from "./barcode-scanner";
import { useRecorder } from "./use-recorder";

interface UiMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  cards: Card[];
  status?: string | null;
  pending?: boolean;
  mode?: "ai" | "search";
}

const SUGGESTIONS = [
  "Quais as contas a pagar hoje?",
  "Quanto vendi hoje?",
  "Quem eu preciso contatar hoje?",
  "Como está o caixa?",
];

let seq = 0;
const localId = () => `local-${Date.now()}-${seq++}`;

/** Conversa com a Central. Usada no painel lateral (todas as telas) e na página /central. */
export function CentralChat({ threadId: initialThread, onThread, autoFocus = true, pendingMessage, onPendingSent }: {
  threadId: string | null;
  onThread?(id: string | null): void;
  autoFocus?: boolean;
  /** Mensagem vinda de fora (paleta Ctrl+K): é enviada assim que a conversa estiver livre. */
  pendingMessage?: string | null;
  onPendingSent?(): void;
}) {
  const pathname = usePathname();
  const [threadId, setThreadId] = useState<string | null>(initialThread);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const recorder = useRecorder();
  const bottom = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Conversa escolhida de fora (histórico, "nova conversa"): carrega as mensagens dela
  if (initialThread !== threadId && !busy) {
    setThreadId(initialThread);
    setMessages([]);
    setLoadedFor(null);
  }
  useEffect(() => {
    if (!threadId || loadedFor === threadId) return;
    let alive = true;
    loadCentralThread(threadId).then((rows) => {
      if (!alive) return;
      setMessages(rows.map((m) => ({ id: m.id, role: m.role, text: m.text, cards: m.cards })));
      setLoadedFor(threadId);
    });
    return () => { alive = false; };
  }, [threadId, loadedFor]);

  useEffect(() => { bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [messages]);

  const send = useCallback(async (raw: string, document?: ReadDocument) => {
    const text = raw.trim();
    if (!text || busy) return;
    setInput("");
    setNotice(null);
    setBusy(true);
    const reply: UiMessage = { id: localId(), role: "assistant", text: "", cards: [], status: "Pensando…", pending: true };
    setMessages((m) => [...m, { id: localId(), role: "user", text, cards: [] }, reply]);
    const patch = (fn: (m: UiMessage) => UiMessage) => setMessages((all) => all.map((m) => (m.id === reply.id ? fn(m) : m)));
    try {
      const resp = await fetch("/api/central", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ threadId, message: text, path: pathname, document: document ?? null }) });
      if (!resp.ok || !resp.body) {
        const err = (await resp.json().catch(() => ({}))) as { error?: string };
        patch((m) => ({ ...m, pending: false, status: null, text: err.error ?? "A Central não respondeu." }));
        return;
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith("data:")) continue;
          const e = JSON.parse(line.slice(5)) as CentralEvent;
          if (e.type === "thread") {
            if (e.id !== threadId) { setThreadId(e.id); setLoadedFor(e.id); onThread?.(e.id); }
          } else if (e.type === "status") patch((m) => ({ ...m, status: e.text }));
          else if (e.type === "card") patch((m) => ({ ...m, cards: [...m.cards, e.card] }));
          else if (e.type === "text") patch((m) => ({ ...m, text: e.text }));
          else if (e.type === "error") patch((m) => ({ ...m, text: e.text }));
          else if (e.type === "done") patch((m) => ({ ...m, pending: false, status: null, mode: e.mode }));
        }
      }
    } catch {
      patch((m) => ({ ...m, text: "Sem conexão com o servidor. Tente de novo." }));
    } finally {
      patch((m) => ({ ...m, pending: false, status: null }));
      setBusy(false);
      inputRef.current?.focus();
    }
  }, [busy, threadId, pathname, onThread]);

  useEffect(() => {
    if (!pendingMessage || busy) return;
    const t = setTimeout(() => { onPendingSent?.(); void send(pendingMessage); }, 0);   // fora do corpo do efeito: o envio muda o estado
    return () => clearTimeout(t);
  }, [pendingMessage, busy, send, onPendingSent]);

  const toggleMic = async () => {
    if (!recorder.recording) { await recorder.start(); return; }
    const blob = await recorder.stop();
    if (!blob) return;
    setNotice("Transcrevendo…");
    const form = new FormData();
    form.set("audio", blob);
    const r = await fetch("/api/central/transcrever", { method: "POST", body: form }).catch(() => null);
    const data = r ? ((await r.json().catch(() => ({}))) as { text?: string; error?: string }) : { error: "Sem conexão com o servidor." };
    setNotice(null);
    if (data.text) await send(data.text);
    else setNotice(data.error ?? "Não consegui transcrever o áudio.");
  };

  // Cada código lido diz o que é: boleto e Pix viram conta a pagar, chave de NF-e vai para o recebimento, o resto é peça
  const onScanned = (codes: ScannedCode[]) => {
    setScanning(false);
    if (!codes.length) return;
    const kinds = codes.map((c) => ({ ...c, kind: classifyCode(c.value) }));
    const pay = kinds.find((c) => c.kind === "BOLETO" || c.kind === "PIX");
    if (pay) {
      const doc = documentFromCode(pay.kind === "BOLETO" ? "boleto" : "pix", pay.value);
      if (doc) { void send(`📷 ${doc.label}`, doc); return; }
    }
    const nfe = kinds.find((c) => c.kind === "NFE_KEY");
    if (nfe) { void send(`Chave de NF-e bipada: ${parseNfeKey(nfe.value)?.key ?? nfe.value}. Quero receber essa nota.`); return; }
    void send(`Códigos bipados: ${summarizeCodes(codes)}`);
  };

  const fileInput = useRef<HTMLInputElement>(null);
  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setNotice("Lendo o documento…");
    const form = new FormData();
    form.set("file", file);
    const r = await fetch("/api/central/ler", { method: "POST", body: form }).catch(() => null);
    const data = r ? ((await r.json().catch(() => ({}))) as { document?: ReadDocument; error?: string }) : { error: "Sem conexão com o servidor." };
    setNotice(null);
    if (fileInput.current) fileInput.current.value = "";
    if (data.document) await send(`📎 ${data.document.label}`, data.document);
    else setNotice(data.error ?? "Não consegui ler o documento.");
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-3" aria-live="polite">
        {/* na tela larga, a conversa fica numa largura de leitura (no painel lateral não muda nada) */}
        <div className="mx-auto max-w-4xl space-y-4">
          {messages.length === 0 && (
            <div className="space-y-3 pt-6 text-center">
              <Sparkles className="mx-auto text-brand" />
              <p className="text-sm text-muted">Fale, escreva, bipe ou mande uma foto (RG, CNH, boleto, Pix, nota). A {ASSISTANT_NAME} consulta o sistema e prepara vendas, cadastros e contas para você confirmar.</p>
              <div className="flex flex-wrap justify-center gap-2">
                {SUGGESTIONS.map((s) => <button key={s} onClick={() => send(s)} className="rounded-full border border-border bg-surface px-3 py-1 text-xs hover:bg-surface-2">{s}</button>)}
              </div>
            </div>
          )}
          {messages.map((m) => (
            <div key={m.id} className={cn("flex flex-col gap-2", m.role === "user" ? "items-end" : "items-stretch")}>
              {m.role === "user" ? (
                <p className="max-w-[85%] rounded-2xl rounded-br-sm bg-brand px-3 py-2 text-sm whitespace-pre-wrap text-brand-contrast">{m.text}</p>
              ) : (
                <>
                  {m.cards.map((c, i) => <CentralCard key={i} card={c} onPick={busy ? undefined : send} />)}
                  {m.text && <p className="text-sm whitespace-pre-wrap">{m.text}</p>}
                  {m.pending && <p className="flex items-center gap-2 text-xs text-muted"><Loader2 size={13} className="animate-spin" />{m.status ?? "Pensando…"}</p>}
                  {m.mode === "search" && <p className="text-[11px] text-muted">modo busca (sem IA)</p>}
                </>
              )}
            </div>
          ))}
          <div ref={bottom} />
        </div>
      </div>

      {(notice || recorder.error) && <p className="px-3 pb-1 text-xs text-warning">{notice ?? recorder.error}</p>}
      <form onSubmit={(e) => { e.preventDefault(); void send(input); }} className="flex items-end gap-1.5 border-t border-border p-2">
        <button type="button" onClick={() => setScanning(true)} disabled={busy} className="rounded-lg p-2 text-muted hover:bg-surface-2 disabled:opacity-50" aria-label="Bipar com a câmera" title="Bipar: etiqueta, boleto, Pix ou DANFE">
          <ScanBarcode size={18} />
        </button>
        <button type="button" onClick={() => fileInput.current?.click()} disabled={busy} className="rounded-lg p-2 text-muted hover:bg-surface-2 disabled:opacity-50"
                aria-label="Enviar foto ou documento" title="Foto ou PDF: RG/CNH, boleto, Pix, nota, recibo, etiqueta">
          <Paperclip size={18} />
        </button>
        <input ref={fileInput} type="file" accept="image/*,application/pdf,.xml,text/xml,application/xml" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} aria-label="Arquivo para a Central" />
        {recorder.supported && (
          <button type="button" onClick={toggleMic} disabled={busy && !recorder.recording}
                  className={cn("rounded-lg p-2 hover:bg-surface-2 disabled:opacity-50", recorder.recording ? "animate-pulse text-danger" : "text-muted")}
                  aria-label={recorder.recording ? "Parar e enviar o áudio" : "Falar"} title={recorder.recording ? "Parar e enviar" : "Falar"}>
            {recorder.recording ? <Square size={18} /> : <Mic size={18} />}
          </button>
        )}
        <textarea
          ref={inputRef}
          autoFocus={autoFocus}
          value={input}
          rows={1}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(input); } }}
          placeholder={recorder.recording ? "Ouvindo… toque no quadrado para enviar" : `Peça à ${ASSISTANT_NAME}…`}
          className="max-h-32 min-h-9 flex-1 resize-none rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand"
          aria-label={`Mensagem para a ${ASSISTANT_NAME}`}
        />
        <Button type="submit" disabled={busy || !input.trim()} className="px-2.5" aria-label="Enviar"><SendHorizontal size={16} /></Button>
      </form>
      {scanning && <BarcodeScanner onDone={onScanned} onClose={() => setScanning(false)} />}
    </div>
  );
}
