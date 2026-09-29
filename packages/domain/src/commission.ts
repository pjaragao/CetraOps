/**
 * Plano de comissão (doc 08 do plano de negócios):
 *  - comissão percentual por canal sobre as vendas creditadas à vendedora;
 *  - bônus fixo de R$ 200 quando a base do mês fica entre R$ 35 mil e R$ 60 mil;
 *  - acima de R$ 60 mil, 1% sobre o excedente (em vez do bônus fixo).
 * A base (faturamento da loja ou individual) é configurável: decisão pendente dos sócios.
 */
export type Channel = "POS" | "WHATSAPP" | "INSTAGRAM" | "TELEGRAM" | "TIKTOK" | "PAYMENT_LINK" | "B2B" | "EVENT";

export interface CommissionTier {
  from: number;
  to?: number;
  bonus?: number;
  pctOver?: number;
}

export interface CommissionPlan {
  ratesByChannel: Partial<Record<Channel, number>>; // percentuais, ex.: { POS: 3 }
  tiers: CommissionTier[];
}

export interface CreditedSale {
  channel: Channel;
  amount: number; // valor líquido de desconto creditado à vendedora
}

export interface CommissionStatement {
  base: number;
  commission: number;
  bonus: number;
  total: number;
  nextTier?: { missing: number; description: string };
}

const round = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

export function computeCommission(plan: CommissionPlan, sales: CreditedSale[], tierBase?: number): CommissionStatement {
  const commission = round(
    sales.reduce((acc, s) => acc + s.amount * ((plan.ratesByChannel[s.channel] ?? 0) / 100), 0),
  );
  const base = tierBase ?? round(sales.reduce((acc, s) => acc + s.amount, 0));

  let bonus = 0;
  let nextTier: CommissionStatement["nextTier"];
  const tiers = [...plan.tiers].sort((a, b) => a.from - b.from);
  for (const t of tiers) {
    const inTier = base >= t.from && (t.to === undefined || base < t.to);
    if (inTier) {
      if (t.bonus) bonus = t.bonus;
      if (t.pctOver) bonus = round((base - t.from) * (t.pctOver / 100));
    }
  }
  const upcoming = tiers.find((t) => base < t.from);
  if (upcoming) {
    nextTier = {
      missing: round(upcoming.from - base),
      description: upcoming.bonus ? `bônus de R$ ${upcoming.bonus}` : `${upcoming.pctOver}% sobre o excedente`,
    };
  }
  return { base, commission, bonus, total: round(commission + bonus), nextTier };
}

export const DEFAULT_COMMISSION_PLAN: CommissionPlan = {
  ratesByChannel: { POS: 3, WHATSAPP: 3, INSTAGRAM: 3 },
  tiers: [
    { from: 35000, to: 60000, bonus: 200 },
    { from: 60000, pctOver: 1 },
  ],
};
