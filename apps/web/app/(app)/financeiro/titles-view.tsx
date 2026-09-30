import { formatBRL } from "@sie/domain";
import { createClient } from "@/lib/supabase/server";
import { can, getSession } from "@/lib/session";
import { todayIsoSP } from "@/lib/context";
import { Badge, Button, Card, Empty, inputClass, PageHeader, Table } from "@/components/ui";
import { approveTitle, createTitle, settleInstallment } from "./actions";

/** Tela compartilhada de contas a pagar / a receber (parcelas abertas + lançamento). */
export async function TitlesView({ direction, erro }: { direction: "PAYABLE" | "RECEIVABLE"; erro?: string }) {
  const session = await getSession();
  const supabase = await createClient();
  const back = direction === "PAYABLE" ? "/financeiro/pagar" : "/financeiro/receber";

  let q = supabase.schema("fin").from("title_installments")
    .select("id, n, due_date, expected_date, amount, fee_expected, status, titles!inner(id, number, description, direction, approval_status, document_kind, store_id, total_amount)")
    .eq("titles.direction", direction).in("status", ["OPEN", "PARTIAL"]).order("due_date").limit(300);
  if (session.storeId) q = q.eq("titles.store_id", session.storeId);
  const [{ data: rows }, { data: accounts }] = await Promise.all([
    q,
    supabase.schema("fin").from("chart_accounts").select("id, code, name").eq("kind", "ANALYTIC")
      .in("group", direction === "PAYABLE" ? ["EXPENSE", "COGS", "FINANCIAL", "LIABILITY"] : ["REVENUE", "ASSET"]).order("code"),
  ]);

  const today = todayIsoSP();
  const total = (rows ?? []).reduce((a, r) => a + Number(r.amount), 0);
  const overdue = (rows ?? []).filter((r) => r.due_date < today).reduce((a, r) => a + Number(r.amount), 0);

  return (
    <>
      <PageHeader title={direction === "PAYABLE" ? "Contas a pagar" : "Contas a receber"}
        description={direction === "PAYABLE" ? "Rascunho → aprovado → pago. Cada lançamento vai para uma conta do plano." : "Recebíveis de cartão (gerados pelas vendas, com taxa esperada), Pix, boletos B2B e lançamentos manuais."} />
      {erro && <p className="mb-3 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{erro === "dados" ? "Confira os dados do lançamento." : erro}</p>}

      <div className="mb-4 grid grid-cols-2 gap-3 sm:w-fit">
        <Card><p className="text-xs text-muted">Em aberto</p><p className="text-xl font-semibold">{formatBRL(total)}</p></Card>
        <Card><p className="text-xs text-muted">Vencido</p><p className={`text-xl font-semibold ${overdue > 0 ? "text-danger" : ""}`}>{formatBRL(overdue)}</p></Card>
      </div>

      {can(session, "fin.write") && (
        <details className="mb-4 rounded-xl border border-border bg-surface p-4">
          <summary className="cursor-pointer text-sm font-medium">+ Novo lançamento</summary>
          <form action={createTitle} className="mt-3 grid gap-2 sm:grid-cols-3">
            <input type="hidden" name="direction" value={direction} />
            <input name="description" required placeholder="Descrição (ex.: Honorários contábeis out/26)" className={`${inputClass} sm:col-span-2`} aria-label="Descrição" />
            <input name="amount" required inputMode="decimal" placeholder="Valor total (R$)" className={inputClass} aria-label="Valor" />
            <select name="chart_account_id" className={inputClass} aria-label="Conta"><option value="">Conta do plano…</option>{(accounts ?? []).map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</select>
            <input name="first_due" type="date" required defaultValue={today} className={inputClass} aria-label="Primeiro vencimento" />
            <div className="flex gap-2">
              <input name="installments" type="number" min={1} max={24} defaultValue={1} className={inputClass} aria-label="Parcelas" title="Parcelas" />
              <input name="every" type="number" min={1} defaultValue={30} className={inputClass} aria-label="Intervalo em dias" title="Intervalo (dias)" />
            </div>
            <input name="document_kind" placeholder="Documento (NF, boleto…)" className={inputClass} aria-label="Tipo de documento" />
            <input name="document_number" placeholder="Número do documento" className={inputClass} aria-label="Número do documento" />
            <input name="barcode" placeholder="Linha digitável (opcional)" className={inputClass} aria-label="Linha digitável" />
            <Button className="sm:col-span-3 sm:w-fit">Lançar</Button>
          </form>
        </details>
      )}

      {(rows ?? []).length === 0 ? <Empty title="Nada em aberto" /> : (
        <Table head={["Vencimento", "Título", "Descrição", "Parcela", "Valor", direction === "RECEIVABLE" ? "Taxa esperada" : "Aprovação", ""]}>
          {(rows ?? []).map((r) => (
            <tr key={r.id}>
              <td className={`px-3 py-2 whitespace-nowrap ${r.due_date < today ? "font-medium text-danger" : ""}`}>{r.due_date.split("-").reverse().join("/")}</td>
              <td className="px-3 py-2 text-xs">{r.titles.number}</td>
              <td className="px-3 py-2">{r.titles.description}</td>
              <td className="px-3 py-2">{r.n}</td>
              <td className="px-3 py-2 font-medium whitespace-nowrap">{formatBRL(r.amount)}</td>
              <td className="px-3 py-2">
                {direction === "RECEIVABLE" ? formatBRL(r.fee_expected)
                  : <Badge tone={r.titles.approval_status === "APPROVED" ? "success" : "warning"}>{r.titles.approval_status === "APPROVED" ? "aprovado" : "rascunho"}</Badge>}
              </td>
              <td className="px-3 py-2">
                <div className="flex gap-1">
                  {direction === "PAYABLE" && r.titles.approval_status === "DRAFT" && can(session, "fin.approve") && (
                    <form action={approveTitle}><input type="hidden" name="title_id" value={r.titles.id} /><Button variant="secondary" className="px-2 py-1 text-xs">Aprovar</Button></form>
                  )}
                  {can(session, "fin.write") && (direction === "RECEIVABLE" || r.titles.approval_status === "APPROVED") && (
                    <form action={settleInstallment}><input type="hidden" name="installment_id" value={r.id} /><input type="hidden" name="back" value={back} />
                      <Button variant="secondary" className="px-2 py-1 text-xs">{direction === "PAYABLE" ? "Pago" : "Recebido"}</Button></form>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </Table>
      )}
      <p className="mt-3 text-xs text-muted">A baixa com conta bancária, conciliação automática com extratos (Inter, BTG, Mercado Pago) e rateio chegam nos próximos sprints.</p>
    </>
  );
}
