"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { Json } from "@centralops/db";
import { createClient } from "@/lib/supabase/server";
import { requirePerm } from "@/lib/session";
import { cancelPosOrder, sendPosOrder } from "@/lib/stone";
import { stoneSecret, syncStoneOrder } from "@/lib/stone-sync";

export interface StoneTerminal {
  id: string;
  name: string;
  serial: string;
  isDefault?: boolean;
}

const sendSchema = z.object({
  orderId: z.string().uuid().optional(),
  orderNumber: z.string().optional(),
  amount: z.number().positive(),
  method: z.enum(["CREDIT", "DEBIT", "PIX"]).default("CREDIT"),
  installments: z.number().int().min(1).max(12).default(1),
  terminalSerial: z.string().optional(),
  terminalName: z.string().optional(),
  customerName: z.string().optional(),
  customerDoc: z.string().optional(),
});

/** Configuração para a tela (maquininhas e ambiente). A chave secreta nunca passa por aqui. */
async function resolveStoneConfig() {
  const supabase = await createClient();
  const { data } = await supabase.schema("sales").rpc("get_stone_config");
  const cfg = data as unknown as { has_integration: boolean; stone_code: string | null; default_serial_number: string | null; terminals: { id: string; name: string; serial: string; is_default?: boolean }[] | null; environment: string } | null;
  const envSerial = process.env.CENTRALOPS_STONE_DEFAULT_SERIAL || "";
  let terminals: StoneTerminal[] = (cfg?.terminals ?? []).map((t) => ({ id: t.id, name: t.name, serial: t.serial, isDefault: Boolean(t.is_default) }));
  let defaultSerial = cfg?.default_serial_number || envSerial || null;
  if (terminals.length === 0 && defaultSerial) terminals = [{ id: "default", name: "Maquininha Padrão", serial: defaultSerial, isDefault: true }];
  if (!defaultSerial && terminals.length > 0) defaultSerial = (terminals.find((t) => t.isDefault) ?? terminals[0]).serial;
  return { hasIntegration: Boolean(cfg?.has_integration) || Boolean(process.env.CENTRALOPS_STONE_SECRET_KEY), defaultSerialNumber: defaultSerial, terminals, stoneCode: cfg?.stone_code ?? null, environment: cfg?.environment || "producao" };
}

/** Salva ou atualiza a lista de maquininhas Stone (nome, serial e padrão). */
export async function saveStoneTerminalsAction(terminals: StoneTerminal[]) {
  await requirePerm("core.admin");
  const supabase = await createClient();
  const cleanTerminals = (terminals ?? []).map((t, idx) => ({
    id: t.id || `term_${Date.now()}_${idx}`,
    name: t.name.trim() || `Maquininha ${idx + 1}`,
    serial: t.serial.trim(),
    is_default: Boolean(t.isDefault),
  })).filter((t) => t.serial.length > 0);

  // Garante que haja exatamente um default se houver máquinas
  const hasDefault = cleanTerminals.some((t) => t.is_default);
  if (!hasDefault && cleanTerminals.length > 0) {
    cleanTerminals[0].is_default = true;
  }

  const { data, error } = await supabase.schema("sales").rpc("save_stone_terminals", {
    p_terminals: cleanTerminals as unknown as Json,
  });

  if (error) return { ok: false, error: error.message };
  revalidatePath("/configuracoes/integracoes");
  revalidatePath("/vender/pdv");
  return { ok: true, data };
}

/** Verifica se a Stone está configurada e retorna as maquininhas cadastradas. */
export async function getStoneConfigAction() {
  const cfg = await resolveStoneConfig();
  return {
    ok: true as const,
    hasIntegration: cfg.hasIntegration,
    defaultSerialNumber: cfg.defaultSerialNumber,
    terminals: cfg.terminals,
    stoneCode: cfg.stoneCode,
    environment: cfg.environment,
  };
}

