export const CAMPAIGN_STATUS: Record<string, { label: string; tone: "neutral" | "info" | "warning" | "success" | "danger" }> = {
  DRAFT: { label: "rascunho", tone: "neutral" }, SCHEDULED: { label: "agendada", tone: "info" }, SENDING: { label: "enviando", tone: "warning" }, DONE: { label: "concluída", tone: "success" }, CANCELLED: { label: "cancelada", tone: "danger" },
};
