import Link from "next/link";
import { formatBRL } from "@sie/domain";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { periodBounds, str, todayIsoSP, type SP } from "@/lib/context";
import { Badge, Button, Card, Empty, inputClass, PageHeader, Table } from "@/components/ui";
import { setPeriodAction } from "../actions";
import { ManualEntryForm } from "./manual-entry-form";

export const metadata = { title: "Razão contábil" };

const TABS: [string, string][] = [["balancete", "Balancete"], ["razao", "Razão da conta"], ["lancamentos", "Lançamentos"], ["periodos", "Fechamento"], ["manual", "Lançamento manual"]];
const GROUP_LABEL: Record<string, string> = { ASSET: "Ativo", LIABILITY: "Passivo", EQUITY: "Patrimônio", REVENUE: "Receita", DEDUCTION: "Dedução", COGS: "CMV", EXPENSE: "Despesa", FINANCIAL: "Financeiro" };

export default async function RazaoPage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("fin.read");
  const sp = await searchParams;
  const supabase = await createClient();
  const aba = str(sp.aba) ?? "balancete";
  const { from, to } = periodBounds(str(sp.periodo));
  const emp = str(sp.emp) || undefined;
  const today = todayIsoSP();

  const [{ data: entities }, { data: accounts }, { data: ccs }] = await Promise.all([
    supabase.schema("core").from("legal_entities").select("id, razao_social, nome_fantasia, cnpj").order("razao_social"),
    supabase.schema("fin").from("chart_accounts").select("id, code, name").eq("kind", "ANALYTIC").is("archived_at", null).order("code"),
    supabase.schema("core").from("cost_centers").select("id, code, name").is("archived_at", null).order("code"),
  ]);
  const entOpts = (entities ?? []).map((e) => ({ id: e.id, label: e.nome_fantasia ?? e.razao_social }));
  const q = (extra: Record<string, string | undefined>) =>
    "?" + Object.entries({ aba, periodo: str(sp.periodo), emp, ...extra }).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v!)}`).join("&");

  let body: React.ReactNode = null;

  if (aba === "balancete") {
    const { data: rows, error } = await supabase.schema("fin").rpc("trial_balance", { p_from: from, p_to: to, p_entity: emp as string, p_ledger: "LEGAL" });
    const list = rows ?? [];
    const d = list.reduce((a, r) => a + Number(r.debit), 0);
    const c = list.reduce((a, r) => a + Number(r.credit), 0);
    body = error ? <p className="text-danger">{error.message}</p> : list.length === 0 ? <Empty title="Sem lançamentos no período" /> : (
      <>
        <Table head={["Conta", "Nome", "Grupo", "Saldo inicial", "Débitos", "Créditos", "Saldo final"]}>
          {list.map((r) => (
            <tr key={r.account_id}>
              <td className="px-3 py-1.5 whitespace-nowrap"><Link className="text-brand" href={q({ aba: "razao", conta: r.account_id })}>{r.code}</Link></td>
              <td className="px-3 py-1.5">{r.name}</td><td className="px-3 py-1.5 text-xs text-muted">{GROUP_LABEL[r.grp] ?? r.grp}</td>
              <td className="px-3 py-1.5 text-right">{formatBRL(r.opening)}</td><td className="px-3 py-1.5 text-right">{formatBRL(r.debit)}</td>
              <td className="px-3 py-1.5 text-right">{formatBRL(r.credit)}</td><td className="px-3 py-1.5 text-right font-medium">{formatBRL(r.closing)} <span className="text-xs text-muted">{r.nature === "DEBIT" ? "D" : "C"}</span></td>
            </tr>
          ))}
        </Table>
        <p className={`mt-2 text-sm ${Math.abs(d - c) < 0.005 ? "text-success" : "text-danger"}`}>Débitos {formatBRL(d)} · Créditos {formatBRL(c)} {Math.abs(d - c) < 0.005 ? "— balancete fecha" : "— NÃO FECHA"}</p>
      </>
    );
  } else if (aba === "razao") {
    const conta = str(sp.conta);
    const { data: rows } = conta ? await supabase.schema("fin").rpc("account_ledger", { p_account: conta, p_from: from, p_to: to, p_entity: emp as string }) : { data: [] as never[] };
    body = (
      <>
        <form className="mb-3 flex flex-wrap items-end gap-2" method="get">
          <input type="hidden" name="aba" value="razao" />{str(sp.periodo) && <input type="hidden" name="periodo" value={str(sp.periodo)} />}
          <label className="text-xs text-muted">Conta
            <select name="conta" defaultValue={conta ?? ""} className={inputClass}><option value="">Escolha…</option>{(accounts ?? []).map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</select>
          </label>
          <Button variant="secondary">Ver razão</Button>
        </form>
        {!conta ? <Empty title="Escolha uma conta" /> : (rows ?? []).length === 0 ? <Empty title="Sem movimento no período" /> : (
          <Table head={["Data", "Lançamento", "Histórico", "Centro de custo", "Débito", "Crédito", "Saldo"]}>
            {(rows ?? []).map((r, i) => (
              <tr key={i}>
                <td className="px-3 py-1.5 whitespace-nowrap">{r.entry_date.split("-").reverse().join("/")}</td>
                <td className="px-3 py-1.5 text-xs">{r.entry_number}</td><td className="px-3 py-1.5">{r.description}</td>
                <td className="px-3 py-1.5 text-xs">{r.cost_center_code}</td>
                <td className="px-3 py-1.5 text-right">{Number(r.debit) ? formatBRL(r.debit) : ""}</td><td className="px-3 py-1.5 text-right">{Number(r.credit) ? formatBRL(r.credit) : ""}</td>
                <td className="px-3 py-1.5 text-right font-medium">{formatBRL(r.running)}</td>
              </tr>
            ))}
          </Table>
        )}
      </>
    );
  } else if (aba === "lancamentos") {
    let eq = supabase.schema("fin").from("journal_entries").select("id, number, entry_date, kind, description, ledger, reversal_of_id, legal_entity_id")
      .gte("entry_date", from).lte("entry_date", to).order("entry_date", { ascending: false }).order("created_at", { ascending: false }).limit(80);
    if (emp) eq = eq.eq("legal_entity_id", emp);
    const { data: entries } = await eq;
    const ids = (entries ?? []).map((e) => e.id);
    const { data: lines } = ids.length
      ? await supabase.schema("fin").from("journal_lines").select("entry_id, line_no, account_id, cost_center_id, debit, credit, memo").in("entry_id", ids).order("line_no")
      : { data: [] as { entry_id: string; line_no: number; account_id: string; cost_center_id: string | null; debit: number; credit: number; memo: string | null }[] };
    const acc = new Map((accounts ?? []).map((a) => [a.id, `${a.code} · ${a.name}`]));
    const cc = new Map((ccs ?? []).map((c) => [c.id, c.code]));
    body = (entries ?? []).length === 0 ? <Empty title="Sem lançamentos no período" /> : (
      <ul className="space-y-2">
        {(entries ?? []).map((e) => (
          <li key={e.id} className="rounded-xl border border-border bg-surface p-3">
            <p className="text-sm"><b>{e.number}</b> · {e.entry_date.split("-").reverse().join("/")} · {e.description} <Badge>{e.kind}</Badge> {e.ledger === "MGMT" && <Badge tone="info">gerencial</Badge>} {e.reversal_of_id && <Badge tone="warning">estorno</Badge>}</p>
            <table className="mt-2 w-full text-xs">
              <tbody className="divide-y divide-border">
                {(lines ?? []).filter((l) => l.entry_id === e.id).map((l) => (
                  <tr key={l.line_no}>
                    <td className={`py-1 ${Number(l.credit) ? "pl-6" : ""}`}>{acc.get(l.account_id)}{l.cost_center_id && <span className="ml-2 text-muted">[{cc.get(l.cost_center_id)}]</span>}</td>
                    <td className="w-28 py-1 text-right">{Number(l.debit) ? formatBRL(l.debit) : ""}</td><td className="w-28 py-1 text-right">{Number(l.credit) ? formatBRL(l.credit) : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </li>
        ))}
      </ul>
    );
  } else if (aba === "periodos") {
    const target = emp ?? entities?.[0]?.id;
    const { data: periods } = await supabase.schema("fin").from("periods").select("competence, status, closed_at").eq("legal_entity_id", target ?? "");
    const closed = new Map((periods ?? []).map((p) => [p.competence, p.status]));
    const months = Array.from({ length: 12 }, (_, i) => { const d = new Date(`${today.slice(0, 7)}-01T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() - i); return d.toISOString().slice(0, 10); });
    body = (
      <>
        <p className="mb-3 text-sm text-muted">Período fechado bloqueia novos lançamentos e baixas naquele mês. Reabrir exige aprovação e fica registrado.</p>
        <Table head={["Mês", "Situação", ""]}>
          {months.map((m) => (
            <tr key={m}>
              <td className="px-3 py-2">{m.slice(5, 7)}/{m.slice(0, 4)}</td>
              <td className="px-3 py-2">{closed.get(m) === "CLOSED" ? <Badge tone="danger">fechado</Badge> : <Badge tone="success">aberto</Badge>}</td>
              <td className="px-3 py-2">
                {can(session, "fin.approve") && target && (
                  <form action={setPeriodAction}>
                    <input type="hidden" name="entity" value={target} /><input type="hidden" name="competence" value={m} />
                    <input type="hidden" name="status" value={closed.get(m) === "CLOSED" ? "OPEN" : "CLOSED"} />
                    <Button variant="secondary" className="px-2 py-1 text-xs">{closed.get(m) === "CLOSED" ? "Reabrir" : "Fechar mês"}</Button>
                  </form>
                )}
              </td>
            </tr>
          ))}
        </Table>
      </>
    );
  } else {
    body = can(session, "fin.approve")
      ? <Card><ManualEntryForm entities={entOpts} today={today} accounts={(accounts ?? []).map((a) => ({ id: a.id, label: `${a.code} · ${a.name}` }))} costCenters={(ccs ?? []).map((c) => ({ id: c.id, label: `${c.code} · ${c.name}` }))} /></Card>
      : <Empty title="Sem permissão para lançamentos manuais" />;
  }

  return (
    <>
      <PageHeader title="Razão contábil" description={`Partidas dobradas geradas por vendas, baixas, folha e contratos. Período: ${from.split("-").reverse().join("/")} a ${to.split("-").reverse().join("/")} (seletor no topo).`} />
      {str(sp.erro) && <p className="mb-3 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{str(sp.erro)}</p>}
      <nav className="mb-4 flex flex-wrap items-center gap-1 text-sm" aria-label="Seções">
        {TABS.map(([v, l]) => <Link key={v} href={q({ aba: v })} className={`rounded-full px-3 py-1 ${aba === v ? "bg-brand text-brand-contrast" : "border border-border hover:bg-surface-2"}`}>{l}</Link>)}
        {(entities ?? []).length > 1 && (
          <form method="get" className="ml-auto flex items-center gap-1">
            <input type="hidden" name="aba" value={aba} />{str(sp.periodo) && <input type="hidden" name="periodo" value={str(sp.periodo)} />}
            <select name="emp" defaultValue={emp ?? ""} className="rounded-lg border border-border bg-surface px-2 py-1 text-sm" aria-label="Empresa"><option value="">Todas as empresas</option>{entOpts.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}</select>
            <Button variant="secondary" className="px-2 py-1 text-xs">Filtrar</Button>
          </form>
        )}
      </nav>
      {body}
    </>
  );
}
