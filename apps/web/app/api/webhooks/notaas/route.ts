import { createClient } from "@supabase/supabase-js";
import type { Database } from "@centralops/db";

/**
 * Webhook oficial da API Notaas (NFC-e e NF-e).
 * Recebe notificações assíncronas de autorização, rejeição e cancelamento da SEFAZ.
 * Documentação: https://docs.notaas.com.br/docs/webhooks
 */
export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const event = String(body.event ?? body.type ?? "").toLowerCase();
  const data = (body.data && typeof body.data === "object" ? body.data : body) as Record<string, unknown>;

  const payload = {
    event: event || String(data.event ?? ""),
    invoiceId: data.invoiceId ?? data.id ?? body.invoiceId ?? body.id,
    chaveAcesso: data.chaveAcesso ?? data.chave_nfe ?? data.access_key ?? body.chaveAcesso,
    status: data.status ?? body.status,
    numero: data.numero ?? data.nNf ?? body.numero,
    serie: data.serie ?? body.serie,
    protocolo: data.protocolo ?? data.nProt ?? body.protocolo,
    codigoStatus: data.codigoStatus ?? data.cStat ?? body.codigoStatus,
    motivo: data.motivo ?? data.xMotivo ?? data.errorMessage ?? body.motivo,
    pdfUrl: data.pdfUrl ?? data.danfeUrl ?? body.pdfUrl,
    xmlUrl: data.xmlUrl ?? body.xmlUrl,
    raw: body,
  };

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || "http://127.0.0.1:55321";
  const serviceKey = process.env.CENTRALOPS_SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

  const supabase = createClient<Database>(url, serviceKey);
  const fiscal = (supabase as unknown as { schema: (s: string) => { rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }> } }).schema("fiscal");

  const { data: res, error } = await fiscal.rpc("process_notaas_webhook", {
    p: payload,
  });

  if (error) {
    return Response.json({ received: true, error: (error as { message?: string }).message }, { status: 500 });
  }

  return Response.json({ received: true, result: res });
}
