import "server-only";
import { z } from "zod";
import type { Json } from "@centralops/db";
import { briefingLine, formatBRL, todaySP, type BriefingItem } from "@centralops/domain";
import type { ActionLine } from "./cards";
import { dbError, fmtDate, propose, tool, type ToolCtx, type ToolDef } from "./tool-kit";

/**
 * Ferramentas de GESTÃO da Central (só leitura): as mesmas funções e consultas das telas de Financeiro, Fiscal, Compras, Relatórios,
 * Equipe, Atendimento e Inteligência. Nenhum número é calculado aqui além de somas simples do que o banco devolveu.
 */

const iso = (d: Date) => d.toISOString().slice(0, 10);
const today = () => todaySP();
const plus = (n: number) => { const t = today(); return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + n)); };
const round = (n: number) => Math.round(n * 100) / 100;

type Period = "mes" | "mes_anterior" | "trimestre" | "ano";
function periodRange(p: Period): { from: string; to: string; label: string } {
  const t = today();
  const y = t.getUTCFullYear();
  const m = t.getUTCMonth();
  switch (p) {
    case "mes": return { from: iso(new Date(Date.UTC(y, m, 1))), to: iso(t), label: "mês atual" };
    case "mes_anterior": return { from: iso(new Date(Date.UTC(y, m - 1, 1))), to: iso(new Date(Date.UTC(y, m, 0))), label: "mês anterior" };
    case "trimestre": return { from: iso(new Date(Date.UTC(y, m - 2, 1))), to: iso(t), label: "últimos 3 meses" };
    case "ano": return { from: iso(new Date(Date.UTC(y, 0, 1))), to: iso(t), label: "ano" };
  }
}
const period = z.enum(["mes", "mes_anterior", "trimestre", "ano"]);

/** Empresa (CNPJ) da loja ativa, ou a primeira cadastrada. */
async function entityOf(ctx: ToolCtx): Promise<string | null> {
  const store = ctx.session.stores.find((s) => s.id === ctx.storeId);
  if (store?.legal_entity_id) return store.legal_entity_id;
  const { data } = await ctx.supabase.schema("core").from("legal_entities").select("id").eq("kind", "OPERATING").order("created_at").limit(1);
  return data?.[0]?.id ?? null;
}

const dre = tool({
  name: "dre",
  description: "DRE gerencial do período (receita, deduções, custos, despesas, resultado), do razão contábil. Para 'quanto lucrei', 'quanto gastei com X'.",
  perms: ["fin.read"],
  status: "Montando o DRE…",
  input: z.object({ periodo: period }),
  async run({ periodo }, ctx) {
    const r = periodRange(periodo);
    const { data, error } = await ctx.supabase.schema("fin").rpc("dre", { p_from: r.from, p_to: r.to });
    dbError(error);
    const rows = ((data ?? []) as { code: string; name: string; is_subtotal: boolean; amount: number }[]).map((x) => ({ ...x, amount: Number(x.amount) }));
    const shown = rows.filter((x) => x.is_subtotal || Math.abs(x.amount) >= 0.01);
    ctx.addCard({ kind: "numeros", title: `DRE — ${r.label} (${fmtDate(r.from)} a ${fmtDate(r.to)})`, href: "/financeiro/dre",
                  items: shown.slice(0, 18).map((x): ActionLine => ({ label: x.is_subtotal ? `= ${x.name}` : x.name, value: formatBRL(x.amount) })) });
    return { de: r.from, ate: r.to, linhas: shown.map((x) => ({ conta: x.name, subtotal: x.is_subtotal, valor: x.amount })),
             observacao: periodo === "mes" || periodo === "ano" ? "período ainda aberto: resultado parcial" : undefined };
  },
});

