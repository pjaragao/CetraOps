/**
 * Cartões que a Central mostra na conversa (tipos compartilhados entre o servidor e a tela).
 * O modelo nunca desenha cartões: eles saem das ferramentas, com os dados do banco.
 */

export interface PersonHit {
  party_id: string;
  name: string;
  tier?: string | null;
  city?: string | null;
  phone_last4?: string | null;
  cpf_last4?: string | null;
  last_purchase_at?: string | null;
}

export interface VariantHit {
  variant_id: string;
  sku: string;
  size: string;
  color: string | null;
  price: number | null;
  available: number;
}

export interface ProductHit {
  product_id: string;
  name: string;
  reference: string;
  variants: VariantHit[];
}

export interface TitleRow {
  installment_id: string;
  title_id: string;
  party: string | null;
  description: string;
  due_date: string;
  balance: number;
  approved: boolean;
  overdue_days: number;
}

export interface ActionLine {
  label: string;
  value: string;
}

export type ActionStatus = "PROPOSED" | "EXECUTED" | "FAILED" | "CANCELLED" | "EXPIRED";

export interface ActionCardData {
  id: string;
  tool: string;
  title: string;
  lines: ActionLine[];
  total?: number | null;
  warnings: string[];
  status: ActionStatus;
  expires_at: string;
  result?: { text: string; href?: string } | null;
  error?: string | null;
}

export type Card =
  | { kind: "clientes"; title: string; items: PersonHit[] }
  | { kind: "ficha"; party_id: string; name: string; lines: ActionLine[]; href: string }
  | { kind: "produtos"; title: string; items: ProductHit[] }
  | { kind: "titulos"; title: string; direction: "PAYABLE" | "RECEIVABLE"; items: TitleRow[]; total: number; href: string }
  | { kind: "saldos"; items: { name: string; balance: number }[]; total: number }
  | { kind: "numeros"; title: string; items: ActionLine[]; href?: string }
  | { kind: "lista"; title: string; items: { title: string; detail?: string; href?: string }[] }
  | { kind: "links"; items: { label: string; href: string }[] }
  | { kind: "acao"; action: ActionCardData };

/** Eventos enviados ao painel enquanto a Central trabalha (Server-Sent Events). */
export type CentralEvent =
  | { type: "thread"; id: string }
  | { type: "status"; text: string }
  | { type: "transcript"; text: string }
  | { type: "card"; card: Card }
  | { type: "text"; text: string }
  | { type: "error"; text: string }
  | { type: "done"; mode: "ai" | "search" };

export interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  cards: Card[];
  created_at: string;
}
