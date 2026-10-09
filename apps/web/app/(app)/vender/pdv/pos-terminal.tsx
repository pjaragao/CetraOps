"use client";
import { useEffect, useMemo, useState, useTransition } from "react";
import { Minus, Plus, ScanBarcode, Smartphone, Tag, Trash2, UserPlus, UserRound } from "lucide-react";
import { formatBRL, roundCents } from "@centralops/domain";
import { Badge, Button, Card, cn, inputClass } from "@/components/ui";
import { BarcodeScanner, type ScannedCode } from "@/components/central/barcode-scanner";
import { createRemoteOrderAction, customerCoupons, type CustomerCoupon } from "../actions";
import { autoCouponFor, finalizeSale, type SaleInput } from "./actions";
import { PartyPicker, type PartyHit } from "../pickers";
import { QuickCustomerDialog } from "./quick-customer-dialog";
import { StonePosDialog } from "../stone-pos-dialog";

export interface PosVariant { id: string; sku: string; size: string; gtin: string | null; price: number; available: number }
export interface PosProduct { key: string; name: string; reference: string; gender: string; color: string; variants: PosVariant[] }

type Method = SaleInput["payments"][number]["method"];
interface CartLine { variant: PosVariant; product: PosProduct; qty: number }
interface PayLine { method: Method; amount: string; installments: number; anticipation: "D1" | "NATURAL"; nsu: string }

const METHODS: { value: Method; label: string }[] = [
  { value: "PIX", label: "Pix" }, { value: "DEBIT", label: "Débito" }, { value: "CREDIT", label: "Crédito" },
  { value: "CASH", label: "Dinheiro" }, { value: "STORE_CREDIT", label: "Vale-troca" },
];

const CHANNELS = [["WHATSAPP", "WhatsApp"], ["INSTAGRAM", "Instagram"], ["TELEGRAM", "Telegram"], ["PAYMENT_LINK", "Link de pagamento"], ["B2B", "B2B"], ["EVENT", "Evento"]] as const;
const FULFILLMENTS = [["MOTOBOY", "Motoboy"], ["CARRIER", "Transportadora / Correios"], ["STORE_PICKUP", "Retirada na loja"], ["LOCKER_PICKUP", "Retirada no Armário VIP"], ["TAKEAWAY", "Levou na hora"]] as const;

