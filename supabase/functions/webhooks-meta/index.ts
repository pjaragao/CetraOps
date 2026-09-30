// Ingresso dos webhooks da Meta (WhatsApp Cloud API e Instagram): valida, grava, enfileira e responde 200 em menos de 1 s.
// Se a VPS do worker cair, os eventos continuam sendo recebidos e ficam na fila; o worker processa o atraso quando voltar.
//
// Segredos (variáveis de ambiente da função): META_VERIFY_TOKEN (handshake) e META_APP_SECRETS (App Secret; lista separada por vírgula quando
// WhatsApp e Instagram são apps diferentes). Sem segredo configurado a função RECUSA tudo — nunca aceita evento sem assinatura.
import { envList, ingest, json } from "../_shared/ingest.ts";
import { metaChallenge, splitMetaPayload, verifyMetaSignature } from "../_shared/webhooks.ts";

Deno.serve(async (req: Request): Promise<Response> => {
  const url = new URL(req.url);

  if (req.method === "GET") {
    const challenge = metaChallenge(url, Deno.env.get("META_VERIFY_TOKEN") ?? "");
    return challenge === null ? json(403, { error: "verification failed" }) : new Response(challenge, { status: 200, headers: { "content-type": "text/plain" } });
  }
  if (req.method !== "POST") return json(405, { error: "method not allowed" });

  const secrets = envList("META_APP_SECRETS");
  if (secrets.length === 0) return json(500, { error: "webhook not configured" });

  const raw = await req.text();                                                    // a assinatura vale para o corpo BRUTO, antes de qualquer parse
  if (!(await verifyMetaSignature(raw, req.headers.get("x-hub-signature-256"), secrets))) return json(401, { error: "invalid signature" });

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return json(400, { error: "invalid json" });
  }

  try {
    const events = await splitMetaPayload(payload);
    const result = events.length ? await ingest(events) : { received: 0, duplicates: 0 };
    return json(200, result);
  } catch (e) {
    console.error(JSON.stringify({ fn: "webhooks-meta", error: String((e as Error).message) }));   // sem o corpo: pode ter dado pessoal
    return json(500, { error: "temporary failure" });                              // 5xx: a Meta reenvia com recuo; a gravação é idempotente
  }
});
