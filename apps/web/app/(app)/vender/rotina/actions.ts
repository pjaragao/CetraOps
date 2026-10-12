"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { Json } from "@centralops/db";
import { createClient } from "@/lib/supabase/server";

const friendly = (m: string) => m.replace(/^ERROR:\s*/, "");
const kindSchema = z.enum(["OPENING", "CLOSING"]);

export async function checkRoutineItem(storeId: string, kind: "OPENING" | "CLOSING", key: string, done: boolean): Promise<{ ok: boolean; error?: string }> {
  if (!z.string().uuid().safeParse(storeId).success || !kindSchema.safeParse(kind).success || !/^[a-z0-9_]{1,30}$/.test(key)) return { ok: false, error: "Dados inválidos" };
  const supabase = await createClient();
  const { error } = await supabase.schema("sales").rpc("routine_check", { p_store: storeId, p_kind: kind, p_key: key, p_done: done });
  if (error) return { ok: false, error: friendly(error.message) };
  revalidatePath("/vender/rotina");
  return { ok: true };
}

export async function completeRoutineAction(formData: FormData) {
  const store = String(formData.get("store_id") ?? ""), kind = String(formData.get("kind") ?? "");
  const supabase = await createClient();
  const { data, error } = await supabase.schema("sales").rpc("routine_complete", { p_store: store, p_kind: kind, p_notes: String(formData.get("notes") ?? "") || undefined });
  revalidatePath("/vender/rotina");
  revalidatePath("/inicio");
  const pending = ((data as unknown as { pending?: string[] } | null)?.pending ?? []).length;
  redirect(`/vender/rotina?r=${kind}&${error ? `erro=${encodeURIComponent(friendly(error.message))}` : `ok=${encodeURIComponent(
    kind === "CLOSING" ? `Fechamento registrado${pending ? ` com ${pending} pendência(s)` : ""}: os sócios foram avisados` : `Abertura registrada${pending ? ` com ${pending} pendência(s)` : ""}`)}`}`);
}

/** Modelo da rotina (itens marcados à mão): uma linha por item. */
export async function saveRoutineTemplateAction(formData: FormData) {
  const toItems = (text: string) => text.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 20).map((label, i) => ({
    key: (label.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 24) || "item") + `_${i + 1}`,
    label: label.slice(0, 140),
  }));
  const supabase = await createClient();
  const { error } = await supabase.schema("sales").rpc("save_routine_template", { p: {
    opening: toItems(String(formData.get("opening") ?? "")), closing: toItems(String(formData.get("closing") ?? "")),
  } as unknown as Json });
  revalidatePath("/vender/rotina");
  redirect(`/vender/rotina?${error ? `erro=${encodeURIComponent(friendly(error.message))}` : "ok=Rotina%20atualizada"}`);
}
