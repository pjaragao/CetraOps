import "server-only";
import { z } from "zod";
import { PAYMENT_METHODS, dueRange, formatBRL, maskCpf, normalizeSize, visibleNav, type DuePeriod, type PaymentKey } from "@centralops/domain";
import type { Session } from "@/lib/session";
import type { ActionLine, PersonHit, ProductHit, TitleRow } from "./cards";
import { GESTAO_TOOLS } from "./tools-gestao";
import { LOJA_TOOLS } from "./tools-loja";
import { COMPRAS_TOOLS } from "./tools-compras";
import { photoUrl } from "@/lib/photos";
import { checkPicked, date, dbError, fail, fmtDate, id, openSession, propose, storeOf, tool, ToolError, type ToolCtx, type ToolDef } from "./tool-kit";

export type { ToolCtx, ToolDef } from "./tool-kit";

/**
 * Ferramentas da Central. Cada uma declara a permissão que a tela exige: a lista enviada ao modelo já sai filtrada, e o banco confere de novo
 * (as consultas usam o JWT de quem está usando, com RLS). As de ESCRITA só propõem: gravam a ação em ai.assistant_actions e devolvem um cartão;
 * quem executa é o clique da pessoa (ai.assistant_execute).
 */

// ---------------------------------------------------------------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------------------------------------------------------------
const buscarCliente = tool({
  name: "buscar_cliente",
  description: "Busca pessoas e empresas do cadastro por nome, telefone (ou final), CPF ou @ do Instagram. Mais de um resultado: a pessoa escolhe no cartão — não escolha por ela.",
  perms: ["crm.read"],
  status: "Procurando no cadastro…",
  input: z.object({ consulta: z.string().min(2).describe("nome, telefone, CPF ou @") }),
  async run({ consulta }, ctx) {
    const { data, error } = await ctx.supabase.schema("crm").rpc("search_people", { p_query: consulta, p_limit: 6 });
    dbError(error);
    const items = (data as unknown as PersonHit[]) ?? [];
    if (items.length > 1) items.forEach((p) => ctx.ambiguousPeople.add(p.party_id));
    if (items.length) ctx.addCard({ kind: "clientes", title: items.length === 1 ? "Cliente encontrada" : `${items.length} pessoas encontradas: qual é?`, items });
    return {
      quantidade: items.length,
      pessoas: items.map((p) => ({ party_id: p.party_id, nome: p.name, nivel: p.tier, cidade: p.city, final_telefone: p.phone_last4, final_cpf: p.cpf_last4, ultima_compra: p.last_purchase_at?.slice(0, 10) })),
      dica: items.length === 0 ? "Ninguém com esse dado: ofereça cadastrar (propor_cadastro) ou vender sem identificar." : items.length > 1 ? "Mais de uma: pergunte qual é (o cartão de escolha já está na tela)." : undefined,
    };
  },
});

const fichaCliente = tool({
  name: "ficha_cliente",
  description: "Resumo da cliente antes de atender: nível, tamanhos, preferências, últimas compras e saldo de vale-troca.",
  perms: ["crm.read"],
  status: "Abrindo a ficha…",
  input: z.object({ party_id: id }),
  async run({ party_id }, ctx) {
    const { data: p, error } = await ctx.supabase.schema("crm").from("parties")
      .select("id, display_name, tier, lifecycle_stage, sizes, preferences, tags, city, birth_date, last_purchase_at, host_member_status").eq("id", party_id).maybeSingle();
    dbError(error);
    if (!p) fail("Pessoa não encontrada");
    const [{ data: orders }, { data: credit }] = await Promise.all([
      ctx.supabase.schema("sales").from("orders").select("number, total, created_at, status").eq("party_id", party_id).order("created_at", { ascending: false }).limit(3),
      ctx.supabase.schema("sales").rpc("store_credit_balance", { p_party: party_id }),
    ]);
    const sizes = Object.entries((p!.sizes ?? {}) as Record<string, string>).map(([k, v]) => `${k}: ${v}`).join(", ");
    const lines: ActionLine[] = [
      { label: "Nível", value: String(p!.tier) },
      { label: "Tamanhos", value: sizes || "não informados" },
      { label: "Última compra", value: fmtDate(p!.last_purchase_at) },
      { label: "Vale-troca", value: formatBRL(Number(credit ?? 0)) },
      ...(orders ?? []).map((o) => ({ label: `Pedido ${o.number}`, value: `${formatBRL(o.total)} em ${fmtDate(o.created_at)}` })),
    ];
    ctx.addCard({ kind: "ficha", party_id, name: p!.display_name, lines, href: `/clientes/${party_id}` });
    return { nome: p!.display_name, nivel: p!.tier, estagio: p!.lifecycle_stage, tamanhos: p!.sizes, preferencias: p!.preferences, etiquetas: p!.tags, vale_troca: Number(credit ?? 0),
             ultimos_pedidos: (orders ?? []).map((o) => ({ numero: o.number, total: Number(o.total), data: o.created_at.slice(0, 10) })) };
  },
});

