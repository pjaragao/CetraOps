import Link from "next/link";
import { formatBRL } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { can, getSession } from "@/lib/session";
import { addDaysIsoSP, str, todayIsoSP, type SP } from "@/lib/context";
import { Card, Empty, inputClass, PageHeader, Pager } from "@/components/ui";
import { TitleForm } from "./title-form";
import { TitlesTable, type TitleRow } from "./titles-table";

const PAGE = 50;
const SITUACOES = [["", "Em aberto"], ["pagas", "Pagas"], ["canceladas", "Canceladas"], ["todas", "Todas"]] as const;

/** Tela compartilhada de contas a pagar / a receber: busca, situação, período, paginação, seleção múltipla para baixa e lançamento com rateio. */
export async function TitlesView({ direction, sp }: { direction: "PAYABLE" | "RECEIVABLE"; sp: Awaited<SP> }) {
  const session = await getSession();
  const supabase = await createClient();
  const base = direction === "PAYABLE" ? "/financeiro/pagar" : "/financeiro/receber";
  const today = todayIsoSP();
  const in7 = addDaysIsoSP(7);
  const situacao = SITUACOES.some(([k]) => k === str(sp.situacao)) ? str(sp.situacao)! : "";
  const filtro = situacao === "" ? str(sp.filtro) ?? "" : "";
  const q = (str(sp.q) ?? "").replace(/[%,()]/g, " ").trim();
  const de = /^\d{4}-\d{2}-\d{2}$/.test(str(sp.de) ?? "") ? str(sp.de)! : "";
  const ate = /^\d{4}-\d{2}-\d{2}$/.test(str(sp.ate) ?? "") ? str(sp.ate)! : "";
  const page = Math.max(1, Number(str(sp.p)) || 1);
  const paid = direction === "PAYABLE" ? "Pagas" : "Recebidas";

  let query = supabase.schema("fin").from("v_installments")
    .select("installment_id, title_id, title_number, description, party_name, receiver_name, n, due_date, amount, balance, fee_expected, approval_status, days_overdue, status, store_id, settled_on, origin_type", { count: "exact" })
    .eq("direction", direction);
  // títulos corporativos (sem loja) aparecem em qualquer contexto de loja
  if (session.storeId) query = query.or(`store_id.eq.${session.storeId},store_id.is.null`);
  if (situacao === "") query = query.in("status", ["OPEN", "PARTIAL"]).neq("title_status", "CANCELLED");
  else if (situacao === "pagas") query = query.eq("status", "SETTLED");
  else if (situacao === "canceladas") query = query.eq("status", "CANCELLED");
  if (filtro === "vencidas") query = query.lt("due_date", today);
  else if (filtro === "7d") query = query.lte("due_date", in7);
  else if (filtro === "rascunho") query = query.eq("approval_status", "DRAFT");
  if (q) for (const w of q.toLowerCase().split(/\s+/).slice(0, 5)) query = query.ilike("search", `%${w}%`);
  if (de) query = query.gte("due_date", de);
  if (ate) query = query.lte("due_date", ate);
  query = situacao === "pagas" ? query.order("settled_on", { ascending: false, nullsFirst: false }).order("due_date", { ascending: false })
    : query.order("due_date", { ascending: situacao !== "canceladas" && situacao !== "todas" });
  query = query.order("title_number").range((page - 1) * PAGE, page * PAGE - 1);

  // totais do que está em aberto (independem da página)
  let totals = supabase.schema("fin").from("v_open_installments").select("balance, due_date").eq("direction", direction).limit(10000);
  if (session.storeId) totals = totals.or(`store_id.eq.${session.storeId},store_id.is.null`);

  const partyQuery = supabase.schema("crm").from("parties").select("id, display_name, default_chart_account_id, cnpj").is("archived_at", null).is("merged_into_id", null).order("display_name").limit(5000);
  const [{ data: rows, count, error }, { data: open }, { data: accounts }, { data: ccs }, { data: templates }, { data: parties }] = await Promise.all([
    query, totals,
    supabase.schema("fin").from("chart_accounts").select("id, code, name").eq("kind", "ANALYTIC")
      .or(direction === "PAYABLE" ? "group.in.(EXPENSE,COGS,FINANCIAL),code.like.1.1.3.%,code.like.1.2.%,code.like.2.%" : "group.in.(REVENUE,FINANCIAL)").is("archived_at", null).order("code"),
    supabase.schema("core").from("cost_centers").select("id, code, name").is("archived_at", null).order("code"),
    supabase.schema("fin").from("allocation_templates").select("id, name").eq("active", true).order("name"),
    partyQuery,
  ]);

  // categoria padrão de cada favorecido (aparece como dica no lançamento)
  const defaultIds = [...new Set((parties ?? []).map((p) => p.default_chart_account_id).filter(Boolean))] as string[];
  const { data: defaults } = defaultIds.length ? await supabase.schema("fin").from("chart_accounts").select("id, code, name").in("id", defaultIds) : { data: [] as { id: string; code: string; name: string }[] };
  const defaultLabel = new Map((defaults ?? []).map((a) => [a.id, `${a.code} · ${a.name}`]));
  const list = (rows ?? []) as unknown as TitleRow[];
  const total = (open ?? []).reduce((a, r) => a + Number(r.balance), 0);
  const overdue = (open ?? []).filter((r) => (r.due_date ?? "") < today).reduce((a, r) => a + Number(r.balance), 0);
  const next7 = (open ?? []).filter((r) => (r.due_date ?? "") >= today && (r.due_date ?? "") <= in7).reduce((a, r) => a + Number(r.balance), 0);
  const tabs = [["", "Todas"], ["vencidas", "Vencidas"], ["7d", "Próximos 7 dias"], ...(direction === "PAYABLE" ? [["rascunho", "Aguardando aprovação"]] : [])];
  const params = { situacao: situacao || undefined, filtro: filtro || undefined, q: q || undefined, de: de || undefined, ate: ate || undefined };
  const link = (extra: Record<string, string | undefined>) => {
    const u = new URLSearchParams(Object.entries({ ...params, ...extra }).filter((e): e is [string, string] => Boolean(e[1])));
    const s = u.toString();
    return s ? `${base}?${s}` : base;
  };

  return (
    <>
      <PageHeader title={direction === "PAYABLE" ? "Contas a pagar" : "Contas a receber"}
        description={direction === "PAYABLE"
          ? "Rascunho → aprovado → pago. Selecione várias parcelas para pagar de uma vez (um Pix, vários títulos), com juros, multa e desconto. Clique no título para ver o detalhe, editar ou anexar."
          : "Recebíveis de cartão (com taxa esperada), Pix, boletos B2B e lançamentos manuais. Um repasse da adquirente baixa várias parcelas de uma vez."} />
      {str(sp.erro) && <p className="mb-3 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{str(sp.erro)}</p>}
      {str(sp.ok) && <p className="mb-3 rounded-lg bg-success/10 px-3 py-2 text-sm text-success">{str(sp.ok)}</p>}

      <div className="mb-4 grid grid-cols-3 gap-3 sm:w-fit">
        <Card><p className="text-xs text-muted">Em aberto</p><p className="text-xl font-semibold">{formatBRL(total)}</p></Card>
        <Card><p className="text-xs text-muted">Vencido</p><p className={`text-xl font-semibold ${overdue > 0 ? "text-danger" : ""}`}>{formatBRL(overdue)}</p></Card>
        <Card><p className="text-xs text-muted">Próximos 7 dias</p><p className="text-xl font-semibold">{formatBRL(next7)}</p></Card>
      </div>

      {can(session, "fin.write") && (
        <details className="mb-4 rounded-xl border border-border bg-surface p-4">
          <summary className="cursor-pointer text-sm font-medium">+ Novo lançamento</summary>
          <TitleForm direction={direction} today={today}
            stores={session.stores.map((s) => ({ id: s.id, name: s.name, legal_entity_id: s.legal_entity_id }))}
            parties={(parties ?? []).map((p) => ({ id: p.id, label: p.display_name, hint: p.default_chart_account_id ? defaultLabel.get(p.default_chart_account_id) : p.cnpj ? `CNPJ ${p.cnpj}` : undefined }))}
            accounts={(accounts ?? []).map((a) => ({ id: a.id, label: `${a.code} · ${a.name}` }))}
            costCenters={(ccs ?? []).map((c) => ({ id: c.id, label: `${c.code} · ${c.name}` }))}
            templates={(templates ?? []).map((t) => ({ id: t.id, label: t.name }))} />
          <p className="mt-2 text-xs text-muted">Fornecedor que ainda não está no cadastro? <Link href="/cadastros/novo" className="text-brand">Cadastre aqui</Link> (com o CNPJ, os dados vêm da Receita).</p>
        </details>
      )}

      <nav className="mb-2 flex flex-wrap gap-1 text-sm" aria-label="Situação">
        {SITUACOES.map(([v, l]) => (
          <Link key={v} href={link({ situacao: v || undefined, filtro: undefined })}
            className={`rounded-full px-3 py-1 ${situacao === v ? "bg-brand text-brand-contrast" : "border border-border hover:bg-surface-2"}`}>{v === "pagas" ? paid : l}</Link>
        ))}
        {situacao === "" && <span className="mx-1 self-center text-border">|</span>}
        {situacao === "" && tabs.map(([v, l]) => (
          <Link key={v} href={link({ filtro: v || undefined })}
            className={`rounded-full px-3 py-1 ${filtro === v ? "bg-surface-2 font-medium" : "hover:bg-surface-2"}`}>{l}</Link>
        ))}
      </nav>
      <form className="mb-3 flex flex-wrap items-end gap-2" action={base}>
        {situacao && <input type="hidden" name="situacao" value={situacao} />}
        {filtro && <input type="hidden" name="filtro" value={filtro} />}
        <label className="text-xs text-muted">Buscar<input name="q" defaultValue={q} placeholder="Descrição, nº, fornecedor…" className={`${inputClass} w-64`} /></label>
        <label className="text-xs text-muted">Vencimento de<input name="de" type="date" defaultValue={de} className={`${inputClass} w-40`} /></label>
        <label className="text-xs text-muted">até<input name="ate" type="date" defaultValue={ate} className={`${inputClass} w-40`} /></label>
        <button className="rounded-lg border border-border px-3 py-2 text-sm">Filtrar</button>
        {(q || de || ate) && <Link href={link({ q: undefined, de: undefined, ate: undefined })} className="py-2 text-sm text-muted">Limpar</Link>}
        <a href={`/financeiro/titulos/exportar?dir=${direction}&${new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => Boolean(e[1]))).toString()}`} className="ml-auto py-2 text-sm text-brand">Exportar CSV</a>
      </form>

      {error && <p className="mb-3 text-sm text-danger">Não foi possível carregar: {error.message}</p>}
      {list.length === 0 ? <Empty title={situacao === "" ? "Nada em aberto" : "Nada encontrado"} /> : (
        <TitlesTable direction={direction} rows={list} canWrite={can(session, "fin.write")} canApprove={can(session, "fin.approve")} back={base} />
      )}
      <Pager path={base} params={params} page={page} pageSize={PAGE} total={count ?? 0} />
    </>
  );
}
