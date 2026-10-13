import "server-only";
import { z } from "zod";
import { formatBRL, todaySP } from "@centralops/domain";
import type { ActionLine } from "./cards";
import { checkPicked, dbError, fail, fmtDate, id, propose, storeOf, tool, type ToolCtx, type ToolDef } from "./tool-kit";

/**
 * Ferramentas da LOJA na Central: encomendas, malinhas, preços que mudaram no site, horário e rotina de abertura/fechamento.
 * Leitura em uma chamada ao banco cada; as de escrita só propõem (cartão que a pessoa confirma).
 */

const iso = (d: Date) => d.toISOString().slice(0, 10);
const itens = z.array(z.object({ variant_id: id, qtd: z.number().int().min(1).max(20).default(1) })).min(1).max(20);

/** Loja para consulta: a ativa; sem loja escolhida, a primeira (consultar não exige escolher). */
function storeForRead(ctx: ToolCtx) {
  const s = ctx.session.stores.find((x) => x.id === ctx.storeId) ?? ctx.session.stores[0];
  if (!s) fail("Nenhuma loja cadastrada.");
  return s!;
}

async function partyName(ctx: ToolCtx, partyId: string) {
  const { data } = await ctx.supabase.schema("crm").from("parties").select("display_name").eq("id", partyId).maybeSingle();
  if (!data) fail("Cliente não encontrada");
  return data!.display_name;
}

interface QuoteLine { variant_id: string; name: string; color: string | null; size: string; qty: number; unit_price: number; total: number; available: number }

const proporEncomenda = tool({
  name: "propor_encomenda",
  description: "Prepara uma ENCOMENDA para a cliente: peça da coleção sem estoque (de produto que aceita encomenda) é pedida ao fornecedor; a peça que tem na loja fica reservada. " +
    "A encomenda nasce aguardando pagamento (aceita sinal). Use variant_id de buscar_produto e party_id de buscar_cliente.",
  perms: ["sales.write"],
  status: "Montando a encomenda…",
  input: z.object({ party_id: id, itens, cupom: z.string().max(40).optional(), observacao: z.string().max(300).optional() }),
  async run(a, ctx) {
    const store = await storeOf(ctx);
    const party = await partyName(ctx, a.party_id);
    const warnings: string[] = [];
    checkPicked(ctx, a.party_id, warnings);
    const { data: quote, error } = await ctx.supabase.schema("sales").rpc("quote_order", {
      p: { store_id: store.id, coupon_code: a.cupom ?? null, items: a.itens.map((i) => ({ variant_id: i.variant_id, qty: i.qtd })) } as never,
    });
    dbError(error);
    const q = quote as unknown as { items: QuoteLine[]; total: number; coupon: { code: string; discount: number } | null; warnings: string[] };
    const { data: bo } = await ctx.supabase.schema("catalog").from("variants").select("id, products!inner(backorder)").in("id", a.itens.map((i) => i.variant_id));
    const canOrder = new Map((bo ?? []).map((v) => [v.id, Boolean((v.products as unknown as { backorder: boolean } | null)?.backorder)]));
    const blocked = q.items.filter((i) => Number(i.available) < Number(i.qty) && !canOrder.get(i.variant_id));
    if (blocked.length) fail(`Sem estoque e o produto não aceita encomenda: ${blocked.map((i) => `${i.name} ${i.color ?? ""} ${i.size}`).join("; ")}. Libere a encomenda no Catálogo ou ofereça o avise-me.`);
    warnings.push(...q.warnings);
    const lines: ActionLine[] = [
      { label: "Cliente", value: party },
      ...q.items.map((i) => {
        const have = Math.min(Number(i.available), Number(i.qty)), order = Number(i.qty) - Math.max(have, 0);
        const how = order <= 0 ? "reservada da loja" : have > 0 ? `${have} da loja, ${order} a pedir` : "a pedir ao fornecedor";
        return { label: `${i.qty}× ${i.name}${i.color ? ` · ${i.color}` : ""} · ${i.size} (${how})`, value: formatBRL(Number(i.total)) };
      }),
      ...(q.coupon ? [{ label: `Cupom ${q.coupon.code}`, value: `−${formatBRL(q.coupon.discount)}` }] : []),
      { label: "Loja", value: store.name },
    ];
    const total = Number(q.total);
    const args = { store_id: store.id, party_id: a.party_id, coupon_code: q.coupon ? a.cupom : undefined, notes: a.observacao,
                   items: a.itens.map((i) => ({ variant_id: i.variant_id, qty: i.qtd })) };
    const r = await propose(ctx, "encomenda", args, { total }, { title: `Encomenda — ${formatBRL(total)}`, lines, total, warnings: [...warnings, "Nasce aguardando pagamento: receba o sinal ou o total no pedido."] });
    return { ...r, total };
  },
});

