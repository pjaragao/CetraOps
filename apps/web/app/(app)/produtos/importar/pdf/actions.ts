"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { Json } from "@centralops/db";
import { createClient } from "@/lib/supabase/server";
import { getSession } from "@/lib/session";

const friendly = (m: string) => m.replace(/^ERROR:\s*/, "");
const uuid = z.string().uuid();

const groupSchema = z.object({
  product: z.union([z.object({ id: uuid }), z.object({ reference: z.string().trim().min(1).max(40), name: z.string().trim().min(2).max(120), gender: z.enum(["FEM", "MASC", "UNISSEX"]) })]),
  color: z.union([z.object({ id: uuid }), z.object({ name: z.string().trim().min(1).max(60), code: z.string().trim().max(10) })]),
  sizes: z.array(z.string().trim().min(1).max(10)).min(1).max(20),
  composition: z.string().max(200).nullable(),
  wholesale_cost: z.number().min(0).max(1000000).nullable(),
  price: z.number().min(0).max(1000000).nullable(),
  backorder: z.boolean(),
});
export type CatalogGroupInput = z.input<typeof groupSchema>;
export type GroupResult = { ok: true; product_id: string; color_id: string; created: number; errors: string[] } | { ok: false; error: string };

/** Um modelo × cor do catálogo em PDF: produto (existente ou novo), cor, uma variação por tamanho da grade, composição, atacado e preço. */
export async function applyCatalogGroup(input: CatalogGroupInput): Promise<GroupResult> {
  const parsed = groupSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: `Confira: ${parsed.error.issues[0]?.path.join(".")}` };
  const g = parsed.data;
  const base = {
    ...("id" in g.product ? { product_id: g.product.id } : { reference: g.product.reference, name: g.product.name, gender: g.product.gender }),
    ...("id" in g.color ? { color_id: g.color.id } : { color_name: g.color.name, color_code: g.color.code }),
    composition: g.composition ?? "", wholesale_cost: g.wholesale_cost ?? "", price: g.price ?? "", backorder: g.backorder,
  };
  const supabase = await createClient();
  const { data, error } = await supabase.schema("catalog").rpc("apply_brand_items", { p: g.sizes.map((size) => ({ ...base, size })) as unknown as Json });
  if (error) return { ok: false, error: friendly(error.message) };
  const res = data as unknown as { items: { product_id: string; color_id: string }[]; erros: { i: number; erro: string }[]; variantes_novas: number };
  revalidatePath("/produtos", "layout");
  if (!res.items.length) return { ok: false, error: res.erros[0]?.erro ?? "Nada gravado" };
  return { ok: true, product_id: res.items[0].product_id, color_id: res.items[0].color_id, created: res.variantes_novas, errors: res.erros.map((e) => `${g.sizes[e.i - 1]}: ${e.erro}`) };
}

const MAX_PHOTO = 4_000_000;

/** Fotos do PDF (já em JPEG, reduzidas no navegador) → bucket público do catálogo, ligadas ao produto e à cor. Foto repetida é ignorada. */
export async function addCatalogPhotos(formData: FormData): Promise<{ ok: boolean; added?: number; error?: string }> {
  const productId = String(formData.get("product_id") ?? "");
  const colorId = String(formData.get("color_id") ?? "");
  if (!uuid.safeParse(productId).success || !uuid.safeParse(colorId).success) return { ok: false, error: "Produto ou cor inválidos" };
  const files = formData.getAll("file").filter((f): f is File => f instanceof File && f.size > 0);
  const hashes = formData.getAll("hash").map(String);
  if (files.length !== hashes.length || files.length > 30) return { ok: false, error: "Fotos inválidas" };
  const s = await getSession();
  const supabase = await createClient();
  const [{ data: prod }, { data: color }, { data: existing }] = await Promise.all([
    supabase.schema("catalog").from("products").select("id, reference_code").eq("id", productId).maybeSingle(),
    supabase.schema("catalog").from("colors").select("id, code").eq("id", colorId).maybeSingle(),
    supabase.schema("catalog").from("product_media").select("content_hash, position").eq("product_id", productId),
  ]);
  if (!prod || !color) return { ok: false, error: "Produto ou cor não encontrados" };
  const known = new Set((existing ?? []).map((m) => m.content_hash).filter(Boolean));
  let position = Math.max(-1, ...(existing ?? []).map((m) => m.position)) + 1;
  let added = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i], hash = hashes[i];
    if (!/^[0-9a-f]{20}$/.test(hash) || known.has(hash)) continue;
    if (f.type !== "image/jpeg" || f.size > MAX_PHOTO) return { ok: false, error: "Foto fora do formato esperado (JPEG até 4 MB)" };
    const path = `${s.orgId}/${prod.reference_code}/${color.code ?? "sem-cor"}/${hash}.jpg`;
    const up = await supabase.storage.from("catalog-media").upload(path, f, { contentType: "image/jpeg", upsert: true, cacheControl: "31536000" });
    if (up.error) return { ok: false, added, error: `Envio da foto: ${up.error.message}` };
    const { error } = await supabase.schema("catalog").from("product_media").insert({
      org_id: s.orgId, product_id: prod.id, color_id: color.id, storage_path: path, position: position++, content_hash: hash, bytes: f.size, mirrored_at: new Date().toISOString(),
    });
    if (error) return { ok: false, added, error: friendly(error.message) };
    known.add(hash);
    added++;
  }
  revalidatePath(`/produtos/${prod.id}`);
  return { ok: true, added };
}
