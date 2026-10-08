import "server-only";
import type { createClient } from "@/lib/supabase/server";
import type { AudienceLookups } from "./audience";

type Client = Awaited<ReturnType<typeof createClient>>;

/** Listas para os seletores do construtor de público. */
export async function loadLookups(supabase: Client): Promise<AudienceLookups> {
  const [events, cats, cols, links, affs, camps, segs] = await Promise.all([
    supabase.schema("mkt").from("events").select("id, name").order("starts_at", { ascending: false }).limit(50),
    supabase.schema("catalog").from("categories").select("id, name").order("name"),
    supabase.schema("catalog").from("collections").select("id, name").order("name"),
    supabase.schema("mkt").from("tracking_links").select("id, name").order("created_at", { ascending: false }).limit(100),
    supabase.schema("aff").from("affiliates").select("party_id").eq("status", "ACTIVE"),
    supabase.schema("mkt").from("campaigns").select("id, name").neq("status", "DRAFT").order("created_at", { ascending: false }).limit(50),
    supabase.schema("mkt").from("segments").select("id, name").order("name"),
  ]);
  const affIds = (affs.data ?? []).map((a) => a.party_id);
  const { data: parties } = affIds.length ? await supabase.schema("crm").from("parties").select("id, display_name").in("id", affIds) : { data: [] as { id: string; display_name: string }[] };
  return {
    events: events.data ?? [], categories: cats.data ?? [], collections: cols.data ?? [], links: links.data ?? [],
    affiliates: (parties ?? []).map((p) => ({ id: p.id, name: p.display_name })), campaigns: camps.data ?? [], segments: segs.data ?? [],
  };
}
