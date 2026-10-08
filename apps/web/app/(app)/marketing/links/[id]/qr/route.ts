import { NextResponse, type NextRequest } from "next/server";
import QRCode from "qrcode";
import { shortLink, trackingUrl } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { can, getSession } from "@/lib/session";

/** QR do link rastreado em PNG (para imprimir) ou SVG (?formato=svg, para gráfica). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!can(session, "crm.read")) return new NextResponse("Sem permissão", { status: 403 });
  const { id } = await params;
  const supabase = await createClient();
  const { data: l } = await supabase.schema("mkt").from("tracking_links").select("code, prefill_text, channel_account_id").eq("id", id).maybeSingle();
  if (!l) return new NextResponse("Link não encontrado", { status: 404 });
  const { data: ca } = await supabase.schema("omni").from("channel_accounts").select("channel, public_address").eq("id", l.channel_account_id ?? "").maybeSingle();
  const { data: pu } = await supabase.schema("core").from("settings").select("value").eq("key", "public_url").maybeSingle();
  const base = (pu?.value as { base?: string } | null)?.base ?? null;
  // QR impresso aponta para o link curto (o destino pode mudar depois); sem endereço público, vai direto ao canal
  const url = shortLink(base, l.code) ?? (ca ? trackingUrl(ca.channel, ca.public_address, l.code, l.prefill_text) : null);
  if (!url) return new NextResponse("Cadastre o número/@ do canal antes de gerar o QR", { status: 409 });
  if (req.nextUrl.searchParams.get("formato") === "svg") {
    const svg = await QRCode.toString(url, { type: "svg", margin: 2, errorCorrectionLevel: "M" });
    return new NextResponse(svg, { headers: { "content-type": "image/svg+xml", "content-disposition": `attachment; filename="qr-${l.code}.svg"`, "cache-control": "no-store" } });
  }
  const png = await QRCode.toBuffer(url, { type: "png", width: 1024, margin: 2, errorCorrectionLevel: "M" });
  return new NextResponse(new Uint8Array(png), { headers: { "content-type": "image/png", "content-disposition": `inline; filename="qr-${l.code}.png"`, "cache-control": "no-store" } });
}
