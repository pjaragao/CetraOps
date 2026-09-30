import Link from "next/link";
import { formatBRL } from "@sie/domain";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, todayIsoSP, type SP } from "@/lib/context";
import { Badge, Button, Card, Empty, inputClass, PageHeader, Stat } from "@/components/ui";
import { autoMatchAction, classifyLineAction, ignoreLineAction, linkLineAction, transferFromLineAction, unlinkLineAction } from "../actions";
import { ImportForm } from "./import-form";

export const metadata = { title: "Conciliação bancária" };

const KINDS_IN: [string, string][] = [["INTEREST_INCOME", "Rendimento de aplicação"], ["OWNER_CONTRIBUTION", "Aporte de sócio"], ["LOAN", "Empréstimo"], ["ADJUSTMENT", "Ajuste"], ["OTHER", "Outro"]];
const KINDS_OUT: [string, string][] = [["BANK_FEE", "Tarifa bancária"], ["PROFIT_DISTRIBUTION", "Distribuição de lucros"], ["ADJUSTMENT", "Ajuste"], ["OTHER", "Outro"]];

export default async function ConciliacaoPage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("fin.read");
  const sp = await searchParams;
  const supabase = await createClient();
  const write = can(session, "fin.write");
  const today = todayIsoSP();

  const { data: balances } = await supabase.schema("fin").from("v_bank_balances").select("bank_account_id, name, kind, balance, unreconciled_count").in("kind", ["CHECKING", "ACQUIRER_BALANCE", "INVESTMENT"]).order("name");
  const banks = balances ?? [];
  const conta = str(sp.conta) ?? banks[0]?.bank_account_id;
  const aba = str(sp.aba) ?? "pendentes";
  const current = banks.find((b) => b.bank_account_id === conta);

  if (!conta || !current) {
    return (<><PageHeader title="Conciliação bancária" /><Empty title="Nenhuma conta bancária cadastrada">Cadastre as contas em Configurações › Contas bancárias.</Empty></>);
  }

  const statusFilter = aba === "conciliadas" ? ["MATCHED"] : aba === "ignoradas" ? ["IGNORED"] : ["PENDING", "PARTIAL"];
  const [{ data: lines }, { data: counts }, { data: lastImport }, { data: pendingTx }, { data: accounts }, { data: ccs }] = await Promise.all([
    supabase.schema("fin").from("statement_lines").select("id, posted_on, amount, description, counterpart_name, counterpart_doc, status, matched_amount, ignore_reason")
      .eq("bank_account_id", conta).in("status", statusFilter).order("posted_on", { ascending: aba === "pendentes" }).limit(300),
    supabase.schema("fin").from("statement_lines").select("status").eq("bank_account_id", conta),
    supabase.schema("fin").from("statement_imports").select("filename, period_end, closing_balance, created_at").eq("bank_account_id", conta).order("created_at", { ascending: false }).limit(1),
    supabase.schema("fin").from("cash_transactions").select("id, occurred_on, amount, kind, description, reference").eq("bank_account_id", conta).eq("voided", false).eq("reconciled", false).order("occurred_on").limit(300),
    supabase.schema("fin").from("chart_accounts").select("id, code, name").eq("kind", "ANALYTIC").is("archived_at", null).order("code"),
    supabase.schema("core").from("cost_centers").select("id, code, name").is("archived_at", null).order("code"),
  ]);

  const count = (s: string[]) => (counts ?? []).filter((c) => s.includes(c.status)).length;
  const system = Number(current.balance);
  const stmtClosing = lastImport?.[0]?.closing_balance != null ? Number(lastImport[0].closing_balance) : null;
  const otherBanks = banks.filter((b) => b.bank_account_id !== conta);
  const { data: otherPending } = otherBanks.length && aba === "pendentes"
    ? await supabase.schema("fin").from("statement_lines").select("id, bank_account_id, posted_on, amount, description").in("bank_account_id", otherBanks.map((b) => b.bank_account_id!)).eq("status", "PENDING").limit(300)
    : { data: [] as { id: string; bank_account_id: string; posted_on: string; amount: number; description: string | null }[] };

  return (
    <>
      <PageHeader title="Conciliação bancária"
        description="Importe o extrato e confronte com o que o sistema lançou. Cada linha vira baixa de um ou vários títulos, transferência, tarifa ou rendimento — o banco nunca é alterado, só classificado." />
      {str(sp.erro) && <p className="mb-3 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{str(sp.erro)}</p>}
      {str(sp.ok) && <p className="mb-3 rounded-lg bg-success/10 px-3 py-2 text-sm text-success">{str(sp.ok)}</p>}

      <nav className="mb-4 flex flex-wrap gap-1 text-sm" aria-label="Contas">
        {banks.map((b) => (
          <Link key={b.bank_account_id} href={`/financeiro/conciliacao?conta=${b.bank_account_id}`}
            className={`rounded-full px-3 py-1 ${conta === b.bank_account_id ? "bg-brand text-brand-contrast" : "border border-border hover:bg-surface-2"}`}>
            {b.name}{Number(b.unreconciled_count) > 0 && <span className="ml-1 opacity-80">· {b.unreconciled_count}</span>}
          </Link>
        ))}
      </nav>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Saldo no sistema" value={formatBRL(system)} />
        <Stat label="Saldo do último extrato" value={stmtClosing === null ? "—" : formatBRL(stmtClosing)}
          hint={stmtClosing === null ? "o arquivo não trouxe saldo" : `até ${lastImport![0].period_end?.split("-").reverse().join("/") ?? "?"}`} />
        <Stat label="Linhas pendentes" value={count(["PENDING", "PARTIAL"])} tone={count(["PENDING", "PARTIAL"]) > 0 ? "warning" : "success"} />
        <Stat label="Movimentos sem extrato" value={(pendingTx ?? []).length} hint="lançados no sistema, ainda não vistos no banco" />
      </div>

      {write && (
        <Card className="mb-4" title="Importar e conciliar">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <ImportForm bank={conta} />
            <form action={autoMatchAction}><input type="hidden" name="bank" value={conta} /><Button variant="secondary">Conciliar automaticamente</Button></form>
          </div>
          <p className="mt-2 text-xs text-muted">Automático: liga linhas a movimentos já lançados (mesmo valor, data até 3 dias) e aplica as regras de tarifa/rendimento. Casos ambíguos ficam para você.</p>
        </Card>
      )}

      <nav className="mb-3 flex gap-1 text-sm" aria-label="Situação">
        {[["pendentes", `Pendentes (${count(["PENDING", "PARTIAL"])})`], ["conciliadas", `Conciliadas (${count(["MATCHED"])})`], ["ignoradas", `Ignoradas (${count(["IGNORED"])})`]].map(([v, l]) => (
          <Link key={v} href={`/financeiro/conciliacao?conta=${conta}&aba=${v}`} className={`rounded-full px-3 py-1 ${aba === v ? "bg-brand text-brand-contrast" : "border border-border hover:bg-surface-2"}`}>{l}</Link>
        ))}
      </nav>

      {(lines ?? []).length === 0 ? <Empty title={aba === "pendentes" ? "Nada pendente neste extrato" : "Nenhuma linha"} /> : (
        <ul className="space-y-2">
          {(lines ?? []).map((l) => {
            const amount = Number(l.amount);
            const inflow = amount > 0;
            const candidates = (pendingTx ?? []).filter((t) => (Number(t.amount) > 0) === inflow);
            const counterparts = (otherPending ?? []).filter((o) => Math.abs(Number(o.amount)) === Math.abs(amount) && (Number(o.amount) > 0) !== inflow);
            return (
              <li key={l.id} className="rounded-xl border border-border bg-surface p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm"><span className="font-medium">{l.posted_on.split("-").reverse().join("/")}</span> · {l.description}</p>
                    {(l.counterpart_name || l.counterpart_doc) && <p className="text-xs text-muted">{l.counterpart_name} {l.counterpart_doc && `· ${l.counterpart_doc}`}</p>}
                    {l.status === "IGNORED" && <p className="text-xs text-muted">Ignorada: {l.ignore_reason}</p>}
                  </div>
                  <div className="text-right">
                    <p className={`text-lg font-semibold ${inflow ? "text-success" : "text-danger"}`}>{formatBRL(amount)}</p>
                    {l.status === "PARTIAL" && <Badge tone="warning">parcial · {formatBRL(l.matched_amount)}</Badge>}
                    {l.status === "MATCHED" && <Badge tone="success">conciliada</Badge>}
                  </div>
                </div>

                {write && aba === "pendentes" && (
                  <div className="mt-2 flex flex-wrap items-start gap-2">
                    <Link href={`/financeiro/baixar?line=${l.id}`} className="inline-flex items-center rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-brand-contrast hover:opacity-90">
                      Dar baixa em títulos
                    </Link>
                    {candidates.length > 0 && (
                      <details className="rounded-lg border border-border px-2 py-1 text-sm"><summary className="cursor-pointer">Vincular a lançamento existente ({candidates.length})</summary>
                        <form action={linkLineAction} className="mt-2 flex gap-2">
                          <input type="hidden" name="bank" value={conta} /><input type="hidden" name="line" value={l.id} />
                          <select name="tx" className={inputClass} required>{candidates.map((t) => <option key={t.id} value={t.id}>{t.occurred_on.split("-").reverse().join("/")} · {formatBRL(t.amount)} · {t.description}</option>)}</select>
                          <Button variant="secondary">Vincular</Button>
                        </form>
                      </details>
                    )}
                    <details className="rounded-lg border border-border px-2 py-1 text-sm"><summary className="cursor-pointer">Classificar</summary>
                      <form action={classifyLineAction} className="mt-2 grid gap-2 sm:grid-cols-2">
                        <input type="hidden" name="bank" value={conta} /><input type="hidden" name="line" value={l.id} />
                        <select name="kind" className={inputClass} required>{(inflow ? KINDS_IN : KINDS_OUT).map(([v, n]) => <option key={v} value={v}>{n}</option>)}</select>
                        <select name="account" className={inputClass}><option value="">Conta padrão do tipo</option>{(accounts ?? []).map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</select>
                        <select name="cc" className={inputClass}><option value="">Centro de custo…</option>{(ccs ?? []).map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}</select>
                        <input name="description" className={inputClass} placeholder="Descrição (opcional)" maxLength={200} />
                        <div className="sm:col-span-2"><Button variant="secondary">Classificar e conciliar</Button></div>
                      </form>
                    </details>
                    {otherBanks.length > 0 && (
                      <details className="rounded-lg border border-border px-2 py-1 text-sm"><summary className="cursor-pointer">É transferência entre contas</summary>
                        <form action={transferFromLineAction} className="mt-2 grid gap-2 sm:grid-cols-2">
                          <input type="hidden" name="bank" value={conta} /><input type="hidden" name="line" value={l.id} />
                          <input type="hidden" name="amount" value={String(amount).replace(".", ",")} /><input type="hidden" name="date" value={l.posted_on} />
                          <select name="other_bank" className={inputClass} required>{otherBanks.map((b) => <option key={b.bank_account_id} value={b.bank_account_id ?? ""}>{inflow ? "Veio de" : "Foi para"} {b.name}</option>)}</select>
                          <select name="counter_line" className={inputClass}>
                            <option value="">Ponta do outro extrato ainda não importada</option>
                            {counterparts.map((o) => <option key={o.id} value={o.id}>{o.posted_on.split("-").reverse().join("/")} · {formatBRL(o.amount)} · {o.description}</option>)}
                          </select>
                          <div className="sm:col-span-2"><Button variant="secondary">Registrar transferência</Button></div>
                        </form>
                      </details>
                    )}
                    <details className="rounded-lg border border-border px-2 py-1 text-sm"><summary className="cursor-pointer">Ignorar</summary>
                      <form action={ignoreLineAction} className="mt-2 flex gap-2">
                        <input type="hidden" name="bank" value={conta} /><input type="hidden" name="line" value={l.id} />
                        <input name="reason" className={inputClass} placeholder="Motivo (ex.: lançamento duplicado do banco)" required />
                        <Button variant="secondary">Ignorar</Button>
                      </form>
                    </details>
                  </div>
                )}
                {write && aba === "conciliadas" && (
                  <form action={unlinkLineAction} className="mt-2"><input type="hidden" name="bank" value={conta} /><input type="hidden" name="line" value={l.id} />
                    <Button variant="ghost" className="px-2 py-1 text-xs">Desfazer conciliação</Button></form>
                )}
                {write && aba === "ignoradas" && (
                  <form action={ignoreLineAction} className="mt-2"><input type="hidden" name="bank" value={conta} /><input type="hidden" name="line" value={l.id} /><input type="hidden" name="restore" value="1" />
                    <Button variant="ghost" className="px-2 py-1 text-xs">Restaurar como pendente</Button></form>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {aba === "pendentes" && (pendingTx ?? []).length > 0 && (
        <Card className="mt-6" title={`Lançados no sistema e ainda sem linha no extrato (${(pendingTx ?? []).length})`}>
          <ul className="divide-y divide-border text-sm">
            {(pendingTx ?? []).map((t) => (
              <li key={t.id} className="flex justify-between gap-3 py-1.5">
                <span>{t.occurred_on.split("-").reverse().join("/")} · {t.description}</span>
                <span className={Number(t.amount) > 0 ? "text-success" : "text-danger"}>{formatBRL(t.amount)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted">Se o dinheiro não aparecer no banco em alguns dias, estorne a baixa em Movimentações.</p>
        </Card>
      )}
      <p className="mt-4 text-xs text-muted">Hoje: {today.split("-").reverse().join("/")}.</p>
    </>
  );
}
