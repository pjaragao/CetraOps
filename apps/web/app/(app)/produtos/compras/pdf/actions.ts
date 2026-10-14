"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { Json } from "@centralops/db";
import { createClient } from "@/lib/supabase/server";
import { can, getSession } from "@/lib/session";
import { resolveItems } from "../options";
import type { PoItem } from "../po-editor";

export type LineStatus = "OK" | "NEW_VARIANT" | "NEW_COLOR" | "NEW_PRODUCT" | "UNKNOWN";
export interface LineCheck { code: string; status: LineStatus; variant_id: string | null; product: string | null; color: string | null }

const friendly = (m: string) => m.replace(/^ERROR:\s*/, "");
const lineSchema = z.object({
  code: z.string().trim().min(1).max(40), model: z.string().max(20).nullable(), colorCode: z.string().max(10).nullable(),
  size: z.string().max(10), color: z.string().max(60), description: z.string().max(160),
});

/** Situação de cada linha do PDF no catálogo: já existe, falta a variação/cor ou falta o produto. Nada é gravado aqui. */
export async function checkOrderLines(input: z.input<typeof lineSchema>[]): Promise<LineCheck[] | { error: string }> {
  const parsed = z.array(lineSchema).max(2000).safeParse(input);
  if (!parsed.success) return { error: "Linhas inválidas" };
  const lines = parsed.data;
  const supabase = await createClient();
  const codes = [...new Set(lines.map((l) => l.code.toUpperCase()))];
  const models = [...new Set(lines.flatMap((l) => (l.model ? [l.model] : [])))];
  const colorCodes = [...new Set(lines.flatMap((l) => (l.colorCode ? [l.colorCode] : [])))];
  const chunks = <T,>(a: T[]) => Array.from({ length: Math.ceil(a.length / 50) }, (_, i) => a.slice(i * 50, i * 50 + 50));
  const [bySku, bySupplier, products, colors] = await Promise.all([
    Promise.all(chunks(codes).map((c) => supabase.schema("catalog").from("variants").select("id, sku, product_id, color_id").in("sku", c))),
    Promise.all(chunks(codes).map((c) => supabase.schema("catalog").from("variants").select("id, supplier_sku, product_id, color_id").in("supplier_sku", c))),
    models.length ? supabase.schema("catalog").from("products").select("id, reference_code, name").in("reference_code", models) : Promise.resolve({ data: [] as { id: string; reference_code: string; name: string }[] }),
    supabase.schema("catalog").from("colors").select("id, code, name"),
  ]);
  const variant = new Map<string, { id: string; product_id: string; color_id: string | null }>();
  for (const r of bySupplier) for (const v of r.data ?? []) if (v.supplier_sku) variant.set(v.supplier_sku.toUpperCase(), v);
  for (const r of bySku) for (const v of r.data ?? []) variant.set(v.sku.toUpperCase(), v);
  const prodByRef = new Map((products.data ?? []).map((p) => [p.reference_code, p]));
  const prodById = new Map((products.data ?? []).map((p) => [p.id, p]));
  const colorById = new Map((colors.data ?? []).map((c) => [c.id, c]));
  const colorByCode = new Map((colors.data ?? []).filter((c) => c.code && colorCodes.includes(c.code)).map((c) => [c.code!, c]));

  // produto achado só pela variante (nome para exibir)
  const missingProd = [...new Set([...variant.values()].map((v) => v.product_id).filter((id) => !prodById.has(id)))];
  if (missingProd.length) {
    const { data } = await supabase.schema("catalog").from("products").select("id, reference_code, name").in("id", missingProd.slice(0, 200));
    for (const p of data ?? []) prodById.set(p.id, p);
  }

  return lines.map((l) => {
    const v = variant.get(l.code.toUpperCase());
    if (v) return { code: l.code, status: "OK", variant_id: v.id, product: prodById.get(v.product_id)?.name ?? null, color: v.color_id ? colorById.get(v.color_id)?.name ?? null : null };
    const prod = l.model ? prodByRef.get(l.model) : undefined;
    const color = l.colorCode ? colorByCode.get(l.colorCode) : undefined;
    if (!l.model || !l.colorCode || !l.size) return { code: l.code, status: "UNKNOWN", variant_id: null, product: null, color: null };
    if (!prod) return { code: l.code, status: "NEW_PRODUCT", variant_id: null, product: null, color: color?.name ?? null };
    return { code: l.code, status: color ? "NEW_VARIANT" : "NEW_COLOR", variant_id: null, product: prod.name, color: color?.name ?? null };
  });
}