const fluxoCaixa = tool({
  name: "fluxo_caixa",
  description: "Fluxo de caixa projetado dos próximos dias: entradas e saídas previstas, saldo no fim e o dia de menor saldo ('vou ficar no vermelho?').",
  perms: ["fin.read"],
  status: "Projetando o caixa…",
  input: z.object({ dias: z.number().int().min(7).max(90).default(30) }),
  async run({ dias }, ctx) {
    const { data, error } = await ctx.supabase.schema("fin").rpc("cash_flow", { p_from: iso(today()), p_to: iso(plus(dias)) });
    dbError(error);
    const rows = ((data ?? []) as { day: string; realized_in: number; realized_out: number; projected_in: number; projected_out: number; balance: number }[])
      .map((x) => ({ day: x.day, entra: Number(x.realized_in) + Number(x.projected_in), sai: Number(x.realized_out) + Number(x.projected_out), saldo: Number(x.balance) }));
    if (!rows.length) return { dias, aviso: "sem dados de fluxo para o período" };
    const min = rows.reduce((a, x) => (x.saldo < a.saldo ? x : a), rows[0]);
    const entradas = round(rows.reduce((a, x) => a + x.entra, 0));
    const saidas = round(rows.reduce((a, x) => a + x.sai, 0));
    const fim = rows[rows.length - 1].saldo;
    const maiores = rows.filter((x) => x.sai > 0).sort((a, b) => b.sai - a.sai).slice(0, 3);
    ctx.addCard({ kind: "numeros", title: `Fluxo de caixa — próximos ${dias} dias`, href: "/financeiro/fluxo",
                  items: [{ label: "Entradas previstas", value: formatBRL(entradas) }, { label: "Saídas previstas", value: formatBRL(saidas) },
                          { label: "Saldo no fim", value: formatBRL(fim) }, { label: "Menor saldo", value: `${formatBRL(min.saldo)} em ${fmtDate(min.day)}` },
                          ...maiores.map((x) => ({ label: `Dia de mais saída: ${fmtDate(x.day)}`, value: formatBRL(x.sai) }))] });
    return { dias, entradas_previstas: entradas, saidas_previstas: saidas, saldo_final: fim, menor_saldo: { dia: min.day, saldo: min.saldo }, fica_negativo: min.saldo < 0,
             dias_de_mais_saida: maiores.map((x) => ({ dia: x.day, saida: round(x.sai) })) };
  },
});

const fechamento = tool({
  name: "fechamento_mes",
  description: "O que falta para fechar o mês contábil (checklist do fechamento), com o link de cada pendência.",
  perms: ["fin.read"],
  status: "Conferindo o fechamento…",
  input: z.object({ competencia: z.string().regex(/^\d{4}-\d{2}$/).optional().describe("AAAA-MM; sem ela, o mês anterior") }),
  async run({ competencia }, ctx) {
    const entity = await entityOf(ctx);
    if (!entity) return { aviso: "nenhuma empresa cadastrada" };
    const t = today();
    const comp = competencia ? `${competencia}-01` : iso(new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - 1, 1)));
    const { data, error } = await ctx.supabase.schema("fin").rpc("closing_checklist", { p_entity: entity, p_competence: comp });
    dbError(error);
    const rows = (data ?? []) as { key: string; label: string; status: string; detail: string | null; n: number | null; href: string | null }[];
    const pend = rows.filter((r) => r.status !== "OK");
    ctx.addCard({ kind: "lista", title: `Fechamento de ${comp.slice(5, 7)}/${comp.slice(0, 4)}: ${pend.length ? `${pend.length} pendência(s)` : "tudo certo"}`,
                  items: rows.map((r) => ({ title: `${r.status === "OK" ? "✓" : "•"} ${r.label}`, detail: r.detail ?? undefined, href: r.href ?? undefined })) });
    return { competencia: comp.slice(0, 7), pendencias: pend.map((r) => ({ item: r.label, situacao: r.status, detalhe: r.detail, quantidade: r.n })), tudo_ok: pend.length === 0 };
  },
});

