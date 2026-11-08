/** Item da nota na tela de bipagem. */
export interface ScanItem {
  id: string;
  n_item: number;
  description: string;
  cprod: string | null;
  cean: string | null;
  qty_nfe: number;
  qty_counted: number;
  /** valor do item na nota (produtos − desconto + frete…), para estimar a falta em R$ */
  item_total: number;
  variant_id: string | null;
  sku: string | null;
  label: string | null;
  photo: string | null;
}

export type ScanStatus = "OK" | "PARTIAL_EXCESS" | "EXCESS" | "NOT_IN_NOTE" | "UNKNOWN";

/** Resposta do banco para uma leitura (purch.scan_receipt_code) ou um +/− (purch.bump_receipt_item). */
export interface ScanResult {
  status: ScanStatus;
  code: string;
  item_id?: string;
  n_item?: number;
  description?: string;
  qty_nfe?: number;
  qty_counted?: number;
  added?: number;
  excess?: number;
  variant_id?: string | null;
  sku?: string | null;
  label?: string | null;
}

export interface ItemCount { item_id: string; qty_counted: number; qty_nfe: number }

export type Outcome<T> = { ok: true; data: T } | { ok: false; error: string; /** falha de rede/servidor: vale tentar de novo */ retry?: boolean };

export interface NoteSummary {
  receiptNumber: string;
  status: string;
  nfNumber: string;
  issueAt: string | null;
  supplier: string;
  supplierCnpj: string | null;
  location: string;
  nfTotal: number;
  vProd: number;
  vFrete: number;
  vDesc: number;
}
