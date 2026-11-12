/** Item da nota na tela de bipagem. */
export interface ScanItem {
  id: string;
  /** nota (recebimento) do item: só importa quando várias notas são bipadas juntas */
  receipt_id?: string;
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

export type ScanStatus = "OK" | "PARTIAL_EXCESS" | "EXCESS" | "NOT_IN_NOTE" | "UNKNOWN" | "ADJUST";

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
  /** foto da peça fora da nota (caminho no Storage ou link) */
  photo?: string | null;
  /** número da leitura no registro da nota (purch.receipt_scan_events) */
  event_id?: number;
  /** várias notas juntas: onde cada peça entrou (qty_counted/qty_nfe do resultado passam a ser o total da peça nas notas) */
  allocations?: ScanAllocation[];
  /** várias notas juntas: todas as linhas das notas com esta peça (entraram ou já estavam completas) */
  candidates?: string[];
}

export interface ScanAllocation { receipt_id: string; item_id: string; added: number; qty_counted: number; qty_nfe: number }

/** Leitura registrada na nota (de qualquer aparelho). */
export interface ScanEvent { id: number; at: string; code: string; qty: number; by_link: boolean; result: ScanResult }

/** Celular ligado à nota por link temporário. */
export interface ScanLink { id: string; label: string | null; expires_at: string; last_seen_at: string | null; /** abriu ou bipou no último minuto */ online?: boolean }

/** O que a tela consulta a cada poucos segundos: quantidades, leituras novas e celulares ligados. */
export interface ScanFeed { status: string; items: ItemCount[]; events: ScanEvent[]; last_event: number; links?: ScanLink[]; expires_at?: string }

/** Funções da tela: do sistema (logado) ou do link temporário (celular sem login). */
export interface ScanApi {
  scan(code: string, qty: number): Promise<Outcome<ScanResult>>;
  bump(itemId: string, delta: number): Promise<Outcome<ScanResult>>;
  feed(after: number): Promise<Outcome<ScanFeed>>;
}

export interface ItemCount { item_id: string; receipt_id?: string; qty_counted: number; qty_nfe: number }

export type Outcome<T> = { ok: true; data: T } | { ok: false; error: string; /** falha de rede/servidor: vale tentar de novo */ retry?: boolean };

/** Nota de um grupo bipado junto (o resumo completo vem em NoteSummary). */
export type GroupNote = NoteSummary & { id: string };

export interface NoteSummary {
  id?: string;
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
