"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { X } from "lucide-react";
import { formatBRL } from "@centralops/domain";
import { Button, cn, inputClass } from "@/components/ui";
import { closeOrder, type CartItem, type CloseOrderResult, type Fulfillment } from "./actions";

interface Row { item: CartItem; include: boolean; variantId: string; qty: number }

const FULFILLMENT: { value: Fulfillment; label: string }[] = [
  { value: "STORE_PICKUP", label: "Retirada na loja" },
  { value: "MOTOBOY", label: "Motoboy" },
  { value: "CARRIER", label: "Transportadora/Correios" },
];

/** Escolha do tamanho: o que veio do PDV já tem; senão, o primeiro tamanho com estoque. */
function initialVariant(i: CartItem): string {
  const vs = i.variants ?? [];
  return (i.size ? vs.find((v) => v.size === i.size) : vs.find((v) => v.available > 0))?.id ?? "";
}

/** "Fechar pedido": o atendente confere tamanhos, quantidades e entrega; o sistema cria o pedido (estoque reservado por 24 h),
 *  gera o link da Stone (Pix ou cartão) e manda o resumo ao cliente. O pagamento dá baixa sozinho. */
export function CheckoutDialog({ conversationId, items, onClose }: { conversationId: string; items: CartItem[]; onClose: () => void }) {
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>(() => items.map((item) => ({ item, include: true, variantId: initialVariant(item), qty: Math.max(1, Math.round(Number(item.qty) || 1)) })));
  const [fulfillment, setFulfillment] = useState<Fulfillment>("STORE_PICKUP");
  const [shipping, setShipping] = useState("");
  const [installments, setInstallments] = useState(3);
  const [send, setSend] = useState(true);
  const [result, setResult] = useState<CloseOrderResult | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !pending) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, pending]);

  const set = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const chosen = rows.filter((r) => r.include && r.variantId);
  const price = (r: Row) => Number(r.item.variants?.find((v) => v.id === r.variantId)?.price ?? r.item.price ?? 0);
  const ship = fulfillment === "STORE_PICKUP" ? 0 : Number(shipping.replace(",", ".")) || 0;
  const total = chosen.reduce((a, r) => a + price(r) * r.qty, 0) + ship;
  const missingSize = rows.some((r) => r.include && !r.variantId);

  const submit = () => start(async () => {
    const r = await closeOrder(conversationId, {
      items: chosen.map((x) => ({ variant_id: x.variantId, qty: x.qty })), fulfillment, shipping: ship, maxInstallments: installments, send,
    });
    setResult(r);
    if (r.ok) router.refresh();
  });

  const copyAndOpen = (message: string) => {
    void navigator.clipboard?.writeText(message).catch(() => undefined);
    router.push(`/atendimento?${new URLSearchParams({ c: conversationId, msg: message })}`);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label="Fechar pedido">
      <div className="max-h-[92dvh] w-full max-w-lg overflow-y-auto rounded-t-2xl border border-border bg-surface p-4 shadow-xl sm:rounded-2xl">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold">Fechar pedido</h2>
          <button type="button" onClick={onClose} disabled={pending} className="rounded p-1 hover:bg-surface-2" aria-label="Fechar"><X size={16} /></button>
        </div>

        {result?.ok ? (
          <div className="space-y-2 text-sm">
            <p className="font-medium text-success">Pedido {result.number} criado · {formatBRL(result.total)} · estoque reservado.</p>
            {result.url && <p>Link de pagamento: <a href={result.url} target="_blank" rel="noopener noreferrer" className="break-all text-brand underline">{result.url}</a></p>}
            {result.sent && <p>Resumo com o link enviado ao cliente. Quando o pagamento cair, o pedido vira pago, o cliente recebe a confirmação e você é avisado.</p>}
            {result.linkError && <p className="text-danger">O link da Stone não foi gerado: {result.linkError}. O pedido ficou criado; gere o link ou registre o pagamento em Vender › Pedidos.</p>}
            {result.sendError && <p className="text-danger">O resumo não foi enviado: {result.sendError}</p>}
            <div className="flex flex-wrap gap-2 pt-1">
              {!result.sent && <Button onClick={() => copyAndOpen(result.message)}>Levar resumo para a mensagem</Button>}
              <Button variant="secondary" onClick={onClose}>Fechar</Button>
            </div>
          </div>
        ) : (
          <>
            <ul className="space-y-2">
              {rows.map((r, i) => (
                <li key={r.item.id} className={cn("flex items-center gap-2 rounded-lg border border-border p-2 text-sm", !r.include && "opacity-50")}>
                  <input type="checkbox" checked={r.include} onChange={(e) => set(i, { include: e.target.checked })} aria-label={`Incluir ${r.item.name}`} />
                  {/* eslint-disable-next-line @next/next/no-img-element -- foto do catálogo (CDN externo) */}
                  {r.item.photo ? <img src={r.item.photo} alt="" className="size-10 shrink-0 rounded object-cover" /> : <span className="size-10 shrink-0 rounded bg-surface-2" />}
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{r.item.name}{r.item.color ? ` · ${r.item.color}` : ""}</p>
                    <p className="text-xs text-muted">{formatBRL(price(r))}</p>
                  </div>
                  <select value={r.variantId} onChange={(e) => set(i, { variantId: e.target.value })} disabled={!r.include} aria-label={`Tamanho de ${r.item.name}`} className={cn(inputClass, "w-24 py-1 text-xs")}>
                    <option value="">Tam.</option>
                    {(r.item.variants ?? []).map((v) => (
                      <option key={v.id} value={v.id} disabled={v.available <= 0}>{v.size}{v.available <= 0 ? " (sem)" : ""}</option>
                    ))}
                  </select>
                  <input type="number" min={1} max={10} value={r.qty} onChange={(e) => set(i, { qty: Math.max(1, Math.min(10, Number(e.target.value) || 1)) })}
                    disabled={!r.include} aria-label={`Quantidade de ${r.item.name}`} className={cn(inputClass, "w-14 py-1 text-xs")} />
                </li>
              ))}
            </ul>

            <fieldset className="mt-3">
              <legend className="mb-1 text-xs font-medium text-muted">Entrega</legend>
              <div className="flex flex-wrap gap-3 text-sm">
                {FULFILLMENT.map((f) => (
                  <label key={f.value} className="flex items-center gap-1.5"><input type="radio" name="fulfillment" checked={fulfillment === f.value} onChange={() => setFulfillment(f.value)} /> {f.label}</label>
                ))}
              </div>
              {fulfillment !== "STORE_PICKUP" && (
                <label className="mt-2 flex items-center gap-2 text-sm">Frete R$
                  <input value={shipping} onChange={(e) => setShipping(e.target.value)} inputMode="decimal" placeholder="0,00" className={cn(inputClass, "w-24 py-1")} aria-label="Valor do frete" />
                </label>
              )}
            </fieldset>

            <label className="mt-3 flex items-center gap-2 text-sm">Cartão em até
              <select value={installments} onChange={(e) => setInstallments(Number(e.target.value))} className={cn(inputClass, "w-20 py-1")} aria-label="Parcelas sem juros">
                {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}x</option>)}
              </select> sem juros · Pix à vista
            </label>
            <label className="mt-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={send} onChange={(e) => setSend(e.target.checked)} /> Enviar o resumo com o link ao cliente agora</label>

            <p className="mt-3 flex justify-between border-t border-border pt-2 text-sm"><span className="text-muted">Total{ship > 0 ? " com frete" : ""}</span><b>{formatBRL(total)}</b></p>
            {result && !result.ok && <p role="alert" className="mt-2 text-sm text-danger">{result.error}</p>}
            {missingSize && <p className="mt-2 text-xs text-warning">Escolha o tamanho das peças marcadas.</p>}
            <div className="mt-3 flex flex-wrap gap-2">
              <Button disabled={pending || chosen.length === 0 || missingSize} onClick={submit}>{pending ? "Criando pedido…" : "Criar pedido e gerar link"}</Button>
              <Button variant="ghost" disabled={pending} onClick={onClose}>Cancelar</Button>
            </div>
            <p className="mt-2 text-xs text-muted">O estoque fica reservado por 24 h. O pagamento (Pix ou cartão) dá baixa sozinho: o pedido vira pago, o cliente recebe a confirmação e você é avisado.</p>
          </>
        )}
      </div>
    </div>
  );
}