const simples = tool({
  name: "simples_das",
  description: "Apuração do Simples Nacional do mês: receita, RBT12, alíquota efetiva e o DAS estimado.",
  perms: ["fiscal.read"],
  status: "Calculando o Simples…",
  input: z.object({ competencia: z.string().regex(/^\d{4}-\d{2}$/).optional().describe("AAAA-MM; sem ela, o mês atual") }),
  async run({ competencia }, ctx) {
    const entity = await entityOf(ctx);
    if (!entity) return { aviso: "nenhuma empresa cadastrada" };
    const comp = competencia ? `${competencia}-01` : `${iso(today()).slice(0, 7)}-01`;
    const { data, error } = await ctx.supabase.schema("fiscal").rpc("simples_calc", { p_entity: entity, p_competence: comp });
    dbError(error);
    const r = ((data ?? []) as { revenue_annex1: number; revenue_annex3: number; returns_amount: number; rbt12: number; rbt12_method: string; rate1: number; rate3: number; das: number }[])[0];
    if (!r) return { aviso: "sem apuração para a competência" };
    ctx.addCard({ kind: "numeros", title: `Simples Nacional — ${comp.slice(5, 7)}/${comp.slice(0, 4)}`, href: "/fiscal",
                  items: [{ label: "Receita (Anexo I)", value: formatBRL(r.revenue_annex1) }, { label: "Receita de serviços (Anexo III)", value: formatBRL(r.revenue_annex3) },
                          { label: "Devoluções", value: formatBRL(r.returns_amount) }, { label: "RBT12", value: `${formatBRL(r.rbt12)} (${r.rbt12_method})` },
                          { label: "Alíquota efetiva (Anexo I)", value: `${Number(r.rate1).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%` },
                          { label: "DAS estimado", value: formatBRL(r.das) }] });
    return { competencia: comp.slice(0, 7), receita_anexo1: Number(r.revenue_annex1), receita_anexo3: Number(r.revenue_annex3), devolucoes: Number(r.returns_amount),
             rbt12: Number(r.rbt12), aliquota_anexo1_pct: Number(r.rate1), aliquota_anexo3_pct: Number(r.rate3), das_estimado: Number(r.das),
             observacao: comp.slice(0, 7) === iso(today()).slice(0, 7) ? "mês em andamento: estimativa com as vendas até hoje" : undefined };
  },
});

const obrigacoes = tool({
  name: "obrigacoes_fiscais",
  description: "Obrigações fiscais e trabalhistas em aberto (DAS, FGTS, INSS, IRRF, eSocial…) que vencem nos próximos dias, e as atrasadas.",
  perms: ["fiscal.read"],
  status: "Olhando as obrigações…",
  input: z.object({ dias: z.number().int().min(1).max(90).default(30) }),
  async run({ dias }, ctx) {
    const { data, error } = await ctx.supabase.schema("fiscal").from("obligations").select("kind, competence, due_date, amount, status, notes")
      .eq("status", "PENDING").lte("due_date", iso(plus(dias))).order("due_date").limit(30);
    dbError(error);
    const rows = data ?? [];
    const late = rows.filter((r) => r.due_date < iso(today()));
    ctx.addCard({ kind: "lista", title: `Obrigações até ${fmtDate(iso(plus(dias)))}${late.length ? ` (${late.length} atrasada[s])` : ""}`,
                  items: rows.map((r) => ({ title: `${r.kind} — vence ${fmtDate(r.due_date)}${r.amount ? ` · ${formatBRL(r.amount)}` : ""}`, detail: r.due_date < iso(today()) ? "atrasada" : undefined, href: "/fiscal/obrigacoes" })) });
    return { quantidade: rows.length, atrasadas: late.length, itens: rows.map((r) => ({ tipo: r.kind, competencia: r.competence, vencimento: r.due_date, valor: r.amount === null ? null : Number(r.amount) })) };
  },
});