const buscarProduto = tool({
  name: "buscar_produto",
  description: "Busca produtos por texto (nome, referência, cor) ou código exato (EAN bipado ou SKU), com cor e tamanho opcionais. Devolve as variantes com preço e estoque disponível na loja ativa.",
  perms: ["catalog.read"],
  status: "Procurando no catálogo…",
  input: z.object({
    consulta: z.string().optional().describe("ex.: calça aurora, legging, bermuda brisa"),
    codigo: z.string().optional().describe("EAN ou SKU exato"),
    cor: z.string().optional(),
    tamanho: z.string().optional().describe("P, M, G, GG, 36, 4…"),
  }),
  async run({ consulta, codigo, cor, tamanho }, ctx) {
    if (!consulta && !codigo) fail("Diga o produto ou o código");
    const { data, error } = await ctx.supabase.schema("catalog").rpc("search_products", {
      p: { query: consulta ?? null, code: codigo ?? null, color: cor ?? null, size: normalizeSize(tamanho), store_id: ctx.storeId, limit: 6 } as never,
    });
    dbError(error);
    type Raw = Omit<ProductHit, "photo"> & { photo?: { path: string; source: string | null } | null };
    const items: ProductHit[] = ((data as unknown as Raw[]) ?? []).map((p) => ({
      ...p, photo: p.photo ? photoUrl(p.photo.path, 160) : null, site_compare_at: p.site_compare_at == null ? null : Number(p.site_compare_at),
      variants: p.variants.map((v) => ({ ...v, price: v.price === null ? null : Number(v.price), available: Number(v.available) })),
    }));
    if (items.length) ctx.addCard({ kind: "produtos", title: items.length === 1 ? items[0].name : `${items.length} produtos`, items });
    const semEstoqueEncomendavel = items.some((p) => p.backorder && p.variants.some((v) => v.available <= 0));
    return {
      quantidade: items.length,
      produtos: items.map((p) => ({ product_id: p.product_id, nome: p.name, referencia: p.reference, categoria: p.category, linha: p.line,
        aceita_encomenda: Boolean(p.backorder), aviso_modelagem: p.fit_note ?? undefined, preco_de_no_site: p.site_compare_at ?? undefined,
        variantes: p.variants.slice(0, 30).map((v) => ({ variant_id: v.variant_id, sku: v.sku, cor: v.color, tamanho: v.size, preco: v.price, disponivel: v.available })) })),
      dica: items.length === 0 ? "Nada encontrado: tente outro nome ou sem a cor/tamanho."
        : semEstoqueEncomendavel ? "Peça sem estoque de produto que aceita encomenda: ofereça propor_encomenda." : undefined,
    };
  },
});

const contas = tool({
  name: "contas",
  description: "Contas a pagar ou a receber em aberto por período de vencimento (hoje, amanhã, semana, mês, próximos 30 dias, vencidas). Por padrão inclui as vencidas.",
  perms: ["fin.read"],
  status: "Consultando o financeiro…",
  input: z.object({
    tipo: z.enum(["pagar", "receber"]),
    periodo: z.enum(["hoje", "amanha", "semana", "mes", "proximos_30", "vencidas"]),
    incluir_vencidas: z.boolean().optional().default(true),
  }),
  async run({ tipo, periodo, incluir_vencidas }, ctx) {
    const direction = tipo === "pagar" ? "PAYABLE" : "RECEIVABLE";
    const r = dueRange(periodo as DuePeriod);
    let q = ctx.supabase.schema("fin").from("v_open_installments")
      .select("installment_id, title_id, party_name, receiver_name, description, due_date, balance, approval_status, days_overdue")
      .eq("direction", direction).lte("due_date", r.to).order("due_date").limit(60);
    if (r.from && !incluir_vencidas) q = q.gte("due_date", r.from);
    if (ctx.storeId) q = q.or(`store_id.eq.${ctx.storeId},store_id.is.null`);
    const { data, error } = await q;
    dbError(error);
    const items: TitleRow[] = (data ?? []).map((t) => ({
      installment_id: t.installment_id!, title_id: t.title_id!, party: t.receiver_name ?? t.party_name, description: t.description ?? "", due_date: t.due_date!,
      balance: Number(t.balance), approved: t.approval_status === "APPROVED", overdue_days: Number(t.days_overdue ?? 0),
    }));
    const total = Math.round(items.reduce((a, t) => a + t.balance, 0) * 100) / 100;
    const overdue = Math.round(items.filter((t) => t.overdue_days > 0).reduce((a, t) => a + t.balance, 0) * 100) / 100;
    const label = { hoje: "hoje", amanha: "amanhã", semana: "nos próximos 7 dias", mes: "até o fim do mês", proximos_30: "nos próximos 30 dias", vencidas: "vencidas" }[periodo];
    ctx.addCard({ kind: "titulos", title: `Contas a ${tipo} ${label}${incluir_vencidas && periodo !== "vencidas" ? " (com as vencidas)" : ""}`, direction, items, total,
                  href: tipo === "pagar" ? "/financeiro/pagar" : "/financeiro/receber" });
    return { quantidade: items.length, total, total_vencidas: overdue, sem_aprovacao: items.filter((t) => !t.approved).length,
             itens: items.slice(0, 15).map((t) => ({ installment_id: t.installment_id, favorecido: t.party, descricao: t.description, vencimento: t.due_date, saldo: t.balance, aprovada: t.approved, dias_atraso: t.overdue_days })) };
  },
});

