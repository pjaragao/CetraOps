import type { CsvColumn } from "@centralops/domain";
import type { createClient } from "@/lib/supabase/server";

type Db = Awaited<ReturnType<typeof createClient>>;
type Row = Record<string, unknown>;
export interface Report {
  title: string;
  description: string;
  perm: "sales.read" | "fin.read" | "crm.read" | "omni.read";
  /** filtros extras além do período (ex.: agrupar por …) */
  options?: { name: string; label: string; values: [string, string][] };
  columns: CsvColumn<Row>[];
  load: (db: Db, p: { from: string; to: string; option: string }) => Promise<Row[]>;
}


const KIND_LABEL: Record<string, string> = {
  VENDA_SEM_NOTA: "Venda sem nota", NOTA_SEM_VENDA: "Nota sem venda", CARTAO_SEM_ADQUIRENTE: "Cartão sem a maquininha", ADQUIRENTE_SEM_VENDA: "Maquininha sem venda",
};

const RECOVERY_LABEL: Record<string, string> = {
  RESERVATION_EXPIRING: "Lembrete de reserva vencendo", PAYMENT_LINK_REMINDER: "Lembrete de link de pagamento", LINK_EXPIRED: "Link vencido (tarefa)",
  ORDER_EXPIRED: "Pedido expirado (tarefa)", LOCKER_RETURNED: "Armário devolvido (tarefa)", LOCKER_PARTIAL: "Armário: levou parte (tarefa)", LOCKER_EXPIRED: "Armário vencido (tarefa)",
};

