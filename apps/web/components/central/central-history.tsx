"use client";
import { useEffect, useMemo, useState, useTransition } from "react";
import { Archive, Loader2, MessageSquare, Search } from "lucide-react";
import { cn } from "@/components/ui";
import { archiveCentralThread, listCentralThreads, type ThreadSummary } from "@/app/(app)/central/actions";

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const days = Math.floor((new Date(today.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86_400_000);
  if (days <= 0) return "Hoje";
  if (days === 1) return "Ontem";
  if (days < 7) return "Últimos 7 dias";
  if (days < 30) return "Últimos 30 dias";
  return d.toLocaleDateString("pt-BR", { month: "long", year: "numeric", timeZone: "America/Sao_Paulo" });
}

/** Conversas da pessoa com a Central (cada pessoa só vê as suas), agrupadas por data, com busca pelo título. */
export function CentralHistory({ current, onOpen }: { current: string | null; onOpen(id: string): void }) {
  const [threads, setThreads] = useState<ThreadSummary[] | null>(null);
  const [q, setQ] = useState("");
  const [, start] = useTransition();

  useEffect(() => {
    let alive = true;
    listCentralThreads().then((t) => { if (alive) setThreads(t); });
    return () => { alive = false; };
  }, []);

  const groups = useMemo(() => {
    const terms = norm(q).split(/\s+/).filter(Boolean);
    const list = (threads ?? []).filter((t) => terms.every((w) => norm(t.title ?? "Conversa").includes(w)));
    const out: { label: string; items: ThreadSummary[] }[] = [];
    for (const t of list) {
      const label = dayLabel(t.updated_at);
      if (out.at(-1)?.label !== label) out.push({ label, items: [] });
      out.at(-1)!.items.push(t);
    }
    return out;
  }, [threads, q]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-border p-2">
        <label className="flex items-center gap-2 rounded-lg border border-border bg-bg px-2.5 py-1.5 text-sm focus-within:ring-2 focus-within:ring-brand">
          <Search size={14} className="text-muted" />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar nas minhas conversas…" className="min-w-0 flex-1 bg-transparent outline-none" aria-label="Buscar conversa" />
        </label>
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto p-2" aria-label="Minhas conversas">
        {threads === null && <p className="flex items-center gap-2 p-2 text-xs text-muted"><Loader2 size={13} className="animate-spin" /> Carregando…</p>}
        {threads !== null && groups.length === 0 && <p className="p-2 text-sm text-muted">{q ? "Nenhuma conversa com esse texto." : "Nenhuma conversa ainda."}</p>}
        {groups.map((g) => (
          <div key={g.label} className="mb-2">
            <p className="px-2 pt-1 pb-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted">{g.label}</p>
            {g.items.map((t) => (
              <div key={t.id} className={cn("group flex items-center gap-1 rounded-lg hover:bg-surface-2", current === t.id && "bg-surface-2")}>
                <button onClick={() => onOpen(t.id)} className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm">
                  <MessageSquare size={14} className="shrink-0 text-muted" />
                  <span className="min-w-0 flex-1 truncate">{t.title ?? "Conversa"}</span>
                  <span className="shrink-0 text-[11px] text-muted">{new Date(t.updated_at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" })}</span>
                </button>
                <button onClick={() => start(async () => { await archiveCentralThread(t.id); setThreads((all) => (all ?? []).filter((x) => x.id !== t.id)); })}
                        className="rounded p-1 text-muted opacity-0 group-hover:opacity-100 hover:bg-border focus:opacity-100" aria-label="Arquivar conversa" title="Arquivar"><Archive size={13} /></button>
              </div>
            ))}
          </div>
        ))}
      </nav>
    </div>
  );
}
