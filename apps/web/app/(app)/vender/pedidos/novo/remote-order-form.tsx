"use client";
import { useState } from "react";
import { formatBRL } from "@centralops/domain";
import { useKeptForm } from "@/components/use-kept-form";
import { Button, Card, inputClass } from "@/components/ui";
import { Field } from "@/components/form";
import { createRemoteOrderAction } from "../../actions";
import { PartyPicker, SellablePicker, type PartyHit } from "../../pickers";

interface Line { variant_id: string; sku: string; label: string; price: number; qty: number; available: number }

/** Pedido criado pela vendedora (ou pela IA depois de confirmado com a cliente): reserva o estoque e espera o pagamento. */
export function RemoteOrderForm({ storeId, storeName, locationId, idempotencyKey }: { storeId: string; storeName: string; locationId?: string; idempotencyKey: string }) {
  const { state, pending, formProps } = useKeptForm(createRemoteOrderAction);
  const [party, setParty] = useState<PartyHit | null>(null);
  const [channel, setChannel] = useState("WHATSAPP");
  const [fulfillment, setFulfillment] = useState("MOTOBOY");
  const [shipping, setShipping] = useState("");
  const [coupon, setCoupon] = useState("");
  const [hold, setHold] = useState(24);
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<Line[]>([]);

  const subtotal = lines.reduce((s, l) => s + l.price * l.qty, 0);
  const ship = Number(shipping.replace(/\./g, "").replace(",", ".")) || 0;
  const short = lines.filter((l) => l.qty > l.available);
  const payload = JSON.stringify({
    store_id: storeId, party_id: party?.id, channel, fulfillment_type: fulfillment, shipping_total: ship, hold_hours: hold, idempotency_key: idempotencyKey,
    ...(coupon ? { coupon_code: coupon.trim() } : {}), ...(notes ? { notes } : {}), items: lines.map((l) => ({ variant_id: l.variant_id, qty: l.qty })),
  });

  return (
    <form {...formProps} className="space-y-4">
      <input type="hidden" name="payload" value={payload} />
      <Card title="Cliente e entrega">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="sm:col-span-2">
            <span className="text-xs text-muted">Cliente</span>
            {party ? (
              <p className="mt-1 flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm"><b>{party.name}</b><span className="text-muted">{party.phone}</span>
                <button type="button" className="ml-auto text-xs text-brand" onClick={() => setParty(null)}>trocar</button></p>
            ) : <div className="mt-1"><PartyPicker onPick={setParty} /></div>}
          </div>
          <Field label="Loja de origem"><input value={storeName} disabled className={inputClass} /></Field>
          <Field label="Canal"><select value={channel} onChange={(e) => setChannel(e.target.value)} className={inputClass}>
            <option value="WHATSAPP">WhatsApp</option><option value="INSTAGRAM">Instagram</option><option value="TELEGRAM">Telegram</option><option value="PAYMENT_LINK">Link de pagamento</option><option value="B2B">B2B</option><option value="EVENT">Evento</option></select></Field>
          <Field label="Entrega"><select value={fulfillment} onChange={(e) => setFulfillment(e.target.value)} className={inputClass}>
            <option value="MOTOBOY">Motoboy</option><option value="CARRIER">Transportadora / Correios</option><option value="STORE_PICKUP">Retirada na loja</option><option value="LOCKER_PICKUP">Retirada no Armário VIP</option><option value="TAKEAWAY">Levou na hora</option></select></Field>
          <Field label="Frete (R$)"><input inputMode="decimal" value={shipping} onChange={(e) => setShipping(e.target.value)} className={inputClass} placeholder="0,00" /></Field>
          <Field label="Cupom"><input value={coupon} onChange={(e) => setCoupon(e.target.value.toUpperCase())} className={inputClass} maxLength={30} /></Field>
          <Field label="Reservar por (horas)"><input type="number" min={1} max={168} value={hold} onChange={(e) => setHold(Number(e.target.value) || 24)} className={inputClass} /></Field>
          <Field label="Observações" className="sm:col-span-3"><input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} className={inputClass} /></Field>
        </div>
      </Card>

      <Card title={`Peças · ${lines.reduce((s, l) => s + l.qty, 0)} · ${formatBRL(subtotal)}`}>
        <SellablePicker locationId={locationId} onPick={(v) => v.price != null && setLines((prev) => (prev.some((l) => l.variant_id === v.id) ? prev : [...prev, { variant_id: v.id, sku: v.sku, label: v.label, price: v.price!, qty: 1, available: v.available }]))} />
        {lines.length === 0 ? <p className="mt-3 text-sm text-muted">Nenhuma peça. Busque por SKU, EAN ou nome.</p> : (
          <div className="mt-3 overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead className="bg-surface-2 text-left text-xs text-muted"><tr><th className="px-3 py-2">Peça</th><th className="w-24 px-3 py-2">Qtd</th><th className="px-3 py-2 text-right">Preço</th><th className="px-3 py-2 text-right">Total</th><th className="w-8" /></tr></thead>
              <tbody className="divide-y divide-border">
                {lines.map((l, i) => (
                  <tr key={l.variant_id}>
                    <td className="px-3 py-1.5"><span className="font-mono text-xs text-muted">{l.sku}</span> {l.label}{l.qty > l.available && <span className="ml-2 text-xs text-danger">só {l.available} disponível</span>}</td>
                    <td className="px-3 py-1.5"><input type="number" min={1} value={l.qty} onChange={(e) => setLines((p) => p.map((x, j) => (j === i ? { ...x, qty: Math.max(1, Number(e.target.value) || 1) } : x)))} className={inputClass} aria-label={`Quantidade de ${l.sku}`} /></td>
                    <td className="px-3 py-1.5 text-right">{formatBRL(l.price)}</td><td className="px-3 py-1.5 text-right font-medium">{formatBRL(l.price * l.qty)}</td>
                    <td className="px-1"><button type="button" onClick={() => setLines((p) => p.filter((_, j) => j !== i))} className="text-muted hover:text-danger" aria-label={`Remover ${l.sku}`}>×</button></td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t border-border text-sm"><tr><td colSpan={3} className="px-3 py-2 text-right text-muted">Subtotal + frete (cupom e total finais são calculados ao salvar)</td><td className="px-3 py-2 text-right font-semibold">{formatBRL(subtotal + ship)}</td><td /></tr></tfoot>
            </table>
          </div>
        )}
      </Card>
      {short.length > 0 && <p className="rounded-lg bg-warning/10 px-3 py-2 text-sm text-warning">Há peça(s) acima do estoque disponível: o sistema recusa reservar além do saldo.</p>}
      {state && !state.ok && <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{state.error}</p>}
      <Button disabled={pending || !party || lines.length === 0}>{pending ? "Criando…" : "Criar pedido e reservar estoque"}</Button>
    </form>
  );
}
