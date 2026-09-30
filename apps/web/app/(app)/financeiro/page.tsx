import Link from "next/link";
import { formatBRL } from "@sie/domain";
import { createClient } from "@/lib/supabase/server";
import { requirePerm } from "@/lib/session";
import { addDaysIsoSP, todayIsoSP } from "@/lib/context";
import { Card, PageHeader, Stat } from "@/components/ui";

export const metadata = { title: "Financeiro" };

export default async function FinanceiroPage() {
  const session = await requirePerm("fin.read");
  const supabase = await createClient();
  const today = todayIsoSP();
  const in7 = addDaysIsoSP(7);
  const in30 = addDaysIsoSP(30);

  let q = supabase.schema("fin").from("v_open_installments")
    .select("balance, fee_expected, due_date, direction, approval_status, store_id").lte("due_date", in30);
  if (session.storeId) q = q.or(`store_id.eq.${session.storeId},store_id.is.null`);
  const [{ data: rows }, { data: banks }] = await Promise.all([
    q,
    supabase.schema("fin").from("v_bank_balances").select("bank_account_id, name, kind, balance, unreconciled_count").order("name"),
  ]);

  const sum = (dir: string, until: string) => (rows ?? []).filter((r) => r.direction === dir && (r.due_date ?? "") <= until).reduce((a, r) => a + Number(r.balance) - (dir === "RECEIVABLE" ? Number(r.fee_expected) : 0), 0);
  const drafts = (rows ?? []).filter((r) => r.direction === "PAYABLE" && r.approval_status === "DRAFT").length;
  const overdue = (rows ?? []).filter((r) => r.direction === "PAYABLE" && (r.due_date ?? "") < today).reduce((a, r) => a + Number(r.balance), 0);
  const cash = (banks ?? []).reduce((a, b) => a + Number(b.balance), 0);
  const pending = (banks ?? []).reduce((a, b) => a + Number(b.unreconciled_count), 0);

  return (
    <>
      <PageHeader title="Financeiro" description="Saldos, próximos 7 e 30 dias e pendências. Recebíveis de cartão já descontam a taxa esperada da adquirente." />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Caixa e bancos" value={formatBRL(cash)} hint={`${(banks ?? []).length} conta(s)`} />
        <Stat label="A receber em 7 dias (líquido)" value={formatBRL(sum("RECEIVABLE", in7))} />
        <Stat label="A pagar em 7 dias" value={formatBRL(sum("PAYABLE", in7))} tone={overdue > 0 ? "danger" : undefined} hint={overdue > 0 ? `${formatBRL(overdue)} vencido` : undefined} />
        <Stat label="Saldo projetado em 30 dias" value={formatBRL(cash + sum("RECEIVABLE", in30) - sum("PAYABLE", in30))} hint="caixa + a receber − a pagar" />
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card title="Contas">
          <ul className="divide-y divide-border text-sm">
            {(banks ?? []).map((b) => (
              <li key={b.bank_account_id} className="flex justify-between gap-2 py-1.5">
                <Link className="text-brand" href={`/financeiro/movimentacoes?conta=${b.bank_account_id}`}>{b.name}</Link>
                <span>{formatBRL(b.balance)}</span>
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Pendências">
          <ul className="space-y-1 text-sm">
            <li><Link className="text-brand" href="/financeiro/pagar?filtro=rascunho">{drafts} conta(s) aguardando aprovação</Link></li>
            <li><Link className="text-brand" href="/financeiro/conciliacao">{pending} movimento(s) sem conciliar</Link></li>
            <li><Link className="text-brand" href="/financeiro/pagar?filtro=vencidas">Contas a pagar vencidas</Link></li>
          </ul>
        </Card>
        <Card title="Atalhos"><ul className="space-y-1 text-sm">
          <li><Link className="text-brand" href="/financeiro/pagar">Contas a pagar</Link></li>
          <li><Link className="text-brand" href="/financeiro/receber">Contas a receber</Link></li>
          <li><Link className="text-brand" href="/financeiro/dre">DRE</Link> · <Link className="text-brand" href="/financeiro/razao">Razão contábil</Link></li>
          <li><Link className="text-brand" href="/financeiro/contratos">Contratos (JOY)</Link></li>
          <li><Link className="text-brand" href="/fiscal">Apuração do Simples</Link></li>
        </ul></Card>
      </div>
    </>
  );
}