/** Envia o pedido / cobrança diretamente para a maquininha Smart POS da Stone. */
export async function sendToStonePosAction(input: z.infer<typeof sendSchema>) {
  const session = await requirePerm("sales.write");
  const parsed = sendSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: "Dados inválidos para cobrança na maquininha" };

  const cfg = await resolveStoneConfig();
  const secretKey = await stoneSecret(session.orgId);
  if (!secretKey) {
    return {
      ok: false as const,
      error: "Integração da Stone não configurada. Conecte sua chave em Configurações › Integrações.",
    };
  }

  const serial = (parsed.data.terminalSerial || cfg.defaultSerialNumber || "").trim();
  if (!serial) {
    return {
      ok: false as const,
      error: "Informe o número de série da maquininha (atrás do terminal Stone).",
    };
  }

  const matchingTerminal = cfg.terminals.find((t) => t.serial.trim().toLowerCase() === serial.toLowerCase());
  const terminalName = parsed.data.terminalName || matchingTerminal?.name || null;

  const code = parsed.data.orderNumber
    ? `${parsed.data.orderNumber}-${Date.now().toString().slice(-4)}`
    : `PDV-${Date.now().toString().slice(-6)}`;

  const displayName = parsed.data.orderNumber
    ? `Pedido #${parsed.data.orderNumber}`
    : "Venda Balcão PDV";

  try {
    const orderRes = await sendPosOrder(secretKey, {
      code,
      amountCents: Math.round(parsed.data.amount * 100),
      terminalSerial: serial,
      displayName,
      method: parsed.data.method,
      installments: parsed.data.installments,
      customer: parsed.data.customerName ? {
        name: parsed.data.customerName,
        document: parsed.data.customerDoc,
      } : undefined,
    });

    const supabase = await createClient();
    const { error: recErr } = await supabase.schema("sales").rpc("record_stone_pos_order", {
      p_order_id: (parsed.data.orderId || null) as unknown as string,      // venda de balcão ainda sem pedido: nulo
      p_stone_order_id: orderRes.id,
      p_terminal_serial: serial,
      p_amount: parsed.data.amount,
      p_method: parsed.data.method,
      p_installments: parsed.data.installments,
      p_display_name: displayName,
      p_raw: orderRes.raw as unknown as Json,
      p_terminal_name: terminalName ?? undefined,
    });
    if (recErr) {
      await cancelPosOrder(secretKey, orderRes.id).catch(() => null);     // sem registro aqui não há como conferir depois: desfaz na maquininha
      return { ok: false as const, error: recErr.message };
    }

    return {
      ok: true as const,
      stoneOrderId: orderRes.id,
      terminalSerial: serial,
      terminalName,
      amount: parsed.data.amount,
      method: parsed.data.method,
      installments: parsed.data.installments,
    };
  } catch (e) {
    return {
      ok: false as const,
      error: (e as Error).message,
    };
  }
}

/** Confere na API da Stone se a cobrança foi paga e, se foi, registra (o valor e a forma vêm da Stone, não da tela). */
export async function checkStonePosPaymentAction(stoneOrderId: string, orderId?: string) {
  const session = await requirePerm("sales.write");
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(stoneOrderId)) return { ok: false as const, error: "Cobrança inválida" };
  try {
    const res = await syncStoneOrder(session.orgId, stoneOrderId);
    if (!res.ok) return { ok: false as const, error: res.error };
    if (res.paid) {
      if (orderId) revalidatePath(`/vender/pedidos/${orderId}`);
      revalidatePath("/vender/pdv");
      revalidatePath("/vender/pedidos");
      revalidatePath("/inicio");
      return { ok: true as const, paid: true as const, nsu: res.nsu ?? stoneOrderId, authCode: res.authCode, cardBrand: res.cardBrand, amount: res.amount, method: res.method, installments: res.installments };
    }
    if (res.canceled) return { ok: true as const, paid: false as const, canceled: true as const };
    return { ok: true as const, paid: false as const, status: res.status };
  } catch (e) {
    return { ok: false as const, error: (e as Error).message };
  }
}

/** Cancela a ordem na maquininha se o operador desistir ou quiser mudar a forma. */
export async function cancelStonePosOrderAction(stoneOrderId: string) {
  const session = await requirePerm("sales.write");
  const secretKey = await stoneSecret(session.orgId);
  if (secretKey) await cancelPosOrder(secretKey, stoneOrderId).catch(() => null);
  const supabase = await createClient();
  const { error } = await supabase.schema("sales").rpc("cancel_stone_pos_order", { p_stone_order_id: stoneOrderId });
  return error ? { ok: false as const, error: error.message } : { ok: true as const };
}
