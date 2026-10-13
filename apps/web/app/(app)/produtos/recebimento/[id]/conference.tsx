"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { formatBRL } from "@centralops/domain";
import { Badge, Button, inputClass } from "@/components/ui";
import { addVariantFromItem, createProductFromItem, setReceiptItem } from "../../compras/actions";
import { MATCH_LABEL } from "../../compras/labels";
import { VariantPicker } from "../../compras/variant-picker";

export interface ConferenceItem {
  id: string; n_item: number; cprod: string | null; cean: string | null; description: string | null; ncm: string | null;
  qty_nfe: number; qty_counted: number | null; item_total: number; landed_unit_cost: number | null;
  match_status: string; match_confidence: number | null; variant: { id: string; sku: string; label: string; product_id?: string } | null;
}

export interface CatalogOptions {
  products: { id: string; name: string; reference_code: string }[];
  colors: string[]; sizes: string[]; categories: string[];
}

const NEW = "__novo__";

/** Lista com os valores já cadastrados + "Cadastrar novo…", que abre um campo de texto. */
function PickOrNew({ label, value, onChange, options, placeholder }: { label: string; value: string; onChange: (v: string) => void; options: string[]; placeholder?: string }) {
  const known = value === "" || options.some((o) => o.toLowerCase() === value.toLowerCase());
  const [typing, setTyping] = useState(!known);
  return (
    <label className="text-xs text-muted">{label}
      {typing ? (
        <span className="flex gap-1">
          <input autoFocus value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder ?? "Novo valor"} className={inputClass} />
          {options.length > 0 && <button type="button" className="shrink-0 text-[11px] text-brand" onClick={() => { setTyping(false); onChange(""); }}>lista</button>}
        </span>
      ) : (
        <select value={options.find((o) => o.toLowerCase() === value.toLowerCase()) ?? ""} className={inputClass}
          onChange={(e) => { if (e.target.value === NEW) { setTyping(true); onChange(""); } else onChange(e.target.value); }}>
          <option value="">Escolha…</option>
          {options.map((o) => <option key={o} value={o}>{o}</option>)}
          <option value={NEW}>+ Cadastrar novo…</option>
        </select>
      )}
    </label>
  );
}

/** Cor/tamanho/código do padrão do fornecedor "RRRRRCCCT" (ref 5 dígitos, cor 3 dígitos, tamanho) e da descrição "Nome - modelo : Cor : Tam". */
function guessParts(item: ConferenceItem) {
  const parts = (item.description ?? "").split(":").map((x) => x.trim()).filter(Boolean);
  const m = /^(\d{5})(\d{3})([A-Z]{1,3}|\d{2})$/.exec((item.cprod ?? "").toUpperCase());
  return { color: parts.length >= 3 ? parts[parts.length - 2] : "", size: parts.length >= 2 ? parts[parts.length - 1].toUpperCase() : "", colorCode: m?.[2] ?? "", ref: m?.[1] ?? "" };
}

/** Tamanho no fim da descrição ("... OFF WHITE P") e referência no início do código do fornecedor ("LEG01-OFW-P" → LEG01). */
function guess(item: ConferenceItem) {
  const tokens = (item.description ?? "").trim().split(/\s+/);
  const last = tokens[tokens.length - 1] ?? "";
  const size = /^(XXG|XG|GG|PP|P|M|G|U|3[4-9]|4[0-8])$/i.test(last) ? last.toUpperCase() : "";
  return { reference: (item.cprod ?? "").split(/[-_/\s]/)[0]?.toUpperCase() ?? "", name: (size ? tokens.slice(0, -1) : tokens).join(" "), size };
}

