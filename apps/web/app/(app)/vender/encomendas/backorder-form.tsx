"use client";
import { useState } from "react";
import { formatBRL } from "@centralops/domain";
import { useKeptForm } from "@/components/use-kept-form";
import { SearchPicker } from "@/components/search-picker";
import { Button, inputClass } from "@/components/ui";
import { Field } from "@/components/form";
import { PartyPicker, type PartyHit } from "../pickers";
import { createBackorderAction, searchBackorderable, type BackorderHit } from "./actions";

interface Line extends BackorderHit { qty: number }

export function BackorderForm({ storeId }: { storeId: string }) {
  const { state, pending, formProps } = useKeptForm(createBackorderAction);
  const [party, setParty] = useState<PartyHit | null>(null);
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const payload = JSON.stringify({ store_id: storeId, party_id: party?.id, ...(notes.trim() ? { notes: notes.trim() } : {}), items: lines.map((l) => ({ variant_id: l.id, qty: l.qty })) });
  const total = lines.reduce((a, l) => a + (l.price ?? 0) * l.qty, 0);
  return (
    <form {...formProps} className="space-y-3">
      <input type="hidden" name="payload" value={payload} />
      <div>
        <span className="text-xs text-muted">Cliente</span>
        {party ? <p className="mt-1 flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm"><b>{party.name}</b><span className="text-muted">{party.phone}</span><button type="button" className="ml-auto text-xs text-brand" onClick={() => setParty(null)}>trocar</button></p>
          : <div className="mt-1"><PartyPicker onPick={setParty} /></div>}
      </div>
      <SearchPicker<BackorderHit> search={searchBackorderable} label="Buscar peça para encomenda" placeholder="Peça da coleção (liberada para encomenda): nome, referência ou SKU"
        onPick={(v) => setLines((p) => (p.some((l) => l.id === v.id) ? p : [...p, { ...v, qty: 1 }]))}
        render={(v) => <span className="flex justify-between gap-3"><span><span className="font-mono text-xs text-muted">{v.sku}</span> {v.label}</span>
          <span className="whitespace-nowrap text-xs">{v.price != null ? formatBRL(v.price) : "sem preço"} · {v.available > 0 ? <span className="text-success">{v.available} na loja</span> : <span className="text-muted">sem estoque</span>}</span></span>} />
      {lines.length > 0 && (
        <ul className="divide-y divide-border rounded-xl border border-border text-sm">
          {lines.map((l, i) => (
            <li key={l.id} className="flex items-center justify-between gap-2 px-3 py-1.5">
              <span><span className="font-mono text-xs text-muted">{l.sku}</span> {l.label} {l.available > 0 && <span className="text-xs text-warning">(tem {l.available} na loja — dá para vender direto)</span>}</span>
              <span className="flex items-center gap-2"><input type="number" min={1} max={50} value={l.qty} onChange={(e) => setLines((p) => p.map((x, j) => (j === i ? { ...x, qty: Math.max(1, Math.trunc(Number(e.target.value) || 1)) } : x)))} className={`${inputClass} w-16`} aria-label={`Quantidade de ${l.sku}`} />
                <button type="button" onClick={() => setLines((p) => p.filter((_, j) => j !== i))} className="text-muted hover:text-danger" aria-label={`Remover ${l.sku}`}>×</button></span>
            </li>
          ))}
          <li className="px-3 py-1.5 text-right text-xs text-muted">Total da encomenda: {formatBRL(total)}</li>
        </ul>
      )}
      <Field label="Observação (opcional)"><input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={300} className={inputClass} placeholder="Ex.: quer para antes do aniversário (20/11)" /></Field>
      {state && !state.ok && <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{state.error}</p>}
      <Button disabled={pending || !party || lines.length === 0}>{pending ? "Registrando…" : "Registrar encomenda"}</Button>
      <p className="text-xs text-muted">A encomenda entra no pedido de compra em rascunho do fornecedor (ou abre um) e fica a tarefa de fechá-lo. Dá para receber um sinal agora; o restante, quando as peças chegarem.</p>
    </form>
  );
}
