import "server-only";

export interface NotaasConfig {
  hasIntegration: boolean;
  apiKey: string | null;
  environment: "producao" | "homologacao";
  defaultModel: "65" | "55";
  apiBase: string;
}

export interface NotaasInvoiceStatus {
  status: "AUTHORIZED" | "PROCESSING" | "REJECTED" | "CANCELLED" | "DENIED" | "NUMBER_VOIDED";
  invoiceId?: string;
  number?: number;
  series?: number;
  accessKey?: string;
  protocol?: string;
  xmlUrl?: string;
  pdfUrl?: string;
  sefazCode?: string;
  sefazMessage?: string;
  raw?: Record<string, unknown>;
}

export const NOTAAS_DEFAULT_BASE = "https://platform.notaas.com.br/api/v1";

/**
 * Consulta status de uma nota fiscal emitida diretamente na API Notaas.
 */
export async function fetchNotaasInvoiceStatus(
  apiKey: string,
  invoiceId: string,
  apiBase = NOTAAS_DEFAULT_BASE,
): Promise<NotaasInvoiceStatus> {
  const base = apiBase.replace(/\/+$/, "");
  const res = await fetch(`${base}/nfe/invoices/${encodeURIComponent(invoiceId)}/status`, {
    headers: {
      "x-api-key": apiKey.trim(),
      Accept: "application/json",
    },
    cache: "no-store",
  });

  if (!res.ok) {
    throw new Error(`Notaas retornou HTTP ${res.status}`);
  }

  const data = (await res.json()) as Record<string, unknown>;
  const rawStatus = String(data.status ?? "").toLowerCase();

  let status: NotaasInvoiceStatus["status"] = "PROCESSING";
  if (["issued", "autorizado", "autorizada"].includes(rawStatus)) {
    status = "AUTHORIZED";
  } else if (["cancelled", "cancelado", "cancelada"].includes(rawStatus)) {
    status = "CANCELLED";
  } else if (["error", "rejeitado", "rejeitada"].includes(rawStatus)) {
    status = "REJECTED";
  } else if (["denied", "denegado"].includes(rawStatus)) {
    status = "DENIED";
  } else if (["inutilized", "inutilizado", "inutilizada"].includes(rawStatus)) {
    status = "NUMBER_VOIDED";
  }

  const rawKey = data.chaveAcesso ?? data.chave_nfe ?? "";
  const accessKey = String(rawKey).replace(/NFe/g, "").trim() || undefined;

  return {
    status,
    invoiceId: String(data.invoiceId ?? data.id ?? invoiceId),
    number: data.numero ? Number(data.numero) : undefined,
    series: data.serie ? Number(data.serie) : undefined,
    accessKey,
    protocol: data.protocolo ? String(data.protocolo) : undefined,
    xmlUrl: data.xmlUrl ? String(data.xmlUrl) : undefined,
    pdfUrl: data.pdfUrl ? String(data.pdfUrl) : undefined,
    sefazCode: data.codigoStatus ? String(data.codigoStatus) : undefined,
    sefazMessage: (data.motivo ?? data.xMotivo ?? data.errorMessage) ? String(data.motivo ?? data.xMotivo ?? data.errorMessage) : undefined,
    raw: data,
  };
}
