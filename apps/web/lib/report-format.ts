import { formatBRL, type ReportFieldType } from "@centralops/domain";

/** Valor de uma célula de relatório como aparece na tela (o CSV usa os valores crus). */
export function formatReportCell(type: ReportFieldType | "text" | undefined, v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean" || type === "boolean") return v === true || v === "true" ? "sim" : "não";
  switch (type) {
    case "money": return formatBRL(Number(v));
    case "percent": return `${Number(v).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%`;
    case "date": return String(v).slice(0, 10).split("-").reverse().join("/");
    case "month": { const [y, m] = String(v).split("-"); return m ? `${m}/${y}` : String(v); }
    case "number": return Number(v).toLocaleString("pt-BR", { maximumFractionDigits: 2 });
    default: return typeof v === "number" ? v.toLocaleString("pt-BR") : String(v);
  }
}
