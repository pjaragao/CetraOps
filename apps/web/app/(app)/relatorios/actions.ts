"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { normalizeSpec, type ReportSpec } from "@centralops/domain";
import type { Json } from "@centralops/db";
import { createClient } from "@/lib/supabase/server";
import { can, getSession } from "@/lib/session";
import { draftReport, type ReportDraft } from "@/lib/central/report-ai";
import { friendly, loadCatalog, runReport, type ReportResult } from "@/lib/reports";

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const PREVIEW_ROWS = 200;

/** Monta (ou ajusta) o relatório a partir do pedido em português. */
export async function draftReportAction(prompt: string, current: ReportSpec | null): Promise<{ draft?: ReportDraft; error?: string }> {
  const text = String(prompt ?? "").trim();
  if (text.length < 4) return { error: "Descreva o relatório que você quer ver." };
  if (text.length > 2000) return { error: "Pedido longo demais (até 2.000 letras)." };
  const session = await getSession();
  if (!can(session, "ai.assistant")) return { error: "Seu perfil não usa a IA (Central). Monte o relatório à mão abaixo." };
  const supabase = await createClient();
  try {
    return { draft: await draftReport(supabase, await loadCatalog(supabase), text, current) };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/** Prévia na tela do construtor (até 200 linhas), na loja escolhida no topo. */
export async function previewReportAction(raw: unknown, from: string, to: string): Promise<{ result?: ReportResult; problems?: string[]; error?: string }> {
  if (!ISO.test(from) || !ISO.test(to)) return { error: "Período inválido" };
  const supabase = await createClient();
  const { spec, problems } = normalizeSpec(raw, await loadCatalog(supabase));
  if (!spec) return { error: problems.join(" ") };
  const session = await getSession();
  try {
    return { result: await runReport(supabase, { ...spec, limit: Math.min(spec.limit ?? PREVIEW_ROWS, PREVIEW_ROWS) }, { from, to, store: session.storeId }), problems };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/** Salva (cria ou altera) e abre o relatório. */
export async function saveReportAction(p: { id?: string; title: string; description?: string; prompt?: string; spec: unknown }): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { spec, problems } = normalizeSpec(p.spec, await loadCatalog(supabase));
  if (!spec) return { error: problems.join(" ") };
  const { data, error } = await supabase.schema("core").rpc("report_save", {
    p: { id: p.id || null, title: p.title, description: p.description ?? null, prompt: p.prompt ?? null, spec } as unknown as Json,
  });
  if (error) return { error: friendly(error.message) };
  revalidatePath("/relatorios", "layout");
  redirect(`/relatorios/${data}?ok=${encodeURIComponent(p.id ? "Relatório atualizado." : "Relatório salvo. Ele aparece na lista para toda a equipe que tem acesso a esses dados.")}`);
}

export async function archiveReportAction(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  const supabase = await createClient();
  const { error } = await supabase.schema("core").rpc("report_archive", { p_id: id });
  if (error) redirect(`/relatorios/${id}?erro=${encodeURIComponent(friendly(error.message))}`);
  revalidatePath("/relatorios", "layout");
  redirect(`/relatorios?ok=${encodeURIComponent("Relatório excluído.")}`);
}
