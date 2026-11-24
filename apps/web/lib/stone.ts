import "server-only";

export interface StonePosConfig {
  hasIntegration: boolean;
  secretKey: string | null;
  stoneCode: string | null;
  defaultSerialNumber: string | null;
  environment: "producao" | "sandbox";
}

export interface SendPosOrderParams {
  code: string;
  amountCents: number;
  terminalSerial: string;
  displayName: string;
  method?: "CREDIT" | "DEBIT" | "PIX";
  installments?: number;
  customer?: {
    name?: string;
    email?: string;
    document?: string;
  };
}

export interface StoneChargeResult {
  paid: boolean;
  nsu?: string;
  authCode?: string;
  cardBrand?: string;
  method?: string;
  amountCents?: number;
  installments?: number;
  terminalSerial?: string;
  raw?: Record<string, unknown>;
}

const BASE_URL = "https://api.pagar.me/core/v5";

function getAuthHeader(secretKey: string): string {
  const token = Buffer.from(`${secretKey.trim()}:`).toString("base64");
  return `Basic ${token}`;
}

/** Cria um pedido no Pagar.me direcionado para a maquininha física (POI / Smart POS Stone). */
export async function sendPosOrder(
  secretKey: string,
  params: SendPosOrderParams,
): Promise<{ id: string; code: string; status: string; raw: Record<string, unknown> }> {
  const methodNorm = (params.method ?? "CREDIT").toUpperCase();
  const paymentType = methodNorm === "DEBIT" ? "debit" : methodNorm === "PIX" ? "pix" : "credit";

  const paymentSetup: Record<string, unknown> = {
    type: paymentType,
  };
  if (paymentType === "credit") {
    paymentSetup.installments = Math.max(1, Math.min(12, Number(params.installments ?? 1)));
    paymentSetup.installment_type = "merchant";
  } else if (paymentType === "debit") {
    paymentSetup.installments = 1;
    paymentSetup.installment_type = "merchant";
  }

  const payload: Record<string, unknown> = {
    code: params.code,
    closed: false,
    items: [
      {
        amount: Math.round(params.amountCents),
        description: params.displayName.slice(0, 60),
        quantity: 1,
      },
    ],
    poi_payment_settings: {
      visible: true,
      print_order_receipt: false,
      devices_serial_number: [params.terminalSerial.trim()],
      display_name: params.displayName.slice(0, 50),
      payment_setup: paymentSetup,
    },
  };

  if (params.customer) {
    const cust: Record<string, string> = {};
    if (params.customer.name) cust.name = params.customer.name;
    if (params.customer.email) cust.email = params.customer.email;
    if (params.customer.document) cust.document = params.customer.document.replace(/\D/g, "");
    if (Object.keys(cust).length > 0) payload.customer = cust;
  }

  const res = await fetch(`${BASE_URL}/orders`, {
    method: "POST",
    headers: {
      Authorization: getAuthHeader(secretKey),
      "Content-Type": "application/json",
      Accept: "application/json",
      ServiceRefererName: process.env.STONE_SERVICE_REFERER_NAME || "6ace2e592a1b7b60ff68b0c7",   // identifica a parceria (Partner Hub da Stone)
    },
    body: JSON.stringify(payload),
    cache: "no-store",
  });

  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const msg = String(data.message ?? data.errors ?? JSON.stringify(data));
    throw new Error(`Stone/Pagar.me erro (${res.status}): ${msg}`);
  }

  return {
    id: String(data.id),
    code: String(data.code ?? params.code),
    status: String(data.status ?? "pending"),
    raw: data,
  };
}

/** Consulta o status do pedido na API do Pagar.me / Stone. */
export async function getPosOrder(
  secretKey: string,
  stoneOrderId: string,
): Promise<{ status: string; charge?: StoneChargeResult; raw: Record<string, unknown> }> {
  const res = await fetch(`${BASE_URL}/orders/${stoneOrderId}`, {
    method: "GET",
    headers: {
      Authorization: getAuthHeader(secretKey),
      Accept: "application/json",
    },
    cache: "no-store",
  });

  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const msg = String(data.message ?? JSON.stringify(data));
    throw new Error(`Stone/Pagar.me erro (${res.status}): ${msg}`);
  }

  const status = String(data.status ?? "").toLowerCase();
  const charges = (Array.isArray(data.charges) ? data.charges : []) as Record<string, unknown>[];
  const paidCharge = charges.find((c) => String(c.status).toLowerCase() === "paid") ?? charges[0];

  if (status === "paid" || (paidCharge && String(paidCharge.status).toLowerCase() === "paid")) {
    const meta = (paidCharge?.metadata ?? {}) as Record<string, unknown>;
    const lastTx = (paidCharge?.last_transaction ?? {}) as Record<string, unknown>;

    const nsu = String(paidCharge?.code ?? meta.authorization_code ?? meta.initiator_transaction_key ?? lastTx.id ?? "");
    const authCode = String(meta.authorization_code ?? meta.authorizationCode ?? "");
    const cardBrand = String(meta.scheme_name ?? meta.schemeName ?? "");
    const funding = String(meta.account_funding_source ?? paidCharge?.payment_method ?? "").toUpperCase();
    const method = funding.includes("DEBIT") ? "DEBIT" : funding.includes("PIX") ? "PIX" : "CREDIT";

    return {
      status: "paid",
      charge: {
        paid: true,
        nsu: nsu || undefined,
        authCode: authCode || undefined,
        cardBrand: cardBrand || undefined,
        method,
        amountCents: Number(paidCharge?.paid_amount ?? paidCharge?.amount ?? 0),
        installments: Number(meta.installment_quantity ?? lastTx.installments ?? 1),
        terminalSerial: String(meta.terminal_serial_number ?? ""),
        raw: data,
      },
      raw: data,
    };
  }

  return {
    status,
    raw: data,
  };
}