const encomendas = tool({
  name: "encomendas",
  description: "Encomendas em andamento: peças a pedir, já no pedido de compra, as que chegaram e esperam a cliente, e quantas estão sem pedido de compra.",
  perms: ["sales.read"],
  status: "Vendo as encomendas…",
  input: z.object({}),
  async run(_a, ctx) {
    const { data, error } = await ctx.supabase.schema("sales").rpc("backorder_overview", { p_limit: 20 });
    dbError(error);
    const d = data as unknown as { counts: { open: number; arrived_waiting: number; without_po: number };
      items: { order_id: string; order_number: string; customer?: string; item: string; qty: number; status: string; po_number?: string; po_status?: string; days: number }[] };
    ctx.addCard({ kind: "lista", title: `Encomendas — ${d.counts.open} a chegar, ${d.counts.arrived_waiting} chegaram`,
      items: d.items.map((i) => ({ title: `${i.order_number} · ${i.customer ?? "—"} — ${Number(i.qty)}× ${i.item}`,
                                   detail: i.status === "ARRIVED" ? "chegou: avisar a cliente" : i.po_number ? `pedido de compra ${i.po_number} (${i.po_status})` : `sem pedido de compra · há ${i.days} dia(s)`,
                                   href: `/vender/pedidos/${i.order_id}` })) });
    return { a_chegar: d.counts.open, chegaram_esperando_cliente: d.counts.arrived_waiting, sem_pedido_de_compra: d.counts.without_po,
             itens: d.items.map((i) => ({ pedido: i.order_number, cliente: i.customer, peca: i.item, qtd: Number(i.qty), situacao: i.status, pedido_compra: i.po_number, dias: i.days })) };
  },
});

const malinhas = tool({
  name: "malinhas",
  description: "Malinhas (peças com a cliente para provar) e peças em campanha que estão fora da loja: com quem, prazo, vencidas e valor fora.",
  perms: ["sales.read"],
  status: "Vendo as malinhas…",
  input: z.object({ tipo: z.enum(["provar", "campanha", "todas"]).default("todas") }),
  async run({ tipo }, ctx) {
    const kind = tipo === "provar" ? "TRY_ON" : tipo === "campanha" ? "CAMPAIGN" : null;
    const { data, error } = await ctx.supabase.schema("inv").rpc("loans_overview", { p_kind: kind as never, p_limit: 20 });
    dbError(error);
    const d = data as unknown as { open: number; overdue: number;
      items: { number: string; kind: string; customer?: string; campaign?: string; purpose?: string; due: string; overdue: boolean; pieces_out: number; value_out: number }[] };
    ctx.addCard({ kind: "lista", title: `Malinhas — ${d.open} abertas, ${d.overdue} vencidas`,
      items: d.items.map((i) => ({ title: `${i.number} · ${i.customer ?? i.campaign ?? i.purpose ?? "—"}`,
                                   detail: `${Number(i.pieces_out)} peça(s), ${formatBRL(Number(i.value_out))} · ${i.overdue ? "venceu" : "devolve"} em ${fmtDate(i.due)}`,
                                   href: `/vender/malinhas?tipo=${i.kind}` })) });
    return { abertas: d.open, vencidas: d.overdue,
             itens: d.items.map((i) => ({ numero: i.number, tipo: i.kind === "TRY_ON" ? "provar" : "campanha", com: i.customer ?? i.campaign ?? i.purpose, devolve_em: i.due,
                                          vencida: i.overdue, pecas_fora: Number(i.pieces_out), valor_fora: Number(i.value_out) })) };
  },
});