const applySchema = z.object({
  lines: z.array(lineSchema.extend({ qty: z.number().positive().max(100000), unitCost: z.number().min(0).max(1000000) })).min(1).max(2000),
  /** arquivo e número do pedido: ficam como origem do que for cadastrado */
  document: z.string().trim().max(300),
  /** nome (e gênero) dos modelos que ainda não existem no catálogo */
  newProducts: z.record(z.string(), z.object({ name: z.string().trim().min(2).max(120), gender: z.enum(["FEM", "MASC", "UNISSEX"]) })),
});

/**
 * Cadastra o que falta (cor pelo código da marca, variação, produto novo), guarda o preço de atacado de cada modelo e devolve os itens do
 * pedido de compra. Linha fora do padrão de código que não existe no catálogo volta como erro (adicione a peça no pedido pela busca).
 */
export async function prepareOrderItems(input: z.input<typeof applySchema>): Promise<{ items: PoItem[]; errors: string[]; created: { produtos: number; cores: number; variantes: number } } | { error: string }> {
  const parsed = applySchema.safeParse(input);
  if (!parsed.success) return { error: `Confira as linhas: ${parsed.error.issues[0]?.path.join(".")}` };
  const session = await getSession();
  const { lines, newProducts, document } = parsed.data;
  const checks = await checkOrderLines(lines);
  if ("error" in checks) return checks;

  const errors: string[] = [];
  const variantOf = new Map<number, string>();
  checks.forEach((c, i) => { if (c.variant_id) variantOf.set(i, c.variant_id); });

  // todas as linhas no padrão da marca passam pela função: cria o que falta e atualiza o atacado (variação existente é só achada)
  const toApply = lines.map((l, i) => ({ l, i, c: checks[i] })).filter(({ c }) => c.status !== "UNKNOWN");
  const needsCatalog = toApply.some(({ c }) => c.status !== "OK");
  let created = { produtos: 0, cores: 0, variantes: 0 };
  if (toApply.length && can(session, "catalog.write")) {
    const supabase = await createClient();
    const payload = toApply.map(({ l }) => ({
      reference: l.model, color_code: l.colorCode, color_name: l.color, size: l.size, supplier_sku: l.code, wholesale_cost: l.unitCost,
      source: "PDF_PEDIDO", document,
      ...(l.model && newProducts[l.model] ? { name: newProducts[l.model].name, gender: newProducts[l.model].gender } : {}),
    }));
    const { data, error } = await supabase.schema("catalog").rpc("apply_brand_items", { p: payload as unknown as Json });
    if (error) return { error: friendly(error.message) };
    const res = data as unknown as { items: { i: number; variant_id: string }[]; erros: { i: number; erro: string }[]; produtos_novos: number; cores_novas: number; variantes_novas: number };
    for (const it of res.items) variantOf.set(toApply[it.i - 1].i, it.variant_id);
    for (const e of res.erros) errors.push(`${toApply[e.i - 1].l.code}: ${e.erro}`);
    created = { produtos: res.produtos_novos, cores: res.cores_novas, variantes: res.variantes_novas };
    revalidatePath("/produtos", "layout");
  } else if (needsCatalog) {
    errors.push("Há peças que ainda não estão no catálogo e você não tem permissão para cadastrá-las: peça a quem cuida do catálogo ou adicione pela busca");
  }
  checks.forEach((c, i) => { if (c.status === "UNKNOWN") errors.push(`${lines[i].code}: código fora do padrão da marca e não encontrado no catálogo — adicione a peça pela busca`); });

  // mesma variação em duas linhas do PDF vira um item só (soma a quantidade)
  const rows = new Map<string, { variant_id: string; qty: number; unit_cost: number }>();
  lines.forEach((l, i) => {
    const v = variantOf.get(i);
    if (!v) return;
    const cur = rows.get(v);
    if (cur) cur.qty += l.qty; else rows.set(v, { variant_id: v, qty: l.qty, unit_cost: l.unitCost });
  });
  return { items: await resolveItems([...rows.values()]), errors, created };
}
