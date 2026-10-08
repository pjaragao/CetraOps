import Link from "next/link";
import { formatBRL } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { addDaysIsoSP, str, todayIsoSP, type SP } from "@/lib/context";
import { Badge, Button, Card, Empty, PageHeader, Table } from "@/components/ui";
import { Flash, fmtDate } from "@/components/form";
import { runRecurringAction, toggleRecurringAction } from "../plan-actions";
import { RecurringForm } from "./recurring-form";
import { CommitmentTabs } from "./tabs";

export const metadata = { title: "Contratos e recorrências" };

/** Aluguel, assinaturas, contratos de serviço: geram o título do mês (rascunho ou aprovado). */
export default async function RecorrentesPage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("fin.read");
  const sp = await searchParams;
  const supabase = await createClient();
  const canWrite = can(session, "fin.write");
  const [{ data: list }, { data: entities }, { data: parties }, { data: accounts }, { data: ccs }] = await Promise.all([
    supabase.schema("fin").from("recurring_templates").select("*").order("active", { ascending: false }).order("description"),
    supabase.schema("core").from("legal_entities").select("id, razao_social, nome_fantasia"),
    supabase.schema("crm").from("parties").select("id, display_name, cnpj").is("merged_into_id", null).is("archived_at", null).order("display_name").limit(5000),
    supabase.schema("fin").from("chart_accounts").select("id, code, name").eq("kind", "ANALYTIC").in("group", ["EXPENSE", "FINANCIAL", "REVENUE", "COGS"]).is("archived_at", null).order("code"),
    supabase.schema("core").from("cost_centers").select("id, code, name").is("archived_at", null).order("code"),
  ]);
  const pname = new Map((parties ?? []).map((p) => [p.id, p.display_name]));
  const aname = new Map((accounts ?? []).map((a) => [a.id, `${a.code} · ${a.name}`]));
  const today = todayIsoSP();
  const editing = (list ?? []).find((t) => t.id === str(sp.editar));
  const opts = {
    entities: (entities ?? []).map((e) => ({ id: e.id, label: e.nome_fantasia ?? e.razao_social })),
    parties: (parties ?? []).map((p) => ({ id: p.id, label: p.display_name, hint: p.cnpj ? `CNPJ ${p.cnpj}` : undefined })),
    accounts: (accounts ?? []).map((a) => ({ id: a.id, label: `${a.code} · ${a.name}` })),
    costCenters: (ccs ?? []).map((c) => ({ id: c.id, label: `${c.code} · ${c.name}` })),
  };

  return (
    <>
      <PageHeader title="Contratos e recorrências" description="Compromissos que se repetem: cadastre uma vez e o sistema gera as contas a pagar e a receber."
        actions={canWrite ? <form action={runRecurringAction} className="flex items-center gap-2"><input type="hidden" name="until" value={addDaysIsoSP(45)} /><Button variant="secondary">Gerar títulos até {fmtDate(addDaysIsoSP(45))}</Button></form> : undefined} />
      <CommitmentTabs current="recorrentes" />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      {(list ?? []).length === 0 ? <Empty title="Nenhuma recorrência">Cadastre o aluguel, a assinatura do software, a contabilidade…</Empty> : (
        <Table head={["Descrição", "Fornecedor", "Conta", "Valor", "Dia", "Próxima competência", "Situação", ""]}>
          {(list ?? []).map((t) => (
            <tr key={t.id} className={t.active ? "" : "opacity-60"}>
              <td className="px-3 py-2 font-medium">{t.description}{t.direction === "RECEIVABLE" && <span className="ml-1"><Badge tone="success">a receber</Badge></span>}</td>
              <td className="px-3 py-2">{t.party_id ? pname.get(t.party_id) ?? "—" : "—"}</td>
              <td className="px-3 py-2 text-xs">{t.chart_account_id ? aname.get(t.chart_account_id) : "Despesas a classificar"}</td>
              <td className="px-3 py-2 font-medium">{formatBRL(t.amount)}</td><td className="px-3 py-2">{t.day_of_month}</td>
              <td className="px-3 py-2 whitespace-nowrap">{fmtDate(t.next_run)}</td>
              <td className="px-3 py-2"><Badge tone={t.active ? "success" : "neutral"}>{t.active ? (t.auto_approve ? "ativa · aprova sozinha" : "ativa") : "pausada"}</Badge>{t.end_date && <span className="ml-1 text-xs text-muted">até {fmtDate(t.end_date)}</span>}</td>
              <td className="px-3 py-2">{canWrite && (
                <span className="flex items-center gap-2 text-xs">
                  <Link href={`/financeiro/recorrentes?editar=${t.id}#form`} className="text-brand">Editar</Link>
                  <form action={toggleRecurringAction}><input type="hidden" name="id" value={t.id} /><input type="hidden" name="active" value={t.active ? "0" : "1"} /><Button variant="ghost" className="px-2 py-1 text-xs">{t.active ? "Pausar" : "Retomar"}</Button></form>
                </span>
              )}</td>
            </tr>
          ))}
        </Table>
      )}
      {canWrite && (
        <Card className="mt-4" title={editing ? `Editar: ${editing.description}` : "Nova recorrência"}>
          <div id="form" />
          <RecurringForm key={editing?.id ?? "nova"} {...opts}
            initial={editing ? {
              id: editing.id, description: editing.description, direction: editing.direction, amount: Number(editing.amount).toFixed(2).replace(".", ","), day_of_month: editing.day_of_month,
              legal_entity_id: editing.legal_entity_id, party_id: editing.party_id ?? "", chart_account_id: editing.chart_account_id ?? "", cost_center_id: editing.cost_center_id ?? "",
              start_date: editing.start_date, end_date: editing.end_date ?? "", auto_approve: editing.auto_approve, active: editing.active,
            } : {
              description: "", direction: "PAYABLE", amount: "", day_of_month: 10, legal_entity_id: opts.entities[0]?.id ?? "", party_id: "", chart_account_id: "", cost_center_id: "",
              start_date: today, end_date: "", auto_approve: false,
            }} />
        </Card>
      )}
    </>
  );
}
