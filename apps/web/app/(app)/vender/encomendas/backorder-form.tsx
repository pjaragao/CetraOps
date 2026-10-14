"use client";
import { useState } from "react";
import { formatBRL } from "@centralops/domain";
import { useKeptForm } from "@/components/use-kept-form";
import { SearchPicker } from "@/components/search-picker";
import { Button, inputClass } from "@/components/ui";
import { Field } from "@/components/form";
import { PartyPicker, type PartyHit } from "../pickers";
import { backorderCost, createBackorderAction, searchBackorderable, type BackorderHit, type CostInfo } from "./actions";

interface Line extends BackorderHit { qty: number; cost: CostInfo | null }

const COST_NOTE: Record<CostInfo["source"], string> = {
  LAST_COST: "custo no pedido de compra: último custo conhecido",
  WHOLESALE: "custo no pedido de compra: preço de atacado da marca (catálogo/pedido em PDF)",
  CATALOG_PRICE: "sem custo conhecido: entra no pedido de compra pelo preço de catálogo (sem desconto) — confira",
  ZERO: "sem custo e sem preço: entra no pedido de compra com custo zero — ajuste antes de aprovar",
};

export function BackorderForm({ storeId }: { storeId: string }) {
  const { state, pending, formProps } = useKeptForm(createBackorderAction);
  const [party, setParty] = useState<PartyHit | null>(null);
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [confirm, setConfirm] = useState<BackorderHit | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const add = async (v: BackorderHit) => {
    setConfirm(null);
    if (lines.some((l) => l.id === v.id)) return;
    const cost = await backorderCost(v.id, storeId);
    setLines((p) => [...p, { ...v, qty: 1, cost }]);
    setNotice(`${v.sku} adicionada${cost ? ` · ${COST_NOTE[cost.source]}${cost.source !== "ZERO" ? ` (${formatBRL(cost.cost)})` : ""}` : ""}.`);
  };
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
        onPick={(v) => (v.available > 0 ? add(v) : setConfirm(v))}
        render={(v) => <span className="flex justify-between gap-3"><span><span className="font-mono text-xs text-muted">{v.sku}</span> {v.label}</span>
          <span className="whitespace-nowrap text-xs">{v.price != null ? formatBRL(v.price) : "sem preço"} · {v.available > 0 ? <span className="text-success">{v.available} na loja</span> : <span className="text-muted">sem estoque</span>}</span></span>} />
      {notice && <p role="status" className="rounded-lg bg-info/10 px-3 py-2 text-sm text-info">{notice}</p>}
      {confirm && (
        <div role="dialog" aria-modal="true" aria-labelledby="sem-estoque" className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-sm rounded-xl border border-border bg-surface p-5 shadow-xl">
            <h2 id="sem-estoque" className="text-base font-semibold">Peça sem estoque</h2>
            <p className="mt-2 text-sm"><span className="font-mono text-xs text-muted">{confirm.sku}</span> {confirm.label} não tem estoque na loja.</p>
            <p className="mt-1 text-sm text-muted">Ela será pedida ao fornecedor e separada para a cliente quando chegar. Adicionar mesmo assim?</p>
            <div className="mt-4 flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setConfirm(null)}>Cancelar</Button>
              <Button type="button" autoFocus onClick={() => add(confirm)}>Adicionar mesmo assim</Button>
            </div>
          </div>
        </div>
      )}
      {lines.length > 0 && (
        <ul className="divide-y divide-border rounded-xl border border-border text-sm">
          {lines.map((l, i) => (
            <li key={l.id} className="flex items-center justify-between gap-2 px-3 py-1.5">
              <span><span className="font-mono text-xs text-muted">{l.sku}</span> {l.label} {l.available > 0 && <span className="text-xs text-warning">(tem {l.available} na loja: o que couber fica reservado para ela e só o que falta vai ao pedido de compra)</span>}
                {l.cost && <span className={`block text-xs ${l.cost.source === "LAST_COST" || l.cost.source === "WHOLESALE" ? "text-muted" : "text-warning"}`}>{COST_NOTE[l.cost.source]}{l.cost.source !== "ZERO" ? ` (${formatBRL(l.cost.cost)})` : ""}</span>}</span>
              <span className="flex items-center gap-2"><input type="number" min={1} max={50} value={l.qty} onChange={(e) => setLines((p) => p.map((x, j) => (j === i ? { ...x, qty: Math.max(1, Math.trunc(Number(e.target.value) || 1)) } : x)))} className={`${inputClass} w-16`} aria-label={`Quantidade de ${l.sku}`} />
                <button type="button" onClick={() => setLines((p) => p.filter((_, j) => j !== i))} className="text-muted hover:text-danger" aria-label={`Remover ${l.sku}`}>×</button></span>
            </li>
          ))}
          <li className="px-3 py-1.5 text-right text-xs text-muted">Total da encomenda: {formatBRL(total)}</li>
        </ul>
      )}
      <Field label="Observação (opcional)"><input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={300} className={inputClass} placeholder="Ex.: quer para antes do aniversário (20/11)" /></Field>
      {state && !state.ok && <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{state.error}</p>}
      <Button disabled={pending || !party || lines.length === 0 || !!confirm}>{pending ? "Registrando…" : "Registrar encomenda"}</Button>
      <p className="text-xs text-muted">A encomenda entra no pedido de compra em rascunho do fornecedor (ou abre um) e fica a tarefa de fechá-lo. Dá para receber um sinal agora; o restante, quando as peças chegarem.</p>
    </form>
  );
}
