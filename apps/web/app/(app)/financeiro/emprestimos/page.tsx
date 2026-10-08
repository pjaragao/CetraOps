import Link from "next/link";
import { formatBRL } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, todayIsoSP, type SP } from "@/lib/context";
import { Badge, Card, Empty, PageHeader, Table } from "@/components/ui";
import { Flash, fmtDate } from "@/components/form";
import { CommitmentTabs } from "../recorrentes/tabs";
import { LoanForm } from "./loan-form";

export const metadata = { title: "Contratos e recorrências" };

export default async function EmprestimosPage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("fin.read");
  const sp = await searchParams;
  const supabase = await createClient();
  const [{ data: loans }, { data: titles }, { data: banks }, { data: parties }, { data: ccs }] = await Promise.all([
    supabase.schema("fin").from("loans").select("*").order("received_on", { ascending: false }),
    supabase.schema("fin").from("titles").select("origin_id, status, total_amount").eq("origin_type", "LOAN"),
    supabase.schema("fin").from("bank_accounts").select("id, name").eq("active", true).order("name"),
    supabase.schema("crm").from("parties").select("id, display_name, cnpj").is("merged_into_id", null).is("archived_at", null).order("display_name").limit(5000),
    supabase.schema("core").from("cost_centers").select("id, code, name").is("archived_at", null).order("code"),
  ]);
  const pname = new Map((parties ?? []).map((p) => [p.id, p.display_name]));
  const bname = new Map((banks ?? []).map((b) => [b.id, b.name]));

  return (
    <>
      <PageHeader title="Contratos e recorrências" description="Compromissos que se repetem: cadastre uma vez e o sistema gera as contas a pagar e a receber." />
      <CommitmentTabs current="emprestimos" />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      {(loans ?? []).length === 0 ? <Empty title="Nenhum empréstimo">Capital de giro, financiamento de equipamento, antecipação contratada…</Empty> : (
        <Table head={["Empréstimo", "Credor", "Entrou", "Valor", "Parcelas", "Taxa a.m.", "Pagas", "Saldo a pagar"]}>
          {(loans ?? []).map((l) => {
            const ts = (titles ?? []).filter((t) => t.origin_id === l.id && t.status !== "CANCELLED");
            const paid = ts.filter((t) => t.status === "SETTLED").length;
            const open = ts.filter((t) => t.status !== "SETTLED").reduce((a, t) => a + Number(t.total_amount), 0);
            return (
              <tr key={l.id}>
                <td className="px-3 py-2 font-medium"><Link href={`/financeiro/pagar?situacao=todas&q=${encodeURIComponent(l.description)}`} className="text-brand">{l.description}</Link>{paid === ts.length && ts.length > 0 && <span className="ml-1"><Badge tone="success">quitado</Badge></span>}</td>
                <td className="px-3 py-2">{l.party_id ? pname.get(l.party_id) : "—"}</td>
                <td className="px-3 py-2 whitespace-nowrap">{fmtDate(l.received_on)} <span className="text-xs text-muted">em {bname.get(l.bank_account_id) ?? "conta"}</span></td>
                <td className="px-3 py-2">{formatBRL(l.principal)}</td>
                <td className="px-3 py-2">{l.installments}x {formatBRL(l.installment_amount)}</td>
                <td className="px-3 py-2">{(Number(l.monthly_rate) * 100).toFixed(2).replace(".", ",")}%</td>
                <td className="px-3 py-2">{paid}/{ts.length}</td>
                <td className="px-3 py-2 font-medium">{formatBRL(open)}</td>
              </tr>
            );
          })}
        </Table>
      )}
      {can(session, "fin.approve") ? (
        <Card className="mt-4" title="Novo empréstimo ou financiamento">
          <LoanForm today={todayIsoSP()} banks={(banks ?? []).map((b) => ({ id: b.id, label: b.name }))}
            parties={(parties ?? []).map((p) => ({ id: p.id, label: p.display_name, hint: p.cnpj ? `CNPJ ${p.cnpj}` : undefined }))}
            costCenters={(ccs ?? []).map((c) => ({ id: c.id, label: `${c.code} · ${c.name}` }))} />
        </Card>
      ) : <p className="mt-4 text-sm text-muted">Lançar empréstimo exige a permissão de aprovação do financeiro.</p>}
    </>
  );
}
