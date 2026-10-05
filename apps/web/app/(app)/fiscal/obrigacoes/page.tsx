import Link from "next/link";
import { formatBRL } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { requirePerm } from "@/lib/session";
import { addDaysIsoSP, str, todayIsoSP, type SP } from "@/lib/context";
import { Badge, Card, Empty, PageHeader, Stat, Table } from "@/components/ui";
import { fmtDate, fmtMonth } from "@/components/form";

export const metadata = { title: "Obrigações fiscais" };

const KIND: Record<string, string> = { DAS: "DAS — Simples Nacional", FGTS: "FGTS (guia)", INSS_DAE: "INSS — DAE eSocial", IRRF_DARF: "IRRF — DARF 0561", ISS: "ISS", ESOCIAL: "eSocial", REINF: "EFD-Reinf", DCTFWEB: "DCTFWeb", OTHER: "Outra" };

/** Calendário de obrigações: DAS, FGTS, INSS e IRRF da folha. Cada guia é uma conta a pagar; ao pagar, a obrigação sai do calendário. */
export default async function ObrigacoesPage({ searchParams }: { searchParams: SP }) {
  await requirePerm("fiscal.read");
  const sp = await searchParams;
  const supabase = await createClient();
  const today = todayIsoSP();
  const filtro = str(sp.situacao) ?? "PENDING";

  let q = supabase.schema("fiscal").from("obligations").select("id, kind, competence, due_date, amount, status, title_id, notes").order("due_date").limit(120);
  if (filtro !== "TODAS") q = q.eq("status", filtro);
  const { data: list } = await q;
  const titleIds = (list ?? []).map((o) => o.title_id).filter(Boolean) as string[];
  const { data: inst } = titleIds.length ? await supabase.schema("fin").from("v_open_installments").select("installment_id, title_id").in("title_id", titleIds) : { data: [] as { installment_id: string | null; title_id: string | null }[] };
  const instOf = new Map((inst ?? []).map((i) => [i.title_id, i.installment_id]));
  const pending = (list ?? []).filter((o) => o.status === "PENDING");
  const overdue = pending.filter((o) => o.due_date < today);
  const in30 = pending.filter((o) => o.due_date >= today && o.due_date <= addDaysIsoSP(30));
  const sum = (a: { amount: number }[]) => a.reduce((s, o) => s + Number(o.amount), 0);

  return (
    <>
      <PageHeader title="Obrigações fiscais" description="Vencimentos de tributos e encargos gerados pela folha e pela apuração. Para pagar, use o botão: leva ao financeiro com a guia já selecionada." />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Stat label="Vencidas" value={formatBRL(sum(overdue))} tone={overdue.length ? "danger" : undefined} hint={`${overdue.length} guia(s)`} />
        <Stat label="Próximos 30 dias" value={formatBRL(sum(in30))} hint={`${in30.length} guia(s)`} />
        <Stat label="Pendentes" value={pending.length} />
      </div>
      <nav className="mb-3 flex gap-1 text-sm" aria-label="Situação">
        {[["PENDING", "Pendentes"], ["PAID", "Pagas"], ["TODAS", "Todas"]].map(([v, l]) => <Link key={v} href={`/fiscal/obrigacoes?situacao=${v}`} className={`rounded-full px-3 py-1 ${filtro === v ? "bg-brand text-brand-contrast" : "border border-border hover:bg-surface-2"}`}>{l}</Link>)}
      </nav>
      {(list ?? []).length === 0 ? <Empty title="Nenhuma obrigação">Aprove uma folha ou gere a guia do DAS para alimentar o calendário.</Empty> : (
        <Table head={["Vencimento", "Obrigação", "Competência", "Valor", "Situação", ""]}>
          {(list ?? []).map((o) => (
            <tr key={o.id}>
              <td className={`px-3 py-2 whitespace-nowrap ${o.status === "PENDING" && o.due_date < today ? "font-medium text-danger" : ""}`}>{fmtDate(o.due_date)}</td>
              <td className="px-3 py-2">{KIND[o.kind] ?? o.kind}{o.notes && <span className="block text-xs text-muted">{o.notes}</span>}</td>
              <td className="px-3 py-2">{fmtMonth(o.competence)}</td><td className="px-3 py-2 font-medium">{formatBRL(o.amount)}</td>
              <td className="px-3 py-2"><Badge tone={o.status === "PAID" ? "success" : o.status === "PENDING" ? "warning" : "neutral"}>{o.status === "PAID" ? "paga" : o.status === "PENDING" ? "pendente" : o.status.toLowerCase()}</Badge></td>
              <td className="px-3 py-2">{o.status === "PENDING" && instOf.get(o.title_id) && <Link className="rounded-lg border border-border px-2 py-1 text-xs hover:bg-surface-2" href={`/financeiro/baixar?dir=PAYABLE&ids=${instOf.get(o.title_id)}`}>Pagar</Link>}</td>
            </tr>
          ))}
        </Table>
      )}
      <Card className="mt-4"><p className="text-xs text-muted">Prazos usados: DAS, FGTS Digital, DAE (INSS) e DARF 0561 vencem no dia 20 do mês seguinte, antecipados para o dia útil anterior se cair em fim de semana ou feriado. A guia rescisória vence em 10 dias do desligamento.</p></Card>
    </>
  );
}
