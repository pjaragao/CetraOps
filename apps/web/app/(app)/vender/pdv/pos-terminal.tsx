"use client";
import { useMemo, useState, useTransition } from "react";
import { Minus, Plus, Trash2, UserRound } from "lucide-react";
import { formatBRL, roundCents } from "@sie/domain";
import { Badge, Button, Card, cn, inputClass } from "@/components/ui";
import { finalizeSale, identifyCustomer, type SaleInput } from "./actions";

export interface PosVariant { id: string; sku: string; size: string; gtin: string | null; price: number; available: number }
export interface PosProduct { key: string; name: string; reference: string; gender: string; color: string; variants: PosVariant[] }

type Method = SaleInput["payments"][number]["method"];
interface CartLine { variant: PosVariant; product: PosProduct; qty: number }
interface PayLine { method: Method; amount: string; installments: number; anticipation: "D1" | "NATURAL"; nsu: string }

const METHODS: { value: Method; label: string }[] = [
  { value: "PIX", label: "Pix" }, { value: "DEBIT", label: "Débito" }, { value: "CREDIT", label: "Crédito" },
  { value: "CASH", label: "Dinheiro" }, { value: "STORE_CREDIT", label: "Vale-troca" },
];

export function PosTerminal({ storeId, products, cashSessionId }: { storeId: string; products: PosProduct[]; cashSessionId: string | null }) {
  const [q, setQ] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [payments, setPayments] = useState<PayLine[]>([]);
  const [customer, setCustomer] = useState<{ id: string; name: string } | null>(null);
  const [phone, setPhone] = useState("");
  const [custName, setCustName] = useState("");
  const [marketing, setMarketing] = useState(false);
  const [cpf, setCpf] = useState("");
  const [coupon, setCoupon] = useState("");
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [idem, setIdem] = useState(() => crypto.randomUUID());
  const [pending, start] = useTransition();

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return products.slice(0, 24);
    return products.filter((p) =>
      p.name.toLowerCase().includes(t) || p.reference.toLowerCase().includes(t) ||
      p.variants.some((v) => v.sku.toLowerCase() === t || v.gtin === t)).slice(0, 24);
  }, [q, products]);

  const total = roundCents(cart.reduce((a, l) => a + l.variant.price * l.qty, 0));
  const paid = roundCents(payments.reduce((a, p) => a + (Number(p.amount.replace(",", ".")) || 0), 0));
  const remaining = roundCents(total - paid);

  const add = (product: PosProduct, variant: PosVariant) => {
    setMessage(null);
    setCart((c) => {
      const i = c.findIndex((l) => l.variant.id === variant.id);
      if (i >= 0) return c.map((l, j) => (j === i ? { ...l, qty: l.qty + 1 } : l));
      return [...c, { product, variant, qty: 1 }];
    });
  };

  // Leitor de código de barras: Enter com EAN/SKU exato adiciona direto
  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    const t = q.trim();
    for (const p of products) {
      const v = p.variants.find((x) => x.gtin === t || x.sku.toLowerCase() === t.toLowerCase());
      if (v) { add(p, v); setQ(""); return; }
    }
  };

  const identify = () => start(async () => {
    const r = await identifyCustomer(phone, custName, marketing);
    if (!r.ok) setMessage({ tone: "danger", text: r.error });
    else if (r.party) setCustomer({ id: r.party.id, name: r.party.display_name });
  });

  const finalize = () => start(async () => {
    setMessage(null);
    const r = await finalizeSale({
      idempotencyKey: idem, storeId, partyId: customer?.id ?? null, cashSessionId,
      cpfOnInvoice: cpf.replace(/\D/g, "").length === 11 ? cpf.replace(/\D/g, "") : null,
      couponCode: coupon.trim() || null,
      items: cart.map((l) => ({ variantId: l.variant.id, qty: l.qty })),
      payments: payments.map((p) => ({
        method: p.method, amount: Number(p.amount.replace(",", ".")), installments: p.installments,
        anticipation: p.anticipation, nsu: p.nsu || undefined,
      })),
    });
    if (!r.ok) { setMessage({ tone: "danger", text: r.error }); return; }
    setMessage({ tone: "success", text: `Venda ${r.number} concluída (${formatBRL(r.total)}). NFC-e enviada para emissão.` });
    setCart([]); setPayments([]); setCustomer(null); setPhone(""); setCustName(""); setCpf(""); setCoupon(""); setMarketing(false);
    setIdem(crypto.randomUUID());
  });

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
      <div className="space-y-3">
        <input
          autoFocus value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onSearchKey}
          placeholder="Buscar produto, referência, SKU ou bipar EAN…" className={cn(inputClass, "py-3 text-base")}
          aria-label="Buscar produto"
        />
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((p) => (
            <Card key={p.key} className="p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-medium">{p.name}</p>
                  <p className="text-xs text-muted">{p.reference} · {p.color}</p>
                </div>
                <Badge tone={p.gender === "MASC" ? "info" : "brand"}>{p.gender === "MASC" ? "Masc" : p.gender === "FEM" ? "Fem" : "Uni"}</Badge>
              </div>
              <p className="mt-1 text-sm font-semibold">{formatBRL(p.variants[0]?.price)}</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {p.variants.map((v) => (
                  <button
                    key={v.id} onClick={() => add(p, v)} disabled={v.available <= 0}
                    title={`${v.sku} · ${v.available} disponível`}
                    className={cn(
                      "min-w-11 rounded-lg border px-2 py-1.5 text-sm font-medium",
                      v.available > 0 ? "border-border hover:border-brand hover:text-brand" : "border-dashed border-border text-muted/50 line-through",
                    )}
                  >
                    {v.size}<span className="block text-[10px] font-normal text-muted">{v.available}</span>
                  </button>
                ))}
              </div>
            </Card>
          ))}
          {filtered.length === 0 && <p className="text-sm text-muted">Nenhum produto encontrado.</p>}
        </div>
      </div>

      <div className="space-y-3 lg:sticky lg:top-16 lg:self-start">
        <Card title="Carrinho">
          {cart.length === 0 ? <p className="text-sm text-muted">Adicione produtos pelo tamanho.</p> : (
            <ul className="divide-y divide-border">
              {cart.map((l) => (
                <li key={l.variant.id} className="flex items-center gap-2 py-2 text-sm">
                  <div className="min-w-0 flex-1">
                    <p className="truncate">{l.product.name} · <b>{l.variant.size}</b></p>
                    <p className="text-xs text-muted">{formatBRL(l.variant.price)}</p>
                  </div>
                  <button aria-label="Diminuir" className="rounded p-1 hover:bg-surface-2" onClick={() => setCart((c) => c.flatMap((x) => x.variant.id === l.variant.id ? (x.qty > 1 ? [{ ...x, qty: x.qty - 1 }] : []) : [x]))}><Minus size={14} /></button>
                  <span className="w-5 text-center">{l.qty}</span>
                  <button aria-label="Aumentar" className="rounded p-1 hover:bg-surface-2" onClick={() => add(l.product, l.variant)}><Plus size={14} /></button>
                  <button aria-label="Remover" className="rounded p-1 text-danger hover:bg-surface-2" onClick={() => setCart((c) => c.filter((x) => x.variant.id !== l.variant.id))}><Trash2 size={14} /></button>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 flex items-center justify-between border-t border-border pt-3 text-lg font-semibold">
            <span>Total</span><span>{formatBRL(total)}</span>
          </div>
          <input value={coupon} onChange={(e) => setCoupon(e.target.value)} placeholder="Cupom (ex.: trainer)" className={cn(inputClass, "mt-2")} aria-label="Cupom" />
          <p className="mt-1 text-xs text-muted">Descontos manuais exigem permissão; o total final é calculado no servidor.</p>
        </Card>

        <Card title="Cliente">
          {customer ? (
            <div className="flex items-center justify-between text-sm">
              <span className="flex items-center gap-2"><UserRound size={16} /> {customer.name}</span>
              <button className="text-xs text-brand" onClick={() => setCustomer(null)}>trocar</button>
            </div>
          ) : (
            <div className="space-y-2">
              <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Celular (WhatsApp)" inputMode="tel" className={inputClass} aria-label="Celular" />
              <input value={custName} onChange={(e) => setCustName(e.target.value)} placeholder="Nome (se for novo)" className={inputClass} aria-label="Nome" />
              <label className="flex items-center gap-2 text-xs text-muted">
                <input type="checkbox" checked={marketing} onChange={(e) => setMarketing(e.target.checked)} />
                Aceita receber novidades e lançamentos pelo WhatsApp
              </label>
              <Button variant="secondary" className="w-full" onClick={identify} disabled={pending || phone.replace(/\D/g, "").length < 10}>Identificar cliente</Button>
            </div>
          )}
          <input value={cpf} onChange={(e) => setCpf(e.target.value)} placeholder="CPF na nota (opcional)" inputMode="numeric" className={cn(inputClass, "mt-2")} aria-label="CPF na nota" />
        </Card>

        <Card title="Pagamento" action={<span className={cn("text-sm font-medium", remaining === 0 ? "text-success" : "text-warning")}>{remaining > 0 ? `falta ${formatBRL(remaining)}` : remaining < 0 ? `troco ${formatBRL(-remaining)}` : "fechado"}</span>}>
          <div className="flex flex-wrap gap-1.5">
            {METHODS.map((m) => (
              <button key={m.value}
                disabled={remaining <= 0 || (m.value === "CASH" && !cashSessionId) || (m.value === "STORE_CREDIT" && !customer)}
                onClick={() => setPayments((ps) => [...ps, { method: m.value, amount: remaining.toFixed(2).replace(".", ","), installments: 1, anticipation: "D1", nsu: "" }])}
                className="rounded-lg border border-border px-2.5 py-1.5 text-sm hover:border-brand disabled:opacity-40"
                title={m.value === "CASH" && !cashSessionId ? "Abra o caixa para receber em dinheiro" : undefined}
              >+ {m.label}</button>
            ))}
          </div>
          <ul className="mt-2 space-y-2">
            {payments.map((p, i) => (
              <li key={i} className="rounded-lg border border-border p-2 text-sm">
                <div className="flex items-center gap-2">
                  <span className="w-20 font-medium">{METHODS.find((m) => m.value === p.method)?.label}</span>
                  <input value={p.amount} inputMode="decimal" aria-label="Valor"
                    onChange={(e) => setPayments((ps) => ps.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))}
                    className={cn(inputClass, "py-1")} />
                  <button aria-label="Remover pagamento" className="p-1 text-danger" onClick={() => setPayments((ps) => ps.filter((_, j) => j !== i))}><Trash2 size={14} /></button>
                </div>
                {p.method === "CREDIT" && (
                  <div className="mt-2 flex gap-2">
                    <select aria-label="Parcelas" value={p.installments} className={cn(inputClass, "py-1")}
                      onChange={(e) => setPayments((ps) => ps.map((x, j) => (j === i ? { ...x, installments: Number(e.target.value) } : x)))}>
                      {Array.from({ length: 6 }, (_, k) => k + 1).map((n) => <option key={n} value={n}>{n}x</option>)}
                    </select>
                    <select aria-label="Recebimento" value={p.anticipation} className={cn(inputClass, "py-1")}
                      onChange={(e) => setPayments((ps) => ps.map((x, j) => (j === i ? { ...x, anticipation: e.target.value as "D1" | "NATURAL" } : x)))}>
                      <option value="D1">Antecipado D+1</option><option value="NATURAL">Fluxo natural</option>
                    </select>
                  </div>
                )}
                {(p.method === "CREDIT" || p.method === "DEBIT") && (
                  <input value={p.nsu} placeholder="NSU / código da maquininha" aria-label="NSU"
                    onChange={(e) => setPayments((ps) => ps.map((x, j) => (j === i ? { ...x, nsu: e.target.value } : x)))}
                    className={cn(inputClass, "mt-2 py-1")} />
                )}
              </li>
            ))}
          </ul>
          <Button className="mt-3 w-full py-3 text-base" onClick={finalize}
            disabled={pending || cart.length === 0 || payments.length === 0 || remaining > 0 || (remaining < 0 && !payments.some((p) => p.method === "CASH"))}>
            {pending ? "Processando…" : "Finalizar venda"}
          </Button>
          {!cashSessionId && <p className="mt-2 text-xs text-muted">Caixa fechado: dinheiro indisponível. Abra em Vender › Caixa.</p>}
        </Card>

        {message && (
          <p role="status" className={cn("rounded-lg px-3 py-2 text-sm", message.tone === "success" ? "bg-success/10 text-success" : "bg-danger/10 text-danger")}>{message.text}</p>
        )}
      </div>
    </div>
  );
}
