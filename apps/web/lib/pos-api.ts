import "server-only";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@centralops/db";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * API do app da maquininha (/api/pos/*). Duas credenciais em todo pedido:
 *  • X-Device-Token: o token da maquininha pareada (só o hash fica no banco). Sem ele, nada responde — nem o login.
 *  • Authorization: Bearer <JWT do Supabase> do operador logado: as consultas passam pelo RLS e pelas permissões dele, como na tela web.
 */

export interface PosDevice { deviceId: string; orgId: string; storeId: string; storeName: string; name: string; serial: string | null; tokenHash: string }
export interface PosOperator { supabase: SupabaseClient<Database>; device: PosDevice; userId: string; memberId: string; name: string; perms: Set<string>; isSuperuser: boolean }

export class PosError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const newDeviceToken = () => randomBytes(32).toString("base64url");

const PAIR_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";            // sem 0/O e 1/I
/** Código de pareamento de 8 caracteres (mostrado como ABCD-2345). */
export function newPairingCode() {
  return Array.from({ length: 8 }, () => PAIR_ALPHABET[randomInt(PAIR_ALPHABET.length)]).join("");
}
export const normalizePairingCode = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Limite simples por IP para pareamento e login (uma instância do app; o banco é a trava definitiva). */
const hits = new Map<string, { n: number; until: number }>();
export function rateLimit(request: Request, bucket: string, max = 10, windowMs = 10 * 60_000) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "local";
  const key = `${bucket}:${ip}`;
  const now = Date.now();
  const h = hits.get(key);
  if (!h || h.until < now) { hits.set(key, { n: 1, until: now + windowMs }); return; }
  if (++h.n > max) throw new PosError("Muitas tentativas. Aguarde alguns minutos.", 429);
}

/** Cliente com a chave pública e o JWT do operador (sem cookie): o mesmo RLS da tela web. */
export function userClient(accessToken?: string) {
  return createSupabaseClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : undefined,
  });
}

export async function deviceFromRequest(request: Request): Promise<PosDevice> {
  const token = request.headers.get("x-device-token")?.trim();
  if (!token || token.length < 20 || token.length > 200) throw new PosError("Maquininha não pareada", 401);
  const tokenHash = sha256(token);
  const { data, error } = await createAdminClient().schema("sales").rpc("pos_device_by_token", {
    p_token_hash: tokenHash, p_app_version: request.headers.get("x-app-version")?.slice(0, 20) ?? undefined,
  });
  if (error) throw new PosError("Falha ao identificar a maquininha", 500);
  const d = data as { device_id: string; org_id: string; store_id: string; store_name: string; name: string; serial: string | null } | null;
  if (!d) throw new PosError("Maquininha não pareada ou desativada: pareie de novo", 401);
  return { deviceId: d.device_id, orgId: d.org_id, storeId: d.store_id, storeName: d.store_name, name: d.name, serial: d.serial, tokenHash };
}

export async function operatorFromRequest(request: Request): Promise<PosOperator> {
  const device = await deviceFromRequest(request);
  const auth = request.headers.get("authorization") ?? "";
  const jwt = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (!jwt) throw new PosError("Entre com o seu usuário", 401);
  const supabase = userClient(jwt);
  const { data, error } = await supabase.auth.getClaims(jwt);
  if (error || !data?.claims) throw new PosError("Sessão expirada: entre de novo", 401);
  const claims = data.claims as { sub: string; app_metadata?: { org_id?: string } };
  if (claims.app_metadata?.org_id !== device.orgId) throw new PosError("Este usuário não é da empresa desta maquininha", 403);

  const { data: member } = await supabase.schema("core").from("members")
    .select("id, display_name, member_roles(roles(key, is_superuser, role_permissions(permission_key)))")
    .eq("user_id", claims.sub).maybeSingle();
  if (!member) throw new PosError("Usuário sem acesso ao sistema", 403);
  const roles = (member.member_roles ?? []).map((mr) => mr.roles).filter(Boolean);
  const perms = new Set<string>(roles.flatMap((r) => (r?.role_permissions ?? []).map((p) => p.permission_key)));
  return { supabase, device, userId: claims.sub, memberId: member.id, name: member.display_name, perms, isSuperuser: roles.some((r) => r?.is_superuser) };
}

export const can = (op: PosOperator, perm: string) => op.isSuperuser || op.perms.has(perm);

export function requirePosPerm(op: PosOperator, perm: string) {
  if (!can(op, perm)) throw new PosError("Seu perfil não tem permissão para isto", 403);
}

/** Envolve a rota: PosError e erros do banco viram JSON { error } com o status certo. */
export function posRoute<C>(fn: (request: Request, ctx: C) => Promise<unknown>) {
  return async (request: Request, ctx: C) => {
    try {
      const out = await fn(request, ctx);
      return out instanceof Response ? out : Response.json(out);
    } catch (e) {
      if (e instanceof PosError) return Response.json({ error: e.message }, { status: e.status });
      console.error("[api/pos]", e);
      return Response.json({ error: "Erro inesperado no servidor" }, { status: 500 });
    }
  };
}

/** Erro de RPC do banco → mensagem para o operador (permissão vira 403; regra de negócio, 422). */
export function dbError(error: { message: string; code?: string }): never {
  if (error.code === "42501") throw new PosError(error.message, 403);
  if (error.code === "P0002") throw new PosError(error.message, 404);
  throw new PosError(error.message, 422);
}

export async function jsonBody(request: Request): Promise<unknown> {
  return request.json().catch(() => { throw new PosError("JSON inválido"); });
}
