// Gravação idempotente dos eventos no banco (omni.ingest_webhook: insere em omni.webhook_events e enfileira em `inbound_events` só se o evento é novo).
import { createClient } from "npm:@supabase/supabase-js@2";
import type { WebhookEvent } from "./webhooks.ts";

let client: ReturnType<typeof createClient> | null = null;

function db() {
  // SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são injetadas pela plataforma nas Edge Functions
  client ??= createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false, autoRefreshToken: false } });
  return client;
}

export type IngestResult = { received: number; duplicates: number };

/** Grava todos os eventos. Se QUALQUER gravação falhar, levanta: a função responde 5xx e o provedor reenvia (a gravação é idempotente, então reenviar é seguro). */
export async function ingest(events: WebhookEvent[]): Promise<IngestResult> {
  const results = await Promise.all(events.map(async (e) => {
    const { data, error } = await db().schema("omni").rpc("ingest_webhook", { p_provider: e.provider, p_event_key: e.key, p_payload: e.payload });
    if (error) throw new Error(`ingest_webhook falhou (${e.provider}): ${error.message}`);
    return data as { duplicate: boolean };
  }));
  return { received: results.length, duplicates: results.filter((r) => r?.duplicate).length };
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function envList(name: string): string[] {
  return (Deno.env.get(name) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}
