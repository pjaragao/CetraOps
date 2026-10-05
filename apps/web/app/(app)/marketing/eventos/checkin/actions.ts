"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { Json } from "@centralops/db";
import { createClient } from "@/lib/supabase/server";

const friendly = (m: string) => m.replace(/^ERROR:\s*/, "");
const str = (v: FormDataEntryValue | null) => String(v ?? "").trim();
const PATH = "/marketing/eventos/checkin";

function go(params: Record<string, string | undefined>): never {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString();
  redirect(q ? `${PATH}?${q}` : PATH);
}

export async function checkinAction(formData: FormData) {
  const supabase = await createClient();
  const token = str(formData.get("token"));
  const plus = str(formData.get("plus_ones"));
  const { data, error } = await supabase.schema("mkt").rpc("checkin_by_token", { p_token: token, ...(plus ? { p_plus_ones: Number(plus) } : {}) });
  revalidatePath("/marketing/eventos", "layout");
  if (error) go({ t: token, erro: friendly(error.message) });
  const r = data as unknown as { already: boolean; name: string; event: string };
  go({ ok: r.already ? `${r.name} já tinha feito o check-in em ${r.event}.` : `Presença de ${r.name} confirmada em ${r.event}.` });
}

export async function walkinAction(formData: FormData) {
  const supabase = await createClient();
  const event = str(formData.get("event_id"));
  const { error } = await supabase.schema("mkt").rpc("checkin_walkin", { p: {
    event_id: event, name: str(formData.get("name")), phone: str(formData.get("phone")), accept_marketing: formData.get("accept_marketing") === "on",
    plus_ones: Number(str(formData.get("plus_ones")) || 0),
  } as Json });
  revalidatePath("/marketing/eventos", "layout");
  go(error ? { erro: friendly(error.message), evento: event } : { ok: "Cadastrada e presença confirmada.", evento: event });
}
