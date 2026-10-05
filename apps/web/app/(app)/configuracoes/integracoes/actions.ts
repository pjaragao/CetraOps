"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { Json } from "@centralops/db";
import { createClient } from "@/lib/supabase/server";
import { PROVIDERS, type ProviderKey } from "./providers";

export type State = { ok: boolean; error?: string; message?: string } | null;

const friendly = (m: string) => m.replace(/^ERROR:\s*/, "");
const str = (v: FormDataEntryValue | null) => String(v ?? "").trim();
const PATH = "/configuracoes/integracoes";
const refresh = () => revalidatePath(PATH);

function back(params: Record<string, string | undefined> = {}): never {
  const q = Object.entries(params).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v!)}`).join("&");
  redirect(q ? `${PATH}?${q}` : PATH);
}

const providerSchema = z.enum(["META_WA", "META_IG", "TELEGRAM", "FOCUS_NFE", "META_CAPI", "META_ADS"]);

/** Salva a conexão: campos de configuração (visíveis) + credencial (vai para o Vault; em branco = mantém a atual). */
export async function saveIntegrationAction(_prev: State, formData: FormData): Promise<State> {
  const provider = providerSchema.safeParse(str(formData.get("provider")));
  if (!provider.success) return { ok: false, error: "Provedor inválido" };
  const def = PROVIDERS[provider.data as ProviderKey];
  const config: Record<string, string> = {};
  for (const f of def.config) {
    const v = str(formData.get(`config.${f.key}`));
    if (v) config[f.key] = v;
    else if (f.required) return { ok: false, error: `Informe: ${f.label}` };
  }
  const secret: Record<string, string> = {};
  for (const f of def.secret) {
    const v = str(formData.get(`secret.${f.key}`));
    if (v) secret[f.key] = v;
  }
  const supabase = await createClient();
  const payload = { provider: provider.data, capability: def.capability, config, ...(Object.keys(secret).length ? { secret } : {}) };
  const { data, error } = await supabase.schema("core").rpc("save_integration", { p: payload as unknown as Json });
  if (error) return { ok: false, error: friendly(error.message) };
  refresh();
  const r = data as { has_secret?: boolean } | null;
  return { ok: true, message: r?.has_secret ? "Salvo. O worker está testando a credencial…" : "Configuração salva. Informe a credencial para testar." };
}

export async function testIntegrationAction(formData: FormData) {
  const supabase = await createClient();
  const action = str(formData.get("action")) === "TELEGRAM_WEBHOOK" ? "TELEGRAM_WEBHOOK" : "CHECK";
  const { error } = await supabase.schema("core").rpc("request_integration_check", { p_id: str(formData.get("id")), p_action: action });
  refresh();
  back(error ? { erro: friendly(error.message) } : { ok: action === "CHECK" ? "Teste pedido: o resultado aparece em instantes." : "Registro do webhook pedido: o resultado aparece em instantes.", wait: "1" });
}

export async function removeSecretAction(formData: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.schema("core").rpc("remove_integration_secret", { p_id: str(formData.get("id")) });
  refresh();
  back(error ? { erro: friendly(error.message) } : { ok: "Credencial removida do cofre." });
}

export async function toggleIntegrationAction(formData: FormData) {
  const supabase = await createClient();
  const enabled = str(formData.get("enabled")) === "1";
  const { error } = await supabase.schema("core").rpc("set_integration_enabled", { p_id: str(formData.get("id")), p_enabled: enabled });
  refresh();
  back(error ? { erro: friendly(error.message) } : { ok: enabled ? "Integração reativada." : "Integração desativada." });
}

const channelSchema = z.object({
  id: z.string().uuid().optional(), channel: z.enum(["WHATSAPP", "INSTAGRAM", "TELEGRAM"]), provider_account_id: z.string().min(2).max(120), display_name: z.string().min(2).max(120),
  connection_id: z.string().uuid().optional(), store_id: z.string().uuid().optional(), default_persona_id: z.string().uuid().optional(),
  default_ai_mode: z.enum(["AI_AUTOPILOT", "AI_COPILOT", "HUMAN"]), status: z.enum(["ACTIVE", "DISABLED"]).optional(),
});

export async function saveChannelAction(_prev: State, formData: FormData): Promise<State> {
  const opt = (k: string) => str(formData.get(k)) || undefined;
  const parsed = channelSchema.safeParse({
    id: opt("id"), channel: opt("channel"), provider_account_id: opt("provider_account_id"), display_name: opt("display_name"), connection_id: opt("connection_id"),
    store_id: opt("store_id"), default_persona_id: opt("default_persona_id"), default_ai_mode: opt("default_ai_mode") ?? "AI_COPILOT", status: opt("status"),
  });
  if (!parsed.success) return { ok: false, error: `Confira os campos: ${parsed.error.issues[0]?.path.join(".")} — ${parsed.error.issues[0]?.message}` };
  const supabase = await createClient();
  const { error } = await supabase.schema("omni").rpc("save_channel_account", { p: parsed.data as unknown as Json });
  if (error) return { ok: false, error: friendly(error.message) };
  refresh();
  revalidatePath("/atendimento", "layout");
  return { ok: true, message: parsed.data.id ? "Canal atualizado" : "Canal cadastrado" };
}

export async function toggleChannelAction(formData: FormData) {
  const supabase = await createClient();
  const { data: ch } = await supabase.schema("omni").from("channel_accounts").select("*").eq("id", str(formData.get("id"))).maybeSingle();
  if (!ch) back({ erro: "Canal não encontrado" });
  const { error } = await supabase.schema("omni").rpc("save_channel_account", {
    p: { id: ch!.id, channel: ch!.channel, provider_account_id: ch!.provider_account_id, display_name: ch!.display_name, connection_id: ch!.connection_id, store_id: ch!.store_id,
      default_persona_id: ch!.default_persona_id, default_ai_mode: ch!.default_ai_mode, status: ch!.status === "ACTIVE" ? "DISABLED" : "ACTIVE" } as unknown as Json,
  });
  refresh();
  revalidatePath("/atendimento", "layout");
  back(error ? { erro: friendly(error.message) } : { ok: ch!.status === "ACTIVE" ? "Canal desativado: novas mensagens deste número serão recusadas." : "Canal reativado." });
}
