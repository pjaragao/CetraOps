"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { Json } from "@centralops/db";
import { createClient } from "@/lib/supabase/server";
import { getSession } from "@/lib/session";

export type State = { ok: boolean; error?: string; message?: string } | null;

const friendly = (m: string) => m.replace(/^ERROR:\s*/, "");
const str = (v: FormDataEntryValue | null) => String(v ?? "").trim();
const num = (v: FormDataEntryValue | null) => Number(String(v ?? "").replace(/\./g, "").replace(",", "."));

function back(path: string, params: Record<string, string | undefined> = {}): never {
  const q = Object.entries(params).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v!)}`).join("&");
  redirect(q ? `${path}${path.includes("?") ? "&" : "?"}${q}` : path);
}
const refresh = () => { revalidatePath("/financeiro", "layout"); revalidatePath("/configuracoes", "layout"); };

// ---------------------------------------------------------------------
// Recorrências
// ---------------------------------------------------------------------
const recurringSchema = z.object({
  legal_entity_id: z.string().uuid(), description: z.string().min(2).max(120), amount: z.number().positive(), day_of_month: z.number().int().min(1).max(28),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  direction: z.enum(["PAYABLE", "RECEIVABLE"]).default("PAYABLE"), party_id: z.string().uuid().optional(), chart_account_id: z.string().uuid().optional(),
  cost_center_id: z.string().uuid().optional(), allocation_template_id: z.string().uuid().optional(), auto_approve: z.boolean().optional(),
});

export async function saveRecurringAction(_prev: State, formData: FormData): Promise<State> {
  const opt = (k: string) => str(formData.get(k)) || undefined;
  const parsed = recurringSchema.safeParse({
    legal_entity_id: opt("legal_entity_id"), description: opt("description"), amount: num(formData.get("amount")), day_of_month: Number(opt("day_of_month")),
    start_date: opt("start_date"), end_date: opt("end_date"), direction: opt("direction") ?? "PAYABLE", party_id: opt("party_id"), chart_account_id: opt("chart_account_id"),
    cost_center_id: opt("cost_center_id"), allocation_template_id: opt("allocation_template_id"), auto_approve: formData.get("auto_approve") === "on",
  });
  if (!parsed.success) return { ok: false, error: `Confira os campos: ${parsed.error.issues[0]?.path.join(".")} — ${parsed.error.issues[0]?.message}` };
  const supabase = await createClient();
  const { error } = await supabase.schema("fin").rpc("save_recurring", { p: parsed.data as unknown as Json });
  if (error) return { ok: false, error: friendly(error.message) };
  refresh();
  return { ok: true, message: "Recorrência criada" };
}

export async function runRecurringAction(formData: FormData) {
  const supabase = await createClient();
  const until = str(formData.get("until"));
  const { data, error } = await supabase.schema("fin").rpc("run_recurring", until ? { p_until: until } : {});
  refresh();
  back("/financeiro/recorrentes", error ? { erro: friendly(error.message) } : { ok: `${data} título(s) gerado(s)` });
}

export async function toggleRecurringAction(formData: FormData) {
  const supabase = await createClient();
  await supabase.schema("fin").from("recurring_templates").update({ active: formData.get("active") === "1" }).eq("id", str(formData.get("id")));
  refresh();
  back("/financeiro/recorrentes", { ok: "Recorrência atualizada" });
}

// ---------------------------------------------------------------------
// Orçamento
// ---------------------------------------------------------------------
const budgetSchema = z.object({
  id: z.string().uuid().optional(), legal_entity_id: z.string().uuid(), year: z.number().int().min(2020).max(2100),
  name: z.string().max(80).optional(), scenario: z.enum(["BASE", "OPTIMISTIC", "PESSIMISTIC"]).default("BASE"), replace: z.boolean().optional(),
  lines: z.array(z.object({ chart_account_id: z.string().uuid(), month: z.number().int().min(1).max(12), amount: z.number().min(0).max(100_000_000) })).max(2000),
});

/** Salva a grade do orçamento (conta × mês). Substitui as linhas quando `replace`. */
export async function saveBudgetAction(_prev: State, formData: FormData): Promise<State> {
  let raw: unknown;
  try { raw = JSON.parse(String(formData.get("payload") ?? "")); } catch { return { ok: false, error: "Dados inválidos" }; }
  const parsed = budgetSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: `Confira o orçamento: ${parsed.error.issues[0]?.path.join(".")} — ${parsed.error.issues[0]?.message}` };
  const supabase = await createClient();
  const { data, error } = await supabase.schema("fin").rpc("save_budget", { p: { ...parsed.data, lines: parsed.data.lines.filter((l) => l.amount !== 0) } as unknown as Json });
  if (error) return { ok: false, error: friendly(error.message) };
  refresh();
  const b = data as unknown as { id: string; year: number };
  return back(`/financeiro/orcamento?ano=${b.year}&orc=${b.id}`, { ok: "Orçamento salvo" });
}

/** Importa CSV (código;jan;fev;...;dez) para um orçamento novo ou existente. */
export async function importBudgetCsvAction(formData: FormData) {
  const supabase = await createClient();
  const entity = str(formData.get("legal_entity_id"));
  const year = Number(str(formData.get("year")));
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) back("/financeiro/orcamento", { ano: String(year), erro: "Escolha o arquivo CSV" });
  const text = (await (file as File).text()).replace(/^﻿/, "");
  const rows = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const sep = rows[0]?.includes(";") ? ";" : ",";
  const lines: { code: string; month: number; amount: number }[] = [];
  for (const [ri, row] of rows.entries()) {
    const cols = row.split(sep).map((c) => c.trim().replace(/^"|"$/g, ""));
    if (ri === 0 && !/^\d/.test(cols[0] ?? "")) continue;       // cabeçalho
    const code = cols[0];
    for (let m = 1; m <= 12; m++) {
      const raw = (cols[m] ?? "").replace(/[R$\s]/g, "");
      if (!raw) continue;
      const n = Number(raw.includes(",") ? raw.replace(/\./g, "").replace(",", ".") : raw);
      if (Number.isFinite(n) && n !== 0) lines.push({ code, month: m, amount: n });
    }
  }
  if (lines.length === 0) back("/financeiro/orcamento", { ano: String(year), erro: "Nenhum valor encontrado: use código da conta na 1ª coluna e 12 meses nas seguintes" });
  const { data, error } = await supabase.schema("fin").rpc("save_budget", { p: { legal_entity_id: entity, year, name: `Orçamento ${year} (importado)`, lines } as unknown as Json });
  refresh();
  if (error) back("/financeiro/orcamento", { ano: String(year), erro: friendly(error.message) });
  const b = data as unknown as { id: string };
  back("/financeiro/orcamento", { ano: String(year), orc: b.id, ok: `${lines.length} valores importados` });
}

export async function budgetStatusAction(formData: FormData) {
  const supabase = await createClient();
  const id = str(formData.get("budget_id"));
  const { error } = await supabase.schema("fin").rpc("set_budget_status", { p_budget: id, p_status: str(formData.get("status")) });
  refresh();
  back("/financeiro/orcamento", { ano: str(formData.get("year")), orc: id, ...(error ? { erro: friendly(error.message) } : { ok: "Situação do orçamento atualizada" }) });
}

// ---------------------------------------------------------------------
// Fechamento
// ---------------------------------------------------------------------
export async function closeMonthAction(formData: FormData) {
  const supabase = await createClient();
  const entity = str(formData.get("entity")), mes = str(formData.get("mes"));
  const { error } = await supabase.schema("fin").rpc("close_month", { p_entity: entity, p_competence: `${mes}-01`, p_force: formData.get("force") === "on" });
  refresh();
  back("/financeiro/fechamento", { mes, entity, ...(error ? { erro: friendly(error.message) } : { ok: `Mês ${mes.split("-").reverse().join("/")} fechado` }) });
}

export async function reopenMonthAction(formData: FormData) {
  const supabase = await createClient();
  const entity = str(formData.get("entity")), mes = str(formData.get("mes"));
  const { error } = await supabase.schema("fin").rpc("reopen_month", { p_entity: entity, p_competence: `${mes}-01`, p_reason: str(formData.get("reason")) });
  refresh();
  back("/financeiro/fechamento", { mes, entity, ...(error ? { erro: friendly(error.message) } : { ok: "Período reaberto (o rateio do mês foi estornado)" }) });
}

export async function runAllocationAction(formData: FormData) {
  const supabase = await createClient();
  const entity = str(formData.get("entity")), mes = str(formData.get("mes"));
  const { error } = await supabase.schema("fin").rpc("run_allocation_batch", { p_entity: entity, p_competence: `${mes}-01` });
  refresh();
  back("/financeiro/fechamento", { mes, entity, ...(error ? { erro: friendly(error.message) } : { ok: "Rateio do mês aplicado" }) });
}

export async function reverseAllocationAction(formData: FormData) {
  const supabase = await createClient();
  const entity = str(formData.get("entity")), mes = str(formData.get("mes"));
  const { error } = await supabase.schema("fin").rpc("reverse_allocation_batch", { p_batch: str(formData.get("batch_id")), p_reason: str(formData.get("reason")) || "Estorno manual" });
  refresh();
  back("/financeiro/fechamento", { mes, entity, ...(error ? { erro: friendly(error.message) } : { ok: "Rateio estornado" }) });
}

// ---------------------------------------------------------------------
// Regras de rateio por direcionadores
// ---------------------------------------------------------------------
const ruleSchema = z.object({
  name: z.string().min(2).max(80), method: z.enum(["FIXED_PCT", "REVENUE_SHARE", "GROSS_MARGIN_SHARE", "ORDERS_COUNT", "HEADCOUNT", "AREA_M2"]),
  source_cost_center_id: z.string().uuid(), targets: z.array(z.object({ cost_center_id: z.string().uuid(), pct: z.number().positive().max(100).optional() })).min(2).max(12),
  legal_entity_id: z.string().uuid().optional(), notes: z.string().max(300).optional(),
});

export async function createAllocationRuleAction(_prev: State, formData: FormData): Promise<State> {
  const session = await getSession();
  const targets: { cost_center_id: string; pct?: number }[] = [];
  for (let i = 0; i < 8; i++) {
    const cc = str(formData.get(`cc_${i}`));
    if (!cc) continue;
    const pct = num(formData.get(`pct_${i}`));
    targets.push({ cost_center_id: cc, ...(pct > 0 ? { pct } : {}) });
  }
  const method = str(formData.get("method"));
  const parsed = ruleSchema.safeParse({ name: str(formData.get("name")), method, source_cost_center_id: str(formData.get("source")), targets,
    legal_entity_id: str(formData.get("legal_entity_id")) || undefined, notes: str(formData.get("notes")) || undefined });
  if (!parsed.success) return { ok: false, error: `Confira a regra: ${parsed.error.issues[0]?.path.join(".")} — ${parsed.error.issues[0]?.message}` };
  if (method === "FIXED_PCT") {
    const sum = targets.reduce((s, t) => s + (t.pct ?? 0), 0);
    if (Math.abs(sum - 100) > 0.0001) return { ok: false, error: `Os percentuais somam ${sum.toFixed(2).replace(".", ",")}% (precisa fechar 100%)` };
  }
  const supabase = await createClient();
  const p = parsed.data;
  const { error } = await supabase.schema("fin").from("allocation_rules").insert({
    org_id: session.orgId, name: p.name, method: p.method, source_cost_center_id: p.source_cost_center_id, targets: p.targets as unknown as NonNullable<Json>,
    legal_entity_id: p.legal_entity_id ?? null, notes: p.notes ?? null,
  });
  if (error) return { ok: false, error: friendly(error.message) };
  refresh();
  return { ok: true, message: "Regra criada: será aplicada no fechamento dos próximos meses" };
}

export async function toggleAllocationRuleAction(formData: FormData) {
  const supabase = await createClient();
  await supabase.schema("fin").from("allocation_rules").update({ active: formData.get("active") === "1" }).eq("id", str(formData.get("id")));
  refresh();
  back("/configuracoes/rateios", { ok: "Regra atualizada" });
}
