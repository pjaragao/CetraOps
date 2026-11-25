"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { Plus, Search, Send, ShoppingBag, X } from "lucide-react";
import { formatBRL } from "@centralops/domain";
import { Badge, Button, cn, inputClass } from "@/components/ui";
import { CheckoutDialog } from "./checkout-dialog";
import { cartAdd, cartRemove, cartSearch, cartSend, cartSetSize, type CartHit, type CartItem } from "./actions";

const SOURCE: Record<CartItem["source"], { label: string; tone: "neutral" | "brand" | "success" | "info" }> = {
  SHOWN: { label: "mostrada", tone: "neutral" },
  ORDER: { label: "pedido do cliente", tone: "success" },
  MANUAL: { label: "manual", tone: "info" },
  PDV: { label: "do PDV", tone: "brand" },
};

/** Carrinho da conversa: o que está sendo mostrado ao cliente (automático em qualquer modo), o carrinho que ele mandou pelo
 *  catálogo e o que o atendente adicionou. Serve para o atendente se localizar; remover aqui não apaga nada da conversa. */
/** Pedido desta conversa (aguardando pagamento ou pago), com o link de pagamento. */
export interface ConversationOrder { id: string; number: string; status: string; total: number; url: string | null }

const ORDER_STATUS: Record<string, { label: string; tone: "warning" | "success" | "neutral" | "danger" }> = {
  PENDING_PAYMENT: { label: "aguardando pagamento", tone: "warning" }, PAID: { label: "pago", tone: "success" }, COMPLETED: { label: "concluído", tone: "success" },
  FULFILLING: { label: "separando", tone: "success" }, READY_FOR_PICKUP: { label: "pronto p/ retirar", tone: "success" }, SHIPPED: { label: "enviado", tone: "success" },
  CANCELLED: { label: "cancelado", tone: "danger" },
};

