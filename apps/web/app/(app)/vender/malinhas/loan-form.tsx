"use client";
import { useState } from "react";
import { formatBRL } from "@centralops/domain";
import { useKeptForm } from "@/components/use-kept-form";
import { Button, inputClass } from "@/components/ui";
import { Field } from "@/components/form";
import { PartyPicker, SellablePicker, type PartyHit } from "../pickers";
import { createLoanAction } from "./actions";

interface Line { variant_id: string; sku: string; label: string; qty: number; available: number; price: number | null }

/** Monta a malinha (cliente) ou a saída para campanha (pessoa opcional + campanha ou finalidade). */
export function LoanForm({ storeId, kind, campaigns }: { storeId: string; kind: "TRY_ON" | "CAMPAIGN"; campaigns: { id: string; name: string }[] }) {
  const { state, pending, formProps } = useKeptForm(createLoanAction);
  const [party, setParty] = useState<PartyHit | null>(null);
  const [campaign, setCampaign] = useState("");
  const [purpose, setPurpose] = useState("");
  const [days, setDays] = useState(kind === "TRY_ON" ? 2 : 7);
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const payload = JSON.stringify({
    store_id: storeId, kind, due_days: days, ...(party ? { party_id: party.id } : {}), ...(campaign ? { campaign_id: campaign } : {}),
    ...(purpose.trim() ? { purpose: purpose.trim() } : {}), ...(notes.trim() ? { notes: notes.trim() } : {}),
    items: lines.map((l) => ({ variant_id: l.variant_id, qty: l.qty })),
  });
  const total = lines.reduce((a, l) => a + (l.price ?? 0) * l.qty, 0);
  const ready = lines.length > 0 && (kind === "TRY_ON" ? !!party : !!(party || campaign || purpose.trim()));

  return (
    <form {...formProps} className="space-y-3">
      <input type="hidden" name="payload" value={payload} />
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="sm:col-span-2">
          <span className="text-xs text-muted">{kind === "TRY_ON" ? "Cliente" : "Pessoa (influenciadora, fotógrafa, modelo) — opcional"}</span>
          {party ? <p className="mt-1 flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm"><b>{party.name}</b><span className="text-muted">{party.phone}</span><button type="button" className="ml-auto text-xs text-brand" onClick={() => setParty(null)}>trocar</button></p>
            : <div className="mt-1"><PartyPicker onPick={setParty} /></div>}
        </div>
        <Field label="Devolver em (dias)"><input type="number" min={1} max={90} value={days} onChange={(e) => setDays(Math.min(90, Math.max(1, Number(e.target.value) || 1)))} className={inputClass} /></Field>
        {kind === "CAMPAIGN" && (
          <>
            <Field label="Campanha (opcional)"><select value={campaign} onChange={(e) => setCampaign(e.target.value)} className={inputClass}><option value="">—</option>{campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
            <Field label="Para quê" className="sm:col-span-2"><input value={purpose} onChange={(e) => setPurpose(e.target.value)} maxLength={200} className={inputClass} placeholder="Ex.: ensaio de fotos do drop de verão" /></Field>
          </>
        )}
        <Field label="Observações" className={kind === "TRY_ON" ? "sm:col-span-3" : "sm:col-span-3"}><input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} className={inputClass} placeholder={kind === "TRY_ON" ? "Ex.: entregue pelo motoboy; busca na sexta" : ""} /></Field>
      </div>
      <SellablePicker placeholder="Adicionar peça: SKU, EAN ou nome" onPick={(v) => setLines((p) => (p.some((l) => l.variant_id === v.id) ? p : [...p, { variant_id: v.id, sku: v.sku, label: v.label, qty: 1, available: v.available, price: v.price }]))} />
      {lines.length > 0 && (
        <ul className="divide-y divide-border rounded-xl border border-border text-sm">
          {lines.map((l, i) => (
            <li key={l.variant_id} className="flex items-center justify-between gap-2 px-3 py-1.5">
              <span><span className="font-mono text-xs text-muted">{l.sku}</span> {l.label} <span className="text-xs text-muted">({l.available} disp. · {l.price != null ? formatBRL(l.price) : "sem preço"})</span></span>
              <span className="flex items-center gap-2"><input type="number" min={1} max={50} value={l.qty} onChange={(e) => setLines((p) => p.map((x, j) => (j === i ? { ...x, qty: Math.max(1, Math.trunc(Number(e.target.value) || 1)) } : x)))} className={`${inputClass} w-16`} aria-label={`Quantidade de ${l.sku}`} />
                <button type="button" onClick={() => setLines((p) => p.filter((_, j) => j !== i))} className="text-muted hover:text-danger" aria-label={`Remover ${l.sku}`}>×</button></span>
            </li>
          ))}
          <li className="px-3 py-1.5 text-right text-xs text-muted">{lines.reduce((a, l) => a + l.qty, 0)} peça(s) · {formatBRL(total)} em mercadoria</li>
        </ul>
      )}
      {state && !state.ok && <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{state.error}</p>}
      <Button disabled={pending || !ready}>{pending ? "Registrando…" : kind === "TRY_ON" ? "Registrar malinha" : "Registrar saída"}</Button>
    </form>
  );
}
