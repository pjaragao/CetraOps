"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { Json } from "@centralops/db";
import { createClient } from "@/lib/supabase/server";

export type State = { ok: boolean; error?: string; message?: string } | null;
const friendly = (m: string) => m.replace(/^ERROR:\s*/, "");
const uuid = z.string().uuid();
const refresh = () => { revalidatePath("/vender", "layout"); revalidatePath("/produtos", "layout"); revalidatePath("/inicio"); };

const loanSchema = z.object({
  store_id: uuid, kind: z.enum(["TRY_ON", "CAMPAIGN"]), party_id: uuid.optional(), campaign_id: uuid.optional(),
  purpose: z.string().trim().max(200).optional(), due_days: z.number().int().min(1).max(90), notes: z.string().trim().max(500).optional(),
  items: z.array(z.object({ variant_id: uuid, qty: z.number().int().min(1).max(50) })).min(1).max(100),
});

export async function createLoanAction(_prev: State, formData: FormData): Promise<State> {
  let raw: unknown;
  try { raw = JSON.parse(String(formData.get("payload") ?? "")); } catch { return { ok: false, error: "Dados inválidos" }; }
  const parsed = loanSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: `Confira: ${parsed.error.issues[0]?.path.join(".")} — ${parsed.error.issues[0]?.message}` };
  if (parsed.data.kind === "TRY_ON" && !parsed.data.party_id) return { ok: false, error: "Escolha a cliente da malinha" };
  const supabase = await createClient();
  const { data, error } = await supabase.schema("inv").rpc("create_loan", { p: parsed.data as unknown as Json });
  if (error) return { ok: false, error: friendly(error.message) };
  refresh();
  redirect(`/vender/malinhas/${(data as { id: string }).id}?ok=${encodeURIComponent("Saída registrada: as peças saíram do estoque da loja")}`);
}

const settleSchema = z.array(z.object({
  item_id: uuid, returned: z.number().int().min(0), sold: z.number().int().min(0), lost: z.number().int().min(0), damaged: z.number().int().min(0), gifted: z.number().int().min(0),
})).max(100);

/** Acerto: devolve, vende, perde, avaria ou dá de brinde. As vendidas abrem uma venda no PDV já com as peças e a cliente. */
export async function settleLoanAction(_prev: State, formData: FormData): Promise<State> {
  const loanId = String(formData.get("loan_id") ?? "");
  if (!uuid.safeParse(loanId).success) return { ok: false, error: "Saída inválida" };
  let raw: unknown;
  try { raw = JSON.parse(String(formData.get("payload") ?? "[]")); } catch { return { ok: false, error: "Dados inválidos" }; }
  const parsed = settleSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Quantidades inválidas" };
  const lines = parsed.data.filter((l) => l.returned + l.sold + l.lost + l.damaged + l.gifted > 0);
  if (lines.length === 0) return { ok: false, error: "Informe o que voltou, o que foi vendido ou o que aconteceu com as peças" };
  const supabase = await createClient();
  const { data, error } = await supabase.schema("inv").rpc("settle_loan", { p_loan: loanId, p: lines as unknown as Json, p_notes: String(formData.get("notes") ?? "") || undefined });
  if (error) return { ok: false, error: friendly(error.message) };
  const res = data as unknown as { loan: { store_id: string; party_id: string | null; number: string; status: string }; sold: { variant_id: string; qty: number; unit_price: number | null }[] };
  refresh();
  if (res.sold.length > 0) {
    // venda já montada no PDV (rascunho): a vendedora só confere e recebe
    const prices = await Promise.all(res.sold.map(async (s) => s.unit_price ?? Number((await supabase.schema("catalog").rpc("current_price", { p_variant: s.variant_id })).data ?? 0)));
    const { data: draft, error: e2 } = await supabase.schema("sales").rpc("save_order_draft", { p: {
      store_id: res.loan.store_id, party_id: res.loan.party_id, channel: "POS", fulfillment_type: "TAKEAWAY", shipping_total: 0,
      notes: `Peças da malinha ${res.loan.number}`,
      items: res.sold.map((s, i) => ({ variant_id: s.variant_id, qty: s.qty, unit_price: prices[i], list_price: prices[i], discount_amount: 0 })),
    } as unknown as Json });
    if (e2) return { ok: true, message: `Acerto registrado, mas a venda não foi montada: ${friendly(e2.message)}. Faça a venda no PDV.` };
    const orderId = (draft as unknown as { id: string }).id;
    await supabase.schema("inv").rpc("link_loan_order", { p_loan: loanId, p_order: orderId });
    redirect(`/vender/pdv?resume=${orderId}`);
  }
  return { ok: true, message: res.loan.status === "CLOSED" ? "Acerto concluído: saída encerrada" : "Acerto parcial registrado" };
}

export async function extendLoanAction(formData: FormData) {
  const loanId = String(formData.get("loan_id") ?? "");
  const date = String(formData.get("due") ?? "");
  const supabase = await createClient();
  const { error } = /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? await supabase.schema("inv").rpc("extend_loan", { p_loan: loanId, p_due: `${date}T23:59:00-03:00` })
    : { error: { message: "Data inválida" } };
  refresh();
  redirect(`/vender/malinhas/${loanId}?${error ? `erro=${encodeURIComponent(friendly(error.message))}` : "ok=Prazo%20alterado"}`);
}
