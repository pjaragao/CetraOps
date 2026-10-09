"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { Json } from "@centralops/db";
import { createClient } from "@/lib/supabase/server";
import { requirePerm } from "@/lib/session";
import { cancelPosOrder, getPosOrder, sendPosOrder } from "@/lib/stone";

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

function salesRpc(client: unknown) {
  return (client as { schema: (s: string) => { rpc: (name: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }> } }).schema("sales");
}

async function resolveStoneConfig() {
  const supabase = await createClient();
  const { data } = await salesRpc(supabase).rpc("get_stone_config");
  const cfg = data as unknown as {
    has_integration: boolean;
    secret_key: string | null;
    stone_code: string | null;
    default_serial_number: string | null;
    terminals: StoneTerminal[] | null;
    environment: string;
  } | null;

  const envKey = process.env.CENTRALOPS_STONE_SECRET_KEY || process.env.STONE_SECRET_KEY || "";
  const envSerial = process.env.CENTRALOPS_STONE_DEFAULT_SERIAL || process.env.STONE_DEFAULT_SERIAL || "";

  const secretKey = cfg?.secret_key || envKey || null;
  let terminals = Array.isArray(cfg?.terminals) ? cfg.terminals : [];
  let defaultSerial = cfg?.default_serial_number || envSerial || null;

  if (terminals.length === 0 && defaultSerial) {
    terminals = [{ id: "default", name: "Maquininha Padrão", serial: defaultSerial, isDefault: true }];
  }
  if (!defaultSerial && terminals.length > 0) {
    const def = terminals.find((t) => t.isDefault) || terminals[0];
    defaultSerial = def.serial;
  }

  const stoneCode = cfg?.stone_code || null;

  return {
    hasIntegration: Boolean(secretKey),
    secretKey,
    defaultSerialNumber: defaultSerial,
    terminals,
    stoneCode,
    environment: cfg?.environment || "producao",
  };
}

/** Salva ou atualiza a lista de maquininhas Stone (nome, serial e padrão). */
export async function saveStoneTerminalsAction(terminals: StoneTerminal[]) {
  await requirePerm("sales.write");
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

  const { data, error } = await salesRpc(supabase).rpc("save_stone_terminals", {
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
  const parsed = sendSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: "Dados inválidos para cobrança na maquininha" };

  const cfg = await resolveStoneConfig();
  if (!cfg.hasIntegration || !cfg.secretKey) {
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
    const orderRes = await sendPosOrder(cfg.secretKey, {
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
    await salesRpc(supabase).rpc("record_stone_pos_order", {
      p_order_id: parsed.data.orderId || null,
      p_stone_order_id: orderRes.id,
      p_terminal_serial: serial,
      p_amount: parsed.data.amount,
      p_method: parsed.data.method,
      p_installments: parsed.data.installments,
      p_display_name: displayName,
      p_raw: orderRes.raw as unknown as Json,
      p_terminal_name: terminalName,
    });

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

/** Verifica se a cobrança foi paga na maquininha da Stone e concilia a venda. */
export async function checkStonePosPaymentAction(stoneOrderId: string, orderId?: string) {
  const cfg = await resolveStoneConfig();
  if (!cfg.hasIntegration || !cfg.secretKey) {
    return { ok: false as const, error: "Credencial da Stone não encontrada" };
  }

  try {
    const res = await getPosOrder(cfg.secretKey, stoneOrderId);

    if (res.status === "paid" || res.charge?.paid) {
      const nsu = res.charge?.nsu || "STONE-PAID";
      const authCode = res.charge?.authCode || undefined;
      const cardBrand = res.charge?.cardBrand || undefined;

      const supabase = await createClient();
      await salesRpc(supabase).rpc("complete_stone_pos_payment", {
        p_stone_order_id: stoneOrderId,
        p_nsu: nsu,
        p_auth_code: authCode || null,
        p_card_brand: cardBrand || null,
        p_raw: res.raw as unknown as Json,
      });

      if (orderId) {
        revalidatePath(`/vender/pedidos/${orderId}`);
      }
      revalidatePath("/vender/pdv");
      revalidatePath("/vender/pedidos");
      revalidatePath("/inicio");

      return {
        ok: true as const,
        paid: true as const,
        nsu,
        authCode,
        cardBrand,
        amount: (res.charge?.amountCents ?? 0) / 100,
        method: res.charge?.method,
      };
    }

    if (res.status === "canceled") {
      const supabase = await createClient();
      await salesRpc(supabase).rpc("cancel_stone_pos_order", { p_stone_order_id: stoneOrderId });
      return { ok: true as const, paid: false as const, canceled: true as const };
    }

    return { ok: true as const, paid: false as const, status: res.status };
  } catch (e) {
    return { ok: false as const, error: (e as Error).message };
  }
}

/** Cancela a ordem na maquininha se o operador desistir ou quiser mudar a forma. */
export async function cancelStonePosOrderAction(stoneOrderId: string) {
  const cfg = await resolveStoneConfig();
  if (cfg.secretKey) {
    await cancelPosOrder(cfg.secretKey, stoneOrderId).catch(() => null);
  }
  const supabase = await createClient();
  await salesRpc(supabase).rpc("cancel_stone_pos_order", { p_stone_order_id: stoneOrderId });
  return { ok: true as const };
}
