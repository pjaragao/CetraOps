"use client";
import { useEffect, useId, useRef, useState, useTransition, type ReactNode } from "react";
import { inputClass } from "./ui";

/** Caixa de busca com lista de resultados vindos do servidor (RLS aplicado). Genérica: quem usa define a busca e o desenho do item. */
export function SearchPicker<T extends { id: string }>({ search, render, onPick, placeholder = "Buscar…", label = "Buscar", className, autoFocus }: {
  search: (q: string) => Promise<T[]>; render: (item: T) => ReactNode; onPick: (item: T) => void; placeholder?: string; label?: string; className?: string; autoFocus?: boolean;
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<T[]>([]);
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const listId = useId();

  useEffect(() => {
    clearTimeout(timer.current);
    if (q.trim().length < 2) return;
    timer.current = setTimeout(() => start(async () => { setHits(await search(q)); setOpen(true); }), 250);
    return () => clearTimeout(timer.current);
  }, [q, search]);

  return (
    <div className={`relative ${className ?? ""}`}>
      <input value={q} autoFocus={autoFocus} autoComplete="off" placeholder={placeholder} aria-label={label} role="combobox" aria-expanded={open} aria-controls={listId} className={inputClass}
        onChange={(e) => { setQ(e.target.value); if (e.target.value.trim().length < 2) { setHits([]); setOpen(false); } }}
        onFocus={() => hits.length > 0 && setOpen(true)} onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }} />
      {open && (
        <ul id={listId} role="listbox" className="absolute z-20 mt-1 max-h-64 w-full min-w-72 overflow-auto rounded-lg border border-border bg-surface shadow-lg">
          {hits.length === 0 ? <li className="px-3 py-2 text-sm text-muted">{pending ? "Buscando…" : "Nada encontrado"}</li> : hits.map((h) => (
            <li key={h.id}>
              <button type="button" role="option" aria-selected={false} className="block w-full px-3 py-2 text-left text-sm hover:bg-surface-2"
                onClick={() => { onPick(h); setQ(""); setHits([]); setOpen(false); }}>{render(h)}</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
