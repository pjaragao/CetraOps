import Link from "next/link";
import { formatBRL } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { can, getSession } from "@/lib/session";
import { addDaysIsoSP, todayIsoSP } from "@/lib/context";
import { Card, Empty, PageHeader } from "@/components/ui";
import { TitleForm } from "./title-form";
import { TitlesTable, type TitleRow } from "./titles-table";

const SUPPLIER_ROLES = ["SUPPLIER", "SERVICE_PROVIDER", "PARTNER_GYM", "CARRIER", "INFLUENCER", "AFFILIATE_TRAINER", "EMPLOYEE", "SHAREHOLDER", "BANK", "ACQUIRER"] as const;

/** Tela compartilhada de contas a pagar / a receber: parcelas abertas, seleção múltipla para baixa e lançamento com rateio. */
export async function TitlesView({ direction, erro, ok, filtro }: { direction: "PAYABLE" | "RECEIVABLE"; erro?: string; ok?: string; filtro?: string }) {
  const session = await getSession();
  const supabase = await createClient();
  const base = direction === "PAYABLE" ? "/financeiro/pagar" : "/financeiro/receber";
  const today = todayIsoSP();
  const in7 = addDaysIsoSP(7);

  let q = supabase.schema("fin").from("v_open_installments")
    .select("installment_id, title_id, title_number, description, party_name, receiver_name, n, due_date, amount, balance, fee_expected, approval_status, days_overdue, status, store_id")
    .eq("direction", direction).order("due_date").limit(400);
  // títulos corporativos (sem loja) aparecem em qualquer contexto de loja
  if (session.storeId) q = q.or(`store_id.eq.${session.storeId},store_id.is.null`);
  if (filtro === "vencidas") q = q.lt("due_date", today);
  else if (filtro === "7d") q = q.lte("due_date", in7);
  else if (filtro === "rascunho") q = q.eq("approval_status", "DRAFT");

  const partyQuery = direction === "PAYABLE"
    ? supabase.schema("crm").from("parties").select("id, display_name, default_chart_account_id, party_roles!inner(role)").in("party_roles.role", [...SUPPLIER_ROLES]).is("archived_at", null).order("display_name").limit(400)
    : supabase.schema("crm").from("parties").select("id, display_name, default_chart_account_id").is("archived_at", null).order("display_name").limit(400);

  const [{ data: rows }, { data: accounts }, { data: ccs }, { data: templates }, { data: parties }] = await Promise.all([
    q,
    supabase.schema("fin").from("chart_accounts").select("id, code, name").eq("kind", "ANALYTIC")
      .or(direction === "PAYABLE" ? "group.in.(EXPENSE,COGS,FINANCIAL),code.like.1.1.3.%,code.like.1.2.%" : "group.in.(REVENUE,FINANCIAL)").is("archived_at", null).order("code"),
    supabase.schema("core").from("cost_centers").select("id, code, name").is("archived_at", null).order("code"),
    supabase.schema("fin").from("allocation_templates").select("id, name").eq("active", true).order("name"),
    partyQuery,
  ]);

  // categoria padrão de cada favorecido (aparece como dica no lançamento)
  const defaultIds = [...new Set((parties ?? []).map((p) => p.default_chart_account_id).filter(Boolean))] as string[];
  const { data: defaults } = defaultIds.length ? await supabase.schema("fin").from("chart_accounts").select("id, code, name").in("id", defaultIds) : { data: [] as { id: string; code: string; name: string }[] };
  const defaultLabel = new Map((defaults ?? []).map((a) => [a.id, `${a.code} · ${a.name}`]));
  const list = (rows ?? []) as unknown as (TitleRow & { store_id: string | null })[];
  const total = list.reduce((a, r) => a + Number(r.balance), 0);
  const overdue = list.filter((r) => r.days_overdue > 0).reduce((a, r) => a + Number(r.balance), 0);
  const tabs = [["", "Todas"], ["vencidas", "Vencidas"], ["7d", "Próximos 7 dias"], ...(direction === "PAYABLE" ? [["rascunho", "Aguardando aprovação"]] : [])];

  return (
    <>
      <PageHeader title={direction === "PAYABLE" ? "Contas a pagar" : "Contas a receber"}
        description={direction === "PAYABLE"
          ? "Rascunho → aprovado → pago. Selecione várias parcelas para pagar de uma vez (um Pix, vários títulos), com juros, multa e desconto."
          : "Recebíveis de cartão (com taxa esperada), Pix, boletos B2B e lançamentos manuais. Um repasse da adquirente baixa várias parcelas de uma vez."} />
      {erro && <p className="mb-3 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{erro}</p>}
      {ok && <p className="mb-3 rounded-lg bg-success/10 px-3 py-2 text-sm text-success">{ok}</p>}

      <div className="mb-4 grid grid-cols-2 gap-3 sm:w-fit">
        <Card><p className="text-xs text-muted">Em aberto</p><p className="text-xl font-semibold">{formatBRL(total)}</p></Card>
        <Card><p className="text-xs text-muted">Vencido</p><p className={`text-xl font-semibold ${overdue > 0 ? "text-danger" : ""}`}>{formatBRL(overdue)}</p></Card>
      </div>

      {can(session, "fin.write") && (
        <details className="mb-4 rounded-xl border border-border bg-surface p-4">
          <summary className="cursor-pointer text-sm font-medium">+ Novo lançamento</summary>
          <TitleForm direction={direction} today={today}
            stores={session.stores.map((s) => ({ id: s.id, name: s.name, legal_entity_id: s.legal_entity_id }))}
            parties={(parties ?? []).map((p) => ({ id: p.id, label: p.display_name, hint: p.default_chart_account_id ? defaultLabel.get(p.default_chart_account_id) : undefined }))}
            accounts={(accounts ?? []).map((a) => ({ id: a.id, label: `${a.code} · ${a.name}` }))}
            costCenters={(ccs ?? []).map((c) => ({ id: c.id, label: `${c.code} · ${c.name}` }))}
            templates={(templates ?? []).map((t) => ({ id: t.id, label: t.name }))} />
        </details>
      )}

      <nav className="mb-3 flex flex-wrap gap-1 text-sm" aria-label="Filtros">
        {tabs.map(([v, l]) => (
          <Link key={v} href={v ? `${base}?filtro=${v}` : base}
            className={`rounded-full px-3 py-1 ${(filtro ?? "") === v ? "bg-brand text-brand-contrast" : "border border-border hover:bg-surface-2"}`}>{l}</Link>
        ))}
      </nav>

      {list.length === 0 ? <Empty title="Nada em aberto" /> : (
        <TitlesTable direction={direction} rows={list} canWrite={can(session, "fin.write")} canApprove={can(session, "fin.approve")} back={base} />
      )}
    </>
  );
}
