import { z } from "zod";
import { deviceFromRequest, jsonBody, PosError, posRoute, rateLimit, userClient } from "@/lib/pos-api";

const body = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) });

/** Login do operador na maquininha (só de uma maquininha pareada). Devolve a sessão do Supabase para o app guardar. */
export const POST = posRoute(async (request) => {
  rateLimit(request, "login", 20);
  const device = await deviceFromRequest(request);
  const parsed = body.safeParse(await jsonBody(request));
  if (!parsed.success) throw new PosError("Informe e-mail e senha");
  const { data, error } = await userClient().auth.signInWithPassword({ email: parsed.data.email.trim().toLowerCase(), password: parsed.data.password });
  if (error || !data.session) throw new PosError("E-mail ou senha incorretos", 401);
  const orgId = (data.session.user.app_metadata as { org_id?: string } | undefined)?.org_id;
  if (orgId !== device.orgId) throw new PosError("Este usuário não é da empresa desta maquininha", 403);
  return { accessToken: data.session.access_token, refreshToken: data.session.refresh_token, expiresAt: data.session.expires_at ?? 0 };
});
