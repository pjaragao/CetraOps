import { formatBRL } from "@sie/domain";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { addDaysIsoSP, str, todayIsoSP, type SP } from "@/lib/context";
import { Badge, Button, Card, Empty, PageHeader, Table } from "@/components/ui";
import { Flash, fmtDate } from "@/components/form";
import { runRecurringAction, toggleRecurringAction } from "../plan-actions";
import { RecurringForm } from "./recurring-form";

export const metadata = { title: "Contas recorrentes" };

/** Aluguel, assinaturas, contratos de serviço: geram o título do mês (rascunho ou aprovado). */
export default async function RecorrentesPage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("fin.read");
  const sp = await searchParams;
  const supabase = await createClient();
  const canWrite = can(session, "fin.write");
  const [{ data: list }, { data: entities }, { data: roles }, { data: accounts }, { data: ccs }] = await Promise.all([
    supabase.schema("fin").from("recurring_templates").select("*").order("active", { ascending: false }).order("description"),
    supabase.schema("core").from("legal_entities").select("id, razao_social, nome_fantasia"),
    supabase.schema("crm").from("party_roles").select("party_id").in("role", ["SUPPLIER", "SERVICE_PROVIDER", "PARTNER_GYM"]),
    supabase.schema("fin").from("chart_accounts").select("id, code, name").eq("kind", "ANALYTIC").in("group", ["EXPENSE", "FINANCIAL", "REVENUE"]).order("code"),
    supabase.schema("core").from("cost_centers").select("id, code, name").is("archived_at", null).order("code"),
  ]);
  const pids = [...new Set([...(roles ?? []).map((r) => r.party_id), ...(list ?? []).map((t) => t.party_id).filter(Boolean) as string[]])];
  const { data: parties } = pids.length ? await supabase.schema("crm").from("parties").select("id, display_name").in("id", pids).order("display_name") : { data: [] as { id: string; display_name: string }[] };
  const pname = new Map((parties ?? []).map((p) => [p.id, p.display_name]));
  const aname = new Map((accounts ?? []).map((a) => [a.id, `${a.code} · ${a.name}`]));
  const today = todayIsoSP();

  return (
    <>
      <PageHeader title="Contas recorrentes" description="Cadastre uma vez; o sistema gera o título de cada mês. Os gerados sem aprovação automática ficam em rascunho em Contas a pagar."
        actions={canWrite ? <form action={runRecurringAction} className="flex items-center gap-2"><input type="hidden" name="until" value={addDaysIsoSP(45)} /><Button variant="secondary">Gerar títulos até {fmtDate(addDaysIsoSP(45))}</Button></form> : undefined} />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      {(list ?? []).length === 0 ? <Empty title="Nenhuma recorrência">Cadastre o aluguel, a assinatura do software, a contabilidade…</Empty> : (
        <Table head={["Descrição", "Fornecedor", "Conta", "Valor", "Dia", "Próxima competência", "Situação", ""]}>
          {(list ?? []).map((t) => (
            <tr key={t.id} className={t.active ? "" : "opacity-60"}>
              <td className="px-3 py-2 font-medium">{t.description}{t.direction === "RECEIVABLE" && <Badge tone="success">a receber</Badge>}</td>
              <td className="px-3 py-2">{t.party_id ? pname.get(t.party_id) ?? "—" : "—"}</td>
              <td className="px-3 py-2 text-xs">{t.chart_account_id ? aname.get(t.chart_account_id) : "Despesas a classificar"}</td>
              <td className="px-3 py-2 font-medium">{formatBRL(t.amount)}</td><td className="px-3 py-2">{t.day_of_month}</td>
              <td className="px-3 py-2 whitespace-nowrap">{fmtDate(t.next_run)}</td>
              <td className="px-3 py-2"><Badge tone={t.active ? "success" : "neutral"}>{t.active ? (t.auto_approve ? "ativa · aprova sozinha" : "ativa") : "pausada"}</Badge>{t.end_date && <span className="ml-1 text-xs text-muted">até {fmtDate(t.end_date)}</span>}</td>
              <td className="px-3 py-2">{canWrite && <form action={toggleRecurringAction}><input type="hidden" name="id" value={t.id} /><input type="hidden" name="active" value={t.active ? "0" : "1"} /><Button variant="ghost" className="px-2 py-1 text-xs">{t.active ? "Pausar" : "Retomar"}</Button></form>}</td>
            </tr>
          ))}
        </Table>
      )}
      {canWrite && (
        <Card className="mt-4" title="Nova recorrência">
          <RecurringForm today={today} entities={(entities ?? []).map((e) => ({ id: e.id, label: e.nome_fantasia ?? e.razao_social }))}
            parties={(parties ?? []).map((p) => ({ id: p.id, label: p.display_name }))} accounts={(accounts ?? []).map((a) => ({ id: a.id, label: `${a.code} · ${a.name}` }))}
            costCenters={(ccs ?? []).map((c) => ({ id: c.id, label: `${c.code} · ${c.name}` }))} />
        </Card>
      )}
    </>
  );
}
