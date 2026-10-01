"use server";
import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { parseAcquirerCsv } from "@sie/domain";
import type { Json } from "@sie/db";
import { createClient } from "@/lib/supabase/server";

export type State = { ok: boolean; error?: string; message?: string } | null;

const LIST = "/financeiro/adquirente";
const friendly = (m: string) => m.replace(/^ERROR:\s*/, "");
const str = (v: FormDataEntryValue | null) => String(v ?? "").trim();
const MAX_BYTES = 8_000_000;

function back(params: Record<string, string | undefined> = {}): never {
  const q = Object.entries(params).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v!)}`).join("&");
  redirect(q ? `${LIST}?${q}` : LIST);
}

/** Lê o arquivo de recebíveis (layout padrão), manda ao banco e devolve o resumo: casadas com vendas, sem venda e alertas de taxa. */
export async function importAcquirerAction(_prev: State, formData: FormData): Promise<State> {
  const acquirer = str(formData.get("acquirer"));
  const file = formData.get("file");
  if (acquirer.length < 2) return { ok: false, error: "Informe a adquirente (ex.: STONE, SIPAG, MERCADOPAGO)." };
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Escolha o arquivo CSV." };
  if (file.size > MAX_BYTES) return { ok: false, error: "O arquivo passa de 8 MB: envie em partes." };
  const content = await file.text();
  const parsed = parseAcquirerCsv(content);
  if (parsed.errors.length > 0) return { ok: false, error: `${parsed.errors.slice(0, 5).join(" ")}${parsed.errors.length > 5 ? ` (e mais ${parsed.errors.length - 5} problema(s))` : ""}` };
  if (parsed.transactions.length === 0 && parsed.payouts.length === 0) return { ok: false, error: "O arquivo não traz nenhuma transação." };
  const supabase = await createClient();
  const { data, error } = await supabase.schema("fin").rpc("import_acquirer", {
    p: { acquirer, filename: file.name, hash: createHash("sha256").update(content).digest("hex"), ...(str(formData.get("bank_account_id")) ? { bank_account_id: str(formData.get("bank_account_id")) } : {}),
      transactions: parsed.transactions, payouts: parsed.payouts } as unknown as Json,
  });
  if (error) return { ok: false, error: friendly(error.message) };
  revalidatePath(LIST);
  const r = data as unknown as { transactions_new: number; transactions_duplicate: number; matched: number; unmatched: number; payouts_new: number; fee_alerts: number };
  return { ok: true, message: `${r.transactions_new} transação(ões) nova(s): ${r.matched} casada(s) com vendas, ${r.unmatched} sem venda${r.transactions_duplicate ? `; ${r.transactions_duplicate} já existia(m)` : ""}; ${r.payouts_new} repasse(s)${r.fee_alerts ? `; ${r.fee_alerts} com taxa acima do contratado` : ""}.` };
}

export async function settlePayoutAction(formData: FormData) {
  const supabase = await createClient();
  const bank = str(formData.get("bank_account_id"));
  const { error } = await supabase.schema("fin").rpc("settle_acquirer_payout", { p_payout: str(formData.get("id")), ...(bank ? { p_bank_account: bank } : {}) });
  revalidatePath(LIST);
  back(error ? { erro: friendly(error.message) } : { ok: "Repasse baixado: parcelas quitadas com a taxa real cobrada." });
}
