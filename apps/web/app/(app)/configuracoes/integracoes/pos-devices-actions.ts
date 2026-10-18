"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requirePerm } from "@/lib/session";
import { newPairingCode, sha256 } from "@/lib/pos-api";

export interface PosDeviceRow {
  id: string; store_id: string; store_name: string; name: string; serial: string | null; model: string | null; app_version: string | null;
  paired: boolean; pairing_pending: boolean; pairing_expires_at: string | null; paired_at: string | null; last_seen_at: string | null; revoked: boolean;
}

/** Maquininhas com o app do PDV e as lojas para parear uma nova. */
export async function listPosDevicesAction() {
  const session = await requirePerm("core.admin");
  const supabase = await createClient();
  const { data, error } = await supabase.schema("sales").rpc("list_pos_devices");
  if (error) return { ok: false as const, error: error.message };
  return { ok: true as const, devices: (data ?? []) as unknown as PosDeviceRow[], stores: session.stores.map((s) => ({ id: s.id, name: s.name })), defaultStoreId: session.storeId };
}

const pairSchema = z.object({ storeId: z.string().uuid(), name: z.string().trim().min(1).max(60), deviceId: z.string().uuid().optional() });

/** Gera o código de pareamento (8 caracteres, 15 minutos). O código só aparece agora; o banco guarda o hash. */
export async function createPairingCodeAction(input: z.infer<typeof pairSchema>) {
  await requirePerm("core.admin");
  const parsed = pairSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: "Escolha a loja e dê um nome à maquininha" };
  const code = newPairingCode();
  const supabase = await createClient();
  const { data, error } = await supabase.schema("sales").rpc("create_pos_device_pairing", {
    p_store: parsed.data.storeId, p_name: parsed.data.name, p_code_hash: sha256(code), p_device: parsed.data.deviceId,
  });
  if (error) return { ok: false as const, error: error.message };
  revalidatePath("/configuracoes/integracoes");
  const r = data as { id: string; expires_at: string };
  return { ok: true as const, deviceId: r.id, code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt: r.expires_at };
}

export async function revokePosDeviceAction(deviceId: string) {
  await requirePerm("core.admin");
  if (!z.string().uuid().safeParse(deviceId).success) return { ok: false as const, error: "Maquininha inválida" };
  const supabase = await createClient();
  const { error } = await supabase.schema("sales").rpc("revoke_pos_device", { p_device: deviceId });
  if (error) return { ok: false as const, error: error.message };
  revalidatePath("/configuracoes/integracoes");
  return { ok: true as const };
}
