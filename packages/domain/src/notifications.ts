/**
 * Notificações (sino do app): cada tipo gerado pelo banco/worker tem um nome legível, um tom e um destino. Sem regra de negócio aqui —
 * só a leitura para a tela. Tipo desconhecido cai num padrão seguro (abre a lista de notificações).
 */
export type NotificationTone = "info" | "success" | "warning" | "danger";

export interface NotificationView {
  label: string;
  tone: NotificationTone;
  href: string;
}

type Payload = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

const conversation = (p: Payload) => (str(p.conversation_id) ? `/atendimento?c=${str(p.conversation_id)}` : "/atendimento");

const KINDS: Record<string, (p: Payload) => NotificationView> = {
  NEW_MESSAGE: (p) => ({ label: "Nova mensagem", tone: "info", href: conversation(p) }),
  DRAFT_READY: (p) => ({ label: "Rascunho da IA", tone: "info", href: conversation(p) }),
  HANDOFF: (p) => ({ label: "Atendimento humano", tone: "warning", href: conversation(p) }),
  SLA_BREACH: (p) => ({ label: "SLA estourado", tone: "danger", href: conversation(p) }),
  WINDOW_EXPIRING: (p) => ({ label: "Janela fechando", tone: "warning", href: conversation(p) }),
  ASSIGNED: (p) => ({ label: "Conversa atribuída", tone: "info", href: conversation(p) }),
  MENTION: (p) => ({ label: "Você foi mencionado", tone: "info", href: conversation(p) }),
  INTEGRATION_ERROR: () => ({ label: "Integração", tone: "danger", href: "/configuracoes/integracoes" }),
  DLQ_ALERT: () => ({ label: "Fila com falhas", tone: "danger", href: "/configuracoes/integracoes" }),
  FISCAL_REJECTED: () => ({ label: "Nota rejeitada", tone: "danger", href: "/fiscal/emitidas?status=REJECTED" }),
  FISCAL_CANCEL_FAILED: () => ({ label: "Cancelamento recusado", tone: "danger", href: "/fiscal/emitidas" }),
  FISCAL_PENDING: () => ({ label: "Vendas sem nota", tone: "warning", href: "/fiscal/emitidas" }),
  FISCAL_REVIEW: () => ({ label: "Fiscal: revisar", tone: "warning", href: "/fiscal/emitidas" }),
  EVAL: () => ({ label: "Avaliação da IA", tone: "info", href: "/ia/avaliacoes" }),
  DFE: () => ({ label: "Notas na SEFAZ", tone: "info", href: "/fiscal/recebidas" }),
  SUGGESTION: () => ({ label: "Sugestão", tone: "warning", href: "/ia" }),
  CAMPAIGN: (p) => ({ label: "Campanha", tone: "success", href: str(p.campaign_id) ? `/marketing/campanhas/${str(p.campaign_id)}` : "/marketing" }),
  PERSONA: (p) => ({ label: "Persona", tone: "info", href: str(p.persona_id) ? `/ia/personas/${str(p.persona_id)}` : "/ia/personas" }),
  CSAT_LOW: (p) => ({ label: "Nota baixa no atendimento", tone: "danger", href: str(p.party_id) ? `/clientes/${str(p.party_id)}` : "/atendimento" }),
  CASE_OPENED: (p) => ({ label: "Caso aberto", tone: "warning", href: "/clientes/casos" + (str(p.case_id) ? "" : "") }),
  CASE_LATE: () => ({ label: "Caso atrasado", tone: "danger", href: "/clientes/casos?filtro=atrasados" }),
  CUSTOMER_AT_RISK: (p) => ({ label: "Cliente em risco", tone: "warning", href: str(p.party_id) ? `/clientes/${str(p.party_id)}` : "/clientes/ciclo-de-vida" }),
  PAYMENT_LINK_REQUESTED: (p) => ({ label: "Link de pagamento", tone: "info", href: str(p.order_id) ? `/vender/pedidos/${str(p.order_id)}` : "/vender/pedidos" }),
};

export function describeNotification(kind: string, payload: Payload | null | undefined): NotificationView {
  const make = KINDS[kind];
  return make ? make(payload ?? {}) : { label: "Aviso", tone: "info", href: "/notificacoes" };
}

/** "há 5 min", "há 3 h", "ontem", "12/10" — para a lista do sino. `now` injetável para testes. */
export function timeAgo(iso: string, now: number = Date.now()): string {
  const diff = Math.max(0, now - new Date(iso).getTime());
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "agora";
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `há ${h} h`;
  const d = Math.floor(h / 24);
  if (d === 1) return "ontem";
  if (d < 7) return `há ${d} dias`;
  return new Date(iso).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit" });
}
