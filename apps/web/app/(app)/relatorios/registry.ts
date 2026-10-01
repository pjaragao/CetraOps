import type { CsvColumn } from "@sie/domain";
import type { createClient } from "@/lib/supabase/server";

type Db = Awaited<ReturnType<typeof createClient>>;
type Row = Record<string, unknown>;
export interface Report {
  title: string;
  description: string;
  perm: "sales.read" | "fin.read";
  /** filtros extras além do período (ex.: agrupar por …) */
  options?: { name: string; label: string; values: [string, string][] };
  columns: CsvColumn<Row>[];
  load: (db: Db, p: { from: string; to: string; option: string }) => Promise<Row[]>;
}


const KIND_LABEL: Record<string, string> = {
  VENDA_SEM_NOTA: "Venda sem nota", NOTA_SEM_VENDA: "Nota sem venda", CARTAO_SEM_ADQUIRENTE: "Cartão sem a maquininha", ADQUIRENTE_SEM_VENDA: "Maquininha sem venda",
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
  cruzamento: {
    title: "Vendas × notas × maquininha", description: "O que não fecha entre o PDV, a nota fiscal e a adquirente: venda paga sem nota, nota sem venda, cartão sem a transação da maquininha e transação sem venda. Cada linha é algo para conferir antes do fechamento.", perm: "fin.read",
    columns: [
      { header: "Tipo", get: (r) => KIND_LABEL[r.kind as string] ?? (r.kind as string) }, { header: "Referência", get: (r) => r.ref as string }, { header: "Data", get: (r) => r.day as string, kind: "date" },
      { header: "Valor", get: (r) => r.amount as number, kind: "money" }, { header: "O que conferir", get: (r) => r.detail as string },
    ],
    load: async (db, p) => ((await db.schema("fin").rpc("report_cross_gaps", { p_from: p.from, p_to: p.to })).data as unknown as Row[]) ?? [],
  },
};
