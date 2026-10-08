"use client";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronDown, X } from "lucide-react";
import { cn, inputClass } from "./ui";

export interface SearchOption { id: string; label: string; hint?: string }

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/**
 * Lista suspensa com busca: digite para filtrar (sem acento, por qualquer parte do texto), setas e Enter para escolher.
 * Controlada (value/onChange) ou dentro de formulário (name + defaultValue → campo escondido com o id).
 */
export function SearchSelect({ options, value, defaultValue, onChange, name, placeholder = "Escolha…", emptyLabel, className, ariaLabel, required, disabled }: {
  options: SearchOption[]; value?: string; defaultValue?: string; onChange?: (id: string) => void; name?: string; placeholder?: string;
  emptyLabel?: string; className?: string; ariaLabel?: string; required?: boolean; disabled?: boolean;
}) {
  const [inner, setInner] = useState(defaultValue ?? "");
  const current = value ?? inner;
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();

  const selected = options.find((o) => o.id === current);
  const filtered = useMemo(() => {
    const terms = norm(q).split(/\s+/).filter(Boolean);
    const list = terms.length ? options.filter((o) => { const t = norm(`${o.label} ${o.hint ?? ""}`); return terms.every((w) => t.includes(w)); }) : options;
    return list.slice(0, 200);
  }, [options, q]);
  const items = emptyLabel !== undefined && !q ? [{ id: "", label: emptyLabel }, ...filtered] : filtered;

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const pick = (id: string) => {
    if (value === undefined) setInner(id);
    onChange?.(id);
    setOpen(false);
    setQ("");
  };
  const openList = () => { if (disabled) return; setOpen(true); setActive(0); setTimeout(() => input.current?.focus(), 0); };

  return (
    <div ref={box} className={cn("relative", className)}>
      {name && <input type="hidden" name={name} value={current} />}
      {name && required && <input tabIndex={-1} aria-hidden className="pointer-events-none absolute h-0 w-0 opacity-0" required value={current} onChange={() => {}} />}
      <button type="button" disabled={disabled} aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open} onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={(e) => { if (e.key === "ArrowDown" || e.key === "Enter" || (e.key.length === 1 && !e.ctrlKey && !e.metaKey)) { e.preventDefault(); openList(); if (e.key.length === 1) setQ(e.key); } }}
        className={cn(inputClass, "flex items-center justify-between gap-2 text-left", !selected && "text-muted", disabled && "opacity-60")}>
        <span className="truncate">{selected ? selected.label : current === "" && emptyLabel ? emptyLabel : placeholder}</span>
        <span className="flex shrink-0 items-center gap-1">
          {selected && emptyLabel !== undefined && !disabled && (
            <span role="button" tabIndex={-1} aria-label="Limpar" className="rounded p-0.5 hover:bg-surface-2" onClick={(e) => { e.stopPropagation(); pick(""); }}><X size={14} /></span>
          )}
          <ChevronDown size={14} />
        </span>
      </button>
      {open && (
        <div className="absolute z-30 mt-1 w-full min-w-[16rem] rounded-lg border border-border bg-surface shadow-lg">
          <input ref={input} value={q} placeholder="Digite para buscar…" aria-label="Buscar" aria-controls={listId}
            onChange={(e) => { setQ(e.target.value); setActive(0); }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, items.length - 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
              else if (e.key === "Enter") { e.preventDefault(); if (items[active]) pick(items[active].id); }
              else if (e.key === "Escape") { e.preventDefault(); setOpen(false); }
            }}
            className="w-full rounded-t-lg border-b border-border bg-bg px-3 py-2 text-sm outline-none" />
          <ul id={listId} role="listbox" className="max-h-64 overflow-y-auto py-1 text-sm">
            {items.length === 0 && <li className="px-3 py-2 text-muted">Nada encontrado</li>}
            {items.map((o, i) => (
              <li key={o.id || "_empty"} role="option" aria-selected={o.id === current}
                onMouseEnter={() => setActive(i)} onMouseDown={(e) => { e.preventDefault(); pick(o.id); }}
                className={cn("cursor-pointer px-3 py-1.5", i === active && "bg-surface-2", o.id === current && "font-medium text-brand")}>
                {o.label}{"hint" in o && o.hint && <span className="block text-xs text-muted">{o.hint}</span>}
              </li>
            ))}
            {filtered.length === 200 && <li className="px-3 py-1.5 text-xs text-muted">Mostrando os 200 primeiros: digite mais para refinar</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
