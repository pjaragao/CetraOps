export type Tone = "neutral" | "brand" | "success" | "warning" | "danger" | "info";

export const PO_STATUS: Record<string, { label: string; tone: Tone }> = {
  DRAFT: { label: "rascunho", tone: "neutral" },
  APPROVED: { label: "aprovado", tone: "info" },
  PARTIAL: { label: "recebido em parte", tone: "warning" },
  RECEIVED: { label: "recebido", tone: "success" },
  CANCELLED: { label: "cancelado", tone: "danger" },
};

export const RECEIPT_STATUS: Record<string, { label: string; tone: Tone }> = {
  PENDING_CHECK: { label: "em conferência", tone: "warning" },
  CHECKED: { label: "conferido", tone: "info" },
  POSTED: { label: "lançado", tone: "success" },
};

export const MATCH_LABEL: Record<string, { label: string; tone: Tone }> = {
  EXACT_EAN: { label: "EAN", tone: "success" },
  LEARNED: { label: "aprendido", tone: "success" },
  SUGGESTED: { label: "sugestão", tone: "warning" },
  MANUAL: { label: "manual", tone: "info" },
  UNMATCHED: { label: "sem vínculo", tone: "danger" },
};
