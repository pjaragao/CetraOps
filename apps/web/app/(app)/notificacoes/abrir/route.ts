import { NextResponse, type NextRequest } from "next/server";
import { describeNotification } from "@sie/domain";
import { createClient } from "@/lib/supabase/server";

/** Abre a notificação: marca como lida e leva para a tela de quem resolve (conversa, nota, integração…). */
export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id") ?? "";
  const supabase = await createClient();
  const { data: n } = await supabase.schema("core").from("notifications").select("id, kind, payload, read_at").eq("id", id).maybeSingle();
  if (!n) return NextResponse.redirect(new URL("/notificacoes", req.url));
  if (!n.read_at) await supabase.schema("core").from("notifications").update({ read_at: new Date().toISOString() }).eq("id", n.id);
  const target = describeNotification(n.kind, (n.payload ?? {}) as Record<string, unknown>).href;
  return NextResponse.redirect(new URL(target, req.url));
}