const reposicao = tool({
  name: "reposicao",
  description: "O que repor na loja ativa: peças com cobertura baixa pelo ritmo de vendas, com a quantidade sugerida por cor e tamanho.",
  perms: ["purch.read"],
  status: "Calculando a reposição…",
  input: z.object({}),
  async run(_a, ctx) {
    const store = ctx.session.stores.find((s) => s.id === ctx.storeId) ?? ctx.session.stores[0];
    if (!store) return { aviso: "nenhuma loja cadastrada" };
    const { data: loc } = await ctx.supabase.schema("inv").from("locations").select("id").eq("store_id", store.id).eq("kind", "SALES_FLOOR").order("created_at").limit(1);
    if (!loc?.[0]) return { aviso: "a loja não tem local de estoque de venda" };
    const { data, error } = await ctx.supabase.schema("purch").rpc("replenishment", { p_location: loc[0].id });
    dbError(error);
    const rows = ((data ?? []) as { product_name: string; color: string | null; size: string; on_hand: number; days_cover: number | null; suggested: number }[])
      .filter((r) => Number(r.suggested) > 0).sort((a, b) => Number(b.suggested) - Number(a.suggested)).slice(0, 15);
    ctx.addCard({ kind: "lista", title: `Repor em ${store.name}`, items: rows.map((r) => ({ title: `${r.product_name} ${r.color ?? ""} ${r.size}: comprar ${Number(r.suggested)}`,
                  detail: `tem ${Number(r.on_hand)}${r.days_cover !== null ? ` · cobre ${Math.round(Number(r.days_cover))} dia(s)` : ""}`, href: "/produtos/reposicao" })) });
    return { loja: store.name, itens: rows.map((r) => ({ produto: r.product_name, cor: r.color, tamanho: r.size, em_estoque: Number(r.on_hand), cobertura_dias: r.days_cover === null ? null : Math.round(Number(r.days_cover)), sugerido: Number(r.suggested) })) };
  },
});

const curvaAbc = tool({
  name: "curva_abc",
  description: "Curva ABC das vendas: o que mais vende (A = 80% da receita), por produto, tamanho ou categoria.",
  perms: ["sales.read"],
  status: "Montando a curva ABC…",
  input: z.object({ periodo: period, por: z.enum(["produto", "tamanho", "categoria"]).default("produto") }),
  async run({ periodo, por }, ctx) {
    const r = periodRange(periodo);
    const { data, error } = await ctx.supabase.schema("sales").rpc("report_abc", { p_from: r.from, p_to: r.to, p_by: { produto: "product", tamanho: "size", categoria: "category" }[por] });
    dbError(error);
    const rows = ((data ?? []) as { label: string; qty: number; revenue: number; share_pct: number; class: string }[]).slice(0, 12);
    ctx.addCard({ kind: "lista", title: `Curva ABC por ${por} — ${r.label}`, items: rows.map((x) => ({ title: `${x.class} · ${x.label}`, detail: `${formatBRL(x.revenue)} · ${Number(x.qty)} peça(s) · ${x.share_pct}%` })) });
    return { de: r.from, ate: r.to, itens: rows.map((x) => ({ classe: x.class, item: x.label, receita: Number(x.revenue), pecas: Number(x.qty), participacao_pct: Number(x.share_pct) })) };
  },
});

const escala = tool({
  name: "escala",
  description: "Quem trabalha num dia (escala publicada e rascunho), com horários.",
  perms: ["hr.read"],
  status: "Abrindo a escala…",
  input: z.object({ dia: z.string().regex(/^(hoje|amanha|\d{4}-\d{2}-\d{2})$/).default("hoje").describe("hoje, amanha ou AAAA-MM-DD") }),
  async run({ dia }, ctx) {
    const d = dia === "hoje" ? iso(today()) : dia === "amanha" ? iso(plus(1)) : dia;
    const { data, error } = await ctx.supabase.schema("hr").from("roster").select("employee_id, kind, start_time, end_time, status, store_id").eq("work_date", d).order("start_time");
    dbError(error);
    const ids = [...new Set((data ?? []).map((r) => r.employee_id))];
    const { data: emps } = ids.length ? await ctx.supabase.schema("hr").from("employees").select("id, party_id, job_title").in("id", ids) : { data: [] };
    const partyIds = (emps ?? []).map((e) => e.party_id).filter(Boolean) as string[];
    const { data: people } = partyIds.length ? await ctx.supabase.schema("crm").from("parties").select("id, display_name").in("id", partyIds) : { data: [] };
    const name = (empId: string) => { const e = (emps ?? []).find((x) => x.id === empId); return (people ?? []).find((p) => p.id === e?.party_id)?.display_name ?? "—"; };
    const work = (data ?? []).filter((r) => r.kind === "WORK");
    const off = (data ?? []).filter((r) => r.kind !== "WORK");
    ctx.addCard({ kind: "lista", title: `Escala de ${fmtDate(d)}${work.some((r) => r.status !== "PUBLISHED") ? " (há turnos em rascunho)" : ""}`,
                  items: [...work.map((r) => ({ title: `${name(r.employee_id)}: ${r.start_time?.slice(0, 5) ?? "?"}–${r.end_time?.slice(0, 5) ?? "?"}`, detail: r.status === "PUBLISHED" ? undefined : "rascunho", href: "/equipe/escalas" })),
                          ...off.map((r) => ({ title: `${name(r.employee_id)}: folga`, href: "/equipe/escalas" }))] });
    return { dia: d, trabalham: work.map((r) => ({ pessoa: name(r.employee_id), inicio: r.start_time, fim: r.end_time, publicada: r.status === "PUBLISHED" })), folgas: off.map((r) => name(r.employee_id)) };
  },
});

