import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { jsonBody, newDeviceToken, normalizePairingCode, PosError, posRoute, rateLimit, sha256 } from "@/lib/pos-api";

const body = z.object({
  code: z.string().min(8).max(20),
  serial: z.string().max(40).optional(),
  model: z.string().max(60).optional(),
  appVersion: z.string().max(20).optional(),
});

/** Pareamento: o app troca o código gerado pelo sócio (válido por 15 min, uma vez) pelo token da maquininha. O token só é mostrado aqui. */
export const POST = posRoute(async (request) => {
  rateLimit(request, "pair", 10);
  const parsed = body.safeParse(await jsonBody(request));
  if (!parsed.success) throw new PosError("Código inválido");
  const code = normalizePairingCode(parsed.data.code);
  if (code.length !== 8) throw new PosError("O código tem 8 letras e números");
  const token = newDeviceToken();
  const { data, error } = await createAdminClient().schema("sales").rpc("pair_pos_device", {
    p_code_hash: sha256(code), p_token_hash: sha256(token),
    p_serial: parsed.data.serial ?? "", p_model: parsed.data.model ?? "", p_app_version: parsed.data.appVersion ?? "",
  });
  if (error) throw new PosError("Falha ao parear", 500);
  const r = data as { ok: boolean; error?: string; device_id: string; store_id: string; store_name: string; name: string };
  if (!r.ok) throw new PosError(r.error ?? "Código inválido", 422);
  return { deviceToken: token, device: { id: r.device_id, name: r.name, storeId: r.store_id, storeName: r.store_name } };
});
