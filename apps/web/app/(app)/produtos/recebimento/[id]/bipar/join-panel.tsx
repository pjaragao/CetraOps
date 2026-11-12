"use client";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Layers, X } from "lucide-react";
import { formatBRL } from "@centralops/domain";
import { Button, cn } from "@/components/ui";

/** Outra nota em aberto (do mesmo fornecedor) que dá para bipar junto com a atual. */
export interface Sibling { id: string; nf: string; receiptNumber: string; total: number; issueAt: string | null; pieces: number; counted: number }

const fmtQty = (n: number) => (Number.isInteger(n) ? String(n) : n.toLocaleString("pt-BR", { maximumFractionDigits: 3 }));

/**
 * Juntar notas: recebeu várias caixas do mesmo pedido, cada uma com a sua NF-e, mas as peças não vêm separadas por nota.
 * Escolhidas as notas, a bipagem passa a ser uma só e cada peça entra na nota que ainda precisa dela.
 */
export function JoinPanel({ currentId, currentLabel, siblings, onJoin, onClose }: {
  currentId: string; currentLabel: string; siblings: Sibling[]; onJoin(otherIds: string[]): void; onClose(): void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="join-title" data-current={currentId} className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-border bg-surface p-4 shadow-xl">
        <div className="mb-3 flex items-start gap-2">
          <Layers size={20} className="mt-0.5 text-brand" />
          <div className="min-w-0 flex-1">
            <h2 id="join-title" className="font-semibold">Bipar várias NF-e de uma vez</h2>
            <p className="text-xs text-muted">Cada peça bipada entra na nota que ainda precisa dela. Cada nota segue com a sua conferência, vencimentos e lançamento.</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1 hover:bg-surface-2" aria-label="Fechar"><X size={18} /></button>
        </div>
        <ul className="space-y-1.5">
          <li className="flex items-center gap-2 rounded-lg border border-brand/40 bg-brand/5 px-3 py-2 text-sm"><input type="checkbox" checked disabled aria-label={`${currentLabel} (esta nota)`} /> <span className="font-medium">{currentLabel}</span><span className="text-xs text-muted">· esta nota</span></li>
          {siblings.map((s) => (
            <li key={s.id}>
              <label className={cn("flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm", picked.includes(s.id) ? "border-brand bg-brand/5" : "border-border")}>
                <input type="checkbox" checked={picked.includes(s.id)} onChange={() => toggle(s.id)} />
                <span className="min-w-0 flex-1 truncate">NF-e {s.nf} <span className="text-xs text-muted">· {s.receiptNumber}{s.issueAt ? ` · ${s.issueAt}` : ""}</span>
                  <span className="block text-xs text-muted">{formatBRL(s.total)} · {fmtQty(s.counted)}/{fmtQty(s.pieces)} peças bipadas</span></span>
              </label>
            </li>
          ))}
        </ul>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button type="button" disabled={picked.length === 0} onClick={() => onJoin(picked)}><Layers size={16} /> Bipar {picked.length + 1} notas juntas</Button>
          <Button type="button" variant="ghost" onClick={onClose}>Cancelar</Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
