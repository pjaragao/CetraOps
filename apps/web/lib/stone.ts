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
        installments: Number(meta.installment_quantity ?? 1),
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

/** Cancela uma ordem enviada para a maquininha. */
export async function cancelPosOrder(
  secretKey: string,
  stoneOrderId: string,
): Promise<{ ok: boolean }> {
  const res = await fetch(`${BASE_URL}/orders/${stoneOrderId}/closed`, {
    method: "DELETE",
    headers: {
      Authorization: getAuthHeader(secretKey),
      Accept: "application/json",
    },
    cache: "no-store",
  });

  return { ok: res.ok || res.status === 404 };
}
