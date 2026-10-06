/**
 * Regras puras da Central (a assistente de IA do CentralOps), usadas no servidor e na tela.
 * Nada aqui chama a IA: são as conferências que impedem a IA de inventar número e os mapeamentos fixos.
 */
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
