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

/** Caminho interno vindo do payload (só "/algo", nunca outro site). */
const internal = (v: unknown): string | undefined => { const h = str(v); return h && /^\/(?![\/\\])/.test(h) ? h : undefined; };

const conversation = (p: Payload) => (str(p.conversation_id) ? `/atendimento?c=${str(p.conversation_id)}` : "/atendimento");

const reimbursement = (p: Payload) => (str(p.reimbursement_id) ? `/financeiro/reembolsos/${str(p.reimbursement_id)}` : "/financeiro/reembolsos");

const KINDS: Record<string, (p: Payload) => NotificationView> = {
  NEW_MESSAGE: (p) => ({ label: "Nova mensagem", tone: "info", href: conversation(p) }),
  DRAFT_READY: (p) => ({ label: "Rascunho da IA", tone: "info", href: conversation(p) }),
  HANDOFF: (p) => ({ label: "Atendimento humano", tone: "warning", href: conversation(p) }),
  SLA_BREACH: (p) => ({ label: "SLA estourado", tone: "danger", href: conversation(p) }),
  WINDOW_EXPIRING: (p) => ({ label: "Janela fechando", tone: "warning", href: conversation(p) }),
  ASSIGNED: (p) => ({ label: "Conversa atribuída", tone: "info", href: conversation(p) }),
  MENTION: (p) => ({ label: "Você foi mencionado", tone: "info", href: conversation(p) }),
  INTEGRATION_ERROR: (p) => ({ label: "Integração", tone: "danger",
    href: str(p.access_key) ? `/fiscal/recebidas/nota/${str(p.access_key)}` : str(p.order_id) ? `/vender/pedidos/${str(p.order_id)}` : "/configuracoes/integracoes" }),
  DLQ_ALERT: () => ({ label: "Fila com falhas", tone: "danger", href: "/configuracoes/integracoes" }),
  FISCAL_REJECTED: () => ({ label: "Nota rejeitada", tone: "danger", href: "/fiscal/emitidas?status=REJECTED" }),
  FISCAL_CANCEL_FAILED: () => ({ label: "Cancelamento recusado", tone: "danger", href: "/fiscal/emitidas" }),
  FISCAL_PENDING: () => ({ label: "Vendas sem nota", tone: "warning", href: "/fiscal/emitidas" }),
  FISCAL_REVIEW: () => ({ label: "Fiscal: revisar", tone: "warning", href: "/fiscal/emitidas" }),
  EVAL: () => ({ label: "Avaliação da IA", tone: "info", href: "/ia/avaliacoes" }),
  DFE: () => ({ label: "Notas na SEFAZ", tone: "info", href: "/fiscal/recebidas" }),
  DFE_TRIAGE: (p) => ({ label: "Nota recebida: confirmar destino", tone: "warning", href: str(p.access_key) ? `/fiscal/recebidas/nota/${str(p.access_key)}` : "/fiscal/recebidas" }),
  SUGGESTION: () => ({ label: "Sugestão", tone: "warning", href: "/ia" }),
  CAMPAIGN: (p) => ({ label: "Campanha", tone: "success", href: str(p.campaign_id) ? `/marketing/campanhas/${str(p.campaign_id)}` : "/marketing" }),
  PERSONA: (p) => ({ label: "Persona", tone: "info", href: str(p.persona_id) ? `/ia/personas/${str(p.persona_id)}` : "/ia/personas" }),
  CSAT_LOW: (p) => ({ label: "Nota baixa no atendimento", tone: "danger", href: str(p.party_id) ? `/clientes/${str(p.party_id)}` : "/atendimento" }),
  CASE_OPENED: () => ({ label: "Caso aberto", tone: "warning", href: "/clientes/casos" }),
  CASE_LATE: () => ({ label: "Caso atrasado", tone: "danger", href: "/clientes/casos?filtro=atrasados" }),
  REIMBURSEMENT_SUBMITTED: (p) => ({ label: "Reembolso para aprovar", tone: "warning", href: reimbursement(p) }),
  REIMBURSEMENT_APPROVED: (p) => ({ label: "Reembolso aprovado", tone: "success", href: reimbursement(p) }),
  REIMBURSEMENT_REJECTED: (p) => ({ label: "Reembolso recusado", tone: "danger", href: reimbursement(p) }),
  CUSTOMER_AT_RISK: (p) => ({ label: "Cliente em risco", tone: "warning", href: str(p.party_id) ? `/clientes/${str(p.party_id)}` : "/clientes/ciclo-de-vida" }),
  PAYMENT_LINK_REQUESTED: (p) => ({ label: "Link de pagamento", tone: "info", href: str(p.order_id) ? `/vender/pedidos/${str(p.order_id)}` : "/vender/pedidos" }),
  BRIEFING: () => ({ label: "Resumo do dia", tone: "info", href: "/inicio" }),
  BACKORDER_ARRIVED: (p) => ({ label: "Encomenda chegou", tone: "success", href: str(p.order_id) ? `/vender/pedidos/${str(p.order_id)}` : "/vender/pedidos" }),
  LOAN_OVERDUE: (p) => ({ label: "Malinha atrasada", tone: "warning", href: str(p.loan_id) ? `/vender/malinhas/${str(p.loan_id)}` : "/vender/malinhas" }),
  PRICE_CHANGED: () => ({ label: "Preço no site", tone: "info", href: "/produtos/site" }),
  STORE_CLOSED: () => ({ label: "Fechamento da loja", tone: "info", href: "/vender/rotina" }),
  TEMPLATE_STATUS: () => ({ label: "Template do WhatsApp", tone: "danger", href: "/atendimento/templates" }),
  OPS_WATCH: () => ({ label: "Plantão do sistema", tone: "warning", href: "/configuracoes/plantao" }),
  MONTH_CLOSE: (p) => ({ label: "Fechamento do mês", tone: "warning",
    href: str(p.competencia) ? `/financeiro/fechamento?mes=${str(p.competencia)!.slice(0, 7)}${str(p.legal_entity_id) ? `&entity=${str(p.legal_entity_id)}` : ""}` : "/financeiro/fechamento" }),
};

export function describeNotification(kind: string, payload: Payload | null | undefined): NotificationView {
  const p = payload ?? {};
  const make = KINDS[kind];
  const view: NotificationView = make ? make(p) : { label: "Aviso", tone: "info", href: "/notificacoes" };
  // quem gera o aviso pode apontar a tela exata (ex.: sincronização do site → /produtos/site); vale mais que o destino padrão do tipo
  const href = internal(p.href);
  return href ? { ...view, href } : view;
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
