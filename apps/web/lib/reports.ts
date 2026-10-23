import "server-only";
import type { CsvColumn, ReportDataset, ReportFieldType, ReportSpec } from "@centralops/domain";
import type { Json } from "@centralops/db";
import type { createClient } from "@/lib/supabase/server";

/** Motor de relatórios (core.report_run): catálogo das fontes, execução e relatórios salvos pela equipe. */

type Db = Awaited<ReturnType<typeof createClient>>;
export type Row = Record<string, unknown>;
export interface ReportColumn { key: string; label: string; type: ReportFieldType; role: "dimension" | "measure" }
export interface ReportResult { columns: ReportColumn[]; rows: Row[]; truncated: boolean; dataset: string; period: boolean; date_label: string | null }
export interface SavedReport { id: string; title: string; description: string | null; dataset: string; spec: ReportSpec; prompt: string | null; created_by: string | null; updated_at: string }

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const friendly = (m: string) => m.replace(/^ERROR:\s*/, "");

export async function loadCatalog(db: Db): Promise<ReportDataset[]> {
  const { data } = await db.schema("core").rpc("report_catalog");
  return (data as unknown as ReportDataset[] | null) ?? [];
}

export async function runReport(db: Db, spec: ReportSpec, p: { from?: string; to?: string; store?: string | null }): Promise<ReportResult> {
  const { data, error } = await db.schema("core").rpc("report_run", {
    p_spec: spec as unknown as Json, p_from: p.from, p_to: p.to, ...(p.store ? { p_store: p.store } : {}),
  });
  if (error) throw new Error(friendly(error.message));
  return data as unknown as ReportResult;
}

export async function loadSaved(db: Db, id: string): Promise<SavedReport | null> {
  if (!UUID.test(id)) return null;
  const { data } = await db.schema("core").from("saved_reports").select("id, title, description, dataset, spec, prompt, created_by, updated_at").eq("id", id).maybeSingle();
  return (data as unknown as SavedReport | null) ?? null;
}

/** Colunas do resultado → CSV (dinheiro com vírgula, datas dd/mm/aaaa). */
export function csvColumns(columns: ReportColumn[]): CsvColumn<Row>[] {
  return columns.map((c) => ({
    header: c.label,
    get: (r: Row) => (r[c.key] ?? "") as string | number | boolean,
    kind: c.type === "money" ? "money" : c.type === "date" ? "date" : "text",
  }));
}