const proporMalinha = tool({
  name: "propor_malinha",
  description: "Prepara uma malinha: peças que saem da loja para a cliente provar em casa (tipo provar, devolve em 2 dias por padrão) ou para uma campanha/influenciadora (tipo campanha, 7 dias).",
  perms: ["sales.write"],
  status: "Montando a malinha…",
  input: z.object({ tipo: z.enum(["provar", "campanha"]).default("provar"), party_id: id.optional(), finalidade: z.string().max(120).optional().describe("campanha: para quem/para quê"),
                    itens, dias: z.number().int().min(1).max(90).optional(), observacao: z.string().max(300).optional() }),
  async run(a, ctx) {
    const store = await storeOf(ctx);
    if (a.tipo === "provar" && !a.party_id) fail("Malinha para provar precisa da cliente (buscar_cliente).");
    if (a.tipo === "campanha" && !a.party_id && !a.finalidade) fail("Diga para quem ou para qual campanha as peças vão.");
    const warnings: string[] = [];
    const who = a.party_id ? await partyName(ctx, a.party_id) : a.finalidade!;
    if (a.party_id) checkPicked(ctx, a.party_id, warnings);
    const { data: v } = await ctx.supabase.schema("inv").from("v_stock_matrix").select("variant_id, product_name, color, size, available")
      .in("variant_id", a.itens.map((i) => i.variant_id)).eq("store_id", store.id).eq("is_sellable", true);
    const byId = new Map<string, { label: string; available: number }>();
    for (const r of v ?? []) {
      const cur = byId.get(r.variant_id!);
      byId.set(r.variant_id!, { label: `${r.product_name} · ${r.color ?? ""} · ${r.size}`, available: (cur?.available ?? 0) + Number(r.available) });
    }
    const short = a.itens.filter((i) => (byId.get(i.variant_id)?.available ?? 0) < i.qtd);
    if (short.length) fail(`Sem estoque na loja para a malinha: ${short.map((i) => byId.get(i.variant_id)?.label ?? i.variant_id).join("; ")}.`);
    const days = a.dias ?? (a.tipo === "campanha" ? 7 : 2);
    const due = todaySP(); due.setUTCDate(due.getUTCDate() + days);
    const lines: ActionLine[] = [
      { label: a.tipo === "provar" ? "Cliente" : "Para", value: who },
      ...a.itens.map((i) => ({ label: `${i.qtd}× ${byId.get(i.variant_id)?.label ?? i.variant_id}`, value: "" })),
      { label: "Devolve até", value: fmtDate(iso(due)) },
      { label: "Loja", value: store.name },
    ];
    return propose(ctx, "malinha", { store_id: store.id, kind: a.tipo === "provar" ? "TRY_ON" : "CAMPAIGN", party_id: a.party_id ?? null, purpose: a.finalidade ?? null,
                                     due_days: days, notes: a.observacao ?? null, items: a.itens.map((i) => ({ variant_id: i.variant_id, qty: i.qtd })) },
                   {}, { title: a.tipo === "provar" ? "Malinha para provar" : "Peças para campanha", lines, warnings });
  },
});

const precosAlterados = tool({
  name: "precos_alterados",
  description: "Peças cujo preço mudou no site da marca nos últimos dias (as com estoque primeiro: precisam de etiqueta nova).",
  perms: ["catalog.read"],
  status: "Vendo os preços que mudaram…",
  input: z.object({ dias: z.number().int().min(1).max(90).default(7) }),
  async run({ dias }, ctx) {
    const { data, error } = await ctx.supabase.schema("catalog").rpc("recent_price_changes", { p_days: dias, p_limit: 30 });
    dbError(error);
    const rows = (data as unknown as { product_id: string; product: string; reference: string; old_price: number; new_price: number; compare_at: number | null; in_stock: number; changed_at: string }[]) ?? [];
    ctx.addCard({ kind: "lista", title: `Preços alterados nos últimos ${dias} dias`,
      items: rows.map((r) => ({ title: `${r.product} (${r.reference}): ${formatBRL(Number(r.old_price))} → ${formatBRL(Number(r.new_price))}`,
                                detail: `${Number(r.in_stock) > 0 ? `${Number(r.in_stock)} em estoque · trocar etiqueta` : "sem estoque"} · ${fmtDate(r.changed_at)}`, href: `/produtos/${r.product_id}` })) });
    return { quantidade: rows.length, itens: rows.map((r) => ({ produto: r.product, de: Number(r.old_price), para: Number(r.new_price), em_estoque: Number(r.in_stock), quando: r.changed_at.slice(0, 10) })) };
  },
});