const ferias = tool({
  name: "ferias",
  description: "Férias marcadas nos próximos 60 dias e períodos com férias perto de vencer.",
  perms: ["hr.read"],
  status: "Olhando as férias…",
  input: z.object({}),
  async run(_a, ctx) {
    const [{ data: vac, error }, { data: bal }] = await Promise.all([
      ctx.supabase.schema("hr").from("vacations").select("employee_id, start_date, end_date, days, status").gte("end_date", iso(today())).lte("start_date", iso(plus(60))).neq("status", "CANCELLED").order("start_date"),
      ctx.supabase.schema("hr").from("v_vacation_balance").select("employee_id, days_left, days_to_expire, concessive_end").gt("days_left", 0).lte("days_to_expire", 60).order("days_to_expire"),
    ]);
    dbError(error);
    const ids = [...new Set([...(vac ?? []).map((v) => v.employee_id), ...(bal ?? []).map((b) => b.employee_id)].filter(Boolean) as string[])];
    const { data: emps } = ids.length ? await ctx.supabase.schema("hr").from("employees").select("id, party_id").in("id", ids) : { data: [] };
    const partyIds = (emps ?? []).map((e) => e.party_id).filter(Boolean) as string[];
    const { data: people } = partyIds.length ? await ctx.supabase.schema("crm").from("parties").select("id, display_name").in("id", partyIds) : { data: [] };
    const name = (empId: string | null) => { const e = (emps ?? []).find((x) => x.id === empId); return (people ?? []).find((p) => p.id === e?.party_id)?.display_name ?? "—"; };
    ctx.addCard({ kind: "lista", title: "Férias", items: [
      ...(vac ?? []).map((v) => ({ title: `${name(v.employee_id)}: ${fmtDate(v.start_date)} a ${fmtDate(v.end_date)} (${v.days} dias)`, detail: v.status, href: "/equipe/ferias" })),
      ...(bal ?? []).map((b) => ({ title: `${name(b.employee_id)}: ${b.days_left} dia(s) a vencer em ${fmtDate(b.concessive_end)}`, detail: "marcar férias", href: "/equipe/ferias" })),
    ] });
    return { marcadas: (vac ?? []).map((v) => ({ pessoa: name(v.employee_id), inicio: v.start_date, fim: v.end_date, dias: v.days })),
             a_vencer: (bal ?? []).map((b) => ({ pessoa: name(b.employee_id), dias_restantes: b.days_left, limite: b.concessive_end })) };
  },
});