function Row({ item, editable, options }: { item: ConferenceItem; editable: boolean; options: CatalogOptions }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [qty, setQty] = useState(item.qty_counted == null ? "" : String(item.qty_counted));
  const [creating, setCreating] = useState(false);
  const g = guess(item);
  const gp = guessParts(item);
  const [mode, setMode] = useState<"variant" | "product">("variant");
  const [form, setForm] = useState({ reference_code: gp.ref || g.reference, name: (item.description ?? "").split(":")[0].trim() || g.name, gender: "FEM" as "FEM" | "MASC" | "UNISSEX",
    color: gp.color, size: gp.size || g.size, category: "", price: "" });
  const [vform, setVform] = useState({ product_id: item.variant?.product_id ?? "", color: gp.color, color_code: gp.colorCode, size: gp.size || g.size, sku: item.cprod ?? "" });
  const colorIsNew = vform.color !== "" && !options.colors.some((c) => c.toLowerCase() === vform.color.toLowerCase());
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
            <Button type="button" variant="ghost" className="px-2 py-1 text-xs" onClick={() => setCreating((c) => !c)}>{creating ? "Fechar" : item.variant ? "Cadastrar variação / produto" : "Cadastrar produto"}</Button>
            {item.variant && <Button type="button" variant="ghost" className="px-2 py-1 text-xs text-danger" disabled={pending} onClick={() => run(() => setReceiptItem(item.id, { variant_id: null }))}>Desvincular</Button>}
            {item.variant?.product_id && <a href={`/produtos/${item.variant.product_id}`} target="_blank" rel="noreferrer" className="text-xs text-brand hover:underline">Editar produto ↗</a>}
          </div>
        )}
        {creating && (
          <div className="mt-2 rounded-lg bg-surface-2 p-3">
            <div className="mb-2 flex gap-1 text-xs">
              {(["variant", "product"] as const).map((k) => (
                <button key={k} type="button" onClick={() => setMode(k)}
                  className={`rounded-full border px-3 py-1 ${mode === k ? "border-brand bg-brand/10 text-brand" : "border-border text-muted hover:bg-surface"}`}>
                  {k === "variant" ? "Nova cor/tamanho de um produto existente" : "Produto novo"}
                </button>
              ))}
            </div>
            {mode === "variant" ? (
              <div className="grid gap-2 sm:grid-cols-3">
                <label className="text-xs text-muted sm:col-span-3">Produto
                  <select value={vform.product_id} onChange={(e) => setVform({ ...vform, product_id: e.target.value })} className={inputClass}>
                    <option value="">Escolha o produto…</option>
                    {options.products.map((p) => <option key={p.id} value={p.id}>{p.name} · ref. {p.reference_code}</option>)}
                  </select>
                </label>
                <PickOrNew label="Cor" value={vform.color} onChange={(v) => setVform({ ...vform, color: v })} options={options.colors} placeholder="Ex.: Pacífico" />
                {colorIsNew
                  ? <label className="text-xs text-muted">Código da cor (nova)<input value={vform.color_code} onChange={(e) => setVform({ ...vform, color_code: e.target.value })} placeholder="Ex.: 333" className={inputClass} /></label>
                  : <span />}
                <PickOrNew label="Tamanho" value={vform.size} onChange={(v) => setVform({ ...vform, size: v })} options={options.sizes} placeholder="Ex.: M" />
                <label className="text-xs text-muted">SKU<input value={vform.sku} onChange={(e) => setVform({ ...vform, sku: e.target.value })} placeholder="em branco: referência + cor + tamanho" className={inputClass} /></label>
                <div className="flex items-end sm:col-span-2"><Button type="button" disabled={pending || !vform.product_id || !vform.color || !vform.size}
                  onClick={() => run(() => addVariantFromItem(item.id, { ...vform, color_code: vform.color_code || undefined, sku: vform.sku || undefined }))}>Criar variação e vincular</Button></div>
              </div>
            ) : (
              <div className="grid gap-2 sm:grid-cols-3">
                <label className="text-xs text-muted">Referência<input value={form.reference_code} onChange={(e) => setForm({ ...form, reference_code: e.target.value })} className={inputClass} /></label>
                <label className="text-xs text-muted sm:col-span-2">Nome<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputClass} /></label>
                <label className="text-xs text-muted">Linha<select value={form.gender} onChange={(e) => setForm({ ...form, gender: e.target.value as typeof form.gender })} className={inputClass}><option value="FEM">Feminina</option><option value="MASC">Masculina</option><option value="UNISSEX">Unissex</option></select></label>
                <PickOrNew label="Cor" value={form.color} onChange={(v) => setForm({ ...form, color: v })} options={options.colors} />
                <PickOrNew label="Tamanho" value={form.size} onChange={(v) => setForm({ ...form, size: v })} options={options.sizes} />
                <PickOrNew label="Categoria" value={form.category} onChange={(v) => setForm({ ...form, category: v })} options={options.categories} />
                <label className="text-xs text-muted">Preço de venda (R$)<input inputMode="decimal" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} className={inputClass} /></label>
                <div className="flex items-end"><Button type="button" disabled={pending} onClick={() => run(async () => {
                  const price = Number(form.price.replace(/\./g, "").replace(",", "."));
                  return createProductFromItem(item.id, { ...form, category: form.category || undefined, price: price > 0 ? price : undefined });
                })}>Cadastrar e vincular</Button></div>
              </div>
            )}
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

export function ConferenceTable({ items, editable, options }: { items: ConferenceItem[]; editable: boolean; options: CatalogOptions }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-surface">
      <table className="w-full text-sm">
        <thead className="bg-surface-2 text-left text-xs text-muted">
          <tr><th className="px-3 py-2">#</th><th className="px-3 py-2">Item da nota</th><th className="px-3 py-2">Produto no sistema</th><th className="px-3 py-2 text-right">Qtd nota</th><th className="px-3 py-2">Contada</th><th className="px-3 py-2 text-right">Custo unit.</th><th className="px-3 py-2 text-right">Total</th></tr>
        </thead>
        <tbody className="divide-y divide-border">{items.map((i) => <Row key={`${i.id}-${i.match_status}-${i.qty_counted}-${i.variant?.id}`} item={i} editable={editable} options={options} />)}</tbody>
      </table>
    </div>
  );
}
