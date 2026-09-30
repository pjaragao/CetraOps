"use server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getSession } from "@/lib/session";

/** Marca como lidas todas as notificações do próprio membro (o RLS também impede mexer nas dos outros). */
export async function markAllNotificationsRead() {
  const s = await getSession();
  const supabase = await createClient();
  await supabase.schema("core").from("notifications").update({ read_at: new Date().toISOString() }).eq("member_id", s.memberId).is("read_at", null);
  revalidatePath("/notificacoes");
}
