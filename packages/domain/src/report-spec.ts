/**
 * Relatórios montados pela equipe (motor em core.report_run): o "roteiro" do relatório é só um conjunto de chaves do catálogo
 * (fonte de dados, campos para agrupar, valores, filtros, ordem). Aqui fica a validação que a tela e a IA usam antes de mandar
 * ao banco — o banco valida de novo e é quem manda.
 */

export type ReportFieldType = "text" | "number" | "money" | "percent" | "date" | "month" | "boolean";
export type ReportFieldRole = "dimension" | "measure";

export interface ReportField {
  key: string;
  label: string;
  role: ReportFieldRole;
  type: ReportFieldType;
  description: string | null;
}

export interface ReportDataset {
  key: string;
  label: string;
  description: string;
  area: string;
  perm: string;
  date_label: string | null;
  has_period: boolean;
  has_store: boolean;
  fields: ReportField[];
}

export type ReportFilterOp = "eq" | "neq" | "contains" | "gt" | "gte" | "lt" | "lte" | "in" | "not_in" | "empty" | "not_empty";

export interface ReportFilter {
  field: string;
  op: ReportFilterOp;
  value?: string | null;
  values?: string[];
}

export interface ReportSpec {
  dataset: string;
  dimensions: string[];
  measures: string[];
  filters: ReportFilter[];
  sort?: { field: string; dir: "asc" | "desc" } | null;
  limit?: number;
  use_period?: boolean;
}

export const REPORT_LIMITS = { dimensions: 4, measures: 16, filters: 12, maxRows: 5000, defaultRows: 500 } as const;

export const FILTER_OP_LABEL: Record<ReportFilterOp, string> = {
  eq: "é igual a", neq: "é diferente de", contains: "contém", gt: "maior que", gte: "maior ou igual a", lt: "menor que", lte: "menor ou igual a",
  in: "é um destes", not_in: "não é nenhum destes", empty: "está vazio", not_empty: "está preenchido",
};

/** Operadores que fazem sentido para cada tipo de campo (o banco recusa os outros). */
export function filterOpsFor(type: ReportFieldType): ReportFilterOp[] {
  switch (type) {
    case "text": return ["eq", "neq", "contains", "in", "not_in", "empty", "not_empty"];
    case "month": return ["eq", "neq", "gt", "gte", "lt", "lte", "in", "not_in", "empty", "not_empty"];
    case "boolean": return ["eq", "neq"];
    default: return ["eq", "neq", "gt", "gte", "lt", "lte", "empty", "not_empty"];
  }
}

export const opNeedsValue = (op: ReportFilterOp) => op !== "empty" && op !== "not_empty";
export const opTakesList = (op: ReportFilterOp) => op === "in" || op === "not_in";

const str = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" || typeof v === "boolean" ? String(v) : "");
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/**
 * Confere um roteiro (da tela ou da IA) contra o catálogo que a pessoa pode ver: descarta o que não existe ou não cabe,
 * explica em `problems` o que foi ajustado e devolve `spec: null` se não sobrar um relatório que rode.
 */
export function normalizeSpec(raw: unknown, catalog: ReportDataset[]): { spec: ReportSpec | null; problems: string[] } {
  const problems: string[] = [];
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const ds = catalog.find((d) => d.key === str(r.dataset));
  if (!ds) return { spec: null, problems: [`Fonte de dados desconhecida ou sem acesso: «${str(r.dataset) || "vazia"}».`] };
  const field = (key: string, role?: ReportFieldRole) => ds.fields.find((f) => f.key === key && (!role || f.role === role));

  const pick = (values: unknown, role: ReportFieldRole, max: number, what: string) => {
    const out: string[] = [];
    for (const v of list(values)) {
      const key = str(v);
      if (!key || out.includes(key)) continue;
      if (!field(key, role)) { problems.push(`«${key}» não existe em ${ds.label} como ${what}; foi tirado.`); continue; }
      if (out.length >= max) { problems.push(`No máximo ${max} campos em ${what}; «${field(key)!.label}» ficou de fora.`); continue; }
      out.push(key);
    }
    return out;
  };
  const dimensions = pick(r.dimensions, "dimension", REPORT_LIMITS.dimensions, "agrupar por");
  const measures = pick(r.measures, "measure", REPORT_LIMITS.measures, "valores");

  const filters: ReportFilter[] = [];
  for (const raw of list(r.filters)) {
    const f = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const fd = field(str(f.field));
    if (!fd) { problems.push(`Filtro com campo desconhecido «${str(f.field)}» foi tirado.`); continue; }
    const op = (str(f.op) || "eq") as ReportFilterOp;
    if (!filterOpsFor(fd.type).includes(op)) { problems.push(`O filtro de «${fd.label}» não aceita «${FILTER_OP_LABEL[op] ?? op}»; foi tirado.`); continue; }
    if (filters.length >= REPORT_LIMITS.filters) { problems.push(`No máximo ${REPORT_LIMITS.filters} filtros.`); break; }
    if (!opNeedsValue(op)) { filters.push({ field: fd.key, op }); continue; }
    if (opTakesList(op)) {
      const values = [...new Set(list(f.values).map(str).filter(Boolean))];
      if (!values.length) { problems.push(`O filtro de «${fd.label}» ficou sem valores; foi tirado.`); continue; }
      filters.push({ field: fd.key, op, values });
      continue;
    }
    const value = str(f.value);
    if (!value) { problems.push(`O filtro de «${fd.label}» ficou sem valor; foi tirado.`); continue; }
    if (["number", "money", "percent"].includes(fd.type) && Number.isNaN(Number(value.replace(",", ".")))) { problems.push(`O filtro de «${fd.label}» precisa de um número.`); continue; }
    if (fd.type === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) { problems.push(`O filtro de «${fd.label}» precisa de uma data AAAA-MM-DD.`); continue; }
    if (fd.type === "month" && !/^\d{4}-\d{2}$/.test(value)) { problems.push(`O filtro de «${fd.label}» precisa de um mês AAAA-MM.`); continue; }
    filters.push({ field: fd.key, op, value });
  }

  if (!dimensions.length && !measures.length) {
    problems.push("Escolha ao menos um campo para agrupar ou um valor.");
    return { spec: null, problems };
  }

  const s = (r.sort && typeof r.sort === "object" ? r.sort : {}) as Record<string, unknown>;
  let sort: ReportSpec["sort"] = null;
  if (str(s.field)) {
    if ([...dimensions, ...measures].includes(str(s.field))) sort = { field: str(s.field), dir: str(s.dir) === "asc" ? "asc" : "desc" };
    else problems.push(`A ordem usa «${str(s.field)}», que não está no relatório; volta para a ordem padrão.`);
  }
  const n = Math.round(Number(r.limit));
  const limit = Number.isFinite(n) && n > 0 ? Math.min(n, REPORT_LIMITS.maxRows) : REPORT_LIMITS.defaultRows;
  const spec: ReportSpec = { dataset: ds.key, dimensions, measures, filters, sort, limit };
  if (ds.has_period && r.use_period === false) spec.use_period = false;
  return { spec, problems };
}

/** Texto curto do que o relatório mostra ("Receita e Pedidos por Canal, Mês"), para a lista e o título sugerido. */
export function describeSpec(spec: ReportSpec, ds: ReportDataset): string {
  const label = (k: string) => ds.fields.find((f) => f.key === k)?.label ?? k;
  const m = spec.measures.map(label);
  const d = spec.dimensions.map(label);
  const what = m.length ? m.join(", ") : d.join(", ");
  return m.length && d.length ? `${what} por ${d.join(", ").toLowerCase()}` : what;
}
