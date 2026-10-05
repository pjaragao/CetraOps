"use client";
import { useMemo, useState, useTransition } from "react";
import { formatBRL } from "@centralops/domain";
import { useKeptForm } from "@/components/use-kept-form";
import { Button, Card, inputClass } from "@/components/ui";
import { Field } from "@/components/form";
import { ensureSupplier, savePoAction } from "./actions";
import { VariantPicker } from "./variant-picker";

export interface PoItem { variant_id: string; sku: string; label: string; qty: number; unit_cost: number }
interface Opt { id: string; name: string }
export interface PoInitial {
  id?: string; legal_entity_id?: string; location_id?: string; supplier_party_id?: string; expected_date?: string;
  payment_terms_id?: string; collection_id?: string; notes?: string; items: PoItem[];
}

const num = (v: string) => Number(v.replace(/\./g, "").replace(",", ".")) || 0;

/** Editor do pedido de compra: fornecedor, destino, condição e itens (variante × quantidade × custo). */
export function PoEditor({ entities, locations, suppliers, terms, collections, initial }: {
  entities: Opt[]; locations: (Opt & { legal_entity_id: string })[]; suppliers: Opt[]; terms: Opt[]; collections: Opt[]; initial: PoInitial;
}) {
  const { state, pending, formProps } = useKeptForm(savePoAction);
  const [entity, setEntity] = useState(initial.legal_entity_id ?? entities[0]?.id ?? "");
  const [location, setLocation] = useState(initial.location_id ?? "");
  const [supplier, setSupplier] = useState(initial.supplier_party_id ?? "");
  const [supplierList, setSupplierList] = useState(suppliers);
  const [expected, setExpected] = useState(initial.expected_date ?? "");
  const [termsId, setTermsId] = useState(initial.payment_terms_id ?? "");
  const [collection, setCollection] = useState(initial.collection_id ?? "");
  const [notes, setNotes] = useState(initial.notes ?? "");
  const [items, setItems] = useState<PoItem[]>(initial.items);
  const [newSupplier, setNewSupplier] = useState<{ cnpj: string; name: string } | null>(null);
  const [supplierError, setSupplierError] = useState<string | null>(null);
  const [busy, start] = useTransition();

  const locs = useMemo(() => locations.filter((l) => l.legal_entity_id === entity), [locations, entity]);
  const effLocation = locs.some((l) => l.id === location) ? location : (locs[0]?.id ?? "");
  const total = items.reduce((s, i) => s + Math.round(i.qty * i.unit_cost * 100) / 100, 0);
  const pieces = items.reduce((s, i) => s + i.qty, 0);

  const payload = JSON.stringify({
    ...(initial.id ? { id: initial.id } : {}), legal_entity_id: entity, location_id: effLocation, supplier_party_id: supplier,
    ...(expected ? { expected_date: expected } : {}), ...(termsId ? { payment_terms_id: termsId } : {}), ...(collection ? { collection_id: collection } : {}),
    ...(notes ? { notes } : {}), items: items.map((i) => ({ variant_id: i.variant_id, qty: i.qty, unit_cost: i.unit_cost })),
  });

  const setItem = (idx: number, patch: Partial<PoItem>) => setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)));

  return (
    <form {...formProps} className="space-y-4">
      <input type="hidden" name="payload" value={payload} />
      <Card title="Pedido">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Fornecedor" className="sm:col-span-2">
            <div className="flex gap-2">
              <select value={supplier} onChange={(e) => setSupplier(e.target.value)} required className={inputClass}>
                <option value="" disabled>Escolha…</option>{supplierList.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <Button type="button" variant="secondary" onClick={() => setNewSupplier(newSupplier ? null : { cnpj: "", name: "" })}>Novo</Button>
            </div>
          </Field>
          <Field label="Previsão de entrega"><input type="date" value={expected} onChange={(e) => setExpected(e.target.value)} className={inputClass} /></Field>
          {newSupplier && (
            <div className="grid gap-2 rounded-lg bg-surface-2 p-3 sm:col-span-3 sm:grid-cols-4">
              <Field label="CNPJ do fornecedor"><input value={newSupplier.cnpj} onChange={(e) => setNewSupplier({ ...newSupplier, cnpj: e.target.value })} placeholder="00.000.000/0000-00" className={inputClass} /></Field>
              <Field label="Nome / razão social" className="sm:col-span-2"><input value={newSupplier.name} onChange={(e) => setNewSupplier({ ...newSupplier, name: e.target.value })} className={inputClass} /></Field>
              <div className="flex items-end"><Button type="button" disabled={busy} onClick={() => start(async () => {
                const r = await ensureSupplier(newSupplier.cnpj, newSupplier.name);
                if (!r.ok || !r.id) { setSupplierError(r.error ?? "Erro"); return; }
                setSupplierError(null); setSupplierList((l) => (l.some((x) => x.id === r.id) ? l : [...l, { id: r.id!, name: newSupplier.name }])); setSupplier(r.id); setNewSupplier(null);
              })}>Cadastrar</Button></div>
              {supplierError && <p role="alert" className="text-sm text-danger sm:col-span-4">{supplierError}</p>}
            </div>
          )}
          <Field label="Empresa (CNPJ)"><select value={entity} onChange={(e) => setEntity(e.target.value)} className={inputClass}>{entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></Field>
          <Field label="Entregar em"><select value={effLocation} onChange={(e) => setLocation(e.target.value)} className={inputClass}>{locs.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>
          <Field label="Condição de pagamento"><select value={termsId} onChange={(e) => setTermsId(e.target.value)} className={inputClass}><option value="">Pelas duplicatas da nota</option>{terms.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
          <Field label="Coleção (opcional)"><select value={collection} onChange={(e) => setCollection(e.target.value)} className={inputClass}><option value="">—</option>{collections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
          <Field label="Observações" className="sm:col-span-2"><input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} className={inputClass} /></Field>
        </div>
      </Card>

      <Card title={`Itens · ${pieces} peça(s) · ${formatBRL(total)}`}>
        <VariantPicker placeholder="Adicionar item: SKU, EAN ou nome do produto" onPick={(v) => setItems((prev) => (prev.some((i) => i.variant_id === v.id) ? prev : [...prev, { variant_id: v.id, sku: v.sku, label: v.label, qty: 1, unit_cost: 0 }]))} />
        {items.length === 0 ? <p className="mt-3 text-sm text-muted">Nenhum item ainda. Busque o produto e informe quantidade e custo.</p> : (
          <div className="mt-3 overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead className="bg-surface-2 text-left text-xs text-muted"><tr><th className="px-3 py-2">Produto</th><th className="w-28 px-3 py-2">Qtd</th><th className="w-32 px-3 py-2">Custo unit. (R$)</th><th className="w-28 px-3 py-2 text-right">Total</th><th className="w-10" /></tr></thead>
              <tbody className="divide-y divide-border">
                {items.map((it, idx) => (
                  <tr key={it.variant_id}>
                    <td className="px-3 py-1.5"><span className="font-mono text-xs text-muted">{it.sku}</span> {it.label}</td>
                    <td className="px-3 py-1.5"><input inputMode="numeric" value={String(it.qty)} onChange={(e) => setItem(idx, { qty: Math.max(0, num(e.target.value)) })} className={inputClass} aria-label={`Quantidade de ${it.sku}`} /></td>
                    <td className="px-3 py-1.5"><input inputMode="decimal" defaultValue={it.unit_cost ? String(it.unit_cost).replace(".", ",") : ""} onChange={(e) => setItem(idx, { unit_cost: num(e.target.value) })} className={inputClass} aria-label={`Custo de ${it.sku}`} /></td>
                    <td className="px-3 py-1.5 text-right">{formatBRL(Math.round(it.qty * it.unit_cost * 100) / 100)}</td>
                    <td className="px-1"><button type="button" onClick={() => setItems((prev) => prev.filter((_, i) => i !== idx))} className="rounded p-1 text-muted hover:text-danger" aria-label={`Remover ${it.sku}`}>×</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {state && !state.ok && <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{state.error}</p>}
      <div className="flex gap-2"><Button disabled={pending || items.length === 0 || !supplier || !effLocation}>{pending ? "Salvando…" : initial.id ? "Salvar pedido" : "Criar pedido (rascunho)"}</Button></div>
    </form>
  );
}
