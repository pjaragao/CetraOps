"use client";
import { useMemo, useState } from "react";
import { Paperclip, Plus, Trash2 } from "lucide-react";
import { formatBRL } from "@centralops/domain";
import { useKeptForm } from "@/components/use-kept-form";
import { Button, inputClass } from "@/components/ui";
import { saveReimbursementAction } from "./actions";
import { DOC_KIND } from "./labels";


export interface ItemDraft {
  id?: string; spent_on: string; description: string; document_kind: string; document_number: string; access_key: string;
  supplier_doc: string; supplier_name: string; amount: string; no_document_reason: string; chart_account_id?: string | null; cost_center_id?: string | null;
  /** comprovante já guardado (só na edição) */
  attachment?: { name: string; url: string | null } | null;
}
type Draft = ItemDraft & { k: number };

const digits = (s: string) => s.replace(/\D/g, "");
const toNum = (s: string) => Number(String(s).replace(/\./g, "").replace(",", ".")) || 0;
let seq = 0;
const withKey = (x: ItemDraft): Draft => ({ ...x, k: seq++ });
const blank = (today: string): ItemDraft => ({ spent_on: today, description: "", document_kind: "NFCE", document_number: "", access_key: "", supplier_doc: "", supplier_name: "", amount: "", no_document_reason: "" });

/**
 * Reembolso: o que foi comprado, de quem (CNPJ preenche o nome), o documento, o valor e a foto/PDF do comprovante.
 * O mesmo formulário cria e edita (rascunho ou recusado); os comprovantes sobem junto ao salvar, e "Enviar para aprovação" salva e envia.
 */
