import Link from "next/link";
import { formatBRL } from "@sie/domain";
import { createClient } from "@/lib/supabase/server";
import { requirePerm } from "@/lib/session";
import { Card, PageHeader, Stat } from "@/components/ui";

export const metadata = { title: "Financeiro" };

export default async function FinanceiroPage() {
  const session = await requirePerm("fin.read");
  const supabase = await createClient();
  const today = new Date();
  const in7 = new Date(today.getTime() + 7 * 86400000).toISOString().slice(0, 10);
  const in30 = new Date(today.getTime() + 30 * 86400000).toISOString().slice(0, 10);

  let q = supabase.schema("fin").from("title_installments")
    .select("amount, fee_expected, due_date, expected_date, titles!inner(direction, store_id, approval_status)")
    .in("status", ["OPEN", "PARTIAL"]).lte("due_date", in30);
  if (session.storeId) q = q.eq("titles.store_id", session.storeId);
  const { data: rows } = await q;

  const sum = (dir: string, until: string) => (rows ?? []).filter((r) => r.titles.direction === dir && r.due_date <= until).reduce((a, r) => a + Number(r.amount) - (dir === "RECEIVABLE" ? Number(r.fee_expected) : 0), 0);
  const drafts = (rows ?? []).filter((r) => r.titles.direction === "PAYABLE" && r.titles.approval_status === "DRAFT").length;

  return (
    <>
      <PageHeader title="Financeiro" description="Próximos 7 e 30 dias. Recebíveis de cartão já descontam a taxa esperada da adquirente." />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="A receber em 7 dias (líquido)" value={formatBRL(sum("RECEIVABLE", in7))} />
        <Stat label="A pagar em 7 dias" value={formatBRL(sum("PAYABLE", in7))} />
        <Stat label="Saldo projetado 30 dias" value={formatBRL(sum("RECEIVABLE", in30) - sum("PAYABLE", in30))} hint="sem saldo bancário (extratos no sprint A3)" />
        <Stat label="Contas aguardando aprovação" value={drafts} tone={drafts > 0 ? "warning" : undefined} />
      </div>
      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <Card title="Atalhos"><ul className="space-y-1 text-sm">
          <li><Link className="text-brand" href="/financeiro/pagar">Contas a pagar</Link></li>
          <li><Link className="text-brand" href="/financeiro/receber">Contas a receber</Link></li>
          <li><Link className="text-brand" href="/financeiro/contratos">Contratos (JOY)</Link></li>
          <li><Link className="text-brand" href="/fiscal">Apuração do Simples</Link></li>
        </ul></Card>
      </div>
    </>
  );
}
