import type { Json } from "@centralops/db";
import { fetchNotaasInvoiceStatus, NOTAAS_DEFAULT_BASE } from "@/lib/notaas";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Aviso da Notaas (NFC-e/NF-e). O corpo só diz QUAL nota mudou: a situação (autorizada, rejeitada, cancelada) é lida na API da Notaas
 * com a chave da empresa dona da nota, e só então gravada. Aviso falso não altera documento fiscal; nota desconhecida é ignorada.
 */
export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "JSON inválido" }, { status: 400 });
  }
  const data = (body.data && typeof body.data === "object" ? body.data : body) as Record<string, unknown>;
  const invoiceId = String(data.invoiceId ?? data.id ?? body.invoiceId ?? body.id ?? "");
  if (!/^[A-Za-z0-9_-]{4,80}$/.test(invoiceId)) return Response.json({ received: true, ignored: "sem nota" });

  const admin = createAdminClient();
  const { data: doc, error } = await admin.schema("fiscal").rpc("document_by_provider_ref", { p_ref: invoiceId });
  if (error) return Response.json({ error: "falha ao consultar" }, { status: 500 });
  const d = doc as unknown as { id: string; org_id: string; status: string } | null;
  if (!d) return Response.json({ received: true, ignored: "nota desconhecida" });

  const { data: conn } = await admin.schema("core").from("integration_connections").select("id, config").eq("org_id", d.org_id).eq("provider", "NOTAAS").neq("status", "DISABLED")
    .order("updated_at", { ascending: false }).limit(1).maybeSingle();
  if (!conn) return Response.json({ received: true, ignored: "Notaas não conectada" });
  const { data: secret } = await admin.schema("core").rpc("integration_secret", { p_connection: conn.id });
  const key = String((secret as Record<string, unknown> | null)?.api_key ?? (secret as Record<string, unknown> | null)?.token ?? "");
  if (!key) return Response.json({ received: true, ignored: "sem credencial" });
  const base = String((conn.config as Record<string, unknown> | null)?.api_base ?? "") || NOTAAS_DEFAULT_BASE;

  try {
    const st = await fetchNotaasInvoiceStatus(key, invoiceId, base);
    const { data: res, error: e2 } = await admin.schema("fiscal").rpc("process_notaas_webhook", { p: {
      invoiceId, status: st.status === "AUTHORIZED" ? "issued" : st.status === "CANCELLED" ? "cancelled" : st.status === "REJECTED" ? "error" : st.status === "DENIED" ? "denied" : "processing",
      chaveAcesso: st.accessKey, numero: st.number, serie: st.series, protocolo: st.protocol, codigoStatus: st.sefazCode, motivo: st.sefazMessage, pdfUrl: st.pdfUrl, xmlUrl: st.xmlUrl,
    } as unknown as Json });
    if (e2) return Response.json({ received: true, error: e2.message }, { status: 500 });
    return Response.json({ received: true, result: res });
  } catch (e) {
    return Response.json({ received: true, error: (e as Error).message }, { status: 502 });   // a Notaas reenvia
  }
}
