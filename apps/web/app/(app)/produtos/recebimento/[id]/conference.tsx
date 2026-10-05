"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { formatBRL } from "@centralops/domain";
import { Badge, Button, inputClass } from "@/components/ui";
import { createProductFromItem, setReceiptItem } from "../../compras/actions";
import { MATCH_LABEL } from "../../compras/labels";
import { VariantPicker } from "../../compras/variant-picker";

export interface ConferenceItem {
  id: string; n_item: number; cprod: string | null; cean: string | null; description: string | null; ncm: string | null;
  qty_nfe: number; qty_counted: number | null; item_total: number; landed_unit_cost: number | null;
  match_status: string; match_confidence: number | null; variant: { id: string; sku: string; label: string } | null;
}

/** Tamanho no fim da descrição ("... OFF WHITE P") e referência no início do código do fornecedor ("LEG01-OFW-P" → LEG01). */
function guess(item: ConferenceItem) {
  const tokens = (item.description ?? "").trim().split(/\s+/);
  const last = tokens[tokens.length - 1] ?? "";
  const size = /^(XXG|XG|GG|PP|P|M|G|U|3[4-9]|4[0-8])$/i.test(last) ? last.toUpperCase() : "";
  return { reference: (item.cprod ?? "").split(/[-_/\s]/)[0]?.toUpperCase() ?? "", name: (size ? tokens.slice(0, -1) : tokens).join(" "), size };
}

