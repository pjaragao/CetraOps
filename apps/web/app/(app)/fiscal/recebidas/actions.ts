"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

const LIST = "/fiscal/recebidas";
const friendly = (m: string) => m.replace(/^ERROR:\s*/, "");
const str = (v: FormDataEntryValue | null) => String(v ?? "").trim();

function back(params: Record<string, string | undefined> = {}): never {
  const q = Object.entries(params).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v!)}`).join("&");
  redirect(q ? `${LIST}?${q}` : LIST);
}

/** Pede ao worker a varredura de notas emitidas contra o CNPJ (também roda sozinha a cada 2 h). */
export async function syncDfeAction() {
  const supabase = await createClient();
  const { error } = await supabase.schema("fiscal").rpc("request_dfe_sync");
  revalidatePath(LIST);
  back(error ? { erro: friendly(error.message) } : { wait: "1" });
}

/** Manifestação do destinatário: tem efeito legal, por isso é sempre uma decisão da pessoa. */
export async function manifestAction(formData: FormData) {
  const supabase = await createClient();
  const reason = str(formData.get("reason"));
  const { error } = await supabase.schema("fiscal").rpc("request_manifest", { p_id: str(formData.get("id")), p_type: str(formData.get("type")), ...(reason ? { p_reason: reason } : {}) });
  revalidatePath(LIST);
  back(error ? { erro: friendly(error.message) } : { wait: "1" });
}

/** Dá entrada no estoque diretamente a partir da NF-e com XML já baixado pela SEFAZ. */
export async function importInboundDfeAction(formData: FormData) {
  const dfeId = str(formData.get("dfe_id"));
  const locationId = str(formData.get("location_id"));
  const poId = str(formData.get("po_id")) || null;

  if (!dfeId) back({ erro: "Nota fiscal não identificada" });
  if (!locationId) back({ erro: "Escolha o local de estoque para recebimento" });

  const supabase = await createClient();
  const { data, error } = await supabase.schema("purch").rpc("import_inbound_dfe", {
    p_dfe_id: dfeId,
    p_location: locationId,
    ...(poId ? { p_po: poId } : {}),
  });

  if (error) {
    back({ erro: friendly(error.message) });
  }

  const receipt = data as { id: string; number: string };
  revalidatePath(LIST);
  revalidatePath("/produtos/recebimento");
  redirect(`/produtos/recebimento/${receipt.id}?ok=${encodeURIComponent(`NF-e importada (${receipt.number}): confira a contagem dos itens para dar entrada no estoque`)}`);
}

/** Busca uma nota pela chave de acesso na SEFAZ (nota anterior ao primeiro uso da busca automática, que não é retroativa). */
export async function fetchDfeByKeyAction(formData: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.schema("fiscal").rpc("request_dfe_by_key", { p_key: str(formData.get("key")) });
  revalidatePath(LIST);
  back(error ? { erro: friendly(error.message) } : { wait: "1" });
}

// ---- destino da nota (triagem da IA, confirmada pela pessoa) ----

type State = { ok: boolean; error?: string } | null;
const notePath = (key: string) => `/fiscal/recebidas/nota/${key}`;

/** Confirma o destino: patrimônio/despesa (conta a pagar em rascunho, classificada), paga por reembolso ou sem lançamento. */
export async function applyDfeDestinationAction(_prev: State, formData: FormData): Promise<State> {
  let p: { id?: string; key?: string } & Record<string, unknown>;
  try { p = JSON.parse(str(formData.get("payload"))); } catch { return { ok: false, error: "Dados inválidos" }; }
  const { id, key, ...rest } = p;
  if (!id || !key) return { ok: false, error: "Nota não identificada" };
  const supabase = await createClient();
  const { data, error } = await supabase.schema("fiscal").rpc("apply_dfe_destination", { p_id: id, p: rest as never });
  if (error) return { ok: false, error: friendly(error.message) };
  const r = data as { destination: string; title_number: string | null };
  revalidatePath(LIST);
  revalidatePath("/financeiro", "layout");
  const ok = r.destination === "REIMBURSED" ? "Nota ligada ao(s) reembolso(s): nenhuma conta nova foi criada."
    : r.destination === "PAYABLE" ? `Nota ligada à conta a pagar ${r.title_number}: nenhuma conta nova foi criada.`
    : r.destination === "PAID" ? "Nota ligada ao pagamento que já saiu do banco: nenhuma conta nova foi criada."
    : r.destination === "IGNORED" ? "Nota marcada como sem lançamento."
    : `Conta a pagar ${r.title_number} criada em rascunho, já classificada. Aprove em Contas a pagar.`;
  redirect(`${notePath(key)}?ok=${encodeURIComponent(ok)}`);
}

export async function reopenDfeDestinationAction(formData: FormData) {
  const key = str(formData.get("key"));
  const supabase = await createClient();
  const { error } = await supabase.schema("fiscal").rpc("reopen_dfe_destination", { p_id: str(formData.get("id")) });
  revalidatePath(LIST);
  revalidatePath("/financeiro", "layout");
  redirect(`${notePath(key)}?${new URLSearchParams(error ? { erro: friendly(error.message) } : { ok: "Destino desfeito: escolha de novo." })}`);
}

export async function requestDfeTriageAction(formData: FormData) {
  const key = str(formData.get("key"));
  const supabase = await createClient();
  const { error } = await supabase.schema("fiscal").rpc("request_dfe_triage", { p_id: str(formData.get("id")) });
  revalidatePath(LIST);
  redirect(`${notePath(key)}?${new URLSearchParams(error ? { erro: friendly(error.message) } : { ok: "A IA está analisando a nota de novo." })}`);
}