export const REPORTS: Record<string, Report> = {
  vendas: {
    title: "Vendas", description: "Receita, descontos, ticket médio e margem sobre o custo registrado, por canal, vendedor, dia ou mês. Só pedidos pagos.", perm: "sales.read",
    options: { name: "agrupar", label: "Agrupar por", values: [["channel", "Canal"], ["seller", "Vendedor"], ["day", "Dia"], ["month", "Mês"]] },
    columns: [
      { header: "Grupo", get: (r) => r.label as string }, { header: "Pedidos", get: (r) => r.orders as number }, { header: "Receita", get: (r) => r.revenue as number, kind: "money" },
      { header: "Descontos", get: (r) => r.discount as number, kind: "money" }, { header: "Ticket médio", get: (r) => r.avg_ticket as number, kind: "money" },
      { header: "Margem", get: (r) => r.margin as number, kind: "money" }, { header: "Margem %", get: (r) => (r.margin_pct as number | null) ?? "" },
    ],
    load: async (db, p) => ((await db.schema("sales").rpc("report_sales", { p_from: p.from, p_to: p.to, p_group: p.option || "channel" })).data as unknown as Row[]) ?? [],
  },
  "curva-abc": {
    title: "Curva ABC", description: "Quais produtos, tamanhos ou categorias respondem pela receita: A = os que somam 80%, B = até 95%, C = o resto. Ajuda a decidir reposição e o que sai de linha.", perm: "sales.read",
    options: { name: "agrupar", label: "Agrupar por", values: [["product", "Produto"], ["size", "Tamanho"], ["category", "Categoria"]] },
    columns: [
      { header: "Item", get: (r) => r.label as string }, { header: "Quantidade", get: (r) => r.qty as number }, { header: "Receita", get: (r) => r.revenue as number, kind: "money" },
      { header: "% da receita", get: (r) => r.share_pct as number }, { header: "% acumulado", get: (r) => r.cumulative_pct as number }, { header: "Classe", get: (r) => r.class as string },
    ],
    load: async (db, p) => ((await db.schema("sales").rpc("report_abc", { p_from: p.from, p_to: p.to, p_by: p.option || "product" })).data as unknown as Row[]) ?? [],
  },
  "vendas-recuperadas": {
    title: "Vendas recuperadas", description: "Vendas que voltaram depois de um lembrete de reserva ou de link, ou de uma tarefa de retomada (link vencido, pedido expirado, armário devolvido). Conta a primeira venda paga da cliente até 7 dias depois.", perm: "sales.read",
    columns: [
      { header: "Tipo", get: (r) => RECOVERY_LABEL[r.kind as string] ?? (r.kind as string) }, { header: "Tentativas", get: (r) => r.attempts as number },
      { header: "Recuperadas", get: (r) => r.recovered as number }, { header: "Receita", get: (r) => r.revenue as number, kind: "money" },
    ],
    load: async (db, p) => ((await db.schema("sales").rpc("report_recovered", { p_from: p.from, p_to: p.to })).data as unknown as Row[]) ?? [],
  },
  cruzamento: {
    title: "Vendas × notas × maquininha", description: "O que não fecha entre o PDV, a nota fiscal e a adquirente: venda paga sem nota, nota sem venda, cartão sem a transação da maquininha e transação sem venda. Cada linha é algo para conferir antes do fechamento.", perm: "fin.read",
    columns: [
      { header: "Tipo", get: (r) => KIND_LABEL[r.kind as string] ?? (r.kind as string) }, { header: "Referência", get: (r) => r.ref as string }, { header: "Data", get: (r) => r.day as string, kind: "date" },
      { header: "Valor", get: (r) => r.amount as number, kind: "money" }, { header: "O que conferir", get: (r) => r.detail as string },
    ],
    load: async (db, p) => ((await db.schema("fin").rpc("report_cross_gaps", { p_from: p.from, p_to: p.to })).data as unknown as Row[]) ?? [],
  },
  aquisicao: {
    title: "Aquisição por origem", description: "De onde vêm as clientes novas: leads criadas no período, quantas compraram em até 30 dias, a conversão, a receita da 1ª compra e o tempo até comprar. A origem vem do link rastreado, do anúncio ou do canal. Para anúncios, mostra o investimento e o custo por cliente.", perm: "crm.read",
    columns: [
      { header: "Origem", get: (r) => r.source as string }, { header: "Leads", get: (r) => r.leads as number }, { header: "Compraram", get: (r) => r.buyers as number },
      { header: "Conversão %", get: (r) => (r.conversion_pct as number | null) ?? "" }, { header: "Receita 1ª compra", get: (r) => r.revenue as number, kind: "money" },
      { header: "Dias até comprar", get: (r) => (r.avg_days_to_buy as number | null) ?? "" }, { header: "Investimento", get: (r) => (r.ad_spend as number | null) ?? "", kind: "money" },
      { header: "Custo por cliente", get: (r) => (r.cost_per_customer as number | null) ?? "", kind: "money" },
    ],
    load: async (db, p) => ((await db.schema("crm").rpc("report_acquisition", { p_from: p.from, p_to: p.to })).data as unknown as Row[]) ?? [],
  },
  coortes: {
    title: "Recompra por coorte", description: "Das clientes que fizeram a 1ª compra em cada mês, quantas voltaram a comprar em 30, 60, 90 e 180 dias. Meses ainda sem esse prazo aparecem em branco. O período escolhido não se aplica: mostra os últimos 12 meses.", perm: "sales.read",
    columns: [
      { header: "Mês da 1ª compra", get: (r) => r.cohort as string }, { header: "Clientes", get: (r) => r.customers as number }, { header: "Voltaram em 30 dias %", get: (r) => (r.back_30 as number | null) ?? "" },
      { header: "60 dias %", get: (r) => (r.back_60 as number | null) ?? "" }, { header: "90 dias %", get: (r) => (r.back_90 as number | null) ?? "" }, { header: "180 dias %", get: (r) => (r.back_180 as number | null) ?? "" },
    ],
    load: async (db) => ((await db.schema("sales").rpc("report_cohorts", { p_months: 12 })).data as unknown as Row[]) ?? [],
  },
  reguas: {
    title: "Desempenho das réguas", description: "Para cada régua: quantas clientes entraram, quantas ficaram no grupo de controle (não receberam as mensagens) e a diferença de recompra em 30 dias. Esse ganho em pontos percentuais é o resultado real da régua.", perm: "crm.read",
    columns: [
      { header: "Régua", get: (r) => r.journey as string }, { header: "Entraram", get: (r) => r.enrolled as number }, { header: "Receberam", get: (r) => r.treatment as number }, { header: "Controle", get: (r) => r.holdout as number },
      { header: "Compra (receberam) %", get: (r) => (r.treatment_rate as number | null) ?? "" }, { header: "Compra (controle) %", get: (r) => (r.holdout_rate as number | null) ?? "" },
      { header: "Ganho (p.p.)", get: (r) => (r.lift_pp as number | null) ?? "" }, { header: "Receita", get: (r) => r.revenue as number, kind: "money" },
    ],
    load: async (db, p) => ((await db.schema("mkt").rpc("report_journeys", { p_from: p.from, p_to: p.to })).data as unknown as Row[]) ?? [],
  },
  satisfacao: {
    title: "Satisfação (CSAT e NPS)", description: "Por mês: perguntas enviadas e respondidas, nota média do atendimento (1 a 5) e o NPS (promotoras menos detratoras, de -100 a 100).", perm: "omni.read",
    columns: [
      { header: "Mês", get: (r) => r.month as string }, { header: "CSAT enviadas", get: (r) => r.csat_asked as number }, { header: "CSAT respondidas", get: (r) => r.csat_answered as number },
      { header: "Nota média", get: (r) => (r.csat_avg as number | null) ?? "" }, { header: "NPS enviadas", get: (r) => r.nps_asked as number }, { header: "NPS respondidas", get: (r) => r.nps_answered as number },
      { header: "NPS", get: (r) => (r.nps as number | null) ?? "" },
    ],
    load: async (db, p) => ((await db.schema("omni").rpc("report_satisfaction", { p_from: p.from, p_to: p.to })).data as unknown as Row[]) ?? [],
  },
  perdas: {
    title: "Motivos de perda", description: "Por que as oportunidades foram perdidas no período e quantas dessas clientes compraram depois, mostrando o que ainda dá para recuperar.", perm: "crm.read",
    columns: [
      { header: "Motivo", get: (r) => r.reason as string }, { header: "Perdidas", get: (r) => r.lost as number }, { header: "Compraram depois", get: (r) => r.bought_later as number }, { header: "Recuperadas %", get: (r) => (r.recovered_pct as number | null) ?? "" },
    ],
    load: async (db, p) => ((await db.schema("crm").rpc("report_lost_reasons", { p_from: p.from, p_to: p.to })).data as unknown as Row[]) ?? [],
  },
};
