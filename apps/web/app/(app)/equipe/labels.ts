export type Tone = "neutral" | "info" | "success" | "warning" | "danger";

export const RUN_KIND: Record<string, string> = {
  MONTHLY: "Folha mensal", ADVANCE: "Adiantamento", VACATION: "Férias", THIRTEENTH_1: "13º — 1ª parcela",
  THIRTEENTH_2: "13º — 2ª parcela", TERMINATION: "Rescisão", PROLABORE: "Pró-labore",
};

export const RUN_STATUS: Record<string, [string, Tone]> = {
  DRAFT: ["rascunho", "warning"], CALCULATED: ["calculada", "info"], APPROVED: ["aprovada", "success"], PAID: ["paga", "neutral"], CANCELLED: ["cancelada", "danger"],
};

export const TERMINATION_KIND: Record<string, string> = {
  WITHOUT_CAUSE: "Dispensa sem justa causa", RESIGNATION: "Pedido de demissão", JUST_CAUSE: "Justa causa", MUTUAL_AGREEMENT: "Acordo (art. 484-A)",
  FIXED_TERM_END: "Término de contrato a prazo", EXPERIENCE_END: "Término do contrato de experiência", DEATH: "Falecimento", RETIREMENT: "Aposentadoria",
};

export const NOTICE_KIND: Record<string, string> = {
  INDEMNIFIED: "Indenizado", WORKED: "Trabalhado", WAIVED: "Dispensado", NOT_SERVED: "Não cumprido (desconto)", NONE: "Sem aviso",
};
