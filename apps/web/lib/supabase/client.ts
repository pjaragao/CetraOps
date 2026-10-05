"use client";
import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "@centralops/db";

let client: ReturnType<typeof createBrowserClient<Database>> | undefined;

/** Cliente do navegador (usado para Realtime na inbox). Nunca recebe a service role. */
export function createClient() {
  client ??= createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
  return client;
}
