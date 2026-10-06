"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Maximize2, Plus, Sparkles, X } from "lucide-react";
import { ASSISTANT_NAME } from "@centralops/domain";
import { cn } from "@/components/ui";
import { CentralChat } from "./central-chat";

const KEY = "centralops:central-thread";
const EVENT = "centralops:central-thread";

/** A última conversa fica no navegador (por pessoa); sem armazenamento disponível, cada abertura começa uma conversa nova. */
function subscribe(cb: () => void) {
  window.addEventListener("storage", cb);
  window.addEventListener(EVENT, cb);
  return () => { window.removeEventListener("storage", cb); window.removeEventListener(EVENT, cb); };
}
function readThread(): string | null {
  try { return window.localStorage.getItem(KEY); } catch { return null; }
}
function writeThread(id: string | null) {
  try { if (id) window.localStorage.setItem(KEY, id); else window.localStorage.removeItem(KEY); } catch { /* vale só nesta página */ }
  window.dispatchEvent(new Event(EVENT));
}

/** Painel da Central em todas as telas (botão na barra do topo, Ctrl+/ ou Ctrl+K): a conversa abre ao lado, sem sair do que se está fazendo. */
export function CentralLauncher() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const threadId = useSyncExternalStore(subscribe, readThread, () => null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "/") { e.preventDefault(); setOpen((o) => !o); }
      if (e.key === "Escape") setOpen(false);
    };
    const onOpen = (e: Event) => {
      setOpen(true);
      const text = (e as CustomEvent<{ text?: string }>).detail?.text?.trim();
      if (text) setPending(text);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("centralops:central", onOpen);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("centralops:central", onOpen); };
  }, []);

  if (pathname.startsWith("/central")) return null;

  return (
    <>
      <aside
        className={cn("fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-border bg-bg shadow-2xl transition-transform sm:w-[440px]", open ? "translate-x-0" : "translate-x-full")}
        inert={!open}
        aria-label={ASSISTANT_NAME}
      >
        <header className="flex items-center gap-2 border-b border-border px-3 py-2">
          <Sparkles size={16} className="text-brand" />
          <p className="flex-1 text-sm font-semibold">{ASSISTANT_NAME}</p>
          <button onClick={() => writeThread(null)} className="rounded-lg p-1.5 text-muted hover:bg-surface-2" title="Nova conversa" aria-label="Nova conversa"><Plus size={16} /></button>
          <Link href={threadId ? `/central?c=${threadId}` : "/central"} onClick={() => setOpen(false)} className="rounded-lg p-1.5 text-muted hover:bg-surface-2" title="Tela cheia e histórico" aria-label="Abrir em tela cheia"><Maximize2 size={16} /></Link>
          <button onClick={() => setOpen(false)} className="rounded-lg p-1.5 text-muted hover:bg-surface-2" aria-label="Fechar"><X size={16} /></button>
        </header>
        {open && <CentralChat threadId={threadId} onThread={writeThread} pendingMessage={pending} onPendingSent={() => setPending(null)} />}
      </aside>
    </>
  );
}
