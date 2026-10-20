import { can, getSession } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { env } from "@/lib/central/llm";

export const maxDuration = 180;
const MAX_BYTES = 8 * 1024 * 1024;

/** Áudio da Central → texto (Whisper no Groq, o mesmo do atendimento; sem a chave do Groq, o AGY pelo shim). O áudio não é guardado. */
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims) return Response.json({ error: "Sessão expirada: entre de novo." }, { status: 401 });
  const session = await getSession();
  if (!can(session, "ai.assistant")) return Response.json({ error: "Seu perfil não tem acesso à Central." }, { status: 403 });
  const key = env("GROQ_KEY");
  const agyToken = env("AGY_SHIM_TOKEN");
  if (!key && !agyToken) return Response.json({ error: "A transcrição de áudio não está configurada (CENTRALOPS_GROQ_KEY ou CENTRALOPS_AGY_SHIM_TOKEN)." }, { status: 503 });

  const form = await request.formData().catch(() => null);
  const audio = form?.get("audio");
  if (!(audio instanceof Blob) || audio.size === 0) return Response.json({ error: "Áudio vazio" }, { status: 400 });
  if (audio.size > MAX_BYTES) return Response.json({ error: "Áudio longo demais (até 1 minuto)" }, { status: 413 });

  // Vocabulário da loja melhora nomes de produtos e cores (o Whisper usa o prompt como contexto)
  const { data: products } = await supabase.schema("catalog").from("products").select("name").eq("status", "ACTIVE").order("updated_at", { ascending: false }).limit(40);
  const vocab = ["Central", "PDV", "Pix", "vale-troca", "armário VIP", ...(products ?? []).map((p) => p.name)].join(", ").slice(0, 600);
  if (!key) return transcribeWithAgy(supabase, audio, agyToken, vocab);

  const ext = audio.type.includes("mp4") ? "m4a" : audio.type.includes("ogg") ? "ogg" : "webm";
  const upstream = new FormData();
  upstream.set("file", audio, `audio.${ext}`);
  upstream.set("model", "whisper-large-v3-turbo");
  upstream.set("language", "pt");
  upstream.set("response_format", "json");
  upstream.set("prompt", vocab);
  const started = Date.now();
  let resp: Response;
  try {
    resp = await fetch(`${(env("GROQ_BASE") || "https://api.groq.com/openai/v1").replace(/\/$/, "")}/audio/transcriptions`, {
      method: "POST", headers: { Authorization: `Bearer ${key}` }, body: upstream, signal: AbortSignal.timeout(45_000),
    });
  } catch (e) {
    return Response.json({ error: `Transcrição indisponível: ${(e as Error).message}` }, { status: 502 });
  }
  const ok = resp.ok;
  const data = ok ? ((await resp.json()) as { text?: string }) : null;
  await supabase.schema("ai").rpc("assistant_log_run", {
    p: { task: "transcribe", model: "whisper-large-v3-turbo", provider: "groq", latency_ms: Date.now() - started, status: ok ? "OK" : "ERROR", error: ok ? null : `HTTP ${resp.status}` } as never,
  });
  if (!ok) return Response.json({ error: "Não consegui entender o áudio. Tente de novo ou escreva." }, { status: 502 });
  const text = (data?.text ?? "").trim();
  if (!text) return Response.json({ error: "Não ouvi nada. Fale mais perto do microfone." }, { status: 422 });
  return Response.json({ text });
}

/** Sem Groq: o AGY transcreve pelo shim (tarefa "transcribe": o arquivo vai para a pasta temporária e o agy ouve). Mais lento (10 a 40 s). */
async function transcribeWithAgy(supabase: Awaited<ReturnType<typeof createClient>>, audio: Blob, token: string, vocab: string): Promise<Response> {
  const mime = (audio.type || "audio/webm").split(";")[0];
  const started = Date.now();
  let resp: Response;
  try {
    resp = await fetch(`${(env("AGY_SHIM_URL") || "http://172.26.0.1:8787/v1").replace(/\/$/, "")}/task`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "transcribe", mime, data_b64: Buffer.from(await audio.arrayBuffer()).toString("base64"), prompt: `Palavras que podem aparecer: ${vocab}` }),
      signal: AbortSignal.timeout(150_000),
    });
  } catch (e) {
    return Response.json({ error: `Transcrição indisponível: ${(e as Error).message}` }, { status: 502 });
  }
  const data = resp.ok ? ((await resp.json()) as { text?: string; model?: string }) : null;
  await supabase.schema("ai").rpc("assistant_log_run", {
    p: { task: "transcribe", model: data?.model ?? "agy", provider: "agy", latency_ms: Date.now() - started, status: resp.ok ? "OK" : "ERROR", error: resp.ok ? null : `HTTP ${resp.status}` } as never,
  });
  if (!data) return Response.json({ error: "Não consegui entender o áudio. Tente de novo ou escreva." }, { status: 502 });
  // o agy às vezes acrescenta o idioma ("(português)"): fica só a fala
  const text = (data.text ?? "").replace(/\n*\(?idioma[^)]*\)?\s*$/i, "").trim();
  if (!text) return Response.json({ error: "Não ouvi nada. Fale mais perto do microfone." }, { status: 422 });
  return Response.json({ text });
}
