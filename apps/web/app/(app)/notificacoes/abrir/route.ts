import { type NextRequest } from "next/server";
import { describeNotification } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";

/** Redireciona com Location relativo: atrás do proxy o req.url do contêiner é http(s)://0.0.0.0:3000, e o link absoluto quebrava. */
const go = (path: string) => new Response(null, { status: 303, headers: { Location: path, "Cache-Control": "no-store" } });

/** Abre a notificação: marca como lida e leva para a tela de quem resolve (conversa, nota, integração…). */
export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id") ?? "";
  const supabase = await createClient();
  const { data: n } = await supabase.schema("core").from("notifications").select("id, kind, payload, read_at").eq("id", id).maybeSingle();
  if (!n) return go("/notificacoes");
  if (!n.read_at) await supabase.schema("core").from("notifications").update({ read_at: new Date().toISOString() }).eq("id", n.id);
  const target = describeNotification(n.kind, (n.payload ?? {}) as Record<string, unknown>).href;
  return go(target);
}