const conversas = tool({
  name: "conversas_aguardando",
  description: "Conversas de clientes esperando uma pessoa da equipe (com o resumo do que a cliente quer).",
  perms: ["omni.read"],
  status: "Olhando o atendimento…",
  input: z.object({}),
  async run(_a, ctx) {
    const { data, error } = await ctx.supabase.schema("omni").from("conversations").select("id, party_id, last_inbound_at, intent, summary, priority")
      .eq("mode", "WAITING_HUMAN").neq("status", "CLOSED").order("last_inbound_at", { ascending: true }).limit(15);
    dbError(error);
    const partyIds = (data ?? []).map((c) => c.party_id).filter(Boolean) as string[];
    const { data: people } = partyIds.length ? await ctx.supabase.schema("crm").from("parties").select("id, display_name").in("id", partyIds) : { data: [] };
    const who = (pid: string | null) => (people ?? []).find((p) => p.id === pid)?.display_name ?? "cliente sem nome";
    const since = (at: string | null) => (at ? Math.max(0, Math.round((Date.now() - Date.parse(at)) / 60000)) : null);
    ctx.addCard({ kind: "lista", title: `${(data ?? []).length} conversa(s) esperando a equipe`, items: (data ?? []).map((c) => ({
      title: `${who(c.party_id)}${since(c.last_inbound_at) !== null ? ` · há ${since(c.last_inbound_at)} min` : ""}`, detail: c.summary ?? c.intent ?? undefined, href: `/atendimento?c=${c.id}` })) });
    return { quantidade: (data ?? []).length, conversas: (data ?? []).map((c) => ({ cliente: who(c.party_id), esperando_min: since(c.last_inbound_at), assunto: c.intent, resumo: c.summary })) };
  },
});

const sugestoes = tool({
  name: "sugestoes_abertas",
  description: "Alertas abertos da Central de sugestões (estoque negativo, diferença de caixa, desconto fora do padrão, queda de vendas…), com o motivo e o link para resolver.",
  perms: ["ai.read"],
  status: "Olhando os alertas…",
  input: z.object({}),
  async run(_a, ctx) {
    const { data, error } = await ctx.supabase.schema("ai").from("suggestions").select("id, kind, payload, created_at").eq("status", "OPEN").order("created_at", { ascending: false }).limit(20);
    dbError(error);
    const sev = (p: Record<string, unknown>) => ({ HIGH: 0, MEDIUM: 1, LOW: 2 }[String(p.severity)] ?? 3);
    const rows = (data ?? []).map((s) => ({ ...s, p: (s.payload ?? {}) as Record<string, unknown> })).sort((a, b) => sev(a.p) - sev(b.p));
    ctx.addCard({ kind: "lista", title: `${rows.length} alerta(s) aberto(s)`, items: rows.map((s) => ({ title: `${s.p.severity === "HIGH" ? "⚠ " : ""}${String(s.p.title ?? s.kind)}`, detail: s.p.detail ? String(s.p.detail) : undefined, href: s.p.href ? String(s.p.href) : "/ia" })) });
    return { quantidade: rows.length, alertas: rows.map((s) => ({ titulo: s.p.title, gravidade: s.p.severity, detalhe: s.p.detail, regra: s.p.rule, desde: s.created_at.slice(0, 10) })) };
  },
});

const resumoDoDia = tool({
  name: "resumo_do_dia",
  description: "Resumo do dia de quem está usando (vendas de ontem, contas de hoje e vencidas, recebimentos, caixa, estoque crítico, conversas esperando, clientes para contatar, alertas), conforme as permissões. Use para 'como estamos hoje?', 'o que faço primeiro?'.",
  perms: [],
  status: "Montando o resumo do dia…",
  input: z.object({}),
  async run(_a, ctx) {
    const { data, error } = await ctx.supabase.schema("ai").rpc("daily_briefing");
    dbError(error);
    const items = ((data as unknown as { items?: BriefingItem[] } | null)?.items ?? []).map((i) => ({ ...i, amount: i.amount === undefined ? undefined : Number(i.amount), compare_amount: i.compare_amount === undefined ? undefined : Number(i.compare_amount) }));
    ctx.addCard({ kind: "lista", title: "Resumo do dia", items: items.map((i) => ({ title: briefingLine(i), href: i.href })) });
    return { itens: items.map((i) => ({ assunto: i.key, frase: briefingLine(i), quantidade: i.count, valor: i.amount, comparacao: i.compare_amount, urgencia: i.tone })) };
  },
});

