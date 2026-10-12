"use client";
import Link from "next/link";
import { useState } from "react";
import { inputClass } from "@/components/ui";
import { SellablePicker } from "../../vender/pickers";

interface Line { id: string; sku: string; label: string; qty: number }

export function LabelPicker() {
  const [lines, setLines] = useState<Line[]>([]);
  const href = `/imprimir/etiquetas?i=${lines.map((l) => `${l.id}:${l.qty}`).join(",")}`;
  return (
    <div className="space-y-3">
      <SellablePicker placeholder="Buscar peça por nome, referência, SKU ou EAN" onPick={(v) => setLines((p) => (p.some((l) => l.id === v.id) ? p : [...p, { id: v.id, sku: v.sku, label: v.label, qty: Math.max(1, v.available) }]))} />
      {lines.length > 0 && (
        <ul className="divide-y divide-border rounded-xl border border-border text-sm">
          {lines.map((l, i) => (
            <li key={l.id} className="flex items-center justify-between gap-2 px-3 py-1.5">
              <span><span className="font-mono text-xs text-muted">{l.sku}</span> {l.label}</span>
              <span className="flex items-center gap-2">
                <input type="number" min={1} max={500} value={l.qty} onChange={(e) => setLines((p) => p.map((x, j) => (j === i ? { ...x, qty: Math.max(1, Math.trunc(Number(e.target.value) || 1)) } : x)))}
                  className={`${inputClass} w-20`} aria-label={`Etiquetas de ${l.sku}`} />
                <button type="button" onClick={() => setLines((p) => p.filter((_, j) => j !== i))} className="text-muted hover:text-danger" aria-label={`Remover ${l.sku}`}>×</button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {lines.length > 0 && <Link href={href} className="inline-flex rounded-lg bg-brand px-3 py-2 text-sm font-medium text-brand-contrast">Gerar {lines.reduce((a, l) => a + l.qty, 0)} etiqueta(s)</Link>}
    </div>
  );
}
