import Link from "next/link";
import { formatBRL } from "@sie/domain";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, todayIsoSP, type SP } from "@/lib/context";
import { Badge, Button, Card, Empty, PageHeader, Stat, Table } from "@/components/ui";
import { reverseSettlementAction } from "../actions";
import { MovementForm, TransferForm } from "./movement-forms";

export const metadata = { title: "Movimentações financeiras" };

const KIND_LABEL: Record<string, string> = {
  SETTLEMENT: "Baixa", TRANSFER: "Transferência", BANK_FEE: "Tarifa", INTEREST_INCOME: "Rendimento", OWNER_CONTRIBUTION: "Aporte",
  PROFIT_DISTRIBUTION: "Distribuição de lucros", LOAN: "Empréstimo", ADJUSTMENT: "Ajuste", ACQUIRER_PAYOUT: "Repasse", CASH_SALE: "Venda em dinheiro", CASH_DEPOSIT: "Depósito", OTHER: "Outro",
};

export default async function MovimentacoesPage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("fin.read");
  const sp = await searchParams;
  const supabase = await createClient();
  const conta = str(sp.conta);
  const today = todayIsoSP();

  let q = supabase.schema("fin").from("cash_transactions")
    .select("id, occurred_on, amount, kind, description, reference, reconciled, voided, settlement_id, bank_account_id, created_at")
    .order("occurred_on", { ascending: false }).order("created_at", { ascending: false }).limit(200);
  if (conta) q = q.eq("bank_account_id", conta);

  const [{ data: txs }, { data: balances }, { data: accounts }, { data: ccs }, { data: settlements }] = await Promise.all([
    q,
    supabase.schema("fin").from("v_bank_balances").select("bank_account_id, name, kind, balance, unreconciled_count").order("name"),
    supabase.schema("fin").from("chart_accounts").select("id, code, name").eq("kind", "ANALYTIC").is("archived_at", null).order("code"),
    supabase.schema("core").from("cost_centers").select("id, code, name").is("archived_at", null).order("code"),
    supabase.schema("fin").from("settlements").select("id, number, status, direction, party_id").order("created_at", { ascending: false }).limit(200),
  ]);
  const balList = (balances ?? []).flatMap((b) => (b.bank_account_id ? [{ ...b, bank_account_id: b.bank_account_id }] : []));
  const bank = new Map((balances ?? []).map((b) => [b.bank_account_id ?? "", b.name]));
  const sett = new Map((settlements ?? []).map((s) => [s.id, s]));
  const total = (balances ?? []).reduce((a, b) => a + Number(b.balance), 0);
  const banks = (balances ?? []).map((b) => ({ id: b.bank_account_id ?? "", label: b.name ?? "" }));

  return (
    <>
      <PageHeader title="Movimentações financeiras"
        description="Todo dinheiro que entra e sai das contas: baixas, transferências, tarifas, aportes e distribuições. A conciliação compara estas linhas com o extrato."
        actions={<Link className="rounded-lg border border-border bg-surface px-3 py-2 text-sm hover:bg-surface-2" href="/financeiro/conciliacao">Conciliação</Link>} />
      {str(sp.erro) && <p className="mb-3 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{str(sp.erro)}</p>}
      {str(sp.ok) && <p className="mb-3 rounded-lg bg-success/10 px-3 py-2 text-sm text-success">{str(sp.ok)}</p>}

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Saldo consolidado" value={formatBRL(total)} hint="todas as contas ativas" />
        {balList.slice(0, 3).map((b) => (
          <Link key={b.bank_account_id} href={`/financeiro/movimentacoes?conta=${b.bank_account_id}`}>
            <Stat label={b.name ?? ""} value={formatBRL(b.balance)} hint={Number(b.unreconciled_count) > 0 ? `${b.unreconciled_count} sem conciliar` : "conciliado"} tone={Number(b.unreconciled_count) > 0 ? "warning" : undefined} />
          </Link>
        ))}
      </div>

      {can(session, "fin.write") && (
        <div className="mb-4 grid gap-3 lg:grid-cols-2">
          <details className="rounded-xl border border-border bg-surface p-4"><summary className="cursor-pointer text-sm font-medium">+ Transferência entre contas</summary><TransferForm banks={banks} today={today} /></details>
          <details className="rounded-xl border border-border bg-surface p-4"><summary className="cursor-pointer text-sm font-medium">+ Tarifa, aporte, distribuição, empréstimo, ajuste</summary>
            <MovementForm banks={banks} today={today}
              accounts={(accounts ?? []).map((a) => ({ id: a.id, label: `${a.code} · ${a.name}` }))} costCenters={(ccs ?? []).map((c) => ({ id: c.id, label: `${c.code} · ${c.name}` }))} />
          </details>
        </div>
      )}

      <nav className="mb-3 flex flex-wrap gap-1 text-sm" aria-label="Contas">
        <Link href="/financeiro/movimentacoes" className={`rounded-full px-3 py-1 ${!conta ? "bg-brand text-brand-contrast" : "border border-border hover:bg-surface-2"}`}>Todas</Link>
        {balList.map((b) => (
          <Link key={b.bank_account_id} href={`/financeiro/movimentacoes?conta=${b.bank_account_id}`}
            className={`rounded-full px-3 py-1 ${conta === b.bank_account_id ? "bg-brand text-brand-contrast" : "border border-border hover:bg-surface-2"}`}>{b.name}</Link>
        ))}
      </nav>

      {(txs ?? []).length === 0 ? <Empty title="Sem movimentos" /> : (
        <Table head={["Data", "Conta", "Tipo", "Descrição", "Valor", "Conciliação", ""]}>
          {(txs ?? []).map((t) => {
            const s = t.settlement_id ? sett.get(t.settlement_id) : undefined;
            return (
              <tr key={t.id} className={t.voided ? "text-muted line-through" : ""}>
                <td className="px-3 py-2 whitespace-nowrap">{t.occurred_on.split("-").reverse().join("/")}</td>
                <td className="px-3 py-2">{bank.get(t.bank_account_id)}</td>
                <td className="px-3 py-2"><Badge>{KIND_LABEL[t.kind] ?? t.kind}</Badge></td>
                <td className="px-3 py-2">{t.description}{s && <span className="block text-xs text-muted no-underline">{s.number}{s.status === "REVERSED" ? " (estornada)" : ""}</span>}</td>
                <td className={`px-3 py-2 font-medium whitespace-nowrap ${Number(t.amount) > 0 ? "text-success" : "text-danger"}`}>{formatBRL(t.amount)}</td>
                <td className="px-3 py-2">{t.voided ? <Badge tone="neutral">anulado</Badge> : t.reconciled ? <Badge tone="success">conciliado</Badge> : <Badge tone="warning">pendente</Badge>}</td>
                <td className="px-3 py-2">
                  {s && s.status === "POSTED" && can(session, "fin.approve") && (
                    <form action={reverseSettlementAction}>
                      <input type="hidden" name="settlement_id" value={s.id} /><input type="hidden" name="conta" value={conta ?? ""} />
                      <Button variant="ghost" className="px-2 py-1 text-xs text-danger">Estornar</Button>
                    </form>
                  )}
                </td>
              </tr>
            );
          })}
        </Table>
      )}
      <Card className="mt-4"><p className="text-xs text-muted">Estornar uma baixa reabre as parcelas, devolve créditos, anula o movimento e estorna o lançamento contábil — a linha de extrato volta para pendente.</p></Card>
    </>
  );
}
