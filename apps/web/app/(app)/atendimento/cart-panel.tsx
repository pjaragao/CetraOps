"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Plus, Search, ShoppingBag, X } from "lucide-react";
import { formatBRL } from "@centralops/domain";
import { Badge, inputClass } from "@/components/ui";
import { cartAdd, cartRemove, cartSearch, type CartHit, type CartItem } from "./actions";

const SOURCE: Record<CartItem["source"], { label: string; tone: "neutral" | "brand" | "success" | "info" }> = {
  SHOWN: { label: "mostrada", tone: "neutral" },
  ORDER: { label: "pedido do cliente", tone: "success" },
  MANUAL: { label: "manual", tone: "info" },
  PDV: { label: "do PDV", tone: "brand" },
};

/** Carrinho da conversa: o que está sendo mostrado ao cliente (automático em qualquer modo), o carrinho que ele mandou pelo
 *  catálogo e o que o atendente adicionou. Serve para o atendente se localizar; remover aqui não apaga nada da conversa. */
export function CartPanel({ conversationId, items }: { conversationId: string; items: CartItem[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<CartHit[]>([]);
  const [error, setError] = useState<string | null>(null);
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
                {/* eslint-disable-next-line @next/next/no-img-element -- foto do catálogo (CDN externo) */}
                {i.photo ? <img src={i.photo} alt="" className="size-10 shrink-0 rounded object-cover" loading="lazy" /> : <span className="size-10 shrink-0 rounded bg-surface-2" />}
                <div className="min-w-0 flex-1 text-xs">
                  <p className="truncate font-medium" title={`${i.name} · ref. ${i.reference}`}>{i.name}</p>
                  <p className="text-muted">{[i.color, i.size && `tam. ${i.size}`, Number(i.qty) > 1 && `${Number(i.qty)} un.`].filter(Boolean).join(" · ")}</p>
                  <p>{i.price != null ? formatBRL(Number(i.price)) : "sem preço"}
                    <span className="text-muted"> · {Number(i.available ?? 0) > 0 ? (i.size ? `${Number(i.available)} na loja` : `tam. ${(i.sizes_in_stock ?? []).join(", ")}`) : "sem estoque"}</span></p>
                  <Badge tone={SOURCE[i.source].tone}>{SOURCE[i.source].label}</Badge>
                </div>
                <button type="button" disabled={pending} onClick={() => run(() => cartRemove(i.id))} className="rounded p-0.5 text-muted hover:bg-surface-2 hover:text-danger"
                  aria-label={`Tirar ${i.name} do carrinho`} title="Tirar do carrinho"><X size={13} /></button>
              </li>
            ))}
          </ul>
          <p className="mt-2 flex justify-between border-t border-border pt-1.5 text-xs"><span className="text-muted">Total</span><span className="font-medium">{formatBRL(total)}</span></p>
        </>
      )}
    </div>
  );
}
