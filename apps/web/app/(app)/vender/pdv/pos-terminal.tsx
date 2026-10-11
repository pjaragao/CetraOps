"use client";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { Minus, Plus, ScanBarcode, Smartphone, Tag, Trash2, UserPlus, UserRound } from "lucide-react";
import { formatBRL, roundCents } from "@centralops/domain";
import { Badge, Button, Card, cn, inputClass } from "@/components/ui";
import { BarcodeScanner, type ScannedCode } from "@/components/central/barcode-scanner";
import { createRemoteOrderAction, customerCoupons, type CustomerCoupon } from "../actions";
import { autoCouponFor, discardDraftOrder, finalizeSale, getCustomerStoreCredit, type getOrderDraft, saveOrderDraft, type SaleInput } from "./actions";
import { PartyPicker, type PartyHit } from "../pickers";
import { QuickCustomerDialog } from "./quick-customer-dialog";
import { StonePosDialog } from "../stone-pos-dialog";
import { CustomItemDialog } from "./custom-item-dialog";
import { ItemDiscountDialog } from "./item-discount-dialog";
import { GlobalDiscountDialog } from "./global-discount-dialog";

export interface PosVariant { id: string; sku: string; size: string; gtin: string | null; price: number; available: number }
export interface PosProduct { key: string; name: string; reference: string; gender: string; color: string; variants: PosVariant[] }

type Method = SaleInput["payments"][number]["method"];

export interface CartLine {
  id: string;
  isCustom?: boolean;
  variant?: PosVariant;
  product?: PosProduct;
  customDescription?: string;
  unitPrice: number;
  qty: number;
  discountType?: "PERCENT" | "FIXED";
  discountValue?: number;
  discountAmount: number;
  discountReason?: string;
}

interface PayLine { method: Method; amount: string; installments: number; anticipation: "D1" | "NATURAL"; nsu: string; stoneOrderId?: string }

const METHODS: { value: Method; label: string }[] = [
  { value: "PIX", label: "Pix" }, { value: "DEBIT", label: "Débito" }, { value: "CREDIT", label: "Crédito" },
  { value: "CASH", label: "Dinheiro" }, { value: "STORE_CREDIT", label: "Vale-troca" },
];

const CHANNELS = [["WHATSAPP", "WhatsApp"], ["INSTAGRAM", "Instagram"], ["TELEGRAM", "Telegram"], ["PAYMENT_LINK", "Link de pagamento"], ["B2B", "B2B"], ["EVENT", "Evento"]] as const;
const FULFILLMENTS = [["MOTOBOY", "Motoboy"], ["CARRIER", "Transportadora / Correios"], ["STORE_PICKUP", "Retirada na loja"], ["LOCKER_PICKUP", "Retirada no Armário VIP"], ["TAKEAWAY", "Levou na hora"]] as const;

interface PosTerminalProps {
  storeId: string;
  products: PosProduct[];
  cashSessionId: string | null;
  initialMode?: "balcao" | "remoto";
  canDiscount?: boolean;
  canCustomItem?: boolean;
  initialDraft?: Awaited<ReturnType<typeof getOrderDraft>> | null;
}