function Row({ item, editable }: { item: ConferenceItem; editable: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [qty, setQty] = useState(item.qty_counted == null ? "" : String(item.qty_counted));
  const [creating, setCreating] = useState(false);
  const g = guess(item);
  const [form, setForm] = useState({ reference_code: g.reference, name: g.name, gender: "FEM" as "FEM" | "MASC" | "UNISSEX", color: "", size: g.size, category: "", price: "" });
  const m = MATCH_LABEL[item.match_status] ?? { label: item.match_status, tone: "neutral" as const };
  const diff = item.qty_counted != null ? item.qty_counted - item.qty_nfe : 0;

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) => start(async () => {
    setError(null);
    const r = await fn();
    if (!r.ok) { setError(r.error ?? "Erro"); return; }
    router.refresh();
  });

  return (
    <tr className={item.match_status === "UNMATCHED" ? "bg-danger/5" : item.match_status === "SUGGESTED" ? "bg-warning/5" : ""}>
      <td className="px-3 py-2 align-top text-xs text-muted">{item.n_item}</td>
      <td className="px-3 py-2 align-top">
        <p className="font-medium">{item.description}</p>
        <p className="font-mono text-[11px] text-muted">{item.cprod}{item.cean && /^\d+$/.test(item.cean) ? ` · EAN ${item.cean}` : ""}{item.ncm ? ` · NCM ${item.ncm}` : ""}</p>
      </td>
      <td className="px-3 py-2 align-top">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={m.tone}>{m.label}{item.match_confidence != null && item.match_status === "SUGGESTED" ? ` ${Math.round(item.match_confidence * 100)}%` : ""}</Badge>
          {item.variant ? <span><span className="font-mono text-xs text-muted">{item.variant.sku}</span> <span className="text-xs">{item.variant.label}</span></span> : <span className="text-xs text-danger">escolha o produto</span>}
        </div>
        {editable && (
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <VariantPicker className="w-64" placeholder={item.variant ? "Trocar produto…" : "Buscar SKU, EAN ou nome"} onPick={(v) => run(() => setReceiptItem(item.id, { variant_id: v.id, learn: true }))} />
            {item.match_status === "SUGGESTED" && item.variant && <Button type="button" variant="secondary" className="px-2 py-1 text-xs" disabled={pending} onClick={() => run(() => setReceiptItem(item.id, { variant_id: item.variant!.id, learn: true }))}>Confirmar</Button>}
            {!item.variant && <Button type="button" variant="ghost" className="px-2 py-1 text-xs" onClick={() => setCreating((c) => !c)}>{creating ? "Fechar" : "Cadastrar produto"}</Button>}
          </div>
        )}
        {creating && (
          <div className="mt-2 grid gap-2 rounded-lg bg-surface-2 p-3 sm:grid-cols-3">
            <label className="text-xs text-muted">Referência<input value={form.reference_code} onChange={(e) => setForm({ ...form, reference_code: e.target.value })} className={inputClass} /></label>
            <label className="text-xs text-muted sm:col-span-2">Nome<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputClass} /></label>
            <label className="text-xs text-muted">Linha<select value={form.gender} onChange={(e) => setForm({ ...form, gender: e.target.value as typeof form.gender })} className={inputClass}><option value="FEM">Feminina</option><option value="MASC">Masculina</option><option value="UNISSEX">Unissex</option></select></label>
            <label className="text-xs text-muted">Cor<input value={form.color} onChange={(e) => setForm({ ...form, color: e.target.value })} className={inputClass} /></label>
            <label className="text-xs text-muted">Tamanho<input value={form.size} onChange={(e) => setForm({ ...form, size: e.target.value })} className={inputClass} /></label>
            <label className="text-xs text-muted">Categoria<input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className={inputClass} /></label>
            <label className="text-xs text-muted">Preço de venda (R$)<input inputMode="decimal" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} className={inputClass} /></label>
            <div className="flex items-end"><Button type="button" disabled={pending} onClick={() => run(async () => {
              const price = Number(form.price.replace(/\./g, "").replace(",", "."));
              return createProductFromItem(item.id, { ...form, category: form.category || undefined, price: price > 0 ? price : undefined });
            })}>Cadastrar e vincular</Button></div>
          </div>
        )}
        {error && <p role="alert" className="mt-1 text-xs text-danger">{error}</p>}
      </td>
      <td className="px-3 py-2 align-top text-right">{item.qty_nfe}</td>
      <td className="px-3 py-2 align-top">
        {editable ? (
          <input inputMode="numeric" value={qty} disabled={pending} onChange={(e) => setQty(e.target.value)} placeholder={String(item.qty_nfe)} aria-label={`Quantidade contada do item ${item.n_item}`}
            onBlur={() => { const n = qty === "" ? null : Number(qty.replace(",", ".")); if (n !== item.qty_counted) run(() => setReceiptItem(item.id, { qty_counted: n })); }}
            className={`${inputClass} w-24 ${diff < 0 ? "border-warning" : ""}`} />
        ) : <span>{item.qty_counted}</span>}
        {diff < 0 && <p className="mt-0.5 text-[11px] text-warning">falta {Math.abs(diff)}</p>}
      </td>
      <td className="px-3 py-2 align-top text-right whitespace-nowrap">{item.landed_unit_cost != null ? formatBRL(item.landed_unit_cost) : "—"}</td>
      <td className="px-3 py-2 align-top text-right whitespace-nowrap font-medium">{formatBRL(item.item_total)}</td>
    </tr>
  );
}

export function ConferenceTable({ items, editable }: { items: ConferenceItem[]; editable: boolean }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-surface">
      <table className="w-full text-sm">
        <thead className="bg-surface-2 text-left text-xs text-muted">
          <tr><th className="px-3 py-2">#</th><th className="px-3 py-2">Item da nota</th><th className="px-3 py-2">Produto no sistema</th><th className="px-3 py-2 text-right">Qtd nota</th><th className="px-3 py-2">Contada</th><th className="px-3 py-2 text-right">Custo unit.</th><th className="px-3 py-2 text-right">Total</th></tr>
        </thead>
        <tbody className="divide-y divide-border">{items.map((i) => <Row key={`${i.id}-${i.match_status}-${i.qty_counted}-${i.variant?.id}`} item={i} editable={editable} />)}</tbody>
      </table>
    </div>
  );
}
