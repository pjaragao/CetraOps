"use client";
import Link from "next/link";
import { useOptimistic, useTransition } from "react";
import { Check, Circle, TriangleAlert } from "lucide-react";
import { cn } from "@/components/ui";
import { checkRoutineItem } from "./actions";

export interface RoutineItem { key: string; label: string; auto: boolean; ok: boolean; detail?: string; href?: string; by?: string | null; at?: string | null }

/** Itens automáticos (conferidos nos dados, com atalho para resolver) e manuais (toque para marcar). */
export function RoutineChecklist({ storeId, kind, items, editable }: { storeId: string; kind: "OPENING" | "CLOSING"; items: RoutineItem[]; editable: boolean }) {
  const [list, setOptimistic] = useOptimistic(items, (cur, u: { key: string; ok: boolean }) => cur.map((i) => (i.key === u.key ? { ...i, ok: u.ok } : i)));
  const [, start] = useTransition();
  const toggle = (i: RoutineItem) => start(async () => { setOptimistic({ key: i.key, ok: !i.ok }); await checkRoutineItem(storeId, kind, i.key, !i.ok); });
  return (
    <ul className="divide-y divide-border">
      {list.map((i) => (
        <li key={i.key} className="flex items-start gap-3 py-2.5">
          {i.auto ? (
            i.ok ? <Check className="mt-0.5 shrink-0 text-success" size={18} aria-label="ok" /> : <TriangleAlert className="mt-0.5 shrink-0 text-warning" size={18} aria-label="pendente" />
          ) : (
            <button type="button" disabled={!editable} onClick={() => toggle(i)} aria-pressed={i.ok} aria-label={i.label}
              className={cn("mt-0.5 shrink-0 rounded-full", i.ok ? "text-success" : "text-muted hover:text-foreground")}>
              {i.ok ? <Check size={18} /> : <Circle size={18} />}
            </button>
          )}
          <div className="min-w-0 flex-1">
            <p className={cn("text-sm", i.ok && !i.auto && "text-muted line-through")}>{i.label}{i.auto && <span className="ml-2 rounded bg-surface-2 px-1.5 text-[10px] uppercase text-muted">automático</span>}</p>
            {i.detail && <p className={cn("text-xs", i.ok ? "text-muted" : "text-warning")}>{i.detail}{!i.ok && i.href && <> · <Link className="text-brand" href={i.href}>resolver</Link></>}</p>}
            {!i.auto && i.ok && i.by && <p className="text-xs text-muted">{i.by}</p>}
          </div>
        </li>
      ))}
    </ul>
  );
}
