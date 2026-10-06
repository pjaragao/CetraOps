"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Archive, MessageSquare, Plus } from "lucide-react";
import { Button, cn } from "@/components/ui";
import { CentralChat } from "@/components/central/central-chat";
import { archiveCentralThread, type ThreadSummary } from "./actions";

/** Página da Central: histórico de conversas à esquerda e a conversa aberta à direita. */
export function CentralWorkspace({ threads, initialThread }: { threads: ThreadSummary[]; initialThread: string | null }) {
  const router = useRouter();
  const [current, setCurrent] = useState<string | null>(initialThread);
  const [, start] = useTransition();
  return (
    <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
      <nav className="space-y-1" aria-label="Conversas">
        <Button variant="secondary" className="w-full" onClick={() => setCurrent(null)}><Plus size={15} /> Nova conversa</Button>
        {threads.map((t) => (
          <div key={t.id} className={cn("group flex items-center gap-1 rounded-lg", current === t.id && "bg-surface-2")}>
            <button onClick={() => setCurrent(t.id)} className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm">
              <MessageSquare size={14} className="shrink-0 text-muted" />
              <span className="truncate">{t.title ?? "Conversa"}</span>
            </button>
            <button onClick={() => start(async () => { await archiveCentralThread(t.id); if (current === t.id) setCurrent(null); router.refresh(); })}
                    className="rounded p-1 text-muted opacity-0 group-hover:opacity-100 hover:bg-surface-2" aria-label="Arquivar conversa" title="Arquivar"><Archive size={13} /></button>
          </div>
        ))}
      </nav>
      <section className="h-[calc(100dvh-13rem)] min-h-[420px] overflow-hidden rounded-xl border border-border bg-surface">
        <CentralChat threadId={current} onThread={(id) => { setCurrent(id); router.refresh(); }} />
      </section>
    </div>
  );
}
