/**
 * Regras puras da Central (a assistente de IA do CentralOps), usadas no servidor e na tela.
 * Nada aqui chama a IA: são as conferências que impedem a IA de inventar número e os mapeamentos fixos.
 */
import { formatBRL } from "./money";
import { todaySP } from "./period";

export const ASSISTANT_NAME = "Central";

/** Formas de pagamento como a equipe fala → como o PDV grava. */
export const PAYMENT_METHODS = {
  pix: { method: "PIX", label: "Pix" },
  debito: { method: "DEBIT", label: "Débito" },
  credito: { method: "CREDIT", label: "Crédito" },
  dinheiro: { method: "CASH", label: "Dinheiro" },
  vale_troca: { method: "STORE_CREDIT", label: "Vale-troca" },
} as const;
export type PaymentKey = keyof typeof PAYMENT_METHODS;

/** Valores em reais citados num texto ("R$ 1.234,50", "R$ 99", "R$99,9") → números. */
export function moneyMentions(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/R\$\s?(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:,\d{1,2})?)/g)) {
    out.push(Number(m[1].replace(/\./g, "").replace(",", ".")));
  }
  return out;
}

/** Todo número que aparece (em qualquer profundidade) nos resultados das ferramentas. */
export function numbersIn(value: unknown, out = new Set<number>()): Set<number> {
  if (typeof value === "number" && Number.isFinite(value)) out.add(Math.round(value * 100) / 100);
  else if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim())) out.add(Math.round(Number(value) * 100) / 100);
  else if (Array.isArray(value)) value.forEach((v) => numbersIn(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => numbersIn(v, out));
  return out;
}

/**
 * Valores em reais da resposta que NÃO vieram das ferramentas desta execução (a mesma regra do validador do atendimento).
 * Somas de dois valores conhecidos também valem (ex.: "R$ 1.240 no total" de duas contas).
 */
export function unverifiedAmounts(text: string, toolResults: unknown[]): number[] {
  const known = numbersIn(toolResults);
  const list = [...known];
  return moneyMentions(text).filter((v) => {
    const c = Math.round(v * 100) / 100;
    if (known.has(c)) return false;
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) if (Math.abs(list[i] + list[j] - c) < 0.005) return false;
    return true;
  });
}

export type DuePeriod = "hoje" | "amanha" | "semana" | "mes" | "vencidas" | "proximos_30";

/** Intervalo de vencimento (datas ISO, fuso de São Paulo) para "contas a pagar hoje", "da semana", "vencidas"… */
export function dueRange(period: DuePeriod, now = new Date()): { from: string | null; to: string } {
  const t = todaySP(now);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const plus = (n: number) => new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + n));
  switch (period) {
    case "hoje": return { from: iso(t), to: iso(t) };
    case "amanha": return { from: iso(plus(1)), to: iso(plus(1)) };
    case "semana": return { from: iso(t), to: iso(plus(6)) };
    case "mes": return { from: iso(t), to: iso(new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0))) };
    case "proximos_30": return { from: iso(t), to: iso(plus(30)) };
    case "vencidas": return { from: null, to: iso(plus(-1)) };
  }
}

/** Tamanhos como a equipe fala → como o catálogo grava ("tamanho 4" → "4", "pê" → "P", "gêgê" → "GG"). */
export function normalizeSize(input: string | null | undefined): string | null {
  if (!input) return null;
  const s = input.trim().toUpperCase().replace(/^TAMANHO\s+/, "").replace(/^TAM\.?\s*/, "");
  const spoken: Record<string, string> = { "PÊ": "P", "PE": "P", "PP": "PP", "EME": "M", "GÊ": "G", "GE": "G", "GÊGÊ": "GG", "GEGE": "GG", "XG": "XG", "XGG": "XGG", "EXTRA GG": "XGG", "ÚNICO": "U", "UNICO": "U" };
  return spoken[s] ?? s;
}

/** Texto curto do que uma ação faz, para o histórico e para o cartão. */
export const ACTION_LABELS: Record<string, string> = {
  venda_pdv: "Venda no PDV",
  cadastrar_pessoa: "Cadastro de pessoa",
  reserva: "Reserva de peça",
  avise_me: "Avise-me quando chegar",
  tarefa: "Tarefa",
  preferencias: "Preferências da cliente",
  conta_pagar: "Conta a pagar",
  baixa: "Pagamento (baixa)",
  abrir_caixa: "Abrir caixa",
  fechar_caixa: "Fechar caixa",
};

/** Item do resumo do dia (ai.daily_briefing): números do banco; o texto é montado aqui, igual no Início e na Central. */
export interface BriefingItem {
  key: string;
  count?: number;
  amount?: number;
  compare_amount?: number;
  tone: "neutral" | "warning" | "danger";
  href: string;
}

const brl = (v: number | undefined) => formatBRL(v ?? 0);
const plural = (n: number | undefined, one: string, many: string) => `${n ?? 0} ${(n ?? 0) === 1 ? one : many}`;

/** Frase de cada item do resumo do dia (ex.: "3 contas vencem hoje: R$ 1.240,00"). */
export function briefingLine(i: BriefingItem): string {
  switch (i.key) {
    case "vendas_ontem": {
      const diff = (i.amount ?? 0) - (i.compare_amount ?? 0);
      const cmp = i.compare_amount ? ` (${diff >= 0 ? "acima" : "abaixo"} do mesmo dia da semana passada: ${brl(i.compare_amount)})` : "";
      return `Ontem: ${plural(i.count, "venda", "vendas")}, ${brl(i.amount)}${cmp}.`;
    }
    case "caixa_diferenca": return `O último caixa fechou com diferença de ${brl(i.amount)}.`;
    case "pagar_hoje": return `${plural(i.count, "conta vence", "contas vencem")} hoje: ${brl(i.amount)}.`;
    case "pagar_vencidas": return `${plural(i.count, "conta vencida", "contas vencidas")}: ${brl(i.amount)}.`;
    case "sem_aprovacao": return `${plural(i.count, "conta a pagar", "contas a pagar")} sem aprovação vence(m) em até 3 dias.`;
    case "receber_hoje": return `Entram hoje (previsto): ${brl(i.amount)} em ${plural(i.count, "recebimento", "recebimentos")}.`;
    case "obrigacoes": return `${plural(i.count, "obrigação fiscal", "obrigações fiscais")} na semana: ${brl(i.amount)}.`;
    case "estoque_critico": return `${plural(i.count, "peça vendida no último mês está", "peças vendidas no último mês estão")} com 1 ou nenhuma unidade.`;
    case "conversas_aguardando": return `${plural(i.count, "conversa espera", "conversas esperam")} alguém da equipe.`;
    case "contatar_hoje": return `${plural(i.count, "cliente para contatar", "clientes para contatar")} hoje.`;
    case "tarefas_atrasadas": return `Você tem ${plural(i.count, "tarefa atrasada", "tarefas atrasadas")}.`;
    case "aniversarios_contatar": return `${plural(i.count, "contato", "contatos")} de aniversário para fazer hoje.`;
    case "aniversariantes": return `${plural(i.count, "cliente faz", "clientes fazem")} aniversário hoje.`;
    case "eventos_semana": return `${plural(i.count, "evento", "eventos")} nos próximos 7 dias.`;
    case "alertas": return `${plural(i.count, "alerta importante", "alertas importantes")} na Central de sugestões.`;
    default: return i.key;
  }
}
