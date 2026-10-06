import { can, getSession } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { readDocument } from "@/lib/central/documents";

export const maxDuration = 120;
const MAX_BYTES = 10 * 1024 * 1024;
const TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "application/pdf", "application/xml", "text/xml"];

/** Foto, PDF ou XML enviado à Central → campos conferidos (o arquivo não é guardado). */
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims) return Response.json({ error: "Sessão expirada: entre de novo." }, { status: 401 });
  const session = await getSession();
  if (!can(session, "ai.assistant")) return Response.json({ error: "Seu perfil não tem acesso à Central." }, { status: 403 });
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File) || file.size === 0) return Response.json({ error: "Arquivo vazio" }, { status: 400 });
  if (file.size > MAX_BYTES) return Response.json({ error: "Arquivo grande demais (até 10 MB)" }, { status: 413 });
  if (!TYPES.includes(file.type) && !file.name.toLowerCase().endsWith(".xml")) return Response.json({ error: "Envie uma foto, um PDF ou o XML da nota." }, { status: 415 });
  try {
    return Response.json({ document: await readDocument(supabase, session, file) });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 422 });
  }
}
