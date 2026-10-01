import { NextResponse, type NextRequest } from "next/server";
import QRCode from "qrcode";
import { createClient } from "@/lib/supabase/server";
import { can, getSession } from "@/lib/session";

/** QR de check-in da convidada (PNG): abre /marketing/eventos/checkin?t=… para a equipe confirmar a presença. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ guestId: string }> }) {
  const session = await getSession();
  if (!can(session, "crm.read")) return new NextResponse("Sem permissão", { status: 403 });
  const { guestId } = await params;
  const supabase = await createClient();
  const { data: g } = await supabase.schema("mkt").from("event_guests").select("checkin_token").eq("id", guestId).maybeSingle();
  if (!g) return new NextResponse("Convidada não encontrada", { status: 404 });
  const url = `${req.nextUrl.origin}/marketing/eventos/checkin?t=${g.checkin_token}`;
  const png = await QRCode.toBuffer(url, { type: "png", width: 768, margin: 2, errorCorrectionLevel: "M" });
  return new NextResponse(new Uint8Array(png), { headers: { "content-type": "image/png", "content-disposition": `inline; filename="checkin-${guestId.slice(0, 8)}.png"`, "cache-control": "no-store" } });
}
