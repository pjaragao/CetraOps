"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bell } from "lucide-react";
import { describeNotification, timeAgo } from "@sie/domain";
import { createClient } from "@/lib/supabase/client";
import { markAllNotificationsRead } from "@/app/(app)/notificacoes/actions";

interface Item { id: string; kind: string; title: string; payload: Record<string, unknown>; read_at: string | null; created_at: string }

const TONE_DOT = { info: "bg-info", success: "bg-success", warning: "bg-warning", danger: "bg-danger" } as const;

/** Sino do app: contador de não lidas em tempo real (Realtime filtrado pelo membro; o RLS também protege) e as 15 últimas ao abrir. */
export function NotificationBell({ memberId, initialUnread }: { memberId: string; initialUnread: number }) {
  const supabase = useMemo(() => createClient(), []);
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(initialUnread);
  const [items, setItems] = useState<Item[] | null>(null);
  const box = useRef<HTMLDivElement>(null);

  const countUnread = useCallback(async () => {
    const { count } = await supabase.schema("core").from("notifications").select("id", { count: "exact", head: true }).is("read_at", null);
    if (count !== null) setUnread(count);
  }, [supabase]);

  const load = useCallback(async () => {
    const { data } = await supabase.schema("core").from("notifications").select("id, kind, title, payload, read_at, created_at").order("created_at", { ascending: false }).limit(15);
    setItems((data ?? []) as Item[]);
  }, [supabase]);

  useEffect(() => {
    const channel = supabase.channel(`bell-${memberId}`)
      .on("postgres_changes", { event: "INSERT", schema: "core", table: "notifications", filter: `member_id=eq.${memberId}` }, (p) => {
        setUnread((n) => n + 1);
        setItems((prev) => (prev ? [p.new as Item, ...prev].slice(0, 15) : prev));
      })
      .on("postgres_changes", { event: "UPDATE", schema: "core", table: "notifications", filter: `member_id=eq.${memberId}` }, () => { void countUnread(); void load(); })
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [supabase, memberId, countUnread, load]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const toggle = () => { if (!open) void load(); setOpen((o) => !o); };

  const markAll = async () => { await markAllNotificationsRead(); setUnread(0); setItems((prev) => prev?.map((i) => ({ ...i, read_at: i.read_at ?? new Date().toISOString() })) ?? prev); };

  return (
    <div ref={box} className="relative">
      <button onClick={toggle} aria-haspopup="true" aria-expanded={open} aria-label={unread ? `Notificações, ${unread} não lidas` : "Notificações"} title="Notificações"
        className="relative rounded-lg p-2 text-muted hover:bg-surface-2">
        <Bell size={16} />
        {unread > 0 && <span className="absolute right-0.5 top-0.5 flex min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold leading-4 text-white">{unread > 99 ? "99+" : unread}</span>}
      </button>
      {open && (
        <div role="region" aria-label="Notificações" className="absolute right-0 z-40 mt-2 w-[22rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border bg-surface shadow-lg">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-sm font-semibold">Notificações</span>
            {unread > 0 && <button onClick={markAll} className="text-xs text-brand hover:underline">Marcar todas como lidas</button>}
          </div>
          <ul className="max-h-[60dvh] overflow-y-auto">
            {items === null && <li className="px-3 py-6 text-center text-sm text-muted">Carregando…</li>}
            {items?.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted">Nada por aqui. Avisos de atendimento, fiscal e integrações aparecem neste sino.</li>}
            {items?.map((n) => {
              const v = describeNotification(n.kind, n.payload);
              return (
                <li key={n.id} className="border-b border-border last:border-0">
                  <a href={`/notificacoes/abrir?id=${n.id}`} className={`flex gap-2 px-3 py-2.5 hover:bg-surface-2 ${n.read_at ? "" : "bg-brand/5"}`} onClick={() => setTimeout(() => setOpen(false), 50)}>
                    <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${n.read_at ? "bg-border" : TONE_DOT[v.tone]}`} aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[11px] uppercase tracking-wide text-muted">{v.label}</span>
                      <span className={`line-clamp-2 text-sm ${n.read_at ? "text-muted" : "font-medium"}`}>{n.title}</span>
                    </span>
                    <span className="shrink-0 text-[11px] text-muted">{timeAgo(n.created_at)}</span>
                  </a>
                </li>
              );
            })}
          </ul>
          <Link href="/notificacoes" onClick={() => setTimeout(() => setOpen(false), 50)} className="block border-t border-border px-3 py-2 text-center text-xs text-brand hover:bg-surface-2">Ver todas</Link>
        </div>
      )}
    </div>
  );
}
