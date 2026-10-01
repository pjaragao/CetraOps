"use server";
import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { parseStatement } from "@sie/domain";
import type { Json } from "@sie/db";
import { createClient } from "@/lib/supabase/server";
import { getSession } from "@/lib/session";

export type State = { ok: boolean; error?: string; message?: string } | null;

const num = (v: FormDataEntryValue | null) => Number(String(v ?? "").replace(/\./g, "").replace(",", "."));
const uuid = z.string().uuid();
const optUuid = z.string().uuid().optional();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Mensagens do banco chegam em português; só tiramos ruído técnico. */
const friendly = (m: string) => m.replace(/^ERROR:\s*/, "");

function back(path: string, params: Record<string, string | undefined>): never {
  const q = Object.entries(params).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v!)}`).join("&");
  redirect(q ? `${path}${path.includes("?") ? "&" : "?"}${q}` : path);
}

// ---------------------------------------------------------------------
// Títulos (a pagar / a receber) com composição e rateio
// ---------------------------------------------------------------------
const titleSchema = z.object({
  direction: z.enum(["PAYABLE", "RECEIVABLE"]),
  legal_entity_id: uuid,
  store_id: optUuid,
  party_id: optUuid,
  description: z.string().min(2).max(200),
  document_kind: z.string().max(40).optional(),
  document_number: z.string().max(60).optional(),
  competence_date: date,
  chart_account_id: optUuid,
  cost_center_id: optUuid,
  allocation_template_id: optUuid,
  lines: z.array(z.object({ chart_account_id: uuid, cost_center_id: optUuid, amount: z.number().positive(), memo: z.string().max(120).optional() })).max(30).optional(),
  installments: z.array(z.object({ due_date: date, amount: z.number().positive(), barcode: z.string().max(120).optional() })).min(1).max(60),
});

export async function createTitleAction(_prev: State, formData: FormData): Promise<State> {
  let raw: unknown;
  try { raw = JSON.parse(String(formData.get("payload") ?? "")); } catch { return { ok: false, error: "Dados inválidos" }; }
  const parsed = titleSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: `Confira o lançamento: ${parsed.error.issues[0]?.path.join(".")} — ${parsed.error.issues[0]?.message}` };
  const supabase = await createClient();
  const { error } = await supabase.schema("fin").rpc("create_title", { p: parsed.data });
  if (error) return { ok: false, error: friendly(error.message) };
  const base = parsed.data.direction === "PAYABLE" ? "/financeiro/pagar" : "/financeiro/receber";
  revalidatePath(base);
  return back(base, { ok: "Lançamento criado" });
}

export async function approveTitle(formData: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.schema("fin").rpc("approve_title", { p_title: String(formData.get("title_id")) });
  revalidatePath("/financeiro/pagar");
  if (error) back("/financeiro/pagar", { erro: friendly(error.message) });
}

export async function cancelTitle(formData: FormData) {
  const supabase = await createClient();
  const back_ = String(formData.get("back") || "/financeiro/pagar");
  const { error } = await supabase.schema("fin").rpc("cancel_title", { p_title: String(formData.get("title_id")), p_reason: String(formData.get("reason") || "Cancelado pelo usuário") });
  revalidatePath(back_);
  if (error) back(back_, { erro: friendly(error.message) });
}

// ---------------------------------------------------------------------
// Baixa com rateio
// ---------------------------------------------------------------------
const settleSchema = z.object({
  direction: z.enum(["PAYABLE", "RECEIVABLE"]),
  bank_account_id: uuid,
  settled_on: date,
  method: z.enum(["PIX", "TED", "BOLETO", "CASH", "CARD_PAYOUT", "DEBIT_AUTO", "CHECK", "OFFSET", "OTHER"]),
  party_id: optUuid,
  amount: z.number().nonnegative().optional(),
  reference: z.string().max(120).optional(),
  description: z.string().max(200).optional(),
  statement_line_id: optUuid,
  idempotency_key: z.string().min(8).max(80),
  lines: z.array(z.object({
    kind: z.enum(["PRINCIPAL", "INTEREST", "FINE", "CHARGE", "ADVANCE", "DISCOUNT", "FEE", "WITHHOLDING", "CREDIT_USE"]),
    amount: z.number().positive(),
    installment_id: optUuid, chart_account_id: optUuid, cost_center_id: optUuid, credit_id: optUuid,
    memo: z.string().max(200).optional(),
  })).min(1).max(300),
});

export async function settleAction(_prev: State, formData: FormData): Promise<State> {
  let raw: unknown;
  try { raw = JSON.parse(String(formData.get("payload") ?? "")); } catch { return { ok: false, error: "Dados inválidos" }; }
  const parsed = settleSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: `Confira a baixa: ${parsed.error.issues[0]?.path.join(".")} — ${parsed.error.issues[0]?.message}` };
  const supabase = await createClient();
  const { data, error } = await supabase.schema("fin").rpc("settle", { p: parsed.data });
  if (error) return { ok: false, error: friendly(error.message) };
  revalidatePath("/financeiro", "layout");
  const number = (data as unknown as { number?: string })?.number ?? "";
  const target = parsed.data.statement_line_id ? "/financeiro/conciliacao" : "/financeiro/movimentacoes";
  return back(target, { conta: parsed.data.bank_account_id, ok: `Baixa ${number} registrada` });
}

export async function reverseSettlementAction(formData: FormData) {
  const supabase = await createClient();
  const conta = String(formData.get("conta") || "");
  const { error } = await supabase.schema("fin").rpc("reverse_settlement", {
    p_settlement: String(formData.get("settlement_id")), p_reason: String(formData.get("reason") || "Estorno solicitado pelo usuário"),
  });
  revalidatePath("/financeiro", "layout");
  back("/financeiro/movimentacoes", { conta, ...(error ? { erro: friendly(error.message) } : { ok: "Baixa estornada" }) });
}

// ---------------------------------------------------------------------
// Movimentos: transferência e lançamentos sem título
// ---------------------------------------------------------------------
export async function transferAction(_prev: State, formData: FormData): Promise<State> {
  const parsed = z.object({
    from_bank_account_id: uuid, to_bank_account_id: uuid, amount: z.number().positive(), fee: z.number().nonnegative().optional(),
    occurred_on: date, description: z.string().max(200).optional(),
    from_statement_line_id: optUuid, to_statement_line_id: optUuid,
  }).safeParse({
    from_bank_account_id: formData.get("from"), to_bank_account_id: formData.get("to"), amount: num(formData.get("amount")),
    fee: formData.get("fee") ? num(formData.get("fee")) : undefined, occurred_on: formData.get("date"),
    description: String(formData.get("description") || "") || undefined,
    from_statement_line_id: String(formData.get("from_line") || "") || undefined, to_statement_line_id: String(formData.get("to_line") || "") || undefined,
  });
  if (!parsed.success) return { ok: false, error: "Confira contas, valor e data da transferência" };
  const supabase = await createClient();
  const { error } = await supabase.schema("fin").rpc("transfer", { p: parsed.data });
  if (error) return { ok: false, error: friendly(error.message) };
  revalidatePath("/financeiro", "layout");
  return { ok: true, message: "Transferência registrada" };
}

export async function cashMovementAction(_prev: State, formData: FormData): Promise<State> {
  const parsed = z.object({
    bank_account_id: uuid, kind: z.enum(["BANK_FEE", "INTEREST_INCOME", "OWNER_CONTRIBUTION", "PROFIT_DISTRIBUTION", "LOAN", "ADJUSTMENT", "OTHER"]),
    direction: z.enum(["IN", "OUT"]), amount: z.number().positive(), occurred_on: date,
    chart_account_id: optUuid, cost_center_id: optUuid, party_id: optUuid, description: z.string().max(200).optional(),
  }).safeParse({
    bank_account_id: formData.get("bank"), kind: formData.get("kind"), direction: formData.get("direction"), amount: num(formData.get("amount")),
    occurred_on: formData.get("date"), chart_account_id: String(formData.get("account") || "") || undefined,
    cost_center_id: String(formData.get("cc") || "") || undefined, party_id: String(formData.get("party") || "") || undefined,
    description: String(formData.get("description") || "") || undefined,
  });
  if (!parsed.success) return { ok: false, error: "Confira conta, tipo, valor e data" };
  const supabase = await createClient();
  const { error } = await supabase.schema("fin").rpc("post_cash_movement", { p: parsed.data });
  if (error) return { ok: false, error: friendly(error.message) };
  revalidatePath("/financeiro", "layout");
  return { ok: true, message: "Movimento lançado" };
}

// ---------------------------------------------------------------------
// Extratos e conciliação
// ---------------------------------------------------------------------
export async function importStatementAction(_prev: State, formData: FormData): Promise<State> {
  const bank = String(formData.get("bank") || "");
  const file = formData.get("file");
  if (!uuid.safeParse(bank).success || !(file instanceof File) || file.size === 0) return { ok: false, error: "Escolha a conta e o arquivo do extrato" };
  if (file.size > 5_000_000) return { ok: false, error: "Arquivo acima de 5 MB" };
  const text = await file.text();
  const parsed = parseStatement(file.name, text);
  if (parsed.lines.length === 0) return { ok: false, error: parsed.warnings[0] ?? "Nenhum lançamento encontrado" };
  const supabase = await createClient();
  const { data, error } = await supabase.schema("fin").rpc("import_statement", {
    p: {
      bank_account_id: bank, source: parsed.source, filename: file.name, file_hash: createHash("sha256").update(text).digest("hex"),
      period_start: parsed.period_start, period_end: parsed.period_end, opening_balance: parsed.opening_balance, closing_balance: parsed.closing_balance,
      lines: parsed.lines,
    } as unknown as Json,
  });
  if (error) return { ok: false, error: friendly(error.message) };
  const r = data as { duplicate_file?: boolean; inserted?: number; total?: number };
  revalidatePath("/financeiro/conciliacao");
  if (r.duplicate_file) return { ok: true, message: "Este arquivo já tinha sido importado." };
  const warn = parsed.warnings.length ? ` (${parsed.warnings.length} aviso(s))` : "";
  return { ok: true, message: `${r.inserted} de ${r.total} linhas novas importadas${warn}.` };
}

export async function autoMatchAction(formData: FormData) {
  const bank = String(formData.get("bank") || "");
  const supabase = await createClient();
  const m = await supabase.schema("fin").rpc("auto_match", { p_bank_account: bank });
  const r = await supabase.schema("fin").rpc("apply_recon_rules", { p_bank_account: bank });
  revalidatePath("/financeiro/conciliacao");
  if (m.error || r.error) back("/financeiro/conciliacao", { conta: bank, erro: friendly((m.error ?? r.error)!.message) });
  back("/financeiro/conciliacao", { conta: bank, ok: `${m.data ?? 0} conciliada(s) por valor/data e ${r.data ?? 0} classificada(s) pelas regras` });
}

export async function linkLineAction(formData: FormData) {
  const bank = String(formData.get("bank") || "");
  const supabase = await createClient();
  const { error } = await supabase.schema("fin").rpc("link_statement_line", { p_line: String(formData.get("line")), p_tx: String(formData.get("tx")) });
  revalidatePath("/financeiro/conciliacao");
  back("/financeiro/conciliacao", { conta: bank, ...(error ? { erro: friendly(error.message) } : { ok: "Linha conciliada" }) });
}

export async function unlinkLineAction(formData: FormData) {
  const bank = String(formData.get("bank") || "");
  const supabase = await createClient();
  const { error } = await supabase.schema("fin").rpc("unlink_statement_line", { p_line: String(formData.get("line")) });
  revalidatePath("/financeiro/conciliacao");
  back("/financeiro/conciliacao", { conta: bank, ...(error ? { erro: friendly(error.message) } : { ok: "Conciliação desfeita" }) });
}

export async function ignoreLineAction(formData: FormData) {
  const bank = String(formData.get("bank") || "");
  const supabase = await createClient();
  const restore = formData.get("restore") === "1";
  const { error } = restore
    ? await supabase.schema("fin").rpc("restore_statement_line", { p_line: String(formData.get("line")) })
    : await supabase.schema("fin").rpc("ignore_statement_line", { p_line: String(formData.get("line")), p_reason: String(formData.get("reason") || "Ignorada pelo usuário") });
  revalidatePath("/financeiro/conciliacao");
  back("/financeiro/conciliacao", { conta: bank, ...(error ? { erro: friendly(error.message) } : {}) });
}

export async function classifyLineAction(formData: FormData) {
  const bank = String(formData.get("bank") || "");
  const supabase = await createClient();
  const { error } = await supabase.schema("fin").rpc("classify_statement_line", {
    p_line: String(formData.get("line")),
    p: {
      kind: String(formData.get("kind")),
      chart_account_id: String(formData.get("account") || "") || undefined,
      cost_center_id: String(formData.get("cc") || "") || undefined,
      description: String(formData.get("description") || "") || undefined,
    },
  });
  revalidatePath("/financeiro", "layout");
  back("/financeiro/conciliacao", { conta: bank, ...(error ? { erro: friendly(error.message) } : { ok: "Linha classificada e conciliada" }) });
}

export async function transferFromLineAction(formData: FormData) {
  const bank = String(formData.get("bank") || "");
  const out = num(formData.get("amount")) < 0;
  const line = String(formData.get("line"));
  const other = String(formData.get("counter_line") || "") || undefined;
  const otherBank = String(formData.get("other_bank"));
  const supabase = await createClient();
  const amount = Math.abs(num(formData.get("amount")));
  const { error } = await supabase.schema("fin").rpc("transfer", {
    p: {
      from_bank_account_id: out ? bank : otherBank, to_bank_account_id: out ? otherBank : bank, amount,
      occurred_on: String(formData.get("date")), description: String(formData.get("description") || "Transferência entre contas"),
      ...(out ? { from_statement_line_id: line, to_statement_line_id: other } : { to_statement_line_id: line, from_statement_line_id: other }),
    },
  });
  revalidatePath("/financeiro", "layout");
  back("/financeiro/conciliacao", { conta: bank, ...(error ? { erro: friendly(error.message) } : { ok: "Transferência conciliada" }) });
}

// ---------------------------------------------------------------------
// Razão contábil: lançamento manual e períodos
// ---------------------------------------------------------------------
export async function manualEntryAction(_prev: State, formData: FormData): Promise<State> {
  const lines: { account_id: string; cost_center_id?: string; debit?: number; credit?: number; memo?: string }[] = [];
  for (let i = 0; i < 6; i++) {
    const account = String(formData.get(`account_${i}`) || "");
    if (!account) continue;
    const debit = num(formData.get(`debit_${i}`)) || 0;
    const credit = num(formData.get(`credit_${i}`)) || 0;
    if (!(debit > 0) && !(credit > 0)) continue;
    lines.push({ account_id: account, cost_center_id: String(formData.get(`cc_${i}`) || "") || undefined, debit: debit || undefined, credit: credit || undefined });
  }
  const entity = String(formData.get("entity") || "");
  if (!uuid.safeParse(entity).success || lines.length < 2) return { ok: false, error: "Informe a empresa e ao menos duas linhas" };
  const supabase = await createClient();
  const { error } = await supabase.schema("fin").rpc("post_manual_entry", {
    p: { legal_entity_id: entity, entry_date: String(formData.get("date") || ""), description: String(formData.get("description") || "Lançamento manual"), lines },
  });
  if (error) return { ok: false, error: friendly(error.message) };
  revalidatePath("/financeiro/razao");
  return { ok: true, message: "Lançamento contábil registrado" };
}

export async function setPeriodAction(formData: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.schema("fin").rpc("set_period_status", {
    p_entity: String(formData.get("entity")), p_competence: String(formData.get("competence")), p_status: String(formData.get("status")),
  });
  revalidatePath("/financeiro/razao");
  back("/financeiro/razao", { aba: "periodos", ...(error ? { erro: friendly(error.message) } : {}) });
}

// ---------------------------------------------------------------------
// Configurações financeiras: contas bancárias e modelos de rateio
// ---------------------------------------------------------------------
export async function createBankAccountAction(formData: FormData) {
  const session = await getSession();
  const supabase = await createClient();
  const opening = num(formData.get("opening")) || 0;
  const { error } = await supabase.schema("fin").from("bank_accounts").insert({
    org_id: session.orgId, legal_entity_id: String(formData.get("entity")), name: String(formData.get("name") || "").slice(0, 80),
    kind: String(formData.get("kind")), bank_code: String(formData.get("bank_code") || "") || null, agency: String(formData.get("agency") || "") || null,
    number: String(formData.get("number") || "") || null, chart_account_id: String(formData.get("account") || "") || null,
    store_id: String(formData.get("store") || "") || null, opening_balance: opening, opening_date: String(formData.get("opening_date") || "") || null,
  });
  revalidatePath("/configuracoes/contas-bancarias");
  back("/configuracoes/contas-bancarias", error ? { erro: friendly(error.message) } : { ok: "Conta criada" });
}

export async function createTemplateAction(_prev: State, formData: FormData): Promise<State> {
  const session = await getSession();
  const name = String(formData.get("name") || "").trim();
  const lines: { cc: string; pct: number }[] = [];
  for (let i = 0; i < 6; i++) {
    const cc = String(formData.get(`cc_${i}`) || "");
    const pct = num(formData.get(`pct_${i}`));
    if (cc && pct > 0) lines.push({ cc, pct });
  }
  if (name.length < 2 || lines.length < 1) return { ok: false, error: "Informe o nome e ao menos um centro de custo" };
  if (Math.abs(lines.reduce((a, l) => a + l.pct, 0) - 100) > 0.0001) return { ok: false, error: "Os percentuais precisam somar 100%" };
  const supabase = await createClient();
  const t = await supabase.schema("fin").from("allocation_templates").insert({ org_id: session.orgId, name, description: String(formData.get("description") || "") || null }).select("id").single();
  if (t.error) return { ok: false, error: friendly(t.error.message) };
  const l = await supabase.schema("fin").from("allocation_template_lines").insert(lines.map((x) => ({ org_id: session.orgId, template_id: t.data.id, cost_center_id: x.cc, pct: x.pct })));
  if (l.error) return { ok: false, error: friendly(l.error.message) };
  revalidatePath("/configuracoes/rateios");
  return { ok: true, message: "Modelo de rateio criado" };
}

// ---------------------------------------------------------------------
// Contrato de patrocínio + licença de espaço (JOY)
// ---------------------------------------------------------------------
const contractSchema = z.object({
  partner_name: z.string().min(2), partner_cnpj: z.string().regex(/^\d{14}$/),
  title: z.string().min(2), start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  months: z.number().int().positive(), in_kind_months: z.number().int().min(0),
  installment_amount: z.number().positive(), due_day: z.number().int().min(1).max(31),
  late_fee_pct: z.number().min(0), monthly_interest_pct: z.number().min(0), exit_penalty_pct: z.number().min(0),
});

/** Cadastra o contrato de patrocínio + licença de espaço (ex.: JOY), gera o cronograma e as contrapartidas. */
export async function createContract(formData: FormData) {
  const session = await getSession();
  const parsed = contractSchema.safeParse({
    partner_name: String(formData.get("partner_name") || "").trim(),
    partner_cnpj: String(formData.get("partner_cnpj") || "").replace(/\D/g, ""),
    title: String(formData.get("title") || "").trim(),
    start_date: String(formData.get("start_date") || ""),
    months: Number(formData.get("months")), in_kind_months: Number(formData.get("in_kind_months")),
    installment_amount: num(formData.get("installment_amount")), due_day: Number(formData.get("due_day")),
    late_fee_pct: num(formData.get("late_fee_pct")), monthly_interest_pct: num(formData.get("monthly_interest_pct")),
    exit_penalty_pct: num(formData.get("exit_penalty_pct")),
  });
  if (!parsed.success || !session.storeId) redirect("/financeiro/contratos?erro=dados");
  const c = parsed.data;
  const store = session.stores.find((s) => s.id === session.storeId)!;
  const supabase = await createClient();

  // Parceiro (academia) no cadastro único
  let { data: partner } = await supabase.schema("crm").from("parties").select("id").eq("cnpj", c.partner_cnpj).maybeSingle();
  if (!partner) {
    const ins = await supabase.schema("crm").from("parties")
      .insert({ org_id: session.orgId, kind: "COMPANY", display_name: c.partner_name, legal_name: c.partner_name, cnpj: c.partner_cnpj, lifecycle_stage: "CUSTOMER", source: "CONTRATO" })
      .select("id").single();
    if (ins.error) redirect(`/financeiro/contratos?erro=${encodeURIComponent(ins.error.message)}`);
    partner = ins.data;
    await supabase.schema("crm").from("party_roles").insert({ org_id: session.orgId, party_id: partner!.id, role: "PARTNER_GYM" });
  }
  const { data: account } = await supabase.schema("fin").from("chart_accounts").select("id").eq("code", "7.2.01").maybeSingle();

  const { data: contract, error } = await supabase.schema("fin").from("contracts").insert({
    org_id: session.orgId, legal_entity_id: store.legal_entity_id, store_id: store.id, party_id: partner!.id,
    kind: "SPONSORSHIP_SPACE_LICENSE", title: c.title, start_date: c.start_date, months: c.months,
    in_kind_months: c.in_kind_months, in_kind_description: "2 looks por mês, com nota fiscal",
    installment_amount: c.installment_amount, due_day: c.due_day, late_fee_pct: c.late_fee_pct,
    monthly_interest_pct: c.monthly_interest_pct, adjustment_index: "IPCA", exit_penalty_pct: c.exit_penalty_pct,
    chart_account_id: account?.id ?? null,
  }).select("id").single();
  if (error) redirect(`/financeiro/contratos?erro=${encodeURIComponent(error.message)}`);

  const sched = await supabase.schema("fin").rpc("generate_contract_schedule", { p_contract: contract!.id });
  if (sched.error) redirect(`/financeiro/contratos?erro=${encodeURIComponent(sched.error.message)}`);

  // Contrapartidas recorrentes do contrato: 2 convidados/mês, 1 café da manhã/mês, 2 ensaios/ano
  const obligations = [];
  for (let i = 0; i < c.months; i++) {
    const d = new Date(`${c.start_date}T12:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + i);
    const due = d.toISOString().slice(0, 10);
    obligations.push({ org_id: session.orgId, contract_id: contract!.id, kind: "GUEST_PASS" as const, description: `Mês ${i + 1}: até 2 convidados SIÉ no Plano Club`, due_date: due });
    obligations.push({ org_id: session.orgId, contract_id: contract!.id, kind: "BREAKFAST_ACTIVATION" as const, description: `Mês ${i + 1}: ativação café da manhã`, due_date: due });
    if (i % 6 === 5) obligations.push({ org_id: session.orgId, contract_id: contract!.id, kind: "PHOTOSHOOT" as const, description: "Ensaio fotográfico semestral", due_date: due });
  }
  await supabase.schema("fin").from("contract_obligations").insert(obligations);
  revalidatePath("/financeiro/contratos");
  redirect("/financeiro/contratos");
}
