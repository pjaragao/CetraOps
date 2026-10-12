"use client";
import { useState } from "react";
import { useKeptForm } from "@/components/use-kept-form";
import { Button, inputClass } from "@/components/ui";
import { Field } from "@/components/form";
import { SellablePicker } from "../../../vender/pickers";
import { adjustStockAction } from "../../contagem/actions";

const REASONS = { LOSS: "Perda / furto (sai do estoque)", DAMAGE: "Avaria (sai do estoque)", MARKETING_GIFT: "Brinde ou uso em marketing (sai do estoque)", CORRECTION: "Correção (entrada ou saída)" } as const;

interface Line { variant_id: string; sku: string; label: string; qty: number }

export function AdjustForm({ locations }: { locations: { id: string; name: string }[] }) {
  const { state, pending, formProps } = useKeptForm(adjustStockAction);
  const [location, setLocation] = useState(locations[0]?.id ?? "");
  const [reason, setReason] = useState<keyof typeof REASONS>("LOSS");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const payload = JSON.stringify({ location_id: location, reason, notes, items: lines.map((l) => ({ variant_id: l.variant_id, qty: l.qty })) });

  return (
    <form {...formProps} className="space-y-3">
      <input type="hidden" name="payload" value={payload} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Local"><select value={location} onChange={(e) => setLocation(e.target.value)} className={inputClass}>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>
        <Field label="Motivo"><select value={reason} onChange={(e) => setReason(e.target.value as keyof typeof REASONS)} className={inputClass}>{Object.entries(REASONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="Explique (fica no histórico)"><input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={300} className={inputClass} placeholder="Ex.: costura aberta na lavagem" /></Field>
      </div>
      <SellablePicker locationId={location} placeholder="Adicionar peça" onPick={(v) => setLines((p) => (p.some((l) => l.variant_id === v.id) ? p : [...p, { variant_id: v.id, sku: v.sku, label: v.label, qty: 1 }]))} />
      {lines.length > 0 && (
        <ul className="divide-y divide-border rounded-xl border border-border text-sm">
          {lines.map((l, i) => (
            <li key={l.variant_id} className="flex items-center justify-between gap-2 px-3 py-1.5">
              <span><span className="font-mono text-xs text-muted">{l.sku}</span> {l.label}</span>
              <span className="flex items-center gap-2">
                <input type="number" value={l.qty} onChange={(e) => setLines((p) => p.map((x, j) => (j === i ? { ...x, qty: Math.trunc(Number(e.target.value) || 0) } : x)))}
                  className={`${inputClass} w-20`} aria-label={`Quantidade de ${l.sku}`} title={reason === "CORRECTION" ? "positivo entra, negativo sai" : "quantidade que sai"} />
                <button type="button" onClick={() => setLines((p) => p.filter((_, j) => j !== i))} className="text-muted hover:text-danger" aria-label={`Remover ${l.sku}`}>×</button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {reason === "CORRECTION" && <p className="text-xs text-muted">Na correção, quantidade positiva entra no estoque e negativa sai.</p>}
      {state && !state.ok && <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{state.error}</p>}
      <Button disabled={pending || lines.length === 0 || notes.trim().length < 3 || lines.some((l) => l.qty === 0)}>{pending ? "Lançando…" : "Lançar ajuste"}</Button>
    </form>
  );
}
