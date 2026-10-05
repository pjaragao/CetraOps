"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { Json } from "@centralops/db";
import { createClient } from "@/lib/supabase/server";
import { getSession } from "@/lib/session";

export type State = { ok: boolean; error?: string; message?: string } | null;

const friendly = (m: string) => m.replace(/^ERROR:\s*/, "");
const num = (v: FormDataEntryValue | null) => Number(String(v ?? "").replace(/\./g, "").replace(",", "."));
const str = (v: FormDataEntryValue | null) => String(v ?? "").trim();
const opt = (v: FormDataEntryValue | null) => str(v) || undefined;
const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

function back(path: string, params: Record<string, string | undefined> = {}): never {
  const q = Object.entries(params).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v!)}`).join("&");
  redirect(q ? `${path}${path.includes("?") ? "&" : "?"}${q}` : path);
}

/** Chama uma RPC do schema hr/comm e volta para a página com mensagem. */
async function call(schema: "hr" | "comm" | "fin", fn: string, args: Record<string, unknown>, path: string, okMsg: string, extra: Record<string, string | undefined> = {}) {
  const supabase = await createClient();
  const { error } = await (supabase.schema(schema) as unknown as { rpc: (n: string, a: unknown) => Promise<{ error: { message: string } | null }> }).rpc(fn, args);
  revalidatePath("/equipe", "layout");
  revalidatePath("/financeiro", "layout");
  revalidatePath("/fiscal", "layout");
  return back(path, error ? { ...extra, erro: friendly(error.message) } : { ...extra, ok: okMsg });
}

// ---------------------------------------------------------------------
// Admissão
// ---------------------------------------------------------------------
const employeeSchema = z.object({
  legal_entity_id: uuid, store_id: z.string().uuid().optional(), name: z.string().min(3).max(120), cpf: z.string().min(11).max(14),
  birth_date: date.optional(), phone: z.string().max(20).optional(), email: z.string().email().optional(),
  contract_type: z.enum(["CLT", "ESTAGIO", "APRENDIZ", "INTERMITENTE", "TEMPORARIO", "PRO_LABORE", "AUTONOMO"]),
  job_title: z.string().min(2).max(80), cbo: z.string().max(10).optional(), department: z.string().max(60).optional(),
  hire_date: date, salary: z.number().positive(), salary_unit: z.enum(["MONTH", "HOUR"]).default("MONTH"),
  weekly_hours: z.number().min(1).max(48).optional(), work_regime: z.enum(["6X1", "5X2", "12X36", "INTERMITTENT", "CUSTOM"]).default("6X1"),
  experience_days: z.array(z.number().int().positive()).max(2).optional(),
  commissioned: z.boolean().optional(), track_time: z.boolean().optional(), time_bank: z.boolean().optional(), fgts: z.boolean().optional(),
  pis: z.string().max(14).optional(), ctps: z.string().max(30).optional(), rg: z.string().max(20).optional(), mother_name: z.string().max(120).optional(),
  marital_status: z.string().max(20).optional(),
  bank_code: z.string().max(4).optional(), bank_agency: z.string().max(10).optional(), bank_account: z.string().max(20).optional(), pix_key: z.string().max(80).optional(),
  address: z.record(z.string(), z.string()).optional(),
  dependents: z.array(z.object({ name: z.string().min(2), birth_date: date.optional(), relationship: z.string().default("FILHO"), irrf: z.boolean().default(true), family_allowance: z.boolean().default(false) })).max(10).optional(),
  benefits: z.array(z.object({ code: z.string(), value: z.number().nonnegative() })).max(6).optional(),
});

export async function createEmployeeAction(_prev: State, formData: FormData): Promise<State> {
  let raw: unknown;
  try { raw = JSON.parse(String(formData.get("payload") ?? "")); } catch { return { ok: false, error: "Dados inválidos" }; }
  const parsed = employeeSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: `Confira a admissão: ${parsed.error.issues[0]?.path.join(".")} — ${parsed.error.issues[0]?.message}` };
  const { benefits, ...payload } = parsed.data;
  const supabase = await createClient();
  const { data, error } = await supabase.schema("hr").rpc("create_employee", { p: payload as unknown as Json });
  if (error) return { ok: false, error: friendly(error.message) };
  const emp = data as unknown as { id: string; org_id: string };
  if (benefits?.length) {
    const { data: types } = await supabase.schema("hr").from("benefit_types").select("id, code").in("code", benefits.map((b) => b.code));
    const rows = benefits.filter((b) => b.value > 0).flatMap((b) => {
      const t = types?.find((x) => x.code === b.code);
      return t ? [{ org_id: emp.org_id, employee_id: emp.id, benefit_type_id: t.id, value: b.value, start_date: payload.hire_date }] : [];
    });
    if (rows.length) await supabase.schema("hr").from("employee_benefits").insert(rows);
  }
  revalidatePath("/equipe", "layout");
  return back(`/equipe/${emp.id}`, { ok: "Colaborador admitido" });
}

const freelancerSchema = z.object({
  legal_entity_id: uuid, store_id: z.string().uuid().optional(), kind: z.enum(["PJ", "MEI"]), name: z.string().min(3).max(120), cnpj: z.string().min(14).max(18),
  service: z.string().min(3).max(200), work_dates: z.array(date).min(1).max(31), amount: z.number().positive(), due_date: date.optional(),
  document_kind: z.enum(["NFSE", "RECIBO", "NF_MEI"]).optional(), phone: z.string().max(20).optional(), email: z.string().email().optional(),
});

/** Freelancer PJ/MEI: prestador sem vínculo; vira conta a pagar (rascunho). Devolve o alerta de risco quando chamado com frequência. */
export async function engageFreelancerAction(_prev: State, formData: FormData): Promise<State> {
  let raw: unknown;
  try { raw = JSON.parse(String(formData.get("payload") ?? "")); } catch { return { ok: false, error: "Dados inválidos" }; }
  const parsed = freelancerSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: `Confira o cadastro: ${parsed.error.issues[0]?.path.join(".")} — ${parsed.error.issues[0]?.message}` };
  const supabase = await createClient();
  const { data, error } = await supabase.schema("hr").rpc("engage_freelancer", { p: parsed.data as unknown as Json });
  if (error) return { ok: false, error: friendly(error.message) };
  const r = data as unknown as { title_id: string; risk: string | null };
  revalidatePath("/financeiro", "layout");
  return back("/financeiro/pagar", { ok: `Freelancer cadastrado e conta a pagar criada (rascunho: o financeiro aprova).${r.risk ? ` ${r.risk}.` : ""}` });
}

// ---------------------------------------------------------------------
// Ficha do colaborador
// ---------------------------------------------------------------------
export async function changeSalaryAction(formData: FormData) {
  const id = str(formData.get("employee_id"));
  return call("hr", "change_salary", { p_employee: id, p_effective_from: str(formData.get("effective_from")), p_amount: num(formData.get("amount")), p_reason: opt(formData.get("reason")) },
    `/equipe/${id}`, "Salário reajustado");
}

export async function addDependentAction(formData: FormData) {
  const session = await getSession();
  const id = str(formData.get("employee_id"));
  const supabase = await createClient();
  const { error } = await supabase.schema("hr").from("dependents").insert({
    org_id: session.orgId, employee_id: id, name: str(formData.get("name")), cpf: str(formData.get("cpf")).replace(/\D/g, "") || null,
    birth_date: opt(formData.get("birth_date")) ?? null, relationship: str(formData.get("relationship")) || "FILHO",
    irrf: formData.get("irrf") === "on", family_allowance: formData.get("family_allowance") === "on",
  });
  revalidatePath(`/equipe/${id}`);
  back(`/equipe/${id}`, error ? { erro: friendly(error.message) } : { ok: "Dependente adicionado" });
}

export async function removeDependentAction(formData: FormData) {
  const id = str(formData.get("employee_id"));
  const supabase = await createClient();
  await supabase.schema("hr").from("dependents").delete().eq("id", str(formData.get("dependent_id")));
  revalidatePath(`/equipe/${id}`);
  back(`/equipe/${id}`, { ok: "Dependente removido" });
}

export async function addBenefitAction(formData: FormData) {
  const session = await getSession();
  const id = str(formData.get("employee_id"));
  const supabase = await createClient();
  const { error } = await supabase.schema("hr").from("employee_benefits").insert({
    org_id: session.orgId, employee_id: id, benefit_type_id: str(formData.get("benefit_type_id")), value: num(formData.get("value")),
    start_date: str(formData.get("start_date")) || new Date().toISOString().slice(0, 10),
  });
  revalidatePath(`/equipe/${id}`);
  back(`/equipe/${id}`, error ? { erro: friendly(error.message) } : { ok: "Benefício adicionado" });
}

export async function endBenefitAction(formData: FormData) {
  const id = str(formData.get("employee_id"));
  const supabase = await createClient();
  await supabase.schema("hr").from("employee_benefits").update({ end_date: new Date().toISOString().slice(0, 10) }).eq("id", str(formData.get("benefit_id")));
  revalidatePath(`/equipe/${id}`);
  back(`/equipe/${id}`, { ok: "Benefício encerrado" });
}

export async function addLeaveAction(formData: FormData) {
  const id = str(formData.get("employee_id"));
  return call("hr", "add_leave", {
    p: { employee_id: id, kind: str(formData.get("kind")), start_date: str(formData.get("start_date")), end_date: str(formData.get("end_date")) || str(formData.get("start_date")),
      inss_leave: formData.get("inss_leave") === "on", cid: opt(formData.get("cid")), notes: opt(formData.get("notes")) },
  }, `/equipe/${id}`, "Afastamento registrado");
}

export async function addExamAction(formData: FormData) {
  const session = await getSession();
  const id = str(formData.get("employee_id"));
  const supabase = await createClient();
  const { error } = await supabase.schema("hr").from("medical_exams").insert({
    org_id: session.orgId, employee_id: id, kind: str(formData.get("kind")), exam_date: str(formData.get("exam_date")),
    valid_until: opt(formData.get("valid_until")) ?? null, result: opt(formData.get("result")) ?? null,
  });
  revalidatePath(`/equipe/${id}`);
  back(`/equipe/${id}`, error ? { erro: friendly(error.message) } : { ok: "Exame registrado" });
}

// ---------------------------------------------------------------------
// Férias
// ---------------------------------------------------------------------
export async function scheduleVacationAction(formData: FormData) {
  const id = str(formData.get("employee_id"));
  const path = str(formData.get("back")) || `/equipe/${id}`;
  return call("hr", "schedule_vacation", {
    p: { employee_id: id, start_date: str(formData.get("start_date")), days: Number(formData.get("days")), sell_days: Number(formData.get("sell_days") || 0),
      thirteenth_advance: formData.get("thirteenth_advance") === "on", notes: opt(formData.get("notes")) },
  }, path, "Férias programadas");
}

export async function approveVacationAction(formData: FormData) {
  return call("hr", "approve_vacation", { p_vacation: str(formData.get("vacation_id")) }, str(formData.get("back")) || "/equipe/ferias", "Férias aprovadas");
}

export async function cancelVacationAction(formData: FormData) {
  return call("hr", "cancel_vacation", { p_vacation: str(formData.get("vacation_id")), p_reason: opt(formData.get("reason")) }, str(formData.get("back")) || "/equipe/ferias", "Férias canceladas");
}

export async function payVacationAction(formData: FormData) {
  const supabase = await createClient();
  const { data, error } = await supabase.schema("hr").rpc("pay_vacation", { p_vacation: str(formData.get("vacation_id")) });
  revalidatePath("/equipe", "layout");
  if (error) back(str(formData.get("back")) || "/equipe/ferias", { erro: friendly(error.message) });
  back(`/equipe/folha/${(data as unknown as { id: string }).id}`, { ok: "Recibo de férias gerado: confira e aprove" });
}

// ---------------------------------------------------------------------
// Escala e ponto
// ---------------------------------------------------------------------
export async function setRosterCell(employeeId: string, day: string, kind: "WORK" | "DAY_OFF" | "COMP_TIME" | "CLEAR", shiftId?: string): Promise<{ ok: boolean; error?: string }> {
  const parsed = z.object({ e: uuid, d: date, k: z.enum(["WORK", "DAY_OFF", "COMP_TIME", "CLEAR"]), s: uuid.optional() }).safeParse({ e: employeeId, d: day, k: kind, s: shiftId });
  if (!parsed.success) return { ok: false, error: "Parâmetros inválidos" };
  const supabase = await createClient();
  const { error } = await supabase.schema("hr").rpc("set_roster_cell", { p_employee: employeeId, p_date: day, p_kind: kind, p_shift: shiftId });
  return error ? { ok: false, error: friendly(error.message) } : { ok: true };
}

const hhmm = z.string().regex(/^\d{2}:\d{2}$/);

/** Horário livre num dia (sem turno pronto). */
export async function setRosterHours(employeeId: string, day: string, start: string, end: string, breakMin: number, notes: string): Promise<{ ok: boolean; error?: string }> {
  const parsed = z.object({ e: uuid, d: date, s: hhmm, f: hhmm, b: z.number().int().min(0).max(240), n: z.string().max(200) })
    .safeParse({ e: employeeId, d: day, s: start, f: end, b: breakMin, n: notes });
  if (!parsed.success) return { ok: false, error: "Confira os horários (HH:MM) e o intervalo (0 a 240 min)" };
  const supabase = await createClient();
  const { error } = await supabase.schema("hr").rpc("set_roster_hours", { p_employee: employeeId, p_date: day, p_start: start, p_end: end, p_break: breakMin, p_notes: notes || undefined });
  return error ? { ok: false, error: friendly(error.message) } : { ok: true };
}

export async function saveShiftAction(formData: FormData) {
  const path = str(formData.get("back")) || "/equipe/escalas/turnos";
  return call("hr", "save_shift_template", { p: {
    id: opt(formData.get("id")), code: str(formData.get("code")), name: opt(formData.get("name")), start_time: str(formData.get("start_time")),
    end_time: str(formData.get("end_time")), break_minutes: Number(formData.get("break_minutes") || 0), color: opt(formData.get("color")), store_id: opt(formData.get("store_id")),
  } }, path, opt(formData.get("id")) ? "Turno atualizado (a escala em rascunho daqui para frente acompanha o novo horário)" : "Turno criado");
}

export async function toggleShiftAction(formData: FormData) {
  return call("hr", "set_shift_active", { p_id: str(formData.get("id")), p_active: str(formData.get("active")) === "1" }, str(formData.get("back")) || "/equipe/escalas/turnos", "Turno atualizado");
}

export async function deleteShiftAction(formData: FormData) {
  return call("hr", "delete_shift_template", { p_id: str(formData.get("id")) }, str(formData.get("back")) || "/equipe/escalas/turnos", "Turno excluído");
}

export async function saveCoverageAction(formData: FormData) {
  const id = opt(formData.get("id"));
  return call("hr", "save_coverage_rule", { p: {
    id, store_id: str(formData.get("store_id")), label: str(formData.get("label")), start_time: str(formData.get("start_time")), end_time: str(formData.get("end_time")),
    min_staff: Number(formData.get("min_staff") || 1), weekday: opt(formData.get("weekday")), weekdays: formData.getAll("weekdays").map(String),
  } }, str(formData.get("back")) || "/equipe/escalas/turnos", id ? "Janela atualizada" : "Janela de pico criada");
}

export async function deleteCoverageAction(formData: FormData) {
  return call("hr", "delete_coverage_rule", { p_id: str(formData.get("id")) }, str(formData.get("back")) || "/equipe/escalas/turnos", "Janela removida");
}

const RULE_FLAGS = ["rest_11h", "consecutive_days", "daily_max", "break_rule", "weekly_hours", "coverage"] as const;
const RULE_NUMS = ["max_consecutive_days", "daily_warn_minutes", "daily_error_minutes", "min_break_minutes", "break_over_minutes", "short_break_minutes", "short_break_over_minutes"] as const;

const RULE_HOURS = new Set<string>(["daily_warn_minutes", "daily_error_minutes", "break_over_minutes", "short_break_over_minutes"]);   // digitados em horas

/** Regras da escala: liga/desliga e limites (horas digitadas em horas, gravadas em minutos). */
export async function saveScheduleRulesAction(formData: FormData) {
  const p: Record<string, boolean | number> = {};
  for (const k of RULE_FLAGS) p[k] = formData.get(k) === "on";
  for (const k of RULE_NUMS) {
    const raw = str(formData.get(k)).replace(",", ".");
    if (raw === "") continue;
    p[k] = RULE_HOURS.has(k) ? Math.round(Number(raw) * 60) : Number(raw);
  }
  return call("hr", "save_schedule_rules", { p }, str(formData.get("back")) || "/equipe/escalas/turnos", "Regras da escala salvas");
}

export async function setCoverageActiveAction(formData: FormData) {
  return call("hr", "set_coverage_active", { p_id: str(formData.get("id")), p_active: str(formData.get("active")) === "1" }, str(formData.get("back")) || "/equipe/escalas/turnos", "Janela atualizada");
}

/** Escala semanal padrão de um colaborador: d0..d6 = id do turno, "OFF" (folga) ou vazio. */
export async function saveWeeklyPatternAction(formData: FormData) {
  const days: Record<string, string> = {};
  for (let d = 0; d <= 6; d++) days[String(d)] = str(formData.get(`d${d}`));
  return call("hr", "save_weekly_pattern", { p_employee: str(formData.get("employee")), p_days: days, p_apply: true }, str(formData.get("back")) || "/equipe/escalas/padrao", "Padrão salvo e aplicado nos dias vazios dos próximos meses (em rascunho)");
}

export async function applyPatternsAction(formData: FormData) {
  return call("hr", "apply_weekly_patterns", { p_store: str(formData.get("store")), p_from: str(formData.get("from")), p_to: str(formData.get("to")), p_overwrite: formData.get("overwrite") === "on" },
    str(formData.get("back")) || "/equipe/escalas", "Padrão semanal aplicado ao período (rascunhos)");
}

export async function copyRosterAction(formData: FormData) {
  const path = str(formData.get("back"));
  return call("hr", "copy_roster", { p_store: str(formData.get("store")), p_source_from: str(formData.get("source_from")), p_days: Number(formData.get("days") || 7), p_target_from: str(formData.get("target_from")) },
    path, "Escala copiada");
}

export async function publishRosterAction(formData: FormData) {
  return call("hr", "publish_roster", { p_store: str(formData.get("store")), p_from: str(formData.get("from")), p_to: str(formData.get("to")) }, str(formData.get("back")), "Escala publicada");
}

export async function closeTimesheetsAction(formData: FormData) {
  const supabase = await createClient();
  const entity = str(formData.get("entity"));
  const competence = str(formData.get("competence"));
  const { data: emps } = await supabase.schema("hr").from("employees").select("id").eq("legal_entity_id", entity).eq("status", "ACTIVE").neq("contract_type", "PRO_LABORE");
  let failed = "";
  for (const e of emps ?? []) {
    const { error } = await supabase.schema("hr").rpc("close_timesheet", { p_employee: e.id, p_competence: competence, p_force: formData.get("force") === "1" });
    if (error) { failed = friendly(error.message); break; }
  }
  revalidatePath("/equipe", "layout");
  back("/equipe/ponto", { mes: competence.slice(0, 7), ...(failed ? { erro: failed } : { ok: `Espelhos de ponto fechados (${emps?.length ?? 0})` }) });
}

export async function reopenTimesheetAction(formData: FormData) {
  return call("hr", "reopen_timesheet", { p_timesheet: str(formData.get("timesheet_id")) }, "/equipe/ponto", "Espelho reaberto", { mes: str(formData.get("mes")) });
}

export async function addTimeEntryAction(formData: FormData) {
  const session = await getSession();
  const supabase = await createClient();
  const { error } = await supabase.schema("hr").from("time_entries").upsert({
    org_id: session.orgId, employee_id: str(formData.get("employee_id")), work_date: str(formData.get("work_date")),
    start_time: str(formData.get("start_time")), end_time: str(formData.get("end_time")), break_minutes: Number(formData.get("break_minutes") || 0), source: "MANUAL",
  }, { onConflict: "employee_id,work_date" });
  revalidatePath("/equipe/ponto");
  back("/equipe/ponto", { mes: str(formData.get("work_date")).slice(0, 7), ...(error ? { erro: friendly(error.message) } : { ok: "Marcação registrada" }) });
}

// ---------------------------------------------------------------------
// Folha
// ---------------------------------------------------------------------
export async function createRunAction(formData: FormData) {
  const supabase = await createClient();
  const { data, error } = await supabase.schema("hr").rpc("create_run", {
    p: { legal_entity_id: str(formData.get("entity")), kind: str(formData.get("kind")), competence: `${str(formData.get("month"))}-01` },
  });
  revalidatePath("/equipe", "layout");
  if (error) back("/equipe/folha", { erro: friendly(error.message) });
  back(`/equipe/folha/${(data as unknown as { id: string }).id}`, { ok: "Folha criada: calcule para ver os valores" });
}

export async function calcRunAction(formData: FormData) {
  const id = str(formData.get("run_id"));
  return call("hr", "calc_run", { p_run: id }, `/equipe/folha/${id}`, "Folha calculada");
}

export async function approveRunAction(formData: FormData) {
  const id = str(formData.get("run_id"));
  return call("hr", "approve_run", { p_run: id }, `/equipe/folha/${id}`, "Folha aprovada: títulos, guias e lançamentos gerados");
}

export async function cancelRunAction(formData: FormData) {
  const id = str(formData.get("run_id"));
  return call("hr", "cancel_run", { p_run: id, p_reason: opt(formData.get("reason")) }, `/equipe/folha/${id}`, "Folha cancelada");
}

export async function addManualLineAction(formData: FormData) {
  const id = str(formData.get("run_id"));
  return call("hr", "add_manual_line", { p_payslip: str(formData.get("payslip_id")), p_code: str(formData.get("code")), p_amount: num(formData.get("amount")), p_desc: opt(formData.get("desc")) },
    `/equipe/folha/${id}`, "Lançamento incluído: recalcule a folha");
}

export async function removeLineAction(formData: FormData) {
  const id = str(formData.get("run_id"));
  return call("hr", "remove_line", { p_line: str(formData.get("line_id")) }, `/equipe/folha/${id}`, "Linha removida: recalcule a folha");
}

export async function accrueProvisionsAction(formData: FormData) {
  return call("hr", "accrue_provisions", { p_entity: str(formData.get("entity")), p_competence: `${str(formData.get("month"))}-01` }, "/equipe/folha", "Provisões lançadas");
}

// ---------------------------------------------------------------------
// Rescisão
// ---------------------------------------------------------------------
const terminationSchema = z.object({
  employee_id: uuid, kind: z.enum(["WITHOUT_CAUSE", "RESIGNATION", "JUST_CAUSE", "MUTUAL_AGREEMENT", "FIXED_TERM_END", "EXPERIENCE_END", "DEATH", "RETIREMENT"]),
  notice_kind: z.enum(["WORKED", "INDEMNIFIED", "WAIVED", "NOT_SERVED", "NONE"]), termination_date: date,
  notice_days: z.number().int().min(0).max(90).optional(), fgts_balance: z.number().nonnegative().optional(), reason: z.string().max(300).optional(),
});

export async function createTerminationAction(_prev: State, formData: FormData): Promise<State> {
  const parsed = terminationSchema.safeParse({
    employee_id: str(formData.get("employee_id")), kind: str(formData.get("kind")), notice_kind: str(formData.get("notice_kind")), termination_date: str(formData.get("termination_date")),
    notice_days: formData.get("notice_days") ? Number(formData.get("notice_days")) : undefined,
    fgts_balance: formData.get("fgts_balance") ? num(formData.get("fgts_balance")) : undefined, reason: opt(formData.get("reason")),
  });
  if (!parsed.success) return { ok: false, error: "Confira colaborador, tipo, aviso e data" };
  const supabase = await createClient();
  const { data, error } = await supabase.schema("hr").rpc("create_termination", { p: parsed.data as unknown as Json });
  if (error) return { ok: false, error: friendly(error.message) };
  revalidatePath("/equipe", "layout");
  return back(`/equipe/rescisoes/${(data as unknown as { id: string }).id}`, { ok: "Rescisão calculada: confira a memória de cálculo" });
}

export async function recalcTerminationAction(formData: FormData) {
  const id = str(formData.get("termination_id"));
  const p: Record<string, unknown> = { kind: str(formData.get("kind")), notice_kind: str(formData.get("notice_kind")), termination_date: str(formData.get("termination_date")),
    notice_days: formData.get("notice_days") ? Number(formData.get("notice_days")) : null, fgts_balance: formData.get("fgts_balance") ? num(formData.get("fgts_balance")) : null };
  return call("hr", "recalc_termination", { p_termination: id, p }, `/equipe/rescisoes/${id}`, "Rescisão recalculada");
}

export async function approveTerminationAction(formData: FormData) {
  const id = str(formData.get("termination_id"));
  return call("hr", "approve_termination", { p_termination: id }, `/equipe/rescisoes/${id}`, "Rescisão aprovada: títulos e guias no financeiro");
}

export async function cancelTerminationAction(formData: FormData) {
  const id = str(formData.get("termination_id"));
  return call("hr", "cancel_termination", { p_termination: id, p_reason: opt(formData.get("reason")) }, `/equipe/rescisoes/${id}`, "Rescisão cancelada");
}

// ---------------------------------------------------------------------
// Comissões
// ---------------------------------------------------------------------
export async function generateStatementsAction(formData: FormData) {
  const supabase = await createClient();
  const competence = `${str(formData.get("month"))}-01`;
  const { data: emps } = await supabase.schema("hr").from("employees").select("member_id").eq("status", "ACTIVE").eq("commissioned", true).not("member_id", "is", null);
  let failed = "";
  for (const e of emps ?? []) {
    const { error } = await supabase.schema("comm").rpc("generate_statement", { p_member: e.member_id!, p_competence: competence });
    if (error) { failed = friendly(error.message); break; }
  }
  revalidatePath("/equipe/comissoes");
  back("/equipe/comissoes", { mes: str(formData.get("month")), ...(failed ? { erro: failed } : { ok: `Extratos gerados (${emps?.length ?? 0})` }) });
}

export async function approveStatementAction(formData: FormData) {
  return call("comm", "approve_statement", { p_statement: str(formData.get("statement_id")) }, "/equipe/comissoes", "Extrato aprovado: entra na próxima folha", { mes: str(formData.get("mes")) });
}

export async function reopenStatementAction(formData: FormData) {
  return call("comm", "reopen_statement", { p_statement: str(formData.get("statement_id")) }, "/equipe/comissoes", "Extrato reaberto", { mes: str(formData.get("mes")) });
}