/** Venda no balcão (paga na hora, com NFC-e) ou pedido remoto (reserva o estoque e espera o pagamento): o mesmo carrinho nos dois modos. */
export function PosTerminal({
  storeId,
  products,
  cashSessionId,
  initialMode = "balcao",
  canDiscount = true,
  canCustomItem = true,
  initialDraft = null,
}: PosTerminalProps) {
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
  const [customerCredit, setCustomerCredit] = useState<number>(0);
  const [cpf, setCpf] = useState("");
  const [coupon, setCoupon] = useState("");
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [idem, setIdem] = useState(() => crypto.randomUUID());
  const [scanning, setScanning] = useState(false);
  const [pending, start] = useTransition();

  // Pedido rascunho persistido no banco de dados (DRAFT)
  const [dbDraftOrderId, setDbDraftOrderId] = useState<string | null>(() => initialDraft?.order.id ?? null);
  const [dbDraftOrderNumber, setDbDraftOrderNumber] = useState<string | null>(() => initialDraft?.order.number ?? null);
  const [draftSaveStatus, setDraftSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const draftOrderIdRef = useRef<string | null>(initialDraft?.order.id ?? null);

  useEffect(() => {
    draftOrderIdRef.current = dbDraftOrderId;
  }, [dbDraftOrderId]);

  // Rascunho automático em localStorage para não perder a venda/pedido ao sair da tela
  const DRAFT_KEY = `cetraops_pos_draft_${storeId}`;
  const [draftRestored, setDraftRestored] = useState(false);
  const [isInitialLoadDone, setIsInitialLoadDone] = useState(false);

  // Modais de itens avulsos e descontos
  const [customDialogOpen, setCustomDialogOpen] = useState(false);
  const [selectedDiscountLine, setSelectedDiscountLine] = useState<CartLine | null>(null);
  const [globalDiscountOpen, setGlobalDiscountOpen] = useState(false);

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

  const grossTotal = roundCents(cart.reduce((a, l) => a + l.unitPrice * l.qty, 0));
  const discountTotal = roundCents(cart.reduce((a, l) => a + l.discountAmount, 0));
  const total = roundCents(Math.max(grossTotal - discountTotal, 0));
  const paid = roundCents(payments.reduce((a, p) => a + (Number(p.amount.replace(",", ".")) || 0), 0));
  const remaining = roundCents(total - paid);
  const remote = mode === "remoto";
  const ship = Number(shipping.replace(/\./g, "").replace(",", ".")) || 0;

  // Restaurar rascunho anterior (seja vindo de initialDraft do banco ou salvo no navegador)
  useEffect(() => {
    const handle = setTimeout(() => {
      if (initialDraft?.order) {
        draftOrderIdRef.current = initialDraft.order.id;
        setDbDraftOrderId(initialDraft.order.id);
        setDbDraftOrderNumber(initialDraft.order.number);
        setDraftSaveStatus("saved");
        if (initialDraft.party) {
          setCustomer({ id: initialDraft.party.id, name: initialDraft.party.name, phone: initialDraft.party.phone });
        }
        if (initialDraft.order.notes) setNotes(initialDraft.order.notes);
        if (initialDraft.order.shipping_total) setShipping(String(initialDraft.order.shipping_total));
        if (initialDraft.order.channel && initialDraft.order.channel !== "POS") {
          setMode("remoto");
          setChannel(initialDraft.order.channel);
        }
        if (initialDraft.items && initialDraft.items.length > 0) {
          const newCart: CartLine[] = initialDraft.items.map((it) => {
            let foundProd: PosProduct | undefined;
            let foundVar: PosVariant | undefined;
            if (it.variant_id) {
              for (const p of products) {
                const v = p.variants.find((x) => x.id === it.variant_id);
                if (v) { foundProd = p; foundVar = v; break; }
              }
            }
            return {
              id: it.id,
              isCustom: !it.variant_id,
              variant: foundVar,
              product: foundProd,
              customDescription: it.description || undefined,
              unitPrice: Number(it.unit_price),
              qty: Number(it.qty),
              discountAmount: Number(it.discount_amount),
              discountReason: it.discount_reason || undefined,
            };
          });
          setCart(newCart);
          setDraftRestored(true);
        }
        setIsInitialLoadDone(true);
        return;
      }

      try {
        const raw = localStorage.getItem(DRAFT_KEY);
        if (raw) {
          const d = JSON.parse(raw);
          if (d.dbDraftOrderId) {
            draftOrderIdRef.current = d.dbDraftOrderId;
            setDbDraftOrderId(d.dbDraftOrderId);
          }
          if (d.dbDraftOrderNumber) {
            setDbDraftOrderNumber(d.dbDraftOrderNumber);
            setDraftSaveStatus("saved");
          }
          if (d.cart && Array.isArray(d.cart) && d.cart.length > 0) {
            setCart(d.cart);
            if (d.customer) setCustomer(d.customer);
            if (d.cpf) setCpf(d.cpf);
            if (d.coupon) setCoupon(d.coupon);
            if (d.mode) setMode(d.mode);
            if (d.channel) setChannel(d.channel);
            if (d.fulfillment) setFulfillment(d.fulfillment);
            if (d.shipping) setShipping(d.shipping);
            if (d.holdHours) setHoldHours(d.holdHours);
            if (d.notes) setNotes(d.notes);
            if (d.payments && Array.isArray(d.payments)) setPayments(d.payments);
            setDraftRestored(true);
          }
        }
      } catch {}
      setIsInitialLoadDone(true);
    }, 0);
    return () => clearTimeout(handle);
  }, [DRAFT_KEY, initialDraft, products]);

  // Auto-salvar no banco (sales.orders em DRAFT). Uma gravação por vez: a próxima espera a anterior terminar (senão o primeiro
  // salvamento ainda sem id criava rascunhos duplicados). Se a venda for concluída/descartada no meio, o resultado atrasado é jogado fora.
  const draftGenRef = useRef(0);
  const draftBusyRef = useRef(false);
  const draftNextRef = useRef<{ gen: number; input: Omit<Parameters<typeof saveOrderDraft>[0], "orderId"> } | null>(null);

  const flushDraft = async () => {
    if (draftBusyRef.current) return;
    draftBusyRef.current = true;
    try {
      while (draftNextRef.current) {
        const job = draftNextRef.current;
        draftNextRef.current = null;
        if (job.gen !== draftGenRef.current) continue;
        setDraftSaveStatus("saving");
        const res = await saveOrderDraft({ ...job.input, orderId: draftOrderIdRef.current }).catch((e: unknown) => ({ ok: false as const, error: String(e) }));
        if (job.gen !== draftGenRef.current) {
          if (res.ok && res.id !== draftOrderIdRef.current) void discardDraftOrder(res.id);       // venda já concluída/descartada: não deixa rascunho órfão
          continue;
        }
        if (res.ok) {
          draftOrderIdRef.current = res.id;
          setDbDraftOrderId(res.id);
          setDbDraftOrderNumber(res.number);
          setDraftSaveStatus("saved");
        } else {
          console.error("Erro no auto-save do pedido:", res.error);
          setDraftSaveStatus("error");
        }
      }
    } finally {
      draftBusyRef.current = false;
    }
  };

  useEffect(() => {
    if (!isInitialLoadDone) return;
    if (cart.length === 0) {
      try { localStorage.removeItem(DRAFT_KEY); } catch {}
      return;
    }
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({
        dbDraftOrderId: draftOrderIdRef.current, dbDraftOrderNumber, cart, customer, cpf, coupon, mode, channel, fulfillment,
        shipping, holdHours, notes, payments, updatedAt: new Date().toISOString(),
      }));
    } catch {}
    const gen = draftGenRef.current;
    const timer = setTimeout(() => {
      draftNextRef.current = {
        gen,
        input: {
          storeId,
          partyId: customer?.id ?? null,
          couponCode: coupon.trim() || null,
          channel: (mode === "remoto" ? channel : "POS") as "POS" | "WHATSAPP" | "INSTAGRAM" | "TELEGRAM" | "PAYMENT_LINK" | "B2B" | "EVENT",
          fulfillmentType: (mode === "remoto" ? fulfillment : "TAKEAWAY") as "MOTOBOY" | "CARRIER" | "STORE_PICKUP" | "LOCKER_PICKUP" | "TAKEAWAY",
          shippingTotal: Number(shipping.replace(/\./g, "").replace(",", ".")) || 0,
          notes: notes || null,
          items: cart.map((l) => ({
            variantId: l.isCustom ? null : l.variant?.id ?? null,
            description: l.isCustom ? l.customDescription : null,
            unitPrice: l.unitPrice,
            listPrice: l.unitPrice,
            qty: l.qty,
            discountAmount: l.discountAmount,
            discountReason: l.discountReason || (l.discountAmount > 0 ? "Desconto manual" : null),
          })),
        },
      };
      void flushDraft();
    }, 800);
    return () => clearTimeout(timer);
  }, [isInitialLoadDone, cart, customer, cpf, coupon, mode, channel, fulfillment, shipping, holdHours, notes, payments, storeId, DRAFT_KEY, dbDraftOrderNumber]);

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
      const i = c.findIndex((l) => !l.isCustom && l.variant?.id === variant.id);
      if (i >= 0) {
        return c.map((l, j) => {
          if (j !== i) return l;
          const newQty = l.qty + 1;
          let newDisc = l.discountAmount;
          if (l.discountType === "PERCENT" && l.discountValue) {
            newDisc = roundCents(l.unitPrice * newQty * (l.discountValue / 100));
          } else if (l.discountType === "FIXED" && l.discountValue) {
            newDisc = roundCents(Math.min(l.discountValue, l.unitPrice * newQty));
          }
          return { ...l, qty: newQty, discountAmount: newDisc };
        });
      }
      return [
        ...c,
        {
          id: variant.id,
          isCustom: false,
          product,
          variant,
          unitPrice: variant.price,
          qty: 1,
          discountAmount: 0,
        },
      ];
    });
  };

  const addCustomItem = (description: string, price: number, qty: number = 1) => {
    setMessage(null);
    setCart((c) => [
      ...c,
      {
        id: crypto.randomUUID(),
        isCustom: true,
        customDescription: description.trim(),
        unitPrice: price,
        qty,
        discountAmount: 0,
      },
    ]);
  };

  const updateLineQty = (lineId: string, newQty: number) => {
    if (newQty <= 0) {
      setCart((c) => c.filter((l) => l.id !== lineId));
      return;
    }
    setCart((c) =>
      c.map((l) => {
        if (l.id !== lineId) return l;
        let newDisc = l.discountAmount;
        if (l.discountType === "PERCENT" && l.discountValue) {
          newDisc = roundCents(l.unitPrice * newQty * (l.discountValue / 100));
        } else if (l.discountType === "FIXED" && l.discountValue) {
          newDisc = roundCents(Math.min(l.discountValue, l.unitPrice * newQty));
        }
        return { ...l, qty: newQty, discountAmount: newDisc };
      }),
    );
  };

  const removeLine = (lineId: string) => {
    setCart((c) => c.filter((l) => l.id !== lineId));
  };

  const setItemDiscount = (lineId: string, type: "PERCENT" | "FIXED", value: number, reason?: string) => {
    setCart((c) =>
      c.map((l) => {
        if (l.id !== lineId) return l;
        const lineGross = l.unitPrice * l.qty;
        let disc = 0;
        if (type === "PERCENT") {
          disc = roundCents(lineGross * (Math.min(Math.max(value, 0), 100) / 100));
        } else {
          disc = roundCents(Math.min(Math.max(value, 0), lineGross));
        }
        return {
          ...l,
          discountType: type,
          discountValue: value,
          discountAmount: disc,
          discountReason: reason || l.discountReason,
        };
      }),
    );
  };

  const removeItemDiscount = (lineId: string) => {
    setCart((c) =>
      c.map((l) =>
        l.id === lineId
          ? { ...l, discountType: undefined, discountValue: undefined, discountAmount: 0, discountReason: undefined }
          : l,
      ),
    );
  };

  const applyGlobalDiscount = (type: "PERCENT" | "FIXED", value: number) => {
    setCart((c) => {
      const gross = roundCents(c.reduce((s, l) => s + l.unitPrice * l.qty, 0));
      if (gross <= 0) return c;

      if (type === "PERCENT") {
        const pct = Math.min(Math.max(value, 0), 100);
        return c.map((l) => {
          const lGross = l.unitPrice * l.qty;
          const disc = roundCents(lGross * (pct / 100));
          return { ...l, discountType: "PERCENT", discountValue: pct, discountAmount: disc };
        });
      }

      // FIXED (R$)
      const target = roundCents(Math.min(Math.max(value, 0), gross));
      let allocated = 0;
      return c.map((l, idx) => {
        const lGross = l.unitPrice * l.qty;
        const ratio = lGross / gross;
        const disc = idx === c.length - 1 ? roundCents(target - allocated) : roundCents(target * ratio);
        allocated += disc;
        return {
          ...l,
          discountType: "FIXED",
          discountValue: disc,
          discountAmount: Math.min(disc, lGross),
        };
      });
    });
  };

  const removeGlobalDiscount = () => {
    setCart((c) =>
      c.map((l) => ({
        ...l,
        discountType: undefined,
        discountValue: undefined,
        discountAmount: 0,
        discountReason: undefined,
      })),
    );
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

  // Ao escolher a cliente, busca saldo de vale-troca e cupom pessoal vigente (ex.: aniversário)
  const pickCustomer = (p: PartyHit) => {
    setCustomer(p);
    void getCustomerStoreCredit(p.id).then((credit) => {
      setCustomerCredit(credit);
    });
    void autoCouponFor(p.id).then((c) => {
      if (!c || coupon.trim()) return;
      setCoupon(c.code);
      setMessage({ tone: "success", text: `Cupom ${c.code} aplicado: ${c.kind === "PERCENT" ? `${String(c.value).replace(".", ",")}%` : formatBRL(c.value)} de desconto para ${p.name}.` });
    });
  };

  const discardDraft = () => {
    draftGenRef.current += 1;
    const currentOrderId = draftOrderIdRef.current;
    if (currentOrderId) {
      void discardDraftOrder(currentOrderId);
    }
    try {
      localStorage.removeItem(DRAFT_KEY);
    } catch {}
    draftOrderIdRef.current = null;
    setDbDraftOrderId(null);
    setDbDraftOrderNumber(null);
    setDraftSaveStatus("idle");
    setCart([]);
    setPayments([]);
    setCustomer(null);
    setCustomerCredit(0);
    setCpf("");
    setCoupon("");
    setNotes("");
    setShipping("");
    setDraftRestored(false);
    setMessage(null);
    setIdem(crypto.randomUUID());
  };

  const createRemote = () => start(async () => {
    setMessage(null);
    if (!customer) {
      setMessage({ tone: "danger", text: "Pedido remoto precisa de cliente: busque ou cadastre." });
      return;
    }
    draftGenRef.current += 1;
    const currentOrderId = draftOrderIdRef.current;
    if (currentOrderId) {
      void discardDraftOrder(currentOrderId);
      draftOrderIdRef.current = null;
      setDbDraftOrderId(null);
      setDbDraftOrderNumber(null);
    }
    const fd = new FormData();
    fd.set("payload", JSON.stringify({
      store_id: storeId,
      party_id: customer?.id ?? null,
      channel,
      fulfillment_type: fulfillment,
      shipping_total: ship,
      hold_hours: holdHours,
      draft: false,
      idempotency_key: `web-${idem}`,
      ...(coupon.trim() ? { coupon_code: coupon.trim() } : {}),
      ...(notes ? { notes } : {}),
      items: cart.map((l) => ({
        variant_id: l.isCustom ? undefined : l.variant?.id,
        description: l.isCustom ? l.customDescription : undefined,
        unit_price: l.unitPrice,
        list_price: l.unitPrice,
        qty: l.qty,
        discount_amount: l.discountAmount,
        discount_reason: l.discountReason || (l.discountAmount > 0 ? "Desconto manual" : undefined),
      })),
    }));
    try {
      localStorage.removeItem(DRAFT_KEY);
    } catch {}
    const r = await createRemoteOrderAction(null, fd);
    if (r && !r.ok) setMessage({ tone: "danger", text: r.error ?? "Não foi possível salvar o pedido" });
  });

  const finalize = () => start(async () => {
    setMessage(null);
    const r = await finalizeSale({
      orderId: draftOrderIdRef.current,
      idempotencyKey: idem, storeId, partyId: customer?.id ?? null, cashSessionId,
      cpfOnInvoice: cpf.replace(/\D/g, "").length === 11 ? cpf.replace(/\D/g, "") : null,
      couponCode: coupon.trim() || null,
      items: cart.map((l) => ({
        variantId: l.isCustom ? undefined : l.variant?.id,
        description: l.isCustom ? l.customDescription : undefined,
        unitPrice: l.unitPrice,
        listPrice: l.unitPrice,
        qty: l.qty,
        discountAmount: l.discountAmount,
        discountReason: l.discountReason || (l.discountAmount > 0 ? "Desconto manual" : undefined),
      })),
      payments: payments.map((p) => ({
        method: p.method, amount: Number(p.amount.replace(",", ".")), installments: p.installments,
        anticipation: p.anticipation, nsu: p.nsu || undefined, stoneOrderId: p.stoneOrderId,
      })),
    });
    if (!r.ok) { setMessage({ tone: "danger", text: r.error }); return; }
    draftGenRef.current += 1;                                              // gravação de rascunho em andamento não recria o pedido já vendido
    try {
      localStorage.removeItem(DRAFT_KEY);
    } catch {}
    draftOrderIdRef.current = null;
    setDbDraftOrderId(null);
    setDbDraftOrderNumber(null);
    setDraftSaveStatus("idle");
    setMessage({ tone: "success", text: `Venda ${r.number} concluída (${formatBRL(r.total)}). NFC-e enviada para emissão.` });
    setCart([]); setPayments([]); setCustomer(null); setCpf(""); setCoupon("");
    setDraftRestored(false);
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
        <div className="flex flex-wrap gap-2">
          <input
            autoFocus value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onSearchKey}
            placeholder="Buscar produto, referência, SKU ou bipar EAN…" className={cn(inputClass, "py-3 text-base flex-1 min-w-[200px]")}
            aria-label="Buscar produto"
          />
          <Button type="button" variant="secondary" onClick={() => setScanning(true)} title="Bipar com a câmera do celular ou notebook" aria-label="Bipar com a câmera">
            <ScanBarcode size={18} /> <span className="hidden sm:inline">Câmera</span>
          </Button>
          {canCustomItem && (
            <Button
              type="button"
              variant="secondary"
              onClick={() => setCustomDialogOpen(true)}
              title="Adicionar item ou serviço avulso fora do estoque"
              className="text-brand hover:border-brand shrink-0"
            >
              <Plus size={18} /> <span>Item avulso</span>
            </Button>
          )}
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
        <Card
          title="Carrinho"
          action={
            cart.length > 0 ? (
              <button
                type="button"
                onClick={discardDraft}
                className="text-xs text-muted hover:text-danger"
                title="Limpar todos os itens e campos do carrinho"
              >
                Limpar
              </button>
            ) : undefined
          }
        >
          {draftRestored && cart.length > 0 && (
            <div className="mb-2.5 flex items-center justify-between rounded-lg border border-brand/30 bg-brand/5 px-2.5 py-1.5 text-xs text-brand">
              <span className="flex items-center gap-1.5 font-medium">
                <span className="inline-block h-2 w-2 rounded-full bg-brand animate-pulse" />
                {dbDraftOrderNumber ? `Pedido ${dbDraftOrderNumber} em andamento` : "Rascunho recuperado"}
              </span>
              <button
                type="button"
                onClick={discardDraft}
                className="text-muted hover:text-danger underline"
                title="Descartar rascunho"
              >
                Descartar
              </button>
            </div>
          )}
          {cart.length === 0 ? <p className="text-sm text-muted">Adicione produtos pelo tamanho ou use “+ Item avulso”.</p> : (
            <ul className="divide-y divide-border">
              {cart.map((l) => {
                const lineNet = Math.max(l.unitPrice * l.qty - l.discountAmount, 0);
                return (
                  <li key={l.id} className="flex items-center gap-2 py-2 text-sm">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 truncate">
                        {l.isCustom && <Badge tone="neutral" className="text-[10px] px-1 py-0">Avulso</Badge>}
                        <p className="truncate font-medium">
                          {l.isCustom ? l.customDescription : `${l.product?.name} · `}
                          {!l.isCustom && <b>{l.variant?.size}</b>}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 text-xs">
                        {l.discountAmount > 0 ? (
                          <>
                            <span className="line-through text-muted">{formatBRL(l.unitPrice)}</span>
                            <span className="font-semibold text-brand">
                              {formatBRL(lineNet / l.qty)}
                            </span>
                            <Badge tone="success" className="text-[10px] px-1 py-0">
                              {l.discountType === "PERCENT" && l.discountValue ? `-${l.discountValue}%` : `-${formatBRL(l.discountAmount)}`}
                            </Badge>
                          </>
                        ) : (
                          <span className="text-muted">{formatBRL(l.unitPrice)}</span>
                        )}
                      </div>
                    </div>

                    {/* Botão de desconto do item */}
                    <button
                      type="button"
                      aria-label="Desconto no item"
                      title={l.discountAmount > 0 ? `Desconto: -${formatBRL(l.discountAmount)} (clique para alterar)` : "Dar desconto neste item (% ou R$)"}
                      onClick={() => setSelectedDiscountLine(l)}
                      className={cn(
                        "rounded p-1 transition-colors",
                        l.discountAmount > 0
                          ? "bg-success/15 text-success hover:bg-success/25"
                          : "text-muted hover:bg-surface-2 hover:text-brand",
                      )}
                    >
                      <Tag size={14} />
                    </button>

                    <button aria-label="Diminuir" className="rounded p-1 hover:bg-surface-2" onClick={() => updateLineQty(l.id, l.qty - 1)}><Minus size={14} /></button>
                    <span className="w-5 text-center font-medium">{l.qty}</span>
                    <button aria-label="Aumentar" className="rounded p-1 hover:bg-surface-2" onClick={() => updateLineQty(l.id, l.qty + 1)}><Plus size={14} /></button>
                    <button aria-label="Remover" className="rounded p-1 text-danger hover:bg-surface-2" onClick={() => removeLine(l.id)}><Trash2 size={14} /></button>
                  </li>
                );
              })}
            </ul>
          )}

          {cart.length > 0 && (
            <div className="mt-3 border-t border-border pt-2 space-y-1 text-xs">
              <div className="flex justify-between text-muted">
                <span>Subtotal bruto</span>
                <span>{formatBRL(grossTotal)}</span>
              </div>
              {discountTotal > 0 && (
                <div className="flex justify-between text-success font-medium">
                  <span>Descontos</span>
                  <span>- {formatBRL(discountTotal)}</span>
                </div>
              )}
              {remote && ship > 0 && (
                <div className="flex justify-between text-muted">
                  <span>Frete</span>
                  <span>{formatBRL(ship)}</span>
                </div>
              )}
            </div>
          )}

          <div className="mt-2 flex items-center justify-between border-t border-border pt-2 text-lg font-semibold">
            <span>Total</span><span>{formatBRL(total + (remote ? ship : 0))}</span>
          </div>

          {cart.length > 0 && (
            <div className="mt-2 flex items-center justify-between pt-1 border-t border-border/50 text-xs">
              <button
                type="button"
                onClick={() => setGlobalDiscountOpen(true)}
                className="inline-flex items-center gap-1 font-medium text-brand hover:underline"
              >
                <Tag size={12} />
                {discountTotal > 0 ? "Alterar desconto da venda" : "+ Desconto geral na venda (% ou R$)"}
              </button>
              {discountTotal > 0 && (
                <button
                  type="button"
                  onClick={removeGlobalDiscount}
                  className="text-danger hover:underline text-[11px]"
                >
                  Limpar
                </button>
              )}
            </div>
          )}

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

          {cart.length > 0 && (
            <div className="mt-3 border-t border-border/50 pt-2.5 flex items-center justify-between text-[11px] text-muted">
              <span className="flex items-center gap-1.5">
                {draftSaveStatus === "saving" ? (
                  <>
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-warning animate-pulse" />
                    <span>Salvando pedido automaticamente…</span>
                  </>
                ) : dbDraftOrderNumber ? (
                  <>
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-success" />
                    <span className="text-success font-medium">Pedido {dbDraftOrderNumber} salvo em andamento</span>
                  </>
                ) : (
                  <span>Auto-salvamento ativo</span>
                )}
              </span>
              {dbDraftOrderNumber && (
                <Link
                  href="/vender/pedidos"
                  target="_blank"
                  className="text-brand hover:underline font-medium"
                  title="Ver este pedido na lista de pedidos"
                >
                  Ver na lista ↗
                </Link>
              )}
            </div>
          )}
        </Card>

        <Card title="Cliente" action={!customer && <button type="button" onClick={() => setNewCustomer(true)} className="inline-flex items-center gap-1 text-xs text-brand"><UserPlus size={14} /> Novo cliente</button>}>
          {customer ? (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2"><UserRound size={16} /> {customer.name}{customer.phone && <span className="text-xs text-muted">{customer.phone}</span>}</span>
                <button className="text-xs text-brand" onClick={() => { setCustomer(null); setCustomerCredit(0); setCoupon(""); }}>trocar</button>
              </div>
              {customerCredit > 0 && (
                <div className="inline-flex items-center gap-1.5 rounded-md bg-success/10 px-2 py-0.5 text-xs font-medium text-success">
                  <span>Vale-troca disponível: <b>{formatBRL(customerCredit)}</b></span>
                </div>
              )}
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
            </div>
            <div className="mt-3 flex flex-col gap-2">
              <Button className="w-full py-3 text-base" onClick={createRemote} disabled={pending || cart.length === 0 || !customer}>
                {pending ? "Criando…" : "Confirmar pedido e reservar estoque"}
              </Button>
            </div>
            <p className="mt-2 text-xs text-muted">O pedido é salvo automaticamente em andamento. Ao confirmar com reserva, o estoque fica bloqueado para a cliente.</p>
          </Card>
        )}

        {!remote && <Card title="Pagamento" action={<span className={cn("text-sm font-medium", remaining === 0 ? "text-success" : "text-warning")}>{remaining > 0 ? `falta ${formatBRL(remaining)}` : remaining < 0 ? `troco ${formatBRL(-remaining)}` : "fechado"}</span>}>
          <div className="flex flex-wrap items-center gap-1.5">
            {METHODS.map((m) => {
              const isCredit = m.value === "STORE_CREDIT";
              const creditAmount = isCredit && customerCredit > 0 ? Math.min(remaining, customerCredit) : remaining;
              const disabledCredit = isCredit && (!customer || customerCredit <= 0);
              return (
                <button key={m.value}
                  disabled={remaining <= 0 || (m.value === "CASH" && !cashSessionId) || disabledCredit}
                  onClick={() => setPayments((ps) => [...ps, { method: m.value, amount: creditAmount.toFixed(2).replace(".", ","), installments: 1, anticipation: "D1", nsu: "" }])}
                  className={cn(
                    "rounded-lg border px-2.5 py-1.5 text-sm hover:border-brand disabled:opacity-40",
                    isCredit && customerCredit > 0 ? "border-success bg-success/10 text-success font-medium" : "border-border",
                  )}
                  title={m.value === "CASH" && !cashSessionId ? "Abra o caixa para receber em dinheiro" : isCredit && customer && customerCredit <= 0 ? "Cliente não possui saldo de vale-troca" : undefined}
                >
                  + {m.label}{isCredit && customerCredit > 0 ? ` (${formatBRL(customerCredit)})` : ""}
                </button>
              );
            })}
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
          {cart.length > 0 && (
            <div className="mt-2.5 flex items-center justify-between text-[11px] text-muted">
              <span>{dbDraftOrderNumber ? `Pedido ${dbDraftOrderNumber} em andamento` : "Auto-salvamento ativo"}</span>
              <span className="text-success font-medium">✓ Salvo no sistema</span>
            </div>
          )}
          {!cashSessionId && <p className="mt-2 text-xs text-muted">Caixa fechado: dinheiro indisponível. Abra em Vender › Caixa.</p>}
        </Card>}

        {message && (
          <p role="status" className={cn("rounded-lg px-3 py-2 text-sm", message.tone === "success" ? "bg-success/10 text-success" : "bg-danger/10 text-danger")}>{message.text}</p>
        )}
      </div>
    </div>

    {/* Diálogo de Item Avulso */}
    <CustomItemDialog
      open={customDialogOpen}
      onClose={() => setCustomDialogOpen(false)}
      onAdd={addCustomItem}
    />

    {/* Diálogo de Desconto no Item Individual */}
    {selectedDiscountLine && (
      <ItemDiscountDialog
        open={Boolean(selectedDiscountLine)}
        onClose={() => setSelectedDiscountLine(null)}
        itemName={selectedDiscountLine.isCustom ? selectedDiscountLine.customDescription || "Item avulso" : `${selectedDiscountLine.product?.name} · ${selectedDiscountLine.variant?.size}`}
        grossAmount={selectedDiscountLine.unitPrice * selectedDiscountLine.qty}
        currentDiscountAmount={selectedDiscountLine.discountAmount}
        initialType={selectedDiscountLine.discountType || "PERCENT"}
        initialValue={selectedDiscountLine.discountValue}
        initialReason={selectedDiscountLine.discountReason}
        canDiscount={canDiscount}
        onApply={(type, value, reason) => setItemDiscount(selectedDiscountLine.id, type, value, reason)}
        onRemove={() => removeItemDiscount(selectedDiscountLine.id)}
      />
    )}

    {/* Diálogo de Desconto Geral na Venda */}
    <GlobalDiscountDialog
      open={globalDiscountOpen}
      onClose={() => setGlobalDiscountOpen(false)}
      grossTotal={grossTotal}
      currentDiscountTotal={discountTotal}
      canDiscount={canDiscount}
      onApply={applyGlobalDiscount}
      onRemove={removeGlobalDiscount}
    />

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
                    stoneOrderId: res.stoneOrderId,
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
              stoneOrderId: res.stoneOrderId,
            },
          ]);
        }
      }}
    />
    </div>
  );
}
