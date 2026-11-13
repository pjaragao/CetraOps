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
  /** revisão: quanto já foi conferido bipando de novo (0 enquanto não revisa) */
  qty_reviewed?: number;
  /** valor do item na nota (produtos − desconto + frete…), para estimar a falta em R$ */
  item_total: number;
  variant_id: string | null;
  sku: string | null;
  label: string | null;
  photo: string | null;
}

/** Revisão (bipar de novo): OK = conferiu; PARTIAL_OVER/OVER = bipou mais do que foi lançado; NOT_COUNTED = a peça é da nota, mas não tinha sido bipada; EXTRA_OK = conferiu uma sobra / peça fora da NF (fica separada dos itens). */
export type ScanStatus = "OK" | "PARTIAL_EXCESS" | "EXCESS" | "NOT_IN_NOTE" | "UNKNOWN" | "ADJUST" | "PARTIAL_OVER" | "OVER" | "NOT_COUNTED" | "EXTRA_OK";

/** Resposta do banco para uma leitura (purch.scan_receipt_code) ou um +/− (purch.bump_receipt_item). */
export interface ScanResult {
  status: ScanStatus;
  code: string;
  item_id?: string;
  n_item?: number;
  description?: string;
  qty_nfe?: number;
  qty_counted?: number;
  /** revisão: quanto já foi conferido bipando de novo (total da peça nas notas) */
  qty_reviewed?: number;
  /** revisão de sobra / peça fora da NF: quanto desta sobra já foi conferido, de quanto, e de que tipo */
  extra?: { reviewed: number; qty: number; kind: "EXCESS" | "NOT_IN_NOTE" | "UNKNOWN" };
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

export interface ScanAllocation { receipt_id: string; item_id: string; added: number; qty_counted: number; qty_nfe?: number; qty_reviewed?: number }

/** Leitura registrada na nota (de qualquer aparelho). */
export interface ScanEvent { id: number; at: string; code: string; qty: number; by_link: boolean; result: ScanResult }

/** Celular ligado à nota por link temporário. */
export interface ScanLink { id: string; label: string | null; expires_at: string; last_seen_at: string | null; /** abriu ou bipou no último minuto */ online?: boolean }

/** O que a tela consulta a cada poucos segundos: quantidades, leituras novas e celulares ligados. */
/** Peça que chegou e não entrou na nota: lida a mais (sobra), fora da nota ou código desconhecido. Fica pendente até ser resolvida. */
export interface ScanExtra { kind: "EXCESS" | "NOT_IN_NOTE" | "UNKNOWN"; code: string; label: string | null; sku: string | null; photo: string | null; /** peça do catálogo, quando a leitura a identificou */ variant_id?: string | null; /** nota da leitura (visão de todas as notas) */ receipt_id?: string | null; /** na lixeira desde */ trashed_at?: string | null; qty: number; /** revisão: quanto já foi conferido bipando de novo */ reviewed?: number; /** leituras de origem */ events: number[]; last_at: string }

export interface ScanFeed { status: string; items: ItemCount[]; events: ScanEvent[]; last_event: number; links?: ScanLink[]; expires_at?: string; extras?: ScanExtra[] }

/** Funções da tela: do sistema (logado) ou do link temporário (celular sem login). */
export interface ScanApi {
  /** cid: id da leitura (criado no aparelho): se o servidor receber o mesmo id de novo (reenvio), não soma outra vez */
  scan(code: string, qty: number, cid?: string): Promise<Outcome<ScanResult>>;
  bump(itemId: string, delta: number): Promise<Outcome<ScanResult>>;
  feed(after: number): Promise<Outcome<ScanFeed>>;
  /** marca leituras de sobra/fora da nota como resolvidas */
  discard(events: number[]): Promise<Outcome<number>>;
  /** revisão: bipa de novo para conferir o que foi lançado (não muda a contagem) */
  review(code: string, qty: number, cid?: string): Promise<Outcome<ScanResult>>;
  /** revisão: começa de novo */
  resetReview(): Promise<Outcome<number>>;
}

export interface ItemCount { item_id: string; receipt_id?: string; qty_counted: number; qty_reviewed?: number; qty_nfe: number }

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

/** O que foi feito com uma sobra: compensada com um faltante, entrada sem NF (a definir / presente / NF depois) ou devolução. */
export interface ExtraResolution {
  id: string; receipt_id: string | null; receipt_number: string | null;
  action: "COMPENSATE" | "ENTRY_NO_NF" | "RETURN"; status: "OPEN" | "DONE"; destination: "GIFT" | "NF_LATER" | "NF_LINKED" | null;
  kind: ScanExtra["kind"]; code: string; label: string | null; sku: string | null; photo: string | null; variant_id: string | null;
  qty: number; note: string | null; detail: Record<string, unknown>; created_at: string; decided_at: string | null;
}

export interface ExtrasOverview { pending: ScanExtra[]; trash: ScanExtra[]; resolutions: ExtraResolution[] }

/** Item da nota que faltou e pode ser compensado pela peça que sobrou. */
export interface CompensationCandidate {
  item_id: string; receipt_id: string; nf: string; label: string; sku: string | null; missing: number; unit_cost: number;
  /** mesmo produto (outro tamanho ou cor) */ same_product: boolean; /** diferença de preço em relação ao custo da peça que sobrou; null se não há referência */ diff_pct: number | null;
}
