import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@centralops/db";

/** Acha a cliente pelo que a pessoa digitou (nome ou parte dele, ou o telefone). Devolve o id, ou o motivo de não ter achado uma só. */
export async function findParty(supabase: SupabaseClient<Database>, text: string): Promise<{ id: string } | { error: string }> {
  const q = text.replace(/[%,()]/g, " ").trim();
  if (q.length < 2) return { error: "Informe o nome da cliente." };
  const crm = supabase.schema("crm");
  const digits = q.replace(/\D/g, "");
  if (digits.length >= 8) {
    const { data } = await crm.from("party_contact_points").select("party_id").like("value_normalized", `%${digits.slice(-9)}`).limit(2);
    const ids = [...new Set((data ?? []).map((r) => r.party_id))];
    if (ids.length === 1) return { id: ids[0] };
    if (ids.length > 1) return { error: "Mais de uma cliente com esse telefone: busque pelo nome." };
  }
  const { data } = await crm.from("parties").select("id, display_name").is("merged_into_id", null).ilike("display_name", `%${q}%`).order("display_name").limit(6);
  const rows = data ?? [];
  const exact = rows.filter((r) => r.display_name.toLowerCase() === q.toLowerCase());
  if (exact.length === 1) return { id: exact[0].id };
  if (rows.length === 1) return { id: rows[0].id };
  if (rows.length === 0) return { error: `Não achei nenhuma cliente com «${q}». Cadastre em Clientes antes.` };
  return { error: `Mais de uma cliente combina com «${q}» (${rows.slice(0, 4).map((r) => r.display_name).join(", ")}…). Escreva o nome completo.` };
}

/** Data (yyyy-mm-dd) e hora opcional (hh:mm) digitadas no fuso de São Paulo → instante ISO. */
export function dueAt(date: string, time?: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return `${date}T${/^\d{2}:\d{2}$/.test(time ?? "") ? time : "09:00"}:00-03:00`;
}
