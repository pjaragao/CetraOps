"use client";
import { useState } from "react";
import { formatBRL } from "@sie/domain";
import { useKeptForm } from "@/components/use-kept-form";
import { Button, Card, inputClass } from "@/components/ui";
import { Field } from "@/components/form";
import { createReturnAction } from "../../actions";

export interface ReturnLine { id: string; sku: string; label: string; qty: number; returned: number; total: number }

/** Escolha das peças, tipo (troca, vale-troca ou devolução) e meio de devolução. O valor devolvido é calculado no banco (proporcional ao pago, com cupom). */
export function ReturnForm({ orderId, hasParty, lines, locations, cashSessionId, ratio }: {
  orderId: string; hasParty: boolean; lines: ReturnLine[]; locations: { id: string; name: string; kind: string }[]; cashSessionId?: string; ratio: number;
}) {
  const { state, pending, formProps } = useKeptForm(createReturnAction);
  const [type, setType] = useState(hasParty ? "EXCHANGE" : "RETURN_REFUND");
  const [reason, setReason] = useState("SIZE");
  const [method, setMethod] = useState("PIX");
  const [notes, setNotes] = useState("");
  const [loc, setLoc] = useState("");
  const [qty, setQty] = useState<Record<string, number>>({});
  const damaged = locations.find((l) => l.kind === "DAMAGED");
  const restock = reason === "DEFECT" && damaged ? damaged.id : loc || undefined;

  const chosen = lines.filter((l) => (qty[l.id] ?? 0) > 0);
  const amount = chosen.reduce((s, l) => s + Math.round(l.total * ((qty[l.id] ?? 0) / l.qty) * ratio * 100) / 100, 0);
  const creditOnly = type === "EXCHANGE" || type === "STORE_CREDIT";
  const payload = JSON.stringify({
    order_id: orderId, type, reason, ...(creditOnly ? {} : { refund_method: method }), ...(method === "CASH" && !creditOnly && cashSessionId ? { cash_session_id: cashSessionId } : {}), ...(notes ? { notes } : {}),
    items: chosen.map((l) => ({ order_item_id: l.id, qty: qty[l.id], ...(restock ? { restock_location_id: restock } : {}) })),
  });

  return (
    <form {...formProps} className="space-y-4">
      <input type="hidden" name="payload" value={payload} />
      <Card title="O que volta">
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-left text-xs text-muted"><tr><th className="px-3 py-2">Peça</th><th className="px-3 py-2">Comprou</th><th className="px-3 py-2">Já devolvida</th><th className="px-3 py-2">Devolver agora</th><th className="px-3 py-2 text-right">Valor</th></tr></thead>
            <tbody className="divide-y divide-border">
              {lines.map((l) => {
                const max = l.qty - l.returned;
                const q = qty[l.id] ?? 0;
                return (
                  <tr key={l.id} className={max <= 0 ? "opacity-50" : ""}>
                    <td className="px-3 py-2"><span className="font-mono text-xs text-muted">{l.sku}</span> {l.label}</td>
                    <td className="px-3 py-2">{l.qty}</td><td className="px-3 py-2">{l.returned || "—"}</td>
                    <td className="px-3 py-2"><input type="number" min={0} max={max} value={q} disabled={max <= 0} onChange={(e) => setQty({ ...qty, [l.id]: Math.min(Math.max(Number(e.target.value) || 0, 0), max) })} className={`${inputClass} w-24`} aria-label={`Quantidade a devolver de ${l.sku}`} /></td>
                    <td className="px-3 py-2 text-right">{q > 0 ? formatBRL(Math.round(l.total * (q / l.qty) * ratio * 100) / 100) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Como resolver">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Tipo"><select value={type} onChange={(e) => setType(e.target.value)} className={inputClass}>
            {hasParty && <option value="EXCHANGE">Troca (vale-troca para levar outra peça)</option>}
            {hasParty && <option value="STORE_CREDIT">Vale-troca (crédito para depois)</option>}
            <option value="RETURN_REFUND">Devolução com reembolso</option></select></Field>
          <Field label="Motivo"><select value={reason} onChange={(e) => setReason(e.target.value)} className={inputClass}>
            <option value="SIZE">Tamanho/modelagem</option><option value="DEFECT">Defeito</option><option value="REGRET_7D">Arrependimento (7 dias)</option><option value="OTHER">Outro</option></select></Field>
          {!creditOnly && (
            <Field label="Devolver o dinheiro por"><select value={method} onChange={(e) => setMethod(e.target.value)} className={inputClass}>
              <option value="PIX">Pix / transferência (gera conta a pagar)</option><option value="CASH" disabled={!cashSessionId}>Dinheiro (sai do caixa aberto)</option><option value="CARD">Estorno no cartão</option></select></Field>
          )}
          {reason !== "DEFECT" && (
            <Field label="Peça volta para o estoque em"><select value={loc} onChange={(e) => setLoc(e.target.value)} className={inputClass}><option value="">Local da venda</option>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>
          )}
          {reason === "DEFECT" && <p className="self-end text-xs text-muted">Peça com defeito volta para {damaged ? `“${damaged.name}”` : "o local da venda"}.</p>}
          <Field label="Observações" className="sm:col-span-3"><input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={300} className={inputClass} /></Field>
        </div>
        {!hasParty && <p className="mt-2 text-xs text-muted">Pedido sem cliente identificado: só devolução com reembolso (vale-troca precisa do cliente).</p>}
      </Card>

      {state && !state.ok && <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{state.error}</p>}
      <div className="flex items-center gap-3">
        <Button disabled={pending || chosen.length === 0}>{pending ? "Registrando…" : creditOnly ? `Gerar vale-troca de ${formatBRL(amount)}` : `Devolver ${formatBRL(amount)}`}</Button>
        <span className="text-xs text-muted">Estoque, CMV, receita e comissão são ajustados na hora.</span>
      </div>
    </form>
  );
}