const saldos = tool({
  name: "saldos_bancarios",
  description: "Saldo de cada conta bancária e caixa (conforme o razão).",
  perms: ["fin.read"],
  status: "Consultando os saldos…",
  input: z.object({}),
  async run(_a, ctx) {
    const { data, error } = await ctx.supabase.schema("fin").from("v_bank_balances").select("name, balance").order("name");
    dbError(error);
    const items = (data ?? []).map((b) => ({ name: b.name ?? "", balance: Number(b.balance) }));
    const total = Math.round(items.reduce((a, b) => a + b.balance, 0) * 100) / 100;
    ctx.addCard({ kind: "saldos", items, total });
    return { contas: items, total };
  },
});

const vendas = tool({
  name: "vendas",
  description: "Vendas do período: quantidade, receita, ticket médio, por canal e por vendedora.",
  perms: ["sales.read"],
  status: "Somando as vendas…",
  input: z.object({ periodo: z.enum(["hoje", "ontem", "semana", "mes"]) }),
  async run({ periodo }, ctx) {
    const today = dueRange("hoje").to;
    const d = (n: number) => { const x = new Date(`${today}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
    const from = { hoje: today, ontem: d(-1), semana: d(-6), mes: `${today.slice(0, 8)}01` }[periodo];
    const to = periodo === "ontem" ? d(-1) : today;
    const [{ data: byChannel, error }, { data: bySeller }] = await Promise.all([
      ctx.supabase.schema("sales").rpc("report_sales", { p_from: from, p_to: to, p_group: "channel" }),
      ctx.supabase.schema("sales").rpc("report_sales", { p_from: from, p_to: to, p_group: "seller" }),
    ]);
    dbError(error);
    type Row = { label: string; orders: number; revenue: number; avg_ticket: number };
    const ch = ((byChannel as unknown as Row[]) ?? []).map((r) => ({ ...r, revenue: Number(r.revenue), orders: Number(r.orders) }));
    const orders = ch.reduce((a, r) => a + r.orders, 0);
    const revenue = Math.round(ch.reduce((a, r) => a + r.revenue, 0) * 100) / 100;
    const avg = orders ? Math.round((revenue / orders) * 100) / 100 : 0;
    const sellers = ((bySeller as unknown as Row[]) ?? []).map((r) => ({ vendedora: r.label, pedidos: Number(r.orders), receita: Number(r.revenue) }));
    ctx.addCard({ kind: "numeros", title: `Vendas (${{ hoje: "hoje", ontem: "ontem", semana: "últimos 7 dias", mes: "mês atual" }[periodo]})`, href: "/relatorios/vendas",
                  items: [{ label: "Pedidos", value: String(orders) }, { label: "Receita", value: formatBRL(revenue) }, { label: "Ticket médio", value: formatBRL(avg) },
                          ...sellers.map((s) => ({ label: s.vendedora, value: `${formatBRL(s.receita)} (${s.pedidos})` }))] });
    return { de: from, ate: to, pedidos: orders, receita: revenue, ticket_medio: avg, por_canal: ch.map((r) => ({ canal: r.label, pedidos: r.orders, receita: r.revenue })), por_vendedora: sellers };
  },
});

const caixa = tool({
  name: "caixa",
  description: "Situação do caixa da loja ativa: aberto ou fechado, desde quando e o valor esperado em dinheiro.",
  perms: ["sales.read"],
  status: "Olhando o caixa…",
  input: z.object({}),
  async run(_a, ctx) {
    const store = await storeOf(ctx);
    const s = await openSession(ctx, store.id);
    if (!s) {
      ctx.addCard({ kind: "numeros", title: `Caixa — ${store.name}`, items: [{ label: "Situação", value: "fechado" }], href: "/vender/caixa" });
      return { aberto: false, loja: store.name };
    }
    const { data: expected } = await ctx.supabase.schema("sales").rpc("cash_session_expected", { p_session: s.id });
    ctx.addCard({ kind: "numeros", title: `Caixa — ${store.name}`, href: "/vender/caixa",
                  items: [{ label: "Situação", value: "aberto" }, { label: "Desde", value: new Date(s.opened_at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) },
                          { label: "Fundo de troco", value: formatBRL(s.opening_float) }, { label: "Esperado em dinheiro", value: formatBRL(Number(expected ?? 0)) }] });
    return { aberto: true, loja: store.name, session_id: s.id, esperado_dinheiro: Number(expected ?? 0), fundo_troco: Number(s.opening_float) };
  },
});

const listaDoDia = tool({
  name: "lista_do_dia",
  description: "Clientes para contatar hoje (tarefas, aniversários, recompra, risco), em ordem de prioridade.",
  perms: ["crm.read"],
  status: "Montando a lista do dia…",
  input: z.object({}),
  async run(_a, ctx) {
    const { data, error } = await ctx.supabase.schema("crm").rpc("daily_actions", { p_limit: 10 });
    dbError(error);
    const rows = (data ?? []) as { party_id: string | null; party_name: string | null; title: string; reason: string | null; overdue: boolean }[];
    ctx.addCard({ kind: "lista", title: "Para contatar hoje", items: rows.map((r) => ({ title: `${r.party_name ?? ""} — ${r.title}`, detail: r.reason ?? undefined, href: r.party_id ? `/clientes/${r.party_id}` : undefined })) });
    return { quantidade: rows.length, itens: rows.map((r) => ({ cliente: r.party_name, o_que: r.title, motivo: r.reason, atrasada: r.overdue })) };
  },
});

const navegar = tool({
  name: "navegar",
  description: "Encontra a tela do sistema para o que a pessoa quer abrir (ex.: folha, DRE, estoque) e mostra o link.",
  perms: [],
  status: "Procurando a tela…",
  input: z.object({ busca: z.string().min(2) }),
  async run({ busca }, ctx) {
    const norm = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    const words = norm(busca).split(/\s+/).filter((w) => w.length > 2);
    const all = visibleNav(ctx.session.perms, ctx.session.isSuperuser).flatMap((a) => [{ label: a.label, href: a.href }, ...a.items.map((i) => ({ label: `${a.label} › ${i.label}`, href: i.href }))]);
    const hits = all.filter((i) => words.some((w) => norm(i.label).includes(w))).filter((i, n, arr) => arr.findIndex((x) => x.href === i.href) === n).slice(0, 5);
    if (hits.length) ctx.addCard({ kind: "links", items: hits });
    return { telas: hits };
  },
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Escrita (propostas com cartão de confirmação)
// ---------------------------------------------------------------------------------------------------------------------------------
const novaCliente = z.object({
  nome: z.string().min(2),
  telefone: z.string().optional().describe("com DDD"),
  cpf: z.string().optional(),
  email: z.string().optional(),
  aceita_marketing: z.boolean().optional().describe("só se ela respondeu; nunca presuma"),
});

const proporVenda = tool({
  name: "propor_venda",
  description: "Prepara uma venda no PDV (loja ativa) e mostra o cartão para a pessoa confirmar. Use variant_id de buscar_produto e party_id de buscar_cliente; para cliente nova, use nova_cliente (com CPF, se ela informou). Item avulso (fora do catálogo/estoque, ex.: \"um item avulso de 100 reais\", serviço, ajuste): item com descricao e preco, sem variant_id — não procure no catálogo. Os valores são calculados pelo banco.",
  perms: ["sales.write"],
  status: "Montando a venda…",
  input: z.object({
    party_id: id.optional(),
    nova_cliente: novaCliente.optional(),
    itens: z.array(z.union([
      z.object({ variant_id: id, qtd: z.number().int().min(1).max(20).default(1) }),
      z.object({ descricao: z.string().trim().min(1).max(200).describe("item avulso: o que é"), preco: z.number().min(0).max(100000).describe("preço unitário em reais"),
                 qtd: z.number().int().min(1).max(20).default(1), ncm: z.string().regex(/^\d{8}$/).optional().describe("opcional; sem ele vale o NCM padrão da matriz fiscal") }),
    ])).min(1).max(20),
    pagamento: z.object({
      forma: z.enum(Object.keys(PAYMENT_METHODS) as [PaymentKey, ...PaymentKey[]]),
      parcelas: z.number().int().min(1).max(12).optional(),
      valor_recebido: z.number().positive().optional().describe("só no dinheiro, quando há troco"),
    }),
    cupom: z.string().max(40).optional(),
    cpf_na_nota: z.boolean().optional().describe("CPF da cliente na NFC-e"),
  }),
  async run(a, ctx) {
    const store = await storeOf(ctx);
    const warnings: string[] = [];
    let partyId = a.party_id ?? null;
    let partyLabel = "sem identificar";
    let newParty: Record<string, unknown> | null = null;
    if (partyId) {
      const { data } = await ctx.supabase.schema("crm").from("parties").select("display_name").eq("id", partyId).maybeSingle();
      if (!data) fail("Cliente não encontrada");
      partyLabel = data!.display_name;
      checkPicked(ctx, partyId, warnings);
    } else if (a.nova_cliente) {
      const cpf = (a.nova_cliente.cpf ?? "").replace(/\D/g, "");
      if (cpf) {
        const { data, error } = await ctx.supabase.schema("crm").rpc("find_by_cpf", { p_cpf: cpf });
        dbError(error);
        const found = data as unknown as { found: boolean; party_id?: string; display_name?: string };
        if (found.found) { partyId = found.party_id!; partyLabel = `${found.display_name} (já cadastrada com este CPF)`; warnings.push("Este CPF já estava no cadastro: a venda vai para essa pessoa."); }
      }
      if (!partyId) {
        newParty = { display_name: a.nova_cliente.nome.trim(), phone: a.nova_cliente.telefone || null, cpf: cpf || null, email: a.nova_cliente.email || null,
                     ...(a.nova_cliente.aceita_marketing === undefined ? {} : { marketing_whatsapp: a.nova_cliente.aceita_marketing }) };
        partyLabel = `${a.nova_cliente.nome.trim()} (cadastro novo${cpf ? `, CPF ${maskCpf(cpf)}` : ""})`;
      }
    }

    const { data: quote, error } = await ctx.supabase.schema("sales").rpc("quote_order", {
      p: { store_id: store.id, coupon_code: a.cupom ?? null,
           items: a.itens.map((i) => ("variant_id" in i ? { variant_id: i.variant_id, qty: i.qtd } : { description: i.descricao, unit_price: i.preco, qty: i.qtd, ncm: i.ncm ?? null })) } as never,
    });
    dbError(error);
    const q = quote as unknown as { items: { variant_id: string | null; custom?: boolean; description?: string; ncm?: string | null; name: string; color: string | null; size: string | null; qty: number; unit_price: number; total: number; available: number | null }[];
                                     subtotal: number; total: number; coupon: { code: string; discount: number } | null; warnings: string[] };
    const short = q.items.filter((i) => !i.custom && Number(i.available) < Number(i.qty));
    if (short.length) {
      const { data: bo } = await ctx.supabase.schema("catalog").from("variants").select("id, products!inner(backorder)").in("id", short.map((i) => i.variant_id!));
      const canOrder = (bo ?? []).some((v) => (v.products as unknown as { backorder: boolean } | null)?.backorder);
      fail(`Sem estoque suficiente na loja: ${short.map((i) => `${i.name} ${i.color ?? ""} ${i.size} (disponível ${Number(i.available)})`).join("; ")}. ` +
           (canOrder ? "O produto aceita encomenda: ofereça propor_encomenda (a cliente paga e a peça é pedida ao fornecedor)." : "Ofereça outro tamanho/cor ou o avise-me."));
    }
    warnings.push(...q.warnings);
    const coupon = q.coupon ? a.cupom : null;
    const pay = PAYMENT_METHODS[a.pagamento.forma];
    const total = Number(q.total);
    const session = await openSession(ctx, store.id);
    if (!session && a.pagamento.forma === "dinheiro") warnings.push("O caixa está fechado: abra o caixa para receber em dinheiro.");
    const amount = a.pagamento.forma === "dinheiro" && a.pagamento.valor_recebido && a.pagamento.valor_recebido > total ? a.pagamento.valor_recebido : total;
    const installments = a.pagamento.forma === "credito" ? a.pagamento.parcelas ?? 1 : 1;
    const payments = [{ method: pay.method, amount, installments, acquirer: ["DEBIT", "CREDIT"].includes(pay.method) ? "STONE" : null,
                        anticipation_mode: pay.method === "CREDIT" ? "D1" : null }];
    const cpfOnInvoice = Boolean(a.cpf_na_nota);

    const lines: ActionLine[] = [
      { label: "Cliente", value: partyLabel },
      ...q.items.map((i) => ({ label: i.custom ? `${i.qty}× ${i.name} · avulso` : `${i.qty}× ${i.name}${i.color ? ` · ${i.color}` : ""} · ${i.size}`, value: formatBRL(i.total) })),
      ...(q.coupon ? [{ label: `Cupom ${q.coupon.code}`, value: `−${formatBRL(q.coupon.discount)}` }] : []),
      { label: "Pagamento", value: `${pay.label}${installments > 1 ? ` em ${installments}x` : ""}${amount > total ? ` (recebe ${formatBRL(amount)}, troco ${formatBRL(amount - total)})` : ""}` },
      { label: "Loja", value: `${store.name}${session ? "" : " · caixa fechado"}` },
      ...(cpfOnInvoice ? [{ label: "NFC-e", value: "com o CPF da cliente (sai sem CPF se ela não tiver no cadastro)" }] : []),
    ];
    const args = { store_id: store.id, party_id: partyId, new_party: newParty, cash_session_id: session?.id ?? null, coupon_code: coupon, cpf_on_invoice: cpfOnInvoice,
                   items: q.items.map((i) => (i.custom ? { description: i.description, unit_price: Number(i.unit_price), qty: i.qty, ...(i.ncm ? { ncm: i.ncm } : {}) } : { variant_id: i.variant_id, qty: i.qty })), payments };
    const r = await propose(ctx, "venda_pdv", args, quote as Record<string, unknown>, { title: `Venda — ${formatBRL(total)}`, lines, total, warnings });
    return { ...r, total, itens: q.items.map((i) => (i.custom ? { avulso: i.name, qtd: i.qty, total: Number(i.total) } : { produto: i.name, cor: i.color, tamanho: i.size, qtd: i.qty, total: Number(i.total) })), cupom_aplicado: q.coupon };
  },
});

const proporCadastro = tool({
  name: "propor_cadastro",
  description: "Prepara o cadastro de uma pessoa (cliente) com os dados que a pessoa disse ou que vieram de um documento, para confirmar no cartão. Para acrescentar dados a um cartão de cadastro ainda não confirmado (ex.: o WhatsApp depois da foto da CNH), passe complementar_acao_id e só os campos novos.",
  perms: ["crm.write"],
  status: "Preparando o cadastro…",
  input: novaCliente.extend({
    nome: z.string().min(2).optional(),
    nascimento: date.optional(),
    genero: z.enum(["F", "M", "O"]).optional(),
    observacoes: z.string().max(300).optional(),
    complementar_acao_id: id.optional().describe("acao_id de um cartão de cadastro aguardando confirmação"),
  }),
  async run(input, ctx) {
    const a = { ...input };
    if (a.complementar_acao_id) {
      const { data: prev } = await ctx.supabase.schema("ai").from("assistant_actions").select("args, status, tool").eq("id", a.complementar_acao_id).maybeSingle();
      if (!prev || prev.tool !== "cadastrar_pessoa" || prev.status !== "PROPOSED") fail("Esse cartão de cadastro não está mais aberto: peça o cadastro de novo.");
      const g = prev!.args as Record<string, string | boolean | null>;
      a.nome ??= (g.display_name as string) ?? undefined;
      a.cpf ??= (g.cpf as string) ?? undefined;
      a.telefone ??= (g.phone as string) ?? undefined;
      a.email ??= (g.email as string) ?? undefined;
      a.nascimento ??= (g.birth_date as string) ?? undefined;
      a.genero ??= (g.gender as "F" | "M" | "O") ?? undefined;
      a.observacoes ??= (g.notes as string) ?? undefined;
      if (a.aceita_marketing === undefined && typeof g.marketing_whatsapp === "boolean") a.aceita_marketing = g.marketing_whatsapp;
      ctx.proposals.set("cadastrar_pessoa", a.complementar_acao_id);                  // o cartão antigo é cancelado pelo novo
    }
    if (!a.nome) fail("Falta o nome da pessoa.");
    const cpf = (a.cpf ?? "").replace(/\D/g, "");
    const warnings: string[] = [];
    if (cpf) {
      const { data, error } = await ctx.supabase.schema("crm").rpc("find_by_cpf", { p_cpf: cpf });
      dbError(error);
      const found = data as unknown as { found: boolean; party_id?: string; display_name?: string };
      if (found.found) {
        ctx.addCard({ kind: "clientes", title: "Este CPF já está no cadastro", items: [{ party_id: found.party_id!, name: found.display_name!, cpf_last4: cpf.slice(-4) }] });
        return { ja_cadastrada: true, party_id: found.party_id, nome: found.display_name };
      }
    }
    const { data: similar } = await ctx.supabase.schema("crm").rpc("search_people", { p_query: a.telefone?.replace(/\D/g, "").slice(-8) || a.nome!, p_limit: 3 });
    const dup = ((similar as unknown as PersonHit[]) ?? []);
    if (dup.length) warnings.push(`Parecidas no cadastro: ${dup.map((d) => d.name).join(", ")}. Confira antes de criar outra.`);
    const lines: ActionLine[] = [
      { label: "Nome", value: a.nome! },
      ...(a.telefone ? [{ label: "WhatsApp", value: a.telefone }] : []),
      ...(cpf ? [{ label: "CPF", value: maskCpf(cpf) }] : []),
      ...(a.email ? [{ label: "E-mail", value: a.email }] : []),
      ...(a.nascimento ? [{ label: "Nascimento", value: fmtDate(a.nascimento) }] : []),
      ...(a.aceita_marketing !== undefined ? [{ label: "Novidades pelo WhatsApp", value: a.aceita_marketing ? "aceitou" : "não quer" }] : []),
    ];
    const args = { display_name: a.nome!.trim(), phone: a.telefone || null, cpf: cpf || null, email: a.email || null, birth_date: a.nascimento || null, gender: a.genero || null,
                   notes: a.observacoes || null, ...(a.aceita_marketing === undefined ? {} : { marketing_whatsapp: a.aceita_marketing }) };
    if (!a.telefone) warnings.push("Sem WhatsApp: diga o número para completar o cartão.");
    const r = await propose(ctx, "cadastrar_pessoa", args, { similar: dup.map((d) => d.party_id) }, { title: `Cadastrar ${a.nome}`, lines, warnings });
    return { ...r, parecidas: dup.map((d) => ({ party_id: d.party_id, nome: d.name })) };
  },
});

const proporReserva = tool({
  name: "propor_reserva",
  description: "Separa (reserva) uma peça para a cliente por algumas horas. motivo 'separar' (padrão, até 72 h) ou 'provar' (2 h).",
  perms: ["sales.write"],
  status: "Preparando a reserva…",
  input: z.object({ party_id: id, variant_id: id, qtd: z.number().int().min(1).max(5).default(1), horas: z.number().int().min(1).max(72).optional(), motivo: z.enum(["separar", "provar"]).default("separar") }),
  async run(a, ctx) {
    const store = await storeOf(ctx);
    const [{ data: party }, { data: v }] = await Promise.all([
      ctx.supabase.schema("crm").from("parties").select("display_name").eq("id", a.party_id).maybeSingle(),
      ctx.supabase.schema("inv").from("v_stock_matrix").select("product_name, color, size, available").eq("variant_id", a.variant_id).eq("store_id", store.id).limit(1),
    ]);
    if (!party) fail("Cliente não encontrada");
    const item = v?.[0];
    const hours = a.horas ?? (a.motivo === "provar" ? 2 : 24);
    const warnings = item && Number(item.available) < a.qtd ? ["Sem estoque disponível suficiente na loja."] : [];
    checkPicked(ctx, a.party_id, warnings);
    const lines: ActionLine[] = [
      { label: "Cliente", value: party!.display_name },
      { label: "Peça", value: item ? `${a.qtd}× ${item.product_name} · ${item.color ?? ""} · ${item.size}` : a.variant_id },
      { label: "Por", value: `${hours} h (${store.name})` },
    ];
    return propose(ctx, "reserva", { party_id: a.party_id, variant_id: a.variant_id, qty: a.qtd, store_id: store.id, reason: a.motivo === "provar" ? "TRY_ON" : "ORDER", hold_hours: hours },
                   {}, { title: "Reservar peça", lines, warnings });
  },
});

const proporAviseMe = tool({
  name: "propor_avise_me",
  description: "Registra o avise-me: a cliente quer um produto num tamanho que não tem; quando chegar, ela é avisada.",
  perms: ["crm.write"],
  status: "Preparando o avise-me…",
  input: z.object({ party_id: id, product_id: id, tamanho: z.string().min(1), color_id: id.optional(), nota: z.string().max(200).optional() }),
  async run(a, ctx) {
    const [{ data: party }, { data: product }] = await Promise.all([
      ctx.supabase.schema("crm").from("parties").select("display_name").eq("id", a.party_id).maybeSingle(),
      ctx.supabase.schema("catalog").from("products").select("name").eq("id", a.product_id).maybeSingle(),
    ]);
    if (!party || !product) fail("Cliente ou produto não encontrado");
    const size = normalizeSize(a.tamanho)!;
    return propose(ctx, "avise_me", { party_id: a.party_id, product_id: a.product_id, size, color_id: a.color_id ?? null, note: a.nota ?? null }, {},
                   { title: "Avise-me quando chegar", lines: [{ label: "Cliente", value: party!.display_name }, { label: "Produto", value: `${product!.name} · ${size}` }], warnings: [] });
  },
});

const proporTarefa = tool({
  name: "propor_tarefa",
  description: "Cria uma tarefa/lembrete para quem está usando (ex.: ligar para a cliente sexta às 10h).",
  perms: ["crm.write"],
  status: "Preparando a tarefa…",
  input: z.object({
    titulo: z.string().min(2).max(140),
    party_id: id.optional(),
    quando: z.string().optional().describe("data e hora ISO 8601 com fuso -03:00"),
    descricao: z.string().max(500).optional(),
    tipo: z.enum(["FOLLOW_UP", "CALL", "MESSAGE", "VISIT", "OTHER"]).optional(),
  }),
  async run(a, ctx) {
    let who = "";
    if (a.party_id) {
      const { data } = await ctx.supabase.schema("crm").from("parties").select("display_name").eq("id", a.party_id).maybeSingle();
      if (!data) fail("Cliente não encontrada");
      who = data!.display_name;
    }
    const when = a.quando && !Number.isNaN(Date.parse(a.quando)) ? new Date(a.quando) : null;
    const lines: ActionLine[] = [
      { label: "Tarefa", value: a.titulo },
      ...(who ? [{ label: "Cliente", value: who }] : []),
      { label: "Quando", value: when ? when.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" }) : "sem data" },
    ];
    return propose(ctx, "tarefa", { title: a.titulo, party_id: a.party_id ?? null, due_at: when?.toISOString() ?? null, body: a.descricao ?? null, type: a.tipo ?? (a.party_id ? "FOLLOW_UP" : "OTHER") },
                   {}, { title: "Nova tarefa", lines, warnings: [] });
  },
});

const proporContaPagar = tool({
  name: "propor_conta_pagar",
  description: "Lança uma conta a pagar (ex.: 'conta de luz R$ 320 vence dia 10'). Use favorecido_id de buscar_cliente quando souber quem recebe; a categoria padrão do favorecido é aplicada.",
  perms: ["fin.write"],
  status: "Preparando a conta a pagar…",
  input: z.object({
    descricao: z.string().min(3).max(200),
    valor: z.number().positive(),
    vencimento: date,
    favorecido_id: id.optional(),
    codigo_barras: z.string().optional().describe("linha digitável ou código do boleto, só dígitos"),
    numero_documento: z.string().max(60).optional(),
  }),
  async run(a, ctx) {
    const store = ctx.session.stores.find((s) => s.id === ctx.storeId) ?? ctx.session.stores[0];
    let legalEntity: string | null = store?.legal_entity_id ?? null;
    if (!legalEntity) {
      const { data } = await ctx.supabase.schema("core").from("legal_entities").select("id").order("created_at").limit(1);
      legalEntity = data?.[0]?.id ?? null;
    }
    if (!legalEntity) fail("Cadastre a empresa em Configurações antes de lançar contas.");
    let payee = "não informado";
    if (a.favorecido_id) {
      const { data } = await ctx.supabase.schema("crm").from("parties").select("display_name").eq("id", a.favorecido_id).maybeSingle();
      if (!data) fail("Favorecido não encontrado");
      payee = data!.display_name;
    }
    const barcode = a.codigo_barras?.replace(/\D/g, "") || null;
    const warnings = a.vencimento < dueRange("hoje").to ? ["O vencimento já passou."] : [];
    const lines: ActionLine[] = [
      { label: "Descrição", value: a.descricao },
      { label: "Favorecido", value: payee },
      { label: "Valor", value: formatBRL(a.valor) },
      { label: "Vencimento", value: fmtDate(a.vencimento) },
      ...(barcode ? [{ label: "Código de barras", value: `…${barcode.slice(-10)}` }] : []),
      { label: "Aprovação", value: "segue a regra do financeiro (não sai aprovada)" },
    ];
    const args = { legal_entity_id: legalEntity, store_id: store?.id ?? null, party_id: a.favorecido_id ?? null, description: a.descricao, document_kind: barcode ? "BOLETO" : null,
                   document_number: a.numero_documento ?? null, installments: [{ due_date: a.vencimento, amount: a.valor, barcode }] };
    return propose(ctx, "conta_pagar", args, { total: a.valor }, { title: `Conta a pagar — ${formatBRL(a.valor)}`, lines, total: a.valor, warnings });
  },
});

const proporBaixa = tool({
  name: "propor_baixa",
  description: "Prepara o pagamento (baixa) de uma conta a pagar em aberto (installment_id de 'contas'). Só contas aprovadas; acima do teto da empresa, a baixa é feita pela tela.",
  perms: ["fin.write"],
  status: "Preparando o pagamento…",
  input: z.object({ installment_id: id, valor: z.number().positive().optional().describe("pagamento parcial; sem valor = saldo inteiro") }),
  async run(a, ctx) {
    const { data, error } = await ctx.supabase.schema("fin").from("v_open_installments")
      .select("installment_id, party_name, receiver_name, description, due_date, balance, approval_status, direction").eq("installment_id", a.installment_id).maybeSingle();
    dbError(error);
    if (!data) fail("Conta não encontrada ou já paga");
    if (data!.direction !== "PAYABLE") fail("Isto é uma conta a receber: a baixa de recebimento é feita pela tela.");
    const amount = a.valor ?? Number(data!.balance);
    const warnings = data!.approval_status !== "APPROVED" ? ["Esta conta ainda não foi aprovada: a baixa vai ser recusada."] : [];
    const lines: ActionLine[] = [
      { label: "Conta", value: data!.description ?? "" },
      { label: "Favorecido", value: data!.receiver_name ?? data!.party_name ?? "—" },
      { label: "Vencimento", value: fmtDate(data!.due_date) },
      { label: "Valor pago", value: formatBRL(amount) },
    ];
    return propose(ctx, "baixa", { installment_id: a.installment_id, amount }, { total: amount }, { title: `Pagar ${formatBRL(amount)}`, lines, total: amount, warnings });
  },
});

const proporAbrirCaixa = tool({
  name: "propor_abrir_caixa",
  description: "Abre o caixa da loja ativa com o fundo de troco informado.",
  perms: ["sales.write"],
  status: "Preparando a abertura do caixa…",
  input: z.object({ fundo_troco: z.number().min(0) }),
  async run(a, ctx) {
    const store = await storeOf(ctx);
    if (await openSession(ctx, store.id)) fail("O caixa desta loja já está aberto.");
    const { data } = await ctx.supabase.schema("sales").from("cash_registers").select("id, name").eq("store_id", store.id).eq("active", true).order("name").limit(1);
    if (!data?.[0]) fail("Esta loja não tem caixa cadastrado.");
    return propose(ctx, "abrir_caixa", { register_id: data![0].id, opening_float: a.fundo_troco }, {},
                   { title: "Abrir caixa", lines: [{ label: "Loja", value: store.name }, { label: "Caixa", value: data![0].name }, { label: "Fundo de troco", value: formatBRL(a.fundo_troco) }], warnings: [] });
  },
});

const proporFecharCaixa = tool({
  name: "propor_fechar_caixa",
  description: "Fecha o caixa da loja ativa com o valor contado em dinheiro (a diferença para o esperado fica registrada).",
  perms: ["sales.write"],
  status: "Preparando o fechamento do caixa…",
  input: z.object({ valor_contado: z.number().min(0), observacao: z.string().max(200).optional() }),
  async run(a, ctx) {
    const store = await storeOf(ctx);
    const s = await openSession(ctx, store.id);
    if (!s) fail("O caixa desta loja já está fechado.");
    const { data: expected } = await ctx.supabase.schema("sales").rpc("cash_session_expected", { p_session: s!.id });
    const diff = Math.round((a.valor_contado - Number(expected ?? 0)) * 100) / 100;
    return propose(ctx, "fechar_caixa", { session_id: s!.id, counted: a.valor_contado, notes: a.observacao ?? null }, { total: a.valor_contado, expected: Number(expected ?? 0) },
                   { title: "Fechar caixa", warnings: diff !== 0 ? [`Diferença de ${formatBRL(diff)} em relação ao esperado.`] : [],
                     lines: [{ label: "Loja", value: store.name }, { label: "Esperado", value: formatBRL(Number(expected ?? 0)) }, { label: "Contado", value: formatBRL(a.valor_contado) }] });
  },
});

export const TOOLS: ToolDef[] = [
  buscarCliente, fichaCliente, buscarProduto, contas, saldos, vendas, caixa, listaDoDia, navegar,
  proporVenda, proporCadastro, proporReserva, proporAviseMe, proporTarefa, proporContaPagar, proporBaixa, proporAbrirCaixa, proporFecharCaixa,
  ...LOJA_TOOLS, ...GESTAO_TOOLS, ...COMPRAS_TOOLS,
];

export function allowedTools(session: Session): ToolDef[] {
  const can = (p: string) => session.isSuperuser || session.perms.has(p);
  return TOOLS.filter((t) => t.perms.length === 0 || t.perms.some(can));
}

/** Formato de function calling (JSON Schema sem o cabeçalho $schema). */
export function toolSchemas(tools: ToolDef[]) {
  return tools.map((t) => {
    const parameters = z.toJSONSchema(t.input, { io: "input" }) as Record<string, unknown>;
    delete parameters.$schema;
    return { type: "function", function: { name: t.name, description: t.description, parameters } };
  });
}

/** Executa a ferramenta pedida pelo modelo: confere os argumentos e devolve erro como dado (o modelo explica à pessoa). */
export async function runTool(t: ToolDef, rawArgs: string, ctx: ToolCtx): Promise<{ ok: boolean; result: unknown; args: unknown }> {
  let args: unknown;
  try {
    args = rawArgs ? JSON.parse(rawArgs) : {};
  } catch {
    return { ok: false, result: { erro: "argumentos em JSON inválido" }, args: rawArgs };
  }
  const parsed = t.input.safeParse(args);
  if (!parsed.success) return { ok: false, result: { erro: "dados inválidos", detalhes: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`) }, args };
  try {
    return { ok: true, result: await t.run(parsed.data as never, ctx), args };
  } catch (e) {
    const message = e instanceof ToolError ? e.message : `falha: ${(e as Error).message}`;
    return { ok: false, result: { erro: message }, args };
  }
}

