"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

const row = z.object({
  // Campos obrigatórios são checados linha a linha no banco (linhas inválidas voltam como erro, sem barrar as demais)
  reference_code: z.string().max(40),
  name: z.string().max(160),
  gender: z.enum(["FEM", "MASC", "UNISSEX"]),
  category: z.string().max(80),
  ncm: z.string().max(10),
  color: z.string().max(60),
  size: z.string().max(10),
  gtin: z.string().max(14),
  price: z.string().max(20),
  qty: z.string().max(10),
  cost: z.string().max(20),
  brand: z.string().max(80),
  collection: z.string().max(80),
});
export type ImportRow = z.infer<typeof row>;

type Result = { linhas: number; produtos: number; variantes: number; precos: number; estoque?: number; erros: { linha: number; erro: string }[] } | { error: string };

export async function importCatalog(rows: ImportRow[], locationId?: string): Promise<Result> {
  const parsed = z.array(row).max(5000).safeParse(rows);
  if (!parsed.success) return { error: "Planilha inválida: confira o cabeçalho e o tamanho dos campos (máx. 5.000 linhas)." };
  const supabase = await createClient();
  if (locationId !== undefined && !z.string().uuid().safeParse(locationId).success) return { error: "Escolha o local do estoque" };
  const { data, error } = await supabase.schema("catalog").rpc("import_rows", { p: parsed.data, p_location: locationId });
  if (error) return { error: error.message };
  revalidatePath("/produtos");
  revalidatePath("/vender/pdv");
  revalidatePath("/produtos/estoque");
  return data as Result;
}
