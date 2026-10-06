import { z } from "zod";
import { getSession, can } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { runCentral } from "@/lib/central/agent";
import type { CentralEvent } from "@/lib/central/cards";

export const maxDuration = 120;

const body = z.object({
  threadId: z.string().uuid().nullish(),
  message: z.string().trim().min(1).max(4000),
  path: z.string().max(300).nullish(),
  document: z.object({
    kind: z.enum(["identidade", "boleto", "pix", "nota_ou_recibo", "comprovante_endereco", "etiqueta_produto", "outro"]),
    label: z.string().max(200),
    fields: z.record(z.string(), z.union([z.string().max(500), z.number(), z.null()])),
    checks: z.array(z.string().max(300)).max(10),
  }).nullish(),
});

/** Conversa com a Central: responde em Server-Sent Events (status, cartões, texto) enquanto as ferramentas rodam. */
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims) return Response.json({ error: "Sessão expirada: entre de novo." }, { status: 401 });
  const session = await getSession();
  if (!can(session, "ai.assistant")) return Response.json({ error: "Seu perfil não tem acesso à Central." }, { status: 403 });
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Mensagem inválida" }, { status: 400 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (e: CentralEvent) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
      try {
        await runCentral({ supabase, session, threadId: parsed.data.threadId ?? null, message: parsed.data.message, path: parsed.data.path ?? null, document: parsed.data.document ?? null, emit });
      } catch (e) {
        emit({ type: "error", text: `A Central falhou: ${(e as Error).message}` });
        emit({ type: "done", mode: "search" });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" } });
}
