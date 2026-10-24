import { createHash } from "node:crypto";
import type { Json } from "@centralops/db";
import { can, getSession } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { readDocument } from "@/lib/central/documents";

export const maxDuration = 120;
const MAX_BYTES = 10 * 1024 * 1024;
const TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "application/pdf", "application/xml", "text/xml"];
const KEEP = new Set(["boleto", "pix", "nota_ou_recibo", "nfe_xml"]);   // comprovantes financeiros ficam guardados; identidade, nunca

/**
 * Caixa de documentos: um arquivo por chamada → lido (XML sem IA; foto/PDF pela leitura da Central), guardado no bucket fin-docs quando é
 * comprovante financeiro e posto na fila com o destino sugerido pelo banco (fin.doc_inbox_add). O mesmo arquivo não é lido duas vezes.
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims) return Response.json({ error: "Sessão expirada: entre de novo." }, { status: 401 });
  const session = await getSession();
  if (!["fin.write", "fin.reimburse", "purch.write"].some((p) => can(session, p))) return Response.json({ error: "Seu perfil não usa a caixa de documentos." }, { status: 403 });
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File) || file.size === 0) return Response.json({ error: "Arquivo vazio" }, { status: 400 });
  if (file.size > MAX_BYTES) return Response.json({ error: "Arquivo grande demais (até 10 MB)" }, { status: 413 });
  const isXml = file.type.includes("xml") || file.name.toLowerCase().endsWith(".xml");
  if (!TYPES.includes(file.type) && !isXml) return Response.json({ error: "Envie foto, PDF ou o XML da nota." }, { status: 415 });

  const bytes = Buffer.from(await file.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const { data: known } = await supabase.schema("fin").from("doc_inbox").select("*").eq("sha256", sha256).neq("status", "DISCARDED").maybeSingle();
  if (known) return Response.json({ item: known, existing: true });

  let payload: Record<string, unknown>;
  if (isXml) {
    payload = { kind: "nfe_xml", xml: bytes.toString("utf8") };
  } else {
    try {
      const doc = await readDocument(supabase, session, new File([bytes], file.name, { type: file.type }));
      payload = { kind: doc.kind, label: doc.label, fields: doc.fields, checks: doc.checks };
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 422 });
    }
  }

  let storage_path: string | null = null;
  if (KEEP.has(String(payload.kind))) {
    const safe = file.name.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-zA-Z0-9._-]+/g, "-").slice(-80) || "documento";
    storage_path = `${session.orgId}/caixa/${sha256.slice(0, 16)}-${Date.now()}-${safe}`;   // caminho próprio: apagar após erro nunca tira o de outro envio
    const up = await supabase.storage.from("fin-docs").upload(storage_path, bytes, { contentType: file.type || "application/octet-stream", upsert: false });
    if (up.error) storage_path = null;          // sem o arquivo, o reembolso fica em rascunho para anexar depois
  }

  const { data, error } = await supabase.schema("fin").rpc("doc_inbox_add", {
    p: { ...payload, sha256, storage_path, file_name: file.name, mime: file.type || (isXml ? "application/xml" : null) } as Json,
  });
  if (error) {
    if (storage_path) await supabase.storage.from("fin-docs").remove([storage_path]);
    return Response.json({ error: error.message.replace(/^ERROR:\s*/, "") }, { status: 422 });
  }
  // o mesmo arquivo entrou por outro envio ao mesmo tempo: fica o de lá, o daqui é apagado
  const existing = Boolean(storage_path && data.storage_path !== storage_path);
  if (existing) await supabase.storage.from("fin-docs").remove([storage_path!]);
  return Response.json({ item: data, existing });
}
