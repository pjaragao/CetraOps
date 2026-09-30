"use client";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { inputClass } from "@/components/ui";
import { searchVariants } from "./actions";

export interface VariantHit { id: string; sku: string; label: string; gtin: string | null }

/** Busca variantes por SKU, EAN ou nome e devolve a escolhida. Resultados vêm do banco (RLS aplicado). */
export function VariantPicker({ onPick, placeholder = "Buscar por SKU, EAN ou nome", autoFocus, className }: {
  onPick: (v: VariantHit) => void; placeholder?: string; autoFocus?: boolean; className?: string;
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<VariantHit[]>([]);
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const listId = useId();

  useEffect(() => {
    clearTimeout(timer.current);
    if (q.trim().length < 2) return;
    timer.current = setTimeout(() => start(async () => { setHits(await searchVariants(q)); setOpen(true); }), 250);
    return () => clearTimeout(timer.current);
  }, [q]);

  return (
    <div className={`relative ${className ?? ""}`}>
      <input value={q} onChange={(e) => { setQ(e.target.value); if (e.target.value.trim().length < 2) { setHits([]); setOpen(false); } }} autoFocus={autoFocus}
        onFocus={() => hits.length && setOpen(true)} onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}
        placeholder={placeholder} className={inputClass} aria-label="Buscar produto" role="combobox" aria-expanded={open} aria-controls={listId} autoComplete="off" />
      {open && (
        <ul id={listId} className="absolute z-20 mt-1 max-h-64 w-full min-w-72 overflow-auto rounded-lg border border-border bg-surface shadow-lg" role="listbox">
          {hits.length === 0 ? <li className="px-3 py-2 text-sm text-muted">{pending ? "Buscando…" : "Nada encontrado"}</li> : hits.map((h) => (
            <li key={h.id}>
              <button type="button" role="option" aria-selected={false} className="block w-full px-3 py-2 text-left text-sm hover:bg-surface-2"
                onClick={() => { onPick(h); setQ(""); setHits([]); setOpen(false); }}>
                <span className="font-mono text-xs text-muted">{h.sku}</span> <span>{h.label}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
