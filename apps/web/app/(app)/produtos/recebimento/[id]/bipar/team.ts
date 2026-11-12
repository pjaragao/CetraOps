import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { TeamPhone } from "./assist-panel";

/** Equipe ativa com WhatsApp cadastrado: para mandar o link do modo assistido. */
export async function loadTeamPhones(): Promise<TeamPhone[]> {
  const supabase = await createClient();
  const { data: members } = await supabase.schema("core").from("members").select("display_name, party_id").eq("status", "ACTIVE");
  const parties = (members ?? []).map((m) => m.party_id).filter(Boolean) as string[];
  if (!parties.length) return [];
  const { data: pts } = await supabase.schema("crm").from("party_contact_points").select("party_id, value_normalized, type").in("party_id", parties).in("type", ["WHATSAPP", "PHONE"]);
  return (members ?? []).flatMap((m) => {
    const mine = (pts ?? []).filter((p) => p.party_id === m.party_id);
    const pick = mine.find((p) => p.type === "WHATSAPP") ?? mine[0];
    return pick ? [{ name: m.display_name, phone: pick.value_normalized }] : [];
  });
}
