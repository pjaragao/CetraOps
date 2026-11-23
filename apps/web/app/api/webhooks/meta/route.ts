import { metaSecretList, metaWebhookChallenge, splitMetaWebhook, verifyMetaWebhookSignature } from "@centralops/domain";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Webhook da Meta (WhatsApp Cloud API e Instagram) quando o sistema mora no homelab: a Meta chama o relay da Vercel
 * (stone-relay `/api/meta`), que repassa o corpo BRUTO para cá pelo Tailscale Funnel. Faz o mesmo que a Edge Function `webhooks-meta`:
 * confere a assinatura, grava cada evento uma vez (omni.ingest_webhook) e responde 200; quem interpreta é o worker.
 *
 * Variáveis (Coolify): META_VERIFY_TOKEN (handshake) e META_APP_SECRETS (App Secret; vírgula quando WhatsApp e Instagram são apps diferentes).
 * Sem elas a rota recusa tudo. Erro de gravação → 5xx: a Meta reenvia e a gravação é idempotente.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const challenge = metaWebhookChallenge(new URL(request.url).searchParams, process.env.META_VERIFY_TOKEN ?? "");
  if (challenge === null) return Response.json({ error: "verification failed" }, { status: 403 });
  return new Response(challenge, { status: 200, headers: { "content-type": "text/plain" } });
}

export async function POST(request: Request) {
  const secrets = metaSecretList(process.env.META_APP_SECRETS);
  if (secrets.length === 0) return Response.json({ error: "webhook not configured" }, { status: 500 });

  const raw = await request.text();                                              // a assinatura vale para o corpo bruto, antes do parse
  if (!(await verifyMetaWebhookSignature(raw, request.headers.get("x-hub-signature-256"), secrets))) {
    return Response.json({ error: "invalid signature" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }

  try {
    const events = await splitMetaWebhook(payload);
    const admin = createAdminClient();
    const results = await Promise.all(events.map(async (e) => {
      const { data, error } = await admin.schema("omni").rpc("ingest_webhook", { p_provider: e.provider, p_event_key: e.key, p_payload: e.payload as never });
      if (error) throw new Error(`ingest_webhook falhou (${e.provider}): ${error.message}`);
      return data as { duplicate?: boolean } | null;
    }));
    return Response.json({ received: results.length, duplicates: results.filter((r) => r?.duplicate).length });
  } catch (e) {
    console.error(JSON.stringify({ route: "webhooks/meta", error: String((e as Error).message) }));   // sem o corpo: pode ter dado pessoal
    return Response.json({ error: "temporary failure" }, { status: 500 });
  }
}