/** Venda no balcão (paga na hora, com NFC-e) ou pedido remoto (reserva o estoque e espera o pagamento): o mesmo carrinho nos dois modos. */
export function PosTerminal({ storeId, products, cashSessionId, initialMode = "balcao" }: { storeId: string; products: PosProduct[]; cashSessionId: string | null; initialMode?: "balcao" | "remoto" }) {
  const [mode, setMode] = useState<"balcao" | "remoto">(initialMode);
  const [channel, setChannel] = useState("WHATSAPP");
  const [fulfillment, setFulfillment] = useState("MOTOBOY");
  const [shipping, setShipping] = useState("");
  const [holdHours, setHoldHours] = useState(24);
  const [notes, setNotes] = useState("");
  const [newCustomer, setNewCustomer] = useState(false);
  const [suggested, setSuggested] = useState<CustomerCoupon[]>([]);
  const [q, setQ] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [payments, setPayments] = useState<PayLine[]>([]);
  const [customer, setCustomer] = useState<PartyHit | null>(null);
  const [cpf, setCpf] = useState("");
  const [coupon, setCoupon] = useState("");
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [idem, setIdem] = useState(() => crypto.randomUUID());
  const [scanning, setScanning] = useState(false);
  const [pending, start] = useTransition();

  const [stoneDialog, setStoneDialog] = useState<{
    open: boolean;
    amount: number;
    method: "CREDIT" | "DEBIT" | "PIX";
    installments: number;
    paymentIndex?: number;
  }>({ open: false, amount: 0, method: "CREDIT", installments: 1 });

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
  const remote = mode === "remoto";
  const ship = Number(shipping.replace(/\./g, "").replace(",", ".")) || 0;

  // Cupons que a cliente tem (dela ou já usados e ainda válidos), conferidos pelo banco com o total atual
  useEffect(() => {
    if (!customer) return;
    let alive = true;
    customerCoupons(customer.id, total).then((c) => { if (alive) setSuggested(c); }).catch(() => { if (alive) setSuggested([]); });
    return () => { alive = false; };
  }, [customer, total]);

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

  // Câmera do celular/notebook como leitor: cada leitura (EAN ou SKU exato) vira uma peça no carrinho
  const onScanned = (codes: ScannedCode[]) => {
    setScanning(false);
    const missing: string[] = [];
    for (const c of codes) {
      const t = c.value.trim();
      const p = products.find((x) => x.variants.some((v) => v.gtin === t || v.sku.toLowerCase() === t.toLowerCase()));
      const v = p?.variants.find((x) => x.gtin === t || x.sku.toLowerCase() === t.toLowerCase());
      if (p && v) add(p, v); else missing.push(t);
    }
    if (missing.length) setMessage({ tone: "danger", text: `Código não encontrado no catálogo: ${[...new Set(missing)].join(", ")}` });
  };

  // Ao escolher a cliente, o cupom pessoal vigente (ex.: aniversário) entra sozinho, se o campo estiver vazio
  const pickCustomer = (p: PartyHit) => {
    setCustomer(p);
    void autoCouponFor(p.id).then((c) => {
      if (!c || coupon.trim()) return;
      setCoupon(c.code);
      setMessage({ tone: "success", text: `Cupom ${c.code} aplicado: ${c.kind === "PERCENT" ? `${String(c.value).replace(".", ",")}%` : formatBRL(c.value)} de desconto para ${p.name}.` });
    });
  };

  const createRemote = () => start(async () => {
    setMessage(null);
    if (!customer) { setMessage({ tone: "danger", text: "Pedido remoto precisa de cliente: busque ou cadastre." }); return; }
    const fd = new FormData();
    fd.set("payload", JSON.stringify({
      store_id: storeId, party_id: customer.id, channel, fulfillment_type: fulfillment, shipping_total: ship, hold_hours: holdHours, idempotency_key: `web-${idem}`,
      ...(coupon.trim() ? { coupon_code: coupon.trim() } : {}), ...(notes ? { notes } : {}), items: cart.map((l) => ({ variant_id: l.variant.id, qty: l.qty })),
    }));
    const r = await createRemoteOrderAction(null, fd);   // sucesso redireciona para o pedido
    if (r && !r.ok) setMessage({ tone: "danger", text: r.error ?? "Não foi possível criar o pedido" });
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
    setCart([]); setPayments([]); setCustomer(null); setCpf(""); setCoupon("");
    setIdem(crypto.randomUUID());
  });

  return (
    <div className="space-y-3">
    <div role="tablist" aria-label="Tipo de venda" className="inline-flex rounded-lg border border-border p-0.5 text-sm">
      {([["balcao", "Venda no balcão"], ["remoto", "Pedido remoto"]] as const).map(([m, label]) => (
        <button key={m} role="tab" aria-selected={mode === m} onClick={() => { setMode(m); setMessage(null); }}
          className={cn("rounded-md px-3 py-1.5 font-medium", mode === m ? "bg-brand text-brand-contrast" : "text-muted hover:text-text")}>{label}</button>
      ))}
    </div>
    <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
      <div className="space-y-3">
        <div className="flex gap-2">
          <input
            autoFocus value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onSearchKey}
            placeholder="Buscar produto, referência, SKU ou bipar EAN…" className={cn(inputClass, "py-3 text-base")}
            aria-label="Buscar produto"
          />
          <Button type="button" variant="secondary" onClick={() => setScanning(true)} title="Bipar com a câmera do celular ou notebook" aria-label="Bipar com a câmera">
            <ScanBarcode size={18} /> <span className="hidden sm:inline">Câmera</span>
          </Button>
        </div>
        {scanning && <BarcodeScanner onDone={onScanned} onClose={() => setScanning(false)} title="Bipar peças para a venda" />}
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
          {remote && ship > 0 && <p className="mt-1 flex justify-between text-sm text-muted"><span>Frete</span><span>{formatBRL(ship)}</span></p>}
          <input value={coupon} onChange={(e) => setCoupon(e.target.value.toUpperCase())} placeholder="Cupom (ex.: trainer)" className={cn(inputClass, "mt-2")} aria-label="Cupom" />
          {customer && suggested.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Cupons da cliente">
              {suggested.map((c) => (
                <button key={c.code} type="button" onClick={() => setCoupon(coupon === c.code ? "" : c.code)} title={`${c.reason} · ${c.label}`}
                  className={cn("inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-xs", coupon === c.code ? "border-brand bg-brand/10 text-brand" : "border-border hover:border-brand")}>
                  <Tag size={12} /> {c.code} · {c.label}
                </button>
              ))}
            </div>
          )}
          <p className="mt-1 text-xs text-muted">Descontos manuais exigem permissão; o total final é calculado no servidor.</p>
        </Card>

        <Card title="Cliente" action={!customer && <button type="button" onClick={() => setNewCustomer(true)} className="inline-flex items-center gap-1 text-xs text-brand"><UserPlus size={14} /> Novo cliente</button>}>
          {customer ? (
            <div className="flex items-center justify-between text-sm">
              <span className="flex items-center gap-2"><UserRound size={16} /> {customer.name}{customer.phone && <span className="text-xs text-muted">{customer.phone}</span>}</span>
              <button className="text-xs text-brand" onClick={() => { setCustomer(null); setCoupon(""); }}>trocar</button>
            </div>
          ) : (
            <PartyPicker onPick={pickCustomer} placeholder={remote ? "Buscar cliente por nome ou telefone (obrigatório)" : "Buscar cliente por nome ou telefone (opcional)"} />
          )}
          {!remote && <input value={cpf} onChange={(e) => setCpf(e.target.value)} placeholder="CPF na nota (opcional)" inputMode="numeric" className={cn(inputClass, "mt-2")} aria-label="CPF na nota" />}
        </Card>
        {newCustomer && <QuickCustomerDialog onClose={() => setNewCustomer(false)} onCreated={(p) => { pickCustomer(p); setNewCustomer(false); }} />}

        {remote && (
          <Card title="Entrega e reserva">
            <div className="grid grid-cols-2 gap-2 text-xs text-muted">
              <label>Canal<select value={channel} onChange={(e) => setChannel(e.target.value)} className={inputClass}>{CHANNELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
              <label>Entrega<select value={fulfillment} onChange={(e) => setFulfillment(e.target.value)} className={inputClass}>{FULFILLMENTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
              <label>Frete (R$)<input inputMode="decimal" value={shipping} onChange={(e) => setShipping(e.target.value)} placeholder="0,00" className={inputClass} /></label>
              <label>Reservar por (h)<input type="number" min={1} max={168} value={holdHours} onChange={(e) => setHoldHours(Number(e.target.value) || 24)} className={inputClass} /></label>
              <label className="col-span-2">Observações<input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} className={inputClass} /></label>
            </div>
            <Button className="mt-3 w-full py-3 text-base" onClick={createRemote} disabled={pending || cart.length === 0 || !customer}>
              {pending ? "Criando…" : "Criar pedido e reservar estoque"}
            </Button>
            <p className="mt-2 text-xs text-muted">O estoque fica reservado até o pagamento; a nota sai quando pago. Cupom e total final são calculados ao salvar.</p>
          </Card>
        )}

        {!remote && <Card title="Pagamento" action={<span className={cn("text-sm font-medium", remaining === 0 ? "text-success" : "text-warning")}>{remaining > 0 ? `falta ${formatBRL(remaining)}` : remaining < 0 ? `troco ${formatBRL(-remaining)}` : "fechado"}</span>}>
          <div className="flex flex-wrap items-center gap-1.5">
            {METHODS.map((m) => (
              <button key={m.value}
                disabled={remaining <= 0 || (m.value === "CASH" && !cashSessionId) || (m.value === "STORE_CREDIT" && !customer)}
                onClick={() => setPayments((ps) => [...ps, { method: m.value, amount: remaining.toFixed(2).replace(".", ","), installments: 1, anticipation: "D1", nsu: "" }])}
                className="rounded-lg border border-border px-2.5 py-1.5 text-sm hover:border-brand disabled:opacity-40"
                title={m.value === "CASH" && !cashSessionId ? "Abra o caixa para receber em dinheiro" : undefined}
              >+ {m.label}</button>
            ))}
            <button
              type="button"
              disabled={remaining <= 0}
              onClick={() => setStoneDialog({ open: true, amount: remaining > 0 ? remaining : total, method: "CREDIT", installments: 1 })}
              className="inline-flex items-center gap-1.5 rounded-lg border border-brand bg-brand/10 px-2.5 py-1.5 text-sm font-semibold text-brand hover:bg-brand/20 disabled:opacity-40"
              title="Envia a cobrança direto para a tela da maquininha Stone"
            >
              <Smartphone size={14} /> Maquininha Stone
            </button>
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
                {(p.method === "CREDIT" || p.method === "DEBIT" || p.method === "PIX") && (
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <input value={p.nsu} placeholder="NSU / código da maquininha" aria-label="NSU"
                      onChange={(e) => setPayments((ps) => ps.map((x, j) => (j === i ? { ...x, nsu: e.target.value } : x)))}
                      className={cn(inputClass, "py-1 flex-1")} />
                    {p.nsu ? (
                      <span className="text-xs text-success font-medium shrink-0">✓ Aprovado</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          const val = Number(p.amount.replace(",", ".")) || remaining || total;
                          const m = p.method === "DEBIT" ? "DEBIT" : p.method === "PIX" ? "PIX" : "CREDIT";
                          setStoneDialog({ open: true, amount: val, method: m, installments: p.installments, paymentIndex: i });
                        }}
                        className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-brand/40 bg-brand/5 px-2 py-1 text-xs font-medium text-brand hover:bg-brand/15"
                      >
                        <Smartphone size={12} /> Cobrar no POS
                      </button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
          <Button className="mt-3 w-full py-3 text-base" onClick={finalize}
            disabled={pending || cart.length === 0 || payments.length === 0 || remaining > 0 || (remaining < 0 && !payments.some((p) => p.method === "CASH"))}>
            {pending ? "Processando…" : "Finalizar venda"}
          </Button>
          {!cashSessionId && <p className="mt-2 text-xs text-muted">Caixa fechado: dinheiro indisponível. Abra em Vender › Caixa.</p>}
        </Card>}

        {message && (
          <p role="status" className={cn("rounded-lg px-3 py-2 text-sm", message.tone === "success" ? "bg-success/10 text-success" : "bg-danger/10 text-danger")}>{message.text}</p>
        )}
      </div>
    </div>

    <StonePosDialog
      open={stoneDialog.open}
      onClose={() => setStoneDialog((s) => ({ ...s, open: false }))}
      amount={stoneDialog.amount}
      initialMethod={stoneDialog.method}
      initialInstallments={stoneDialog.installments}
      customerName={customer?.name}
      customerDoc={cpf.replace(/\D/g, "") || undefined}
      onPaymentConfirmed={(res) => {
        setMessage({
          tone: "success",
          text: `Pagamento de ${formatBRL(res.amount)} aprovado na maquininha Stone! NSU: ${res.nsu}${res.cardBrand ? ` (${res.cardBrand})` : ""}`,
        });
        if (stoneDialog.paymentIndex !== undefined) {
          setPayments((ps) =>
            ps.map((p, idx) =>
              idx === stoneDialog.paymentIndex
                ? {
                    ...p,
                    method: res.method,
                    amount: res.amount.toFixed(2).replace(".", ","),
                    installments: res.installments,
                    nsu: res.nsu,
                  }
                : p,
            ),
          );
        } else {
          setPayments((ps) => [
            ...ps,
            {
              method: res.method,
              amount: res.amount.toFixed(2).replace(".", ","),
              installments: res.installments,
              anticipation: "D1",
              nsu: res.nsu,
            },
          ]);
        }
      }}
    />
    </div>
  );
}
