"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { Json } from "@centralops/db";
import { createClient } from "@/lib/supabase/server";
import { getSession } from "@/lib/session";

export type State = { ok: boolean; error?: string; message?: string } | null;
export type ActionResult = { ok: boolean; error?: string };

const friendly = (m: string) => m.replace(/^ERROR:\s*/, "");
const str = (v: FormDataEntryValue | null) => String(v ?? "").trim();
const uuid = z.string().uuid();

function back(path: string, params: Record<string, string | undefined> = {}): never {
  const q = Object.entries(params).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v!)}`).join("&");
  redirect(q ? `${path}${path.includes("?") ? "&" : "?"}${q}` : path);
}

const refresh = () => {
  revalidatePath("/produtos", "layout");
  revalidatePath("/financeiro", "layout");
  revalidatePath("/fiscal", "layout");
};

// ---------------------------------------------------------------------
// Recebimento de NF-e
// ---------------------------------------------------------------------

/** Importa um ou mais XMLs de NF-e (nfeProc). Um só arquivo abre direto a conferência. */
export async function importNfeAction(formData: FormData) {
  const supabase = await createClient();
  const location = str(formData.get("location_id"));
  const po = str(formData.get("po_id")) || null;
  const files = formData.getAll("file").filter((f): f is File => f instanceof File && f.size > 0);
  if (!location) back("/produtos/recebimento", { erro: "Escolha o local de recebimento" });
  if (files.length === 0) back("/produtos/recebimento", { erro: "Escolha o(s) arquivo(s) XML da NF-e" });

  const done: { id: string; number: string }[] = [];
  const errors: string[] = [];
  for (const f of files) {
    if (f.size > 2_000_000) { errors.push(`${f.name}: arquivo maior que 2 MB`); continue; }
    const xml = await f.text();
    const { data, error } = await supabase.schema("purch").rpc("import_nfe", { p_xml: xml, p_location: location, ...(po ? { p_po: po } : {}) });
    if (error) errors.push(`${f.name}: ${friendly(error.message)}`);
    else done.push({ id: (data as unknown as { id: string }).id, number: (data as unknown as { number: string }).number });
  }
  refresh();
  if (done.length === 1 && errors.length === 0) back(`/produtos/recebimento/${done[0].id}`, { ok: `NF-e importada (${done[0].number}): confira os itens` });
  back("/produtos/recebimento", {
    ...(done.length ? { ok: `${done.length} nota(s) importada(s): ${done.map((d) => d.number).join(", ")}` } : {}),
    ...(errors.length ? { erro: errors.join(" · ") } : {}),
  });
}

/** Busca variantes por SKU/EAN/nome (usada pelo seletor da conferência). */
export async function searchVariants(q: string): Promise<{ id: string; sku: string; label: string; gtin: string | null }[]> {
  const term = q.trim().replace(/[%,()"'\\]/g, " ");
  if (term.length < 2) return [];
  const supabase = await createClient();
  const digits = term.replace(/\D/g, "");
  const [bySku, byProduct] = await Promise.all([
    supabase.schema("catalog").from("variants").select("id, sku, gtin, size, product_id, color_id").eq("active", true)
      .or(digits.length >= 8 ? `sku.ilike.%${term}%,gtin.eq.${digits}` : `sku.ilike.%${term}%`).limit(12),
    supabase.schema("catalog").from("products").select("id, name, reference_code").or(`name.ilike.%${term}%,reference_code.ilike.%${term}%`).limit(6),
  ]);
  const prodIds = new Set([...(bySku.data ?? []).map((v) => v.product_id), ...(byProduct.data ?? []).map((p) => p.id)]);
  const [{ data: products }, { data: variants }, { data: colors }] = await Promise.all([
    prodIds.size ? supabase.schema("catalog").from("products").select("id, name").in("id", [...prodIds]) : Promise.resolve({ data: [] as { id: string; name: string }[] }),
    (byProduct.data ?? []).length
      ? supabase.schema("catalog").from("variants").select("id, sku, gtin, size, product_id, color_id").eq("active", true).in("product_id", (byProduct.data ?? []).map((p) => p.id)).limit(24)
      : Promise.resolve({ data: [] as { id: string; sku: string; gtin: string | null; size: string; product_id: string; color_id: string | null }[] }),
    supabase.schema("catalog").from("colors").select("id, name"),
  ]);
  const pname = new Map((products ?? []).map((p) => [p.id, p.name]));
  const cname = new Map((colors ?? []).map((c) => [c.id, c.name]));
  const all = new Map<string, { id: string; sku: string; label: string; gtin: string | null }>();
  for (const v of [...(bySku.data ?? []), ...(variants ?? [])]) {
    all.set(v.id, { id: v.id, sku: v.sku, gtin: v.gtin, label: `${pname.get(v.product_id) ?? ""} · ${v.color_id ? cname.get(v.color_id) ?? "" : "—"} · ${v.size}` });
  }
  return [...all.values()].slice(0, 20);
}

const itemSchema = z.object({ variant_id: uuid.nullable().optional(), qty_counted: z.number().min(0).nullable().optional(), learn: z.boolean().optional() });

/** Vincula variante e/ou quantidade contada de um item da nota (chamada pela grade de conferência). */
export async function setReceiptItem(itemId: string, patch: { variant_id?: string | null; qty_counted?: number | null; learn?: boolean }): Promise<ActionResult> {
  const parsed = itemSchema.safeParse(patch);
  if (!uuid.safeParse(itemId).success || !parsed.success) return { ok: false, error: "Dados inválidos" };
  const supabase = await createClient();
  const { error } = await supabase.schema("purch").rpc("set_receipt_item", { p_item: itemId, p: parsed.data as unknown as Json });
  if (error) return { ok: false, error: friendly(error.message) };
  return { ok: true };
}

const newProductSchema = z.object({
  reference_code: z.string().min(1).max(40), name: z.string().min(2).max(120), gender: z.enum(["FEM", "MASC", "UNISSEX"]),
  color: z.string().min(1).max(40), size: z.string().min(1).max(10), category: z.string().max(60).optional(), price: z.number().positive().optional(),
});

/** Cadastra rapidamente o produto/variante de um item da nota que ainda não existe no catálogo e já vincula. */
export async function createProductFromItem(itemId: string, input: z.input<typeof newProductSchema>): Promise<ActionResult> {
  const parsed = newProductSchema.safeParse(input);
  if (!uuid.safeParse(itemId).success || !parsed.success) return { ok: false, error: parsed.success ? "Item inválido" : `Confira os campos: ${parsed.error.issues[0]?.path.join(".")}` };
  const supabase = await createClient();
  const { data: item } = await supabase.schema("purch").from("receipt_items").select("id, cean, ncm").eq("id", itemId).maybeSingle();
  if (!item) return { ok: false, error: "Item não encontrado" };
  const p = parsed.data;
  const gtin = /^\d{8,14}$/.test(item.cean ?? "") ? item.cean : null;
  const { data, error } = await supabase.schema("catalog").rpc("import_rows", {
    p: [{ reference_code: p.reference_code, name: p.name, gender: p.gender, category: p.category ?? "", ncm: item.ncm ?? "", color: p.color, size: p.size, gtin: gtin ?? "", price: p.price ?? "" }] as unknown as Json,
  });
  if (error) return { ok: false, error: friendly(error.message) };
  const res = data as unknown as { erros: { erro: string }[] };
  if (res.erros?.length) return { ok: false, error: res.erros[0].erro };
  const [{ data: prod }, { data: col }] = await Promise.all([
    supabase.schema("catalog").from("products").select("id").eq("reference_code", p.reference_code.trim().toUpperCase()).maybeSingle(),
    supabase.schema("catalog").from("colors").select("id").eq("name", p.color.trim()).maybeSingle(),
  ]);
  const { data: variant } = prod && col
    ? await supabase.schema("catalog").from("variants").select("id").eq("product_id", prod.id).eq("color_id", col.id).eq("size", p.size.trim().toUpperCase()).maybeSingle()
    : { data: null };
  if (!variant) return { ok: false, error: "Produto criado, mas não foi possível localizar a variante: vincule manualmente" };
  return setReceiptItem(itemId, { variant_id: variant.id, learn: true });
}

const variantSchema = z.object({
  product_id: uuid, color: z.string().trim().min(1).max(40), color_code: z.string().trim().max(10).optional(), size: z.string().trim().min(1).max(10), sku: z.string().trim().max(40).optional(),
});

/** Nova variação (cor/tamanho) de um produto que já existe, a partir do item da nota, e já vincula. A cor nova entra no cadastro de cores;
 * o SKU segue o padrão do catálogo (referência + código da cor + tamanho) e o NCM da nota preenche o produto que ainda não tem. */
export async function addVariantFromItem(itemId: string, input: z.input<typeof variantSchema>): Promise<ActionResult> {
  const parsed = variantSchema.safeParse(input);
  if (!uuid.safeParse(itemId).success || !parsed.success) return { ok: false, error: parsed.success ? "Item inválido" : `Confira os campos: ${parsed.error.issues[0]?.path.join(".")}` };
  const s = await getSession();
  const supabase = await createClient();
  const p = parsed.data;
  const size = p.size.toUpperCase();
  const [{ data: item }, { data: prod }] = await Promise.all([
    supabase.schema("purch").from("receipt_items").select("id, cean, ncm").eq("id", itemId).maybeSingle(),
    supabase.schema("catalog").from("products").select("id, reference_code, ncm").eq("id", p.product_id).maybeSingle(),
  ]);
  if (!item || !prod) return { ok: false, error: "Item ou produto não encontrado" };

  let { data: color } = await supabase.schema("catalog").from("colors").select("id, code").ilike("name", p.color).maybeSingle();
  if (!color) {
    const code = (p.color_code || p.color.normalize("NFD").replace(/[^a-zA-Z0-9]/g, "").slice(0, 3)).toUpperCase();
    const { data: created, error } = await supabase.schema("catalog").from("colors").insert({ org_id: s.orgId, name: p.color, code }).select("id, code").single();
    if (error) return { ok: false, error: `Não foi possível cadastrar a cor: ${friendly(error.message)}` };
    color = created;
  }
  let { data: variant } = await supabase.schema("catalog").from("variants").select("id").eq("product_id", prod.id).eq("color_id", color.id).eq("size", size).maybeSingle();
  if (!variant) {
    const gtin = /^\d{8,14}$/.test(item.cean ?? "") && !/^0+$/.test(item.cean ?? "") ? item.cean : null;
    const sku = (p.sku || `${prod.reference_code}${color.code ?? ""}${size}`).toUpperCase();
    const { data: created, error } = await supabase.schema("catalog").from("variants")
      .insert({ org_id: s.orgId, product_id: prod.id, color_id: color.id, size, sku, gtin }).select("id").single();
    if (error) return { ok: false, error: /duplicate|unique/i.test(error.message) ? `Já existe uma variação com o SKU ${sku} ou o mesmo código de barras: ajuste o SKU` : friendly(error.message) };
    variant = created;
  }
  if (!prod.ncm && /^\d{8}$/.test(item.ncm ?? "")) await supabase.schema("catalog").from("products").update({ ncm: item.ncm }).eq("id", prod.id);
  return setReceiptItem(itemId, { variant_id: variant.id, learn: true });
}

export async function acceptSuggestionsAction(formData: FormData) {
  const id = str(formData.get("receipt_id"));
  const supabase = await createClient();
  const { data, error } = await supabase.schema("purch").rpc("accept_suggestions", { p_receipt: id });
  revalidatePath(`/produtos/recebimento/${id}`);
  back(`/produtos/recebimento/${id}`, error ? { erro: friendly(error.message) } : { ok: `${data} sugestão(ões) confirmada(s)` });
}

export async function countAllAction(formData: FormData) {
  const id = str(formData.get("receipt_id"));
  const supabase = await createClient();
  const { data, error } = await supabase.schema("purch").rpc("count_all", { p_receipt: id });
  revalidatePath(`/produtos/recebimento/${id}`);
  back(`/produtos/recebimento/${id}`, error ? { erro: friendly(error.message) } : { ok: `${data} item(ns) igualado(s) à nota` });
}

export async function confirmReceiptAction(formData: FormData) {
  const id = str(formData.get("receipt_id"));
  const supabase = await createClient();
  const { error } = await supabase.schema("purch").rpc("confirm_receipt", { p_receipt: id });
  revalidatePath(`/produtos/recebimento/${id}`);
  back(`/produtos/recebimento/${id}`, error ? { erro: friendly(error.message) } : { ok: "Conferência confirmada: revise os vencimentos e lance no estoque" });
}

export async function postReceiptAction(formData: FormData) {
  const id = str(formData.get("receipt_id"));
  const dues = formData.getAll("due_date").map(String);
  const amounts = formData.getAll("amount").map((v) => Number(String(v).replace(/\./g, "").replace(",", ".")));
  const installments = dues.map((d, i) => ({ due_date: d, amount: amounts[i] })).filter((x) => x.due_date && x.amount > 0);
  const supabase = await createClient();
  const { error } = await supabase.schema("purch").rpc("post_receipt", { p_receipt: id, ...(installments.length ? { p_installments: installments as unknown as Json } : {}) });
  refresh();
  back(`/produtos/recebimento/${id}`, error ? { erro: friendly(error.message) } : { ok: "Recebimento lançado: estoque, contas a pagar e contabilidade atualizados" });
}

export async function reverseReceiptAction(formData: FormData) {
  const id = str(formData.get("receipt_id"));
  const supabase = await createClient();
  const { error } = await supabase.schema("purch").rpc("reverse_receipt", { p_receipt: id, p_reason: str(formData.get("reason")) });
  refresh();
  back(`/produtos/recebimento/${id}`, error ? { erro: friendly(error.message) } : { ok: "Recebimento estornado: refaça a conferência" });
}

export async function discardReceiptAction(formData: FormData) {
  const id = str(formData.get("receipt_id"));
  const supabase = await createClient();
  const { error } = await supabase.schema("purch").rpc("discard_receipt", { p_receipt: id });
  refresh();
  if (error) back(`/produtos/recebimento/${id}`, { erro: friendly(error.message) });
  back("/produtos/recebimento", { ok: "Recebimento descartado" });
}

// ---------------------------------------------------------------------
// Pedidos de compra
// ---------------------------------------------------------------------
const poSchema = z.object({
  id: uuid.optional(), legal_entity_id: uuid, location_id: uuid, supplier_party_id: uuid,
  expected_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), payment_terms_id: uuid.optional(), collection_id: uuid.optional(), notes: z.string().max(500).optional(),
  items: z.array(z.object({ variant_id: uuid, qty: z.number().positive().max(100000), unit_cost: z.number().min(0).max(1000000) })).min(1).max(500),
});

export async function savePoAction(_prev: State, formData: FormData): Promise<State> {
  let raw: unknown;
  try { raw = JSON.parse(String(formData.get("payload") ?? "")); } catch { return { ok: false, error: "Dados inválidos" }; }
  const parsed = poSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: `Confira o pedido: ${parsed.error.issues[0]?.path.join(".")} — ${parsed.error.issues[0]?.message}` };
  const supabase = await createClient();
  const { data, error } = await supabase.schema("purch").rpc("save_po", { p: parsed.data as unknown as Json });
  if (error) return { ok: false, error: friendly(error.message) };
  revalidatePath("/produtos", "layout");
  return back(`/produtos/compras/${(data as unknown as { id: string }).id}`, { ok: "Pedido salvo" });
}

async function poRpc(fn: "approve_po" | "close_po", formData: FormData, okMsg: string) {
  const id = str(formData.get("po_id"));
  const supabase = await createClient();
  const { error } = await supabase.schema("purch").rpc(fn, { p_po: id });
  revalidatePath("/produtos", "layout");
  back(`/produtos/compras/${id}`, error ? { erro: friendly(error.message) } : { ok: okMsg });
}
export async function approvePoAction(formData: FormData) { return poRpc("approve_po", formData, "Pedido aprovado"); }
export async function closePoAction(formData: FormData) { return poRpc("close_po", formData, "Pedido encerrado (o saldo foi cancelado)"); }

export async function cancelPoAction(formData: FormData) {
  const id = str(formData.get("po_id"));
  const supabase = await createClient();
  const { error } = await supabase.schema("purch").rpc("cancel_po", { p_po: id, p_reason: str(formData.get("reason")) });
  revalidatePath("/produtos", "layout");
  back(`/produtos/compras/${id}`, error ? { erro: friendly(error.message) } : { ok: "Pedido cancelado" });
}

/** Cadastra um fornecedor pelo CNPJ (cadastro único, papel SUPPLIER) e devolve o id para o pedido. */
export async function ensureSupplier(cnpj: string, name: string): Promise<{ ok: boolean; error?: string; id?: string }> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema("purch").rpc("ensure_supplier", { p_cnpj: cnpj, p_name: name });
  if (error) return { ok: false, error: friendly(error.message) };
  revalidatePath("/produtos", "layout");
  return { ok: true, id: data as unknown as string };
}
