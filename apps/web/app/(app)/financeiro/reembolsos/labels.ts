/** Rótulos do módulo de reembolso (usados nas páginas do servidor e no formulário). */
export const DOC_KIND: Record<string, string> = { NFCE: "NFC-e (cupom fiscal eletrônico)", NFE: "NF-e", NFSE: "NFS-e (serviço)", CUPOM: "Cupom / SAT", RECIBO: "Recibo", OUTRO: "Outro" };

export const STATUS: Record<string, { label: string; tone: "neutral" | "info" | "warning" | "success" | "danger" }> = {
  DRAFT: { label: "rascunho", tone: "neutral" }, SUBMITTED: { label: "aguardando aprovação", tone: "warning" }, APPROVED: { label: "aprovado, a pagar", tone: "info" },
  REJECTED: { label: "recusado, corrigir", tone: "danger" }, PAID: { label: "pago", tone: "success" }, CANCELLED: { label: "cancelado", tone: "neutral" },
};
