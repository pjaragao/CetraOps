"use client";
import { useState } from "react";
import { useKeptForm } from "@/components/use-kept-form";
import { Button, inputClass } from "@/components/ui";
import { Field } from "@/components/form";
import { prepareLockerAction } from "../actions";
import { PartyPicker, SellablePicker, type PartyHit } from "../pickers";

interface Line { variant_id: string; sku: string; label: string; qty: number; available: number }

/** Separa peças no Armário VIP para uma cliente: reserva pelo prazo e libera sozinho se ela não vier. */
export function LockerForm({ storeId, lockers, locationId }: { storeId: string; lockers: { id: string; code: string }[]; locationId?: string }) {
  const { state, pending, formProps } = useKeptForm(prepareLockerAction);
  const [party, setParty] = useState<PartyHit | null>(null);
  const [locker, setLocker] = useState(lockers[0]?.id ?? "");
  const [hours, setHours] = useState(48);
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const payload = JSON.stringify({ store_id: storeId, locker_id: locker, party_id: party?.id, hold_hours: hours, ...(notes ? { notes } : {}), items: lines.map((l) => ({ variant_id: l.variant_id, qty: l.qty })) });

  return (
    <form {...formProps} className="space-y-3">
      <input type="hidden" name="payload" value={payload} />
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="sm:col-span-2">
          <span className="text-xs text-muted">Cliente</span>
          {party ? <p className="mt-1 flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm"><b>{party.name}</b><span className="text-muted">{party.phone}</span><button type="button" className="ml-auto text-xs text-brand" onClick={() => setParty(null)}>trocar</button></p>
            : <div className="mt-1"><PartyPicker onPick={setParty} /></div>}
        </div>
        <Field label="Armário"><select value={locker} onChange={(e) => setLocker(e.target.value)} className={inputClass}>{lockers.map((l) => <option key={l.id} value={l.id}>{l.code}</option>)}</select></Field>
        <Field label="Guardar por (horas)"><input type="number" min={1} max={168} value={hours} onChange={(e) => setHours(Number(e.target.value) || 48)} className={inputClass} /></Field>
        <Field label="Observações" className="sm:col-span-2"><input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={300} className={inputClass} placeholder="Ex.: prova após o treino de terça" /></Field>
      </div>
      <SellablePicker locationId={locationId} placeholder="Adicionar peça ao armário" onPick={(v) => setLines((p) => (p.some((l) => l.variant_id === v.id) ? p : [...p, { variant_id: v.id, sku: v.sku, label: v.label, qty: 1, available: v.available }]))} />
      {lines.length > 0 && (
        <ul className="divide-y divide-border rounded-xl border border-border text-sm">
          {lines.map((l, i) => (
            <li key={l.variant_id} className="flex items-center justify-between gap-2 px-3 py-1.5">
              <span><span className="font-mono text-xs text-muted">{l.sku}</span> {l.label} <span className="text-xs text-muted">({l.available} disp.)</span></span>
              <span className="flex items-center gap-2"><input type="number" min={1} max={20} value={l.qty} onChange={(e) => setLines((p) => p.map((x, j) => (j === i ? { ...x, qty: Math.max(1, Number(e.target.value) || 1) } : x)))} className={`${inputClass} w-16`} aria-label={`Quantidade de ${l.sku}`} />
                <button type="button" onClick={() => setLines((p) => p.filter((_, j) => j !== i))} className="text-muted hover:text-danger" aria-label={`Remover ${l.sku}`}>×</button></span>
            </li>
          ))}
        </ul>
      )}
      {state && !state.ok && <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{state.error}</p>}
      <Button disabled={pending || !party || !locker || lines.length === 0}>{pending ? "Reservando…" : "Preparar armário"}</Button>
    </form>
  );
}
