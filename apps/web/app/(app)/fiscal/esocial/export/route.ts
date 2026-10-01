import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { can, getSession } from "@/lib/session";

/** Exporta os eventos pendentes do eSocial em JSON para o contador (não altera a situação; use “marcar como enviados”). */
export async function GET() {
  const session = await getSession();
  if (!can(session, "fiscal.read")) return new NextResponse("Sem permissão", { status: 403 });
  const supabase = await createClient();
  const { data } = await supabase.schema("fiscal").from("esocial_events").select("id, event, reference_type, reference_id, competence, payload, created_at").eq("status", "PENDING").order("created_at");
  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(JSON.stringify({ generated_at: new Date().toISOString(), events: data ?? [] }, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="esocial-pendentes-${stamp}.json"`, "cache-control": "no-store" },
  });
}