const contarPublico = tool({
  name: "contar_publico",
  description: "Conta quantas pessoas se encaixam em filtros (ex.: 'quantas clientes não compram há 90 dias?', 'quantas leads temos?'). Mostra total e alcançáveis no WhatsApp e Meta.",
  perms: ["crm.read"],
  status: "Calculando público…",
  input: z.object({
    dias_sem_comprar: z.number().optional().describe("dias sem compra (mínimo, ex: 60, 90, 180)"),
    estagios: z.array(z.string()).optional().describe("etapas ex: CUSTOMER, VIP, LEAD, INACTIVE"),
    cidade: z.string().optional().describe("cidade"),
    nunca_comprou: z.boolean().optional().describe("só quem nunca comprou"),
  }),
  async run(arg, ctx) {
    const def: Record<string, unknown> = {};
    if (arg.dias_sem_comprar) def.inactive_days = arg.dias_sem_comprar;
    if (arg.estagios?.length) def.lifecycle = arg.estagios;
    if (arg.cidade) def.cities = [arg.cidade];
    if (arg.nunca_comprou) def.never_bought = true;
    const { data, error } = await ctx.supabase.schema("mkt").rpc("segment_preview", { p_def: def as unknown as Json });
    dbError(error);
    const p = data as unknown as { total: number; whatsapp: number; ads: number; sample: string[] };
    ctx.addCard({
      kind: "numeros",
      title: "Contagem de público",
      href: "/marketing/publicos",
      items: [
        { label: "Total de pessoas", value: String(p?.total ?? 0) },
        { label: "Alcançáveis no WhatsApp", value: String(p?.whatsapp ?? 0) },
        { label: "Alcançáveis na Meta", value: String(p?.ads ?? 0) },
      ],
    });
    return {
      total: p?.total ?? 0,
      whatsapp: p?.whatsapp ?? 0,
      meta_ads: p?.ads ?? 0,
      amostra: p?.sample ?? [],
    };
  },
});

const proporCampanha = tool({
  name: "propor_campanha",
  description: "Prepara um rascunho de campanha segmentada para a pessoa confirmar (cartão). Nada é criado antes da confirmação e a campanha nunca é lançada sozinha.",
  perms: ["crm.write"],
  status: "Montando rascunho de campanha…",
  input: z.object({
    nome: z.string().min(3).max(120).describe("nome da campanha"),
    objetivo: z.enum(["REACTIVATE", "LAUNCH", "ACQUIRE", "CONVERT", "LOYALTY", "EVENT", "CLEARANCE", "CUSTOM"]).default("REACTIVATE"),
    dias_sem_comprar: z.number().int().min(1).max(3650).optional().describe("dias sem compra"),
    estagios: z.array(z.enum(["LEAD", "PROSPECT", "CUSTOMER", "VIP", "INACTIVE", "LOST"])).optional().describe("etapas"),
  }),
  async run(arg, ctx) {
    const audience: Record<string, unknown> = {};
    if (arg.dias_sem_comprar) audience.inactive_days = arg.dias_sem_comprar;
    if (arg.estagios?.length) audience.lifecycle = arg.estagios;
    const { data, error } = await ctx.supabase.schema("mkt").rpc("segment_preview", { p_def: audience as unknown as Json });
    dbError(error);
    const p = data as unknown as { total: number; whatsapp: number };
    const lines: ActionLine[] = [
      { label: "Objetivo", value: arg.objetivo },
      { label: "Público", value: `${p?.total ?? 0} pessoa(s) · ${p?.whatsapp ?? 0} no WhatsApp` },
    ];
    return propose(ctx, "campanha_rascunho", { name: arg.nome, objective: arg.objetivo, audience }, { total: p?.total ?? 0 },
      { title: `Rascunho de campanha: ${arg.nome}`, lines, warnings: ["Depois de criada, revise oferta e canais e lance pela tela de campanhas."] });
  },
});

export const GESTAO_TOOLS: ToolDef[] = [resumoDoDia, dre, fluxoCaixa, fechamento, simples, obrigacoes, reposicao, curvaAbc, escala, ferias, conversas, sugestoes, contarPublico, proporCampanha];
