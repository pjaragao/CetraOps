"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { Json } from "@sie/db";
import { createClient } from "@/lib/supabase/server";
import { findParty } from "../party-lookup";

const friendly = (m: string) => m.replace(/^ERROR:\s*/, "");
const str = (v: FormDataEntryValue | null) => String(v ?? "").trim();
const num = (v: FormDataEntryValue | null) => str(v).replace(",", ".");
const PATH = "/clientes/afiliados";

function back(params: Record<string, string | undefined> = {}): never {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString();
  redirect(q ? `${PATH}?${q}` : PATH);
}

export async function saveAffiliateAction(formData: FormData) {
  const supabase = await createClient();
  const id = str(formData.get("id"));
  let party = str(formData.get("party_id"));
  if (!id) {
    const found = await findParty(supabase, str(formData.get("party")));
    if ("error" in found) back({ erro: found.error });
    party = found.id;
  }
  const { error } = await supabase.schema("aff").rpc("save_affiliate", { p: {
    ...(id ? { id } : {}), party_id: party, coupon_code: str(formData.get("coupon_code")), student_discount_pct: num(formData.get("discount")), commission_pct: num(formData.get("commission")),
    payout_mode: str(formData.get("payout_mode")), notes: str(formData.get("notes")),
  } as Json });
  revalidatePath(PATH);
  back(error ? { erro: friendly(error.message), ...(id ? { editar: id } : {}) } : { ok: id ? "Afiliada atualizada." : "Afiliada cadastrada: o cupom já vale no PDV e nas vendas remotas." });
}

export async function setAffiliateStatusAction(formData: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.schema("aff").rpc("set_affiliate_status", { p_id: str(formData.get("id")), p_status: str(formData.get("status")) });
  revalidatePath(PATH);
  back(error ? { erro: friendly(error.message) } : { ok: "Situação atualizada." });
}

/** Calcula (ou recalcula os rascunhos de) o extrato do mês de todas as afiliadas ativas. */
export async function generateStatementsAction(formData: FormData) {
  const mes = str(formData.get("mes"));
  const supabase = await createClient();
  const { data: affs } = await supabase.schema("aff").from("affiliates").select("id").eq("status", "ACTIVE");
  let n = 0;
  for (const a of affs ?? []) {
    const { error } = await supabase.schema("aff").rpc("generate_statement", { p_affiliate: a.id, p_competence: `${mes}-01` });
    if (error) back({ erro: friendly(error.message), mes });
    n++;
  }
  revalidatePath(PATH);
  back({ ok: n ? `Extratos de ${n} afiliada(s) calculados.` : "Nenhuma afiliada ativa.", mes });
}

export async function approveStatementAction(formData: FormData) {
  const supabase = await createClient();
  const { data, error } = await supabase.schema("aff").rpc("approve_statement", { p_id: str(formData.get("id")) });
  revalidatePath(PATH);
  const st = data as unknown as { payout_mode?: string } | null;
  back({ mes: str(formData.get("mes")), ...(error ? { erro: friendly(error.message) } : { ok: st?.payout_mode === "PIX" ? "Aprovado: o título a pagar foi criado no Financeiro." : "Aprovado: a comissão entrou como vale-troca da afiliada." }) });
}
