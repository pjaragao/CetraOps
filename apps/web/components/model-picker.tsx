"use client";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronDown, X } from "lucide-react";
import { cn, inputClass } from "./ui";

export interface ModelOption { id: string; label: string; hint?: string; group: string }

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/**
 * Escolha de modelo com busca (Modelos & custos): digite qualquer parte do nome, do nível de pensamento ou do slug.
 * Aceita um slug livre (ex.: modelo do OpenRouter fora da lista). `multiple` = lista de reservas (vai no formulário separada por vírgula).
 * A lista abre flutuando (position: fixed) para não ser cortada pela rolagem da tabela.
 */
export function ModelPicker({ options, name, form, defaultValue, multiple, disabled, ariaLabel, placeholder, className }: {
  options: ModelOption[]; name: string; form?: string; defaultValue: string | string[]; multiple?: boolean; disabled?: boolean;
  ariaLabel?: string; placeholder?: string; className?: string;
}) {
  const [values, setValues] = useState<string[]>(() => (Array.isArray(defaultValue) ? defaultValue : defaultValue ? [defaultValue] : []));
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ top: number; left: number; width: number; up: boolean } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const byId = useMemo(() => new Map(options.map((o) => [o.id, o])), [options]);

  const filtered = useMemo(() => {
    const terms = norm(q).split(/\s+/).filter(Boolean);
    const pool = multiple ? options.filter((o) => !values.includes(o.id)) : options;
    return terms.length ? pool.filter((o) => { const t = norm(`${o.label} ${o.hint ?? ""} ${o.id} ${o.group}`); return terms.every((w) => t.includes(w)); }) : pool;
  }, [options, q, values, multiple]);
  const custom = q.trim() && !byId.has(q.trim()) && /^[A-Za-z0-9._:/-]{3,100}$/.test(q.trim()) ? q.trim() : null;
  const items: ModelOption[] = custom ? [{ id: custom, label: `Usar «${custom}»`, hint: "slug digitado (OpenRouter: provedor/modelo)", group: "Outro" }, ...filtered] : filtered;

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node) && !pop.current?.contains(e.target as Node)) setOpen(false); };
    const away = (e: Event) => { if (!pop.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    window.addEventListener("scroll", away, true);
    window.addEventListener("resize", away);
    return () => { document.removeEventListener("mousedown", close); window.removeEventListener("scroll", away, true); window.removeEventListener("resize", away); };
  }, [open]);

  const openList = (first = "") => {
    if (disabled || !box.current) return;
    const r = box.current.getBoundingClientRect();
    const up = window.innerHeight - r.bottom < 340 && r.top > window.innerHeight - r.bottom;
    setPos({ top: up ? r.top - 4 : r.bottom + 4, left: Math.min(r.left, window.innerWidth - 336), width: Math.max(r.width, 320), up });
    setQ(first);
    setActive(0);
    setOpen(true);
    setTimeout(() => input.current?.focus(), 0);
  };
  const pick = (id: string) => {
    setValues((v) => (multiple ? [...v.filter((x) => x !== id), id] : [id]));
    setQ("");
    if (!multiple) setOpen(false);
  };
  const remove = (id: string) => setValues((v) => v.filter((x) => x !== id));
  const label = (id: string) => byId.get(id)?.label ?? id;

  return (
    <div ref={box} className={cn("relative", className)}>
      <input type="hidden" name={name} form={form} value={values.join(", ")} />
      <div role="button" tabIndex={disabled ? -1 : 0} aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={(e) => { if (e.key === "ArrowDown" || e.key === "Enter" || (e.key.length === 1 && !e.ctrlKey && !e.metaKey)) { e.preventDefault(); openList(e.key.length === 1 ? e.key : ""); } }}
        className={cn(inputClass, "flex min-h-9 cursor-pointer items-center justify-between gap-2 text-left", disabled && "pointer-events-none opacity-60")}>
        <span className="flex min-w-0 flex-wrap gap-1">
          {values.length === 0 && <span className="text-muted">{placeholder ?? (multiple ? "Nenhuma" : "Escolha…")}</span>}
          {!multiple && values[0] && <span className="truncate" title={values[0]}>{label(values[0])}</span>}
          {multiple && values.map((v) => (
            <span key={v} title={v} className="inline-flex max-w-full items-center gap-1 rounded bg-surface-2 px-1.5 py-0.5 text-xs">
              <span className="truncate">{label(v)}</span>
              {!disabled && <span role="button" tabIndex={-1} aria-label={`Tirar ${label(v)}`} className="rounded hover:bg-border" onClick={(e) => { e.stopPropagation(); remove(v); }}><X size={12} /></span>}
            </span>
          ))}
        </span>
        <ChevronDown size={14} className="shrink-0" />
      </div>
      {open && pos && (
        <div ref={pop} style={{ position: "fixed", left: pos.left, width: pos.width, ...(pos.up ? { bottom: window.innerHeight - pos.top } : { top: pos.top }) }}
          className="z-50 rounded-lg border border-border bg-surface shadow-lg">
          <input ref={input} value={q} placeholder="Buscar: nome, nível (alto, baixo), agy, slug…" aria-label="Buscar modelo" aria-controls={listId}
            onChange={(e) => { setQ(e.target.value); setActive(0); }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, items.length - 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
              else if (e.key === "Enter") { e.preventDefault(); if (items[active]) pick(items[active].id); }
              else if (e.key === "Escape") { e.preventDefault(); setOpen(false); }
              else if (e.key === "Backspace" && !q && multiple && values.length) remove(values[values.length - 1]);
            }}
            className="w-full rounded-t-lg border-b border-border bg-bg px-3 py-2 text-sm outline-none" />
          <ul id={listId} role="listbox" className="max-h-72 overflow-y-auto py-1 text-sm">
            {items.length === 0 && <li className="px-3 py-2 text-muted">Nada encontrado</li>}
            {items.map((o, i) => {
              const header = i === 0 || items[i - 1].group !== o.group ? o.group : null;
              return (
                <li key={`${o.group}:${o.id}`} role="option" aria-selected={values.includes(o.id)}>
                  {header && <p className="px-3 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">{header}</p>}
                  <div onMouseEnter={() => setActive(i)} onMouseDown={(e) => { e.preventDefault(); pick(o.id); }}
                    className={cn("cursor-pointer px-3 py-1.5", i === active && "bg-surface-2", values.includes(o.id) && "font-medium text-brand")}>
                    {o.label}{o.hint && <span className="block text-xs text-muted">{o.hint}</span>}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