export function ReimbursementForm({ id, purpose: purpose0, items: items0, today }: { id?: string; purpose?: string; items?: ItemDraft[]; today: string }) {
  const { state, pending, formProps } = useKeptForm(saveReimbursementAction);
  const [purpose, setPurpose] = useState(purpose0 ?? "");
  const [items, setItems] = useState<Draft[]>(() => (items0?.length ? items0 : [blank(today)]).map(withKey));
  const [picked, setPicked] = useState<Record<number, string>>({});   // arquivo escolhido por despesa (chave k)
  const [msg, setMsg] = useState<Record<number, string>>({});
  const set = (i: number, patch: Partial<ItemDraft>) => setItems((xs) => xs.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const total = items.reduce((a, x) => a + toNum(x.amount), 0);

  async function lookup(k: number, raw: string) {
    const d = digits(raw);
    if (d.length !== 14) return;
    setMsg((m) => ({ ...m, [k]: "Buscando…" }));
    try {
      const r = await fetch(`/api/cnpj/${d}`);
      const j = await r.json();
      if (!r.ok) { setMsg((m) => ({ ...m, [k]: String(j.error ?? "CNPJ não encontrado") })); return; }
      setItems((xs) => xs.map((x) => (x.k === k && !x.supplier_name ? { ...x, supplier_name: j.trade_name || j.legal_name } : x)));
      setMsg((m) => ({ ...m, [k]: j.situation && j.situation.toLowerCase() !== "ativa" ? `Atenção: ${j.situation} na Receita` : "" }));
    } catch { setMsg((m) => ({ ...m, [k]: "" })); }
  }

  const payload = useMemo(() => ({
    id, purpose,
    items: items.map((x) => ({
      id: x.id, spent_on: x.spent_on, description: x.description, document_kind: x.document_kind, document_number: x.document_number || undefined,
      access_key: digits(x.access_key) || undefined, supplier_doc: digits(x.supplier_doc) || undefined, supplier_name: x.supplier_name || undefined,
      amount: toNum(x.amount), no_document_reason: x.no_document_reason || undefined, chart_account_id: x.chart_account_id || undefined, cost_center_id: x.cost_center_id || undefined,
    })),
  }), [id, purpose, items]);
  const ok = purpose.trim().length >= 3 && items.length > 0 && items.every((x) => x.description.trim().length > 1 && toNum(x.amount) > 0 && x.spent_on);
  const missing = items.filter((x) => !x.attachment && !picked[x.k] && !x.no_document_reason.trim()).length;

  return (
    <form {...formProps} className="space-y-4">
      <input type="hidden" name="payload" value={JSON.stringify(payload)} />
      <label className="block text-sm font-medium">Do que é o reembolso
        <input className={inputClass} value={purpose} onChange={(e) => setPurpose(e.target.value)} maxLength={200} placeholder="Ex.: almoço com fornecedor e material da loja" />
      </label>
      {items.map((x, i) => (
        <fieldset key={x.k} className="rounded-xl border border-border p-3">
          <legend className="px-1 text-sm font-medium">Despesa {i + 1}</legend>
          <div className="grid gap-2 sm:grid-cols-6">
            <label className="text-xs text-muted sm:col-span-1">Data<input type="date" className={inputClass} value={x.spent_on} max={today} onChange={(e) => set(i, { spent_on: e.target.value })} /></label>
            <label className="text-xs text-muted sm:col-span-3">O que foi comprado<input className={inputClass} value={x.description} onChange={(e) => set(i, { description: e.target.value })} maxLength={200} placeholder="Almoço, combustível, fita adesiva…" /></label>
            <label className="text-xs text-muted sm:col-span-2">Valor (R$)<input className={inputClass} inputMode="decimal" value={x.amount} onChange={(e) => set(i, { amount: e.target.value })} placeholder="0,00" /></label>
            <label className="text-xs text-muted sm:col-span-2">CNPJ ou CPF do fornecedor<input className={inputClass} value={x.supplier_doc} inputMode="numeric" onChange={(e) => { set(i, { supplier_doc: e.target.value }); void lookup(x.k, e.target.value); }} placeholder="Opcional" />
              {msg[x.k] && <span className="mt-0.5 block text-[11px]">{msg[x.k]}</span>}</label>
            <label className="text-xs text-muted sm:col-span-2">Fornecedor (onde comprou)<input className={inputClass} value={x.supplier_name} onChange={(e) => set(i, { supplier_name: e.target.value })} maxLength={120} placeholder="Restaurante, posto, papelaria…" /></label>
            <label className="text-xs text-muted sm:col-span-2">Documento<select className={inputClass} value={x.document_kind} onChange={(e) => set(i, { document_kind: e.target.value })}>{Object.entries(DOC_KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            <label className="text-xs text-muted sm:col-span-2">Número do documento<input className={inputClass} value={x.document_number} onChange={(e) => set(i, { document_number: e.target.value })} maxLength={60} /></label>
            {["NFE", "NFCE"].includes(x.document_kind) && (
              <label className="text-xs text-muted sm:col-span-4">Chave de acesso (44 números, embaixo do QR code)<input className={inputClass} value={x.access_key} inputMode="numeric" onChange={(e) => set(i, { access_key: e.target.value })} placeholder="Opcional: evita lançar a mesma nota duas vezes" /></label>
            )}
            <div className="rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted sm:col-span-6">
              <span className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                <Paperclip size={12} aria-hidden /> <span className="font-medium text-text">Comprovante</span> (foto ou PDF da nota/recibo, até 10 MB)
                {x.attachment && (x.attachment.url
                  ? <a href={x.attachment.url} target="_blank" rel="noreferrer" className="text-brand">Ver comprovante ({x.attachment.name})</a>
                  : <span>{x.attachment.name}</span>)}
              </span>
              <input type="file" name={`file_${i}`} accept="image/*,application/pdf" aria-label={`Comprovante da despesa ${i + 1}`} className="text-xs"
                onChange={(e) => setPicked((p) => ({ ...p, [x.k]: e.target.files?.[0]?.name ?? "" }))} />
              {x.attachment && picked[x.k] && <span className="ml-1">vai substituir o atual ao salvar</span>}
            </div>
            <label className="text-xs text-muted sm:col-span-6">Sem comprovante? Explique por quê<input className={inputClass} value={x.no_document_reason} onChange={(e) => set(i, { no_document_reason: e.target.value })} maxLength={300} placeholder="Deixe em branco se for anexar a nota ou o recibo" /></label>
          </div>
          {items.length > 1 && <button type="button" onClick={() => setItems(items.filter((_, j) => j !== i))} className="mt-2 inline-flex items-center gap-1 text-xs text-danger"><Trash2 size={12} /> Tirar esta despesa</button>}
        </fieldset>
      ))}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="secondary" onClick={() => setItems([...items, withKey(blank(today))])}><Plus size={14} /> Outra despesa</Button>
        <span className="text-sm">Total: <b>{formatBRL(total)}</b></span>
      </div>
      {state && !state.ok && <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{state.error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {/* "Salvar rascunho" vem antes: é o que o Enter num campo aciona */}
        <Button variant="secondary" disabled={pending || !ok}>{pending ? "Salvando…" : "Salvar rascunho"}</Button>
        <Button name="then" value="submit" disabled={pending || !ok}>Enviar para aprovação</Button>
        {ok && missing > 0 && <span className="text-xs text-warning">{missing} despesa(s) sem comprovante nem explicação: dá para salvar, mas não para enviar.</span>}
      </div>
    </form>
  );
}
