import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { can, getSession } from "@/lib/session";

/** XML da NF-e recebida (guardado depois da ciência da operação). Vale a permissão fiscal da conta (RLS). */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!can(session, "fiscal.read")) return new NextResponse("Sem permissão", { status: 403 });
  const { id } = await params;
  const supabase = await createClient();
  const { data } = await supabase.schema("fiscal").from("inbound_dfe").select("access_key, xml").eq("id", id).maybeSingle();
  if (!data?.xml) return new NextResponse("XML ainda não disponível", { status: 404 });
  return new NextResponse(data.xml, { headers: { "content-type": "application/xml; charset=utf-8", "content-disposition": `attachment; filename="${data.access_key}.xml"`, "cache-control": "no-store" } });
}
