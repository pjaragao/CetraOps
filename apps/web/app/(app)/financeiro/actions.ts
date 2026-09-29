"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { splitInstallments } from "@sie/domain";
import { createClient } from "@/lib/supabase/server";
import { getSession } from "@/lib/session";

const num = (v: FormDataEntryValue | null) => Number(String(v ?? "").replace(/\./g, "").replace(",", "."));

export async function createTitle(formData: FormData) {
  const session = await getSession();
  const direction = formData.get("direction") === "RECEIVABLE" ? "RECEIVABLE" : "PAYABLE";
  const total = num(formData.get("amount"));
  const n = Math.max(1, Math.min(24, Number(formData.get("installments") || 1)));
  const every = Math.max(1, Number(formData.get("every") || 30));
  const first = String(formData.get("first_due") || new Date().toISOString().slice(0, 10));
  const store = session.stores.find((s) => s.id === (String(formData.get("store_id") || session.storeId || "")));
  if (!store || !(total > 0)) redirect(`/financeiro/${direction === "PAYABLE" ? "pagar" : "receber"}?erro=dados`);

  const parts = splitInstallments(total, n).map((amount, i) => {
    const d = new Date(`${first}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + every * i);
    return { due_date: d.toISOString().slice(0, 10), amount, barcode: i === 0 ? String(formData.get("barcode") || "") || null : null };
  });

  const supabase = await createClient();
  const { error } = await supabase.schema("fin").rpc("create_title", {
    p: {
      direction, legal_entity_id: store!.legal_entity_id, store_id: store!.id,
      description: String(formData.get("description") || "").slice(0, 200),
      document_kind: String(formData.get("document_kind") || "") || null,
      document_number: String(formData.get("document_number") || "") || null,
      chart_account_id: String(formData.get("chart_account_id") || "") || null,
      installments: parts,
    },
  });
  const base = `/financeiro/${direction === "PAYABLE" ? "pagar" : "receber"}`;
  if (error) redirect(`${base}?erro=${encodeURIComponent(error.message)}`);
  revalidatePath(base);
  redirect(base);
}

export async function approveTitle(formData: FormData) {
  const supabase = await createClient();
  await supabase.schema("fin").rpc("approve_title", { p_title: String(formData.get("title_id")) });
  revalidatePath("/financeiro/pagar");
}

export async function settleInstallment(formData: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.schema("fin").rpc("settle_installment", { p_installment: String(formData.get("installment_id")) });
  const back = String(formData.get("back") || "/financeiro");
  if (error) redirect(`${back}?erro=${encodeURIComponent(error.message)}`);
  revalidatePath(back);
}

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

  await supabase.schema("fin").rpc("generate_contract_schedule", { p_contract: contract!.id });

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
