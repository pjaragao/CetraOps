import "server-only";

import { completeViaHermes, hermesConfigured, isHermesModel } from "./hermes";

/**
 * Cliente mínimo do OpenRouter (API compatível com chat completions + function calling) para a Central.
 * O modelo de cada tarefa vem do banco (ai.model_routes, via ai.assistant_route): troca-se na tela Modelos & custos, sem deploy.
 * Modelo `hermes/...` vai para o Hermes exclusivo do CentralOps (LLM = AGY), ver ./hermes.ts.
 */

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "file"; file: { filename: string; file_data: string } };

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ContentPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface Route {
  model: string;
  fallback_models?: string[];
  params?: Record<string, unknown>;
  provider_prefs?: Record<string, unknown>;
}

export interface Usage {
  tokens_in: number;
  tokens_out: number;
  cache_read_tokens: number;
  cost_usd: number;
  model: string | null;
}

export class LlmError extends Error {
  constructor(message: string, readonly transient: boolean) {
    super(message);
  }
}

/** Variáveis de ambiente do servidor (nunca no navegador). Aceita o prefixo antigo SIE_ enquanto o deploy não for renomeado. */
export function env(name: string): string {
  return process.env[`CENTRALOPS_${name}`] || process.env[`SIE_${name}`] || "";
}

export function llmConfigured(): boolean {
  return Boolean(env("OPENROUTER_KEY")) || hermesConfigured();
}

export function addUsage(total: Usage, data: { model?: string; usage?: Record<string, unknown> }) {
  const u = data.usage ?? {};
  total.tokens_in += Number(u.prompt_tokens ?? 0);
  total.tokens_out += Number(u.completion_tokens ?? 0);
  total.cache_read_tokens += Number((u.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens ?? 0);
  total.cost_usd += Number(u.cost ?? 0);
  total.model = data.model ?? total.model;
}

export function emptyUsage(): Usage {
  return { tokens_in: 0, tokens_out: 0, cache_read_tokens: 0, cost_usd: 0, model: null };
}

type CompleteOpts = { tools?: unknown[]; toolChoice?: "auto" | "none"; jsonSchema?: { name: string; schema: unknown }; usage: Usage; timeoutMs?: number };

/** Uma chamada ao modelo. `tools` no formato de function calling; `jsonSchema` pede saída estruturada.
 *  Principal e reservas podem misturar OpenRouter e Hermes: tenta primeiro o lado do modelo principal e, se falhar, o outro. */
export async function complete(route: Route, messages: ChatMessage[], opts: CompleteOpts) {
  const all = [route.model, ...(route.fallback_models ?? [])];
  const hermes = all.filter(isHermesModel);
  const openrouter = all.filter((m) => !isHermesModel(m));
  const order = isHermesModel(route.model) ? (["hermes", "openrouter"] as const) : (["openrouter", "hermes"] as const);
  let last: LlmError | null = null;
  for (const side of order) {
    const models = side === "hermes" ? hermes : openrouter;
    if (!models.length || (side === "hermes" ? !hermesConfigured() : !env("OPENROUTER_KEY"))) continue;
    try {
      const r = { ...route, model: models[0], fallback_models: models.slice(1) };
      return side === "hermes" ? await completeViaHermes(r, messages, opts) : await completeViaOpenRouter(r, messages, opts);
    } catch (e) {
      if (!(e instanceof LlmError)) throw e;
      last = e;
    }
  }
  throw last ?? new LlmError("IA não configurada neste servidor (CENTRALOPS_OPENROUTER_KEY ou CENTRALOPS_HERMES_LLM_KEY)", false);
}

async function completeViaOpenRouter(route: Route, messages: ChatMessage[], opts: CompleteOpts) {
  const key = env("OPENROUTER_KEY");
  if (!key) throw new LlmError("IA não configurada neste servidor (CENTRALOPS_OPENROUTER_KEY)", false);
  const params = route.params ?? {};
  const body: Record<string, unknown> = {
    model: route.model,
    messages,
    usage: { include: true },
    ...Object.fromEntries(Object.entries(params).filter(([k]) => ["temperature", "max_tokens", "reasoning"].includes(k))),
  };
  if (route.fallback_models?.length) body.models = [route.model, ...route.fallback_models];
  if (route.provider_prefs && Object.keys(route.provider_prefs).length) body.provider = route.provider_prefs;
  if (opts.tools?.length) {
    body.tools = opts.tools;
    body.tool_choice = opts.toolChoice ?? "auto";
  }
  if (opts.jsonSchema) body.response_format = { type: "json_schema", json_schema: { name: opts.jsonSchema.name, strict: true, schema: opts.jsonSchema.schema } };

  let resp: Response;
  try {
    resp = await fetch(`${(env("OPENROUTER_BASE") || "https://openrouter.ai/api/v1").replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "X-Title": "CentralOps" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
    });
  } catch (e) {
    throw new LlmError(`rede: ${(e as Error).message}`, true);
  }
  if (!resp.ok) {
    const text = (await resp.text()).slice(0, 300);
    throw new LlmError(`IA respondeu ${resp.status}: ${text}`, resp.status === 429 || resp.status >= 500);
  }
  const data = (await resp.json()) as { model?: string; usage?: Record<string, unknown>; choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[] };
  addUsage(opts.usage, data);
  const message = data.choices?.[0]?.message ?? {};
  return { content: message.content ?? null, toolCalls: message.tool_calls ?? [] };
}

/** Lê o JSON devolvido pelo modelo (alguns modelos cercam com ```json mesmo com schema). */
export function parseJson<T>(content: string | null): T {
  let text = (content ?? "").trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenced) text = fenced[1];
  return JSON.parse(text) as T;
}
