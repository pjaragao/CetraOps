import { z } from "zod";
import { deviceFromRequest, jsonBody, PosError, posRoute, userClient } from "@/lib/pos-api";

const body = z.object({ refreshToken: z.string().min(10).max(500) });

/** Renova a sessão do operador (o app chama quando o JWT está para vencer ou voltou 401). */
export const POST = posRoute(async (request) => {
  const device = await deviceFromRequest(request);
  const parsed = body.safeParse(await jsonBody(request));
  if (!parsed.success) throw new PosError("Sessão inválida", 401);
  const { data, error } = await userClient().auth.refreshSession({ refresh_token: parsed.data.refreshToken });
  if (error || !data.session) throw new PosError("Sessão expirada: entre de novo", 401);
  if ((data.session.user.app_metadata as { org_id?: string } | undefined)?.org_id !== device.orgId) throw new PosError("Usuário de outra empresa", 403);
  return { accessToken: data.session.access_token, refreshToken: data.session.refresh_token, expiresAt: data.session.expires_at ?? 0 };
});
