import "server-only";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@centralops/db";

/**
 * Cliente com a chave de serviço (ignora o RLS): SÓ para o servidor e só para o que o usuário não pode fazer por conta própria
 * (ler credencial de integração, confirmar pagamento conferido na API do provedor, webhooks). Nunca exponha o resultado bruto ao navegador.
 */
export function createAdminClient() {
  const url = process.env.CENTRALOPS_SUPABASE_URL || process.env.SIE_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.CENTRALOPS_SUPABASE_SERVICE_KEY || process.env.SIE_SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error("Chave de serviço do Supabase não configurada (CENTRALOPS_SUPABASE_SERVICE_KEY)");
  return createSupabaseClient<Database>(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
