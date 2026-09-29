import { formatBRL } from "@sie/domain";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { Badge, Button, Card, Empty, inputClass, PageHeader, Table } from "@/components/ui";
import { createContract } from "../actions";

export const metadata = { title: "Contratos" };

export default async function ContratosPage({ searchParams }: { searchParams: SP }) {
  const erro = str((await searchParams).erro);
  const session = await requirePerm("fin.read");
  const supabase = await createClient();
  const [{ data: contracts }, { data: obligations }] = await Promise.all([
    supabase.schema("fin").from("contracts").select("id, title, kind, start_date, months, in_kind_months, installment_amount, exit_penalty_pct, status").order("start_date"),
    supabase.schema("fin").from("contract_obligations").select("id, contract_id, kind, description, due_date, status").eq("status", "PENDING").order("due_date").limit(20),
  ]);
  const { data: paid } = await supabase.schema("fin").from("titles").select("origin_id, status, total_amount").eq("origin_type", "CONTRACT");

  return (
    <>
      <PageHeader title="Contratos" description="Patrocínio + licença de espaço (não é aluguel): parcelas, pagamentos em peças e contrapartidas." />
      {erro && <p className="mb-3 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{erro === "dados" ? "Confira os dados e selecione uma loja no topo." : erro}</p>}

      {(contracts ?? []).length === 0 ? (
        can(session, "fin.write") ? (
          <Card title="Cadastrar contrato de patrocínio (valores do contrato JOY pré-preenchidos — confira)">
            <form action={createContract} className="grid gap-2 sm:grid-cols-3">
              <input name="partner_name" required defaultValue="JOY Wellness Club Empreendimentos Esportivos Ltda." className={`${inputClass} sm:col-span-2`} aria-label="Parceiro" />
              <input name="partner_cnpj" required placeholder="CNPJ do parceiro" className={inputClass} aria-label="CNPJ do parceiro" />
              <input name="title" required defaultValue="Patrocínio e licença de espaço — JOY" className={`${inputClass} sm:col-span-2`} aria-label="Título" />
              <label className="text-xs text-muted">Início<input name="start_date" type="date" required defaultValue="2026-10-01" className={inputClass} /></label>
              <label className="text-xs text-muted">Meses<input name="months" type="number" required defaultValue={15} className={inputClass} /></label>
              <label className="text-xs text-muted">Meses pagos em peças<input name="in_kind_months" type="number" required defaultValue={3} className={inputClass} /></label>
              <label className="text-xs text-muted">Parcela (R$)<input name="installment_amount" required defaultValue="6000" className={inputClass} /></label>
              <label className="text-xs text-muted">Dia de vencimento<input name="due_day" type="number" required defaultValue={10} className={inputClass} /></label>
              <label className="text-xs text-muted">Multa atraso (%)<input name="late_fee_pct" required defaultValue="2" className={inputClass} /></label>
              <label className="text-xs text-muted">Juros ao mês (%)<input name="monthly_interest_pct" required defaultValue="1" className={inputClass} /></label>
              <label className="text-xs text-muted">Multa de saída (% das parcelas restantes)<input name="exit_penalty_pct" required defaultValue="20" className={inputClass} /></label>
              <Button className="sm:col-span-3 sm:w-fit">Cadastrar e gerar cronograma</Button>
            </form>
          </Card>
        ) : <Empty title="Nenhum contrato cadastrado" />
      ) : (
        <Table head={["Contrato", "Início", "Meses", "Em peças", "Parcela", "Pago / total", "Multa de saída hoje"]}>
          {(contracts ?? []).map((c) => {
            const ts = (paid ?? []).filter((t) => t.origin_id === c.id);
            const open = ts.filter((t) => t.status !== "SETTLED").reduce((a, t) => a + Number(t.total_amount), 0);
            return (
              <tr key={c.id}>
                <td className="px-3 py-2 font-medium">{c.title}</td>
                <td className="px-3 py-2">{c.start_date.split("-").reverse().join("/")}</td>
                <td className="px-3 py-2">{c.months}</td>
                <td className="px-3 py-2">{c.in_kind_months}</td>
                <td className="px-3 py-2">{formatBRL(c.installment_amount)}</td>
                <td className="px-3 py-2">{ts.filter((t) => t.status === "SETTLED").length} / {ts.length}</td>
                <td className="px-3 py-2">{formatBRL(open * Number(c.exit_penalty_pct ?? 0) / 100)}</td>
              </tr>
            );
          })}
        </Table>
      )}

      <h2 className="mt-8 mb-2 text-sm font-semibold text-muted">Próximas obrigações e contrapartidas</h2>
      {(obligations ?? []).length === 0 ? <Empty title="Nada pendente" /> : (
        <Table head={["Data", "Tipo", "Descrição"]}>
          {(obligations ?? []).map((o) => (
            <tr key={o.id}><td className="px-3 py-2">{o.due_date.split("-").reverse().join("/")}</td><td className="px-3 py-2"><Badge>{o.kind}</Badge></td><td className="px-3 py-2">{o.description}</td></tr>
          ))}
        </Table>
      )}
    </>
  );
}