export interface CancelPosOrderResult {
  ok: boolean;
  status?: string;
  error?: string;
}

/**
 * Cancela uma ordem enviada para a maquininha: fecha o pedido com status "canceled"
 * (PATCH /orders/{id}/closed). Nunca enviar sem corpo: sem ele o Pagar.me fecha como pago.
 * Se a chamada falhar, consulta o pedido: já cancelado/fechado sem pagamento conta como sucesso; pago não.
 */
export async function cancelPosOrder(secretKey: string, stoneOrderId: string): Promise<CancelPosOrderResult> {
  let apiError = "";
  try {
    const res = await fetch(`${BASE_URL}/orders/${encodeURIComponent(stoneOrderId)}/closed`, {
      method: "PATCH",
      headers: {
        Authorization: getAuthHeader(secretKey),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ status: "canceled" }),
      cache: "no-store",
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok) return { ok: true, status: String(data.status ?? "canceled").toLowerCase() };
    apiError = String(data.message ?? (data.errors ? JSON.stringify(data.errors) : "") ?? "") || `HTTP ${res.status}`;
  } catch (e) {
    apiError = (e as Error).message;
  }

  try {
    const cur = await getPosOrder(secretKey, stoneOrderId);
    if (cur.status === "paid") return { ok: false, status: "paid", error: "Cobrança já foi paga na maquininha" };
    const closed = cur.raw.closed === true;
    if (["canceled", "cancelled", "failed"].includes(cur.status) || closed) {
      return { ok: true, status: cur.status };
    }
    return { ok: false, status: cur.status, error: apiError };
  } catch {
    return { ok: false, error: apiError };
  }
}

export interface CheckoutLinkParams {
  code: string;
  amountCents: number;
  description: string;
  maxInstallments: number;
  customer: { name: string; phone?: string | null; email?: string | null };
  /** Para onde o cliente volta depois de pagar (o WhatsApp da loja). */
  successUrl?: string | null;
  expiresInMinutes?: number;
}

/**
 * Link de pagamento online (checkout da Stone / Pagar.me): Pix ou cartão em até `maxInstallments` vezes sem juros.
 * O pedido do Pagar.me nasce com id próprio, que fica em sales.stone_pos_orders (source LINK): o aviso da Stone e a conferência
 * (syncStoneOrder) dão baixa no pedido sozinhos, como na maquininha.
 */
export async function createCheckoutLink(secretKey: string, params: CheckoutLinkParams): Promise<{ id: string; url: string; raw: Record<string, unknown> }> {
  const amount = Math.round(params.amountCents);
  const maxInst = Math.max(1, Math.min(12, Math.floor(params.maxInstallments)));
  const phone = (params.customer.phone ?? "").replace(/\D/g, "");
  const local = phone.startsWith("55") ? phone.slice(2) : phone;
  const customer: Record<string, unknown> = { name: params.customer.name.slice(0, 64) || "Cliente", type: "individual" };
  if (params.customer.email) customer.email = params.customer.email;
  if (local.length >= 10) customer.phones = { mobile_phone: { country_code: "55", area_code: local.slice(0, 2), number: local.slice(2) } };
  const expires = params.expiresInMinutes ?? 24 * 60;
  const payload = {
    code: params.code.slice(0, 52),
    closed: true,
    items: [{ amount, description: params.description.slice(0, 256), quantity: 1, code: params.code.slice(0, 52) }],
    customer,
    payments: [{
      payment_method: "checkout",
      amount,
      checkout: {
        expires_in: expires,
        customer_editable: true,
        billing_address_editable: false,
        skip_checkout_success_page: false,
        accepted_payment_methods: ["pix", "credit_card"],
        default_payment_method: "pix",
        ...(params.successUrl ? { success_url: params.successUrl } : {}),
        pix: { expires_in: expires * 60 },
        credit_card: {
          capture: true,
          installments: Array.from({ length: maxInst }, (_, i) => ({ number: i + 1, total: amount })),   // sem juros para o cliente
        },
      },
    }],
  };
  const res = await fetch(`${BASE_URL}/orders`, {
    method: "POST",
    headers: {
      Authorization: getAuthHeader(secretKey),
      "Content-Type": "application/json",
      Accept: "application/json",
      ServiceRefererName: process.env.STONE_SERVICE_REFERER_NAME || "6ace2e592a1b7b60ff68b0c7",
    },
    body: JSON.stringify(payload),
    cache: "no-store",
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const msg = String(data.message ?? (data.errors ? JSON.stringify(data.errors) : JSON.stringify(data)));
    throw new Error(`Stone/Pagar.me erro (${res.status}): ${msg.slice(0, 300)}`);
  }
  const checkouts = (Array.isArray(data.checkouts) ? data.checkouts : []) as Record<string, unknown>[];
  const url = String(checkouts[0]?.payment_url ?? "");
  if (!url) throw new Error("A Stone criou a cobrança mas não devolveu o link de pagamento");
  return { id: String(data.id), url, raw: data };
}