const horarioLoja = tool({
  name: "horario_loja",
  description: "Horário da loja nos próximos 7 dias (com feriados/exceções) e a escala de quem trabalha.",
  perms: ["core.read", "core.admin", "hr.read", "sales.read"],
  status: "Vendo o horário…",
  input: z.object({}),
  async run(_a, ctx) {
    const store = storeForRead(ctx);
    const from = todaySP(), to = todaySP(); to.setUTCDate(to.getUTCDate() + 6);
    const { data, error } = await ctx.supabase.schema("core").rpc("store_calendar", { p_store: store.id, p_from: iso(from), p_to: iso(to) });
    dbError(error);
    const days = (data as unknown as { day: string; hours: [string, string][]; staff: { start: string; end: string }[]; exception: string | null; closed_exception: boolean }[]) ?? [];
    const wd = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit", timeZone: "UTC" });
    const configured = days.some((d) => d.hours.length > 0);
    ctx.addCard({ kind: "lista", title: `Horário — ${store.name}`, items: days.map((d) => ({
      title: `${wd(d.day)}: ${d.hours.length ? d.hours.map((h) => `${h[0]}–${h[1]}`).join(", ") : "fechada"}`,
      detail: [d.exception, d.staff.length ? `${d.staff.length} na escala` : d.hours.length ? "ninguém na escala" : null].filter(Boolean).join(" · ") || undefined,
      href: "/configuracoes/horarios" })) });
    return { loja: store.name, horario_cadastrado: configured,
             dias: days.map((d) => ({ dia: d.day, horario: d.hours.map((h) => `${h[0]}–${h[1]}`), excecao: d.exception, pessoas_na_escala: d.staff.length })),
             dica: configured ? undefined : "O horário da loja ainda não foi cadastrado (Configurações › Horários)." };
  },
});

const rotinaDoDia = tool({
  name: "rotina_do_dia",
  description: "Checklist de abertura ou fechamento da loja hoje: o que já foi feito e o que falta (caixa, notas, malinhas, rascunhos e os itens da loja).",
  perms: ["sales.read"],
  status: "Conferindo a rotina…",
  input: z.object({ qual: z.enum(["abertura", "fechamento"]).optional().describe("sem informar: abertura antes das 14h, fechamento depois") }),
  async run({ qual }, ctx) {
    const store = storeForRead(ctx);
    const hour = Number(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo", hour: "2-digit", hour12: false }));
    const kind = (qual ?? (hour < 14 ? "abertura" : "fechamento")) === "abertura" ? "OPENING" : "CLOSING";
    const { data, error } = await ctx.supabase.schema("sales").rpc("routine_status", { p_store: store.id, p_kind: kind });
    dbError(error);
    const r = data as unknown as { items: { key: string; label: string; ok: boolean; auto: boolean }[]; completed_at: string | null; completed_by: string | null };
    const pending = r.items.filter((i) => !i.ok);
    ctx.addCard({ kind: "lista", title: `${kind === "OPENING" ? "Abertura" : "Fechamento"} — ${store.name}${r.completed_at ? " (concluída)" : ""}`,
      items: r.items.map((i) => ({ title: `${i.ok ? "✓" : "○"} ${i.label}`, detail: i.auto ? "conferido pelo sistema" : undefined, href: "/vender/rotina" })) });
    return { rotina: kind === "OPENING" ? "abertura" : "fechamento", concluida: Boolean(r.completed_at), concluida_por: r.completed_by,
             falta: pending.map((i) => i.label), feito: r.items.filter((i) => i.ok).map((i) => i.label) };
  },
});

export const LOJA_TOOLS: ToolDef[] = [proporEncomenda, encomendas, malinhas, proporMalinha, precosAlterados, horarioLoja, rotinaDoDia];
