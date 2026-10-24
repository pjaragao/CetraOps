/**
 * Caixa de documentos: leitura dos campos para a tela e a regra de "pronto para lançar em lote". O destino é sugerido e conferido no banco
 * (fin.doc_inbox_add / fin.doc_inbox_confirm); aqui só o que a tela precisa para mostrar e para não mandar ao lote o que vai falhar.
 */
export type DocDestination = "PAYABLE" | "REIMBURSEMENT" | "RECEIPT" | "REVIEW";

export const DOC_DESTINATIONS: Record<DocDestination, string> = {
  PAYABLE: "Conta a pagar",
  REIMBURSEMENT: "Reembolso para mim",
  RECEIPT: "Recebimento de mercadoria",
  REVIEW: "Para revisar",
};

export const DOC_KINDS: Record<string, string> = {
  boleto: "Boleto", pix: "Pix", nota_ou_recibo: "Nota ou recibo", nfe_xml: "XML de NF-e", identidade: "Identidade",
  comprovante_endereco: "Comprovante de endereço", etiqueta_produto: "Etiqueta", outro: "Outro",
};

type Fields = Record<string, unknown>;
export interface DocRow { kind: string; destination: string; duplicate: unknown; fields: Fields | null }

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const iso = (v: unknown): string | null => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

/** Valor do documento (boleto/Pix: valor; nota/recibo/XML: valor total). */
export function docAmount(f: Fields | null): number | null {
  return num(f?.valor) ?? num(f?.valor_total);
}

/** Quem cobra ou quem emitiu. */
export function docCounterpart(f: Fields | null): string | null {
  const v = f?.beneficiario ?? f?.recebedor ?? f?.emitente;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** O que falta para lançar neste destino (vazio = dá para lançar sem abrir a linha). */
export function docMissing(row: DocRow, destination: string = row.destination): string[] {
  const f = row.fields ?? {};
  const out: string[] = [];
  if (destination === "REVIEW") return ["escolha o destino"];
  if (destination === "RECEIPT") return row.kind === "nfe_xml" ? [] : ["o recebimento precisa do XML da NF-e"];
  const amount = docAmount(f);
  if (amount === null || amount <= 0) out.push("valor");
  if (destination === "PAYABLE" && row.kind !== "nfe_xml" && !iso(f.vencimento)) out.push("vencimento");
  return out;
}

/** Entra no "Lançar os prontos": destino decidido, nada faltando e sem suspeita de duplicidade. */
export function docReady(row: DocRow): boolean {
  return !row.duplicate && docMissing(row).length === 0;
}