export function CartPanel({ conversationId, items, orders = [] }: { conversationId: string; items: CartItem[]; orders?: ConversationOrder[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<CartHit[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [checkout, setCheckout] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const chosen = picked.filter((id) => items.some((i) => i.id === id));   // ignora o que saiu do carrinho
  const [sent, setSent] = useState<string | null>(null);
  const searching = adding && query.trim().length >= 2;
  const shown = searching ? hits : [];
  const total = items.reduce((a, i) => a + Number(i.price ?? 0) * Number(i.qty), 0);

  useEffect(() => {
    if (!adding || query.trim().length < 2) return;
    let alive = true;
    const t = setTimeout(async () => { const r = await cartSearch(conversationId, query); if (alive) setHits(r); }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [adding, query, conversationId]);

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) => start(async () => {
    setError(null);
    const r = await fn();
    if (!r.ok) setError(r.error ?? "Não foi possível");
    else { after?.(); router.refresh(); }
  });

  return (
    <div className="border-t border-border pt-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="flex items-center gap-1.5 text-xs font-semibold"><ShoppingBag size={13} /> Carrinho {items.length > 0 && `(${items.length})`}</p>
        <button type="button" onClick={() => { setAdding((v) => !v); setQuery(""); }} className="inline-flex items-center gap-1 text-xs text-brand" aria-expanded={adding}>
          {adding ? <><X size={12} /> Fechar</> : <><Plus size={12} /> Adicionar</>}
        </button>
      </div>

      {adding && (
        <div className="mb-2">
          <label className="relative block">
            <Search size={13} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted" />
            <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Peça, referência ou cor" aria-label="Buscar peça para o carrinho" className={`${inputClass} pl-7 text-xs`} />
          </label>
          {shown.length > 0 && (
            <ul className="mt-1 max-h-60 overflow-y-auto rounded-lg border border-border">
              {shown.map((h) => (
                <li key={`${h.product_id}-${h.color_id ?? ""}`}>
                  <button type="button" disabled={pending} onClick={() => run(() => cartAdd(conversationId, h.product_id, h.color_id), () => { setQuery(""); setAdding(false); })}
                    className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-surface-2">
                    {/* eslint-disable-next-line @next/next/no-img-element -- foto do catálogo (CDN externo) */}
                    {h.photo ? <img src={h.photo} alt="" className="size-8 shrink-0 rounded object-cover" loading="lazy" /> : <span className="size-8 shrink-0 rounded bg-surface-2" />}
                    <span className="min-w-0 flex-1"><span className="block truncate font-medium">{h.name}{h.color ? ` · ${h.color}` : ""}</span>
                      <span className="text-muted">{h.price != null ? formatBRL(Number(h.price)) : "sem preço"} · {Number(h.available ?? 0) > 0 ? `${Number(h.available)} na loja` : "sem estoque"}</span></span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {searching && hits.length === 0 && <p className="mt-1 text-xs text-muted">Nada encontrado.</p>}
        </div>
      )}

      {error && <p role="alert" className="mb-1 text-xs text-danger">{error}</p>}
      {items.length === 0 ? (
        <p className="text-xs text-muted">Vazio. As peças mostradas ao cliente (fotos do catálogo) entram aqui sozinhas.</p>
      ) : (
        <>
          <ul className="space-y-1.5">
            {items.map((i) => (
              <li key={i.id} className="flex items-start gap-2">
                <input type="checkbox" className="mt-3 shrink-0" checked={chosen.includes(i.id)} aria-label={`Selecionar ${i.name} para enviar`}
                  onChange={(e) => setPicked((p) => e.target.checked ? [...p, i.id] : p.filter((x) => x !== i.id))} />
                {/* eslint-disable-next-line @next/next/no-img-element -- foto do catálogo (CDN externo) */}
                {i.photo ? <img src={i.photo} alt="" className="size-10 shrink-0 rounded object-cover" loading="lazy" /> : <span className="size-10 shrink-0 rounded bg-surface-2" />}
                <div className="min-w-0 flex-1 text-xs">
                  <p className="truncate font-medium" title={`${i.name} · ref. ${i.reference}`}>{i.name}</p>
                  <div className="flex flex-wrap items-center gap-1 text-muted">
                    {i.color && <span>{i.color}</span>}
                    {(i.variants?.length ?? 0) > 0 ? (
                      // tamanhos como fichinhas: o escolhido em destaque; sem estoque fica riscado (ainda dá para escolher, a cliente pode encomendar)
                      <span role="radiogroup" aria-label={`Tamanho de ${i.name}`} className={cn("inline-flex flex-wrap gap-0.5", !i.size && "rounded ring-1 ring-warning")}
                        title={i.size ? undefined : "Escolha o tamanho"}>
                        {i.variants!.map((v) => {
                          const on = v.size === i.size;
                          return (
                            <button key={v.id} type="button" role="radio" aria-checked={on} disabled={pending || on}
                              onClick={() => run(() => cartSetSize(i.id, v.size))} title={v.available <= 0 ? "sem estoque" : `${v.available} na loja`}
                              className={cn("min-w-5 rounded px-1 text-[11px] leading-4",
                                on ? "bg-brand font-semibold text-brand-contrast" : "text-muted hover:bg-surface-2 hover:text-text",
                                v.available <= 0 && !on && "line-through opacity-50")}>
                              {v.size}
                            </button>
                          );
                        })}
                      </span>
                    ) : i.size ? <span>tam. {i.size}</span> : null}
                    {Number(i.qty) > 1 && <span>· {Number(i.qty)} un.</span>}
                  </div>
                  <p>{i.price != null ? formatBRL(Number(i.price)) : "sem preço"}
                    <span className="text-muted"> · {Number(i.available ?? 0) > 0 ? (i.size ? `${Number(i.available)} na loja` : `em estoque: ${(i.sizes_in_stock ?? []).join(", ")}`) : "sem estoque"}</span></p>
                  <Badge tone={SOURCE[i.source].tone}>{SOURCE[i.source].label}</Badge>
                </div>
                <button type="button" disabled={pending} onClick={() => run(() => cartRemove(i.id))} className="rounded p-0.5 text-muted hover:bg-surface-2 hover:text-danger"
                  aria-label={`Tirar ${i.name} do carrinho`} title="Tirar do carrinho"><X size={13} /></button>
              </li>
            ))}
          </ul>
          <p className="mt-2 flex justify-between border-t border-border pt-1.5 text-xs"><span className="text-muted">Total</span><span className="font-medium">{formatBRL(total)}</span></p>
          <div className="mt-2 flex gap-2">
            <Button variant="secondary" className="h-8 flex-1 whitespace-nowrap px-2 py-0 text-xs" disabled={pending}
              title="Manda as fotos/cartões do catálogo das peças ao cliente (você assume a conversa)"
              onClick={() => run(() => cartSend(conversationId, chosen), () => { setSent(chosen.length === 1 ? "Peça enviada." : "Peças enviadas."); setPicked([]); })}>
              <Send size={12} /> {chosen.length === 0 ? "Enviar todas" : `Enviar (${chosen.length})`}
            </Button>
            <Button className="h-8 flex-1 whitespace-nowrap px-2 py-0 text-xs" onClick={() => setCheckout(true)}>Fechar pedido</Button>
          </div>
          {sent && !pending && !error && <p role="status" className="mt-1 text-xs text-success">{sent}</p>}
        </>
      )}
      {checkout && <CheckoutDialog conversationId={conversationId} items={items} onClose={() => setCheckout(false)} />}

      {orders.length > 0 && (
        <ul className="mt-3 space-y-1 border-t border-border pt-2 text-xs" aria-label="Pedidos desta conversa">
          {orders.map((o) => {
            const st = ORDER_STATUS[o.status] ?? { label: o.status.toLowerCase(), tone: "neutral" as const };
            return (
              <li key={o.id} className="flex flex-wrap items-center gap-1.5">
                <Link href={`/vender/pedidos/${o.id}`} className="font-medium text-brand">{o.number}</Link>
                <span>{formatBRL(Number(o.total))}</span>
                <Badge tone={st.tone}>{st.label}</Badge>
                {o.url && o.status === "PENDING_PAYMENT" && (
                  <button type="button" className="text-brand underline" onClick={() => void navigator.clipboard?.writeText(o.url!)} title={o.url}>copiar link</button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
