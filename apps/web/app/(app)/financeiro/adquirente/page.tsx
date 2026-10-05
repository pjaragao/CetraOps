import { formatBRL } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, todayIsoSP, type SP } from "@/lib/context";
import { Badge, Button, Card, Empty, LinkButton, PageHeader, Stat, Table, inputClass } from "@/components/ui";
import { Flash, fmtDate } from "@/components/form";
import { ImportForm } from "./import-form";
import { settlePayoutAction } from "./actions";

export const metadata = { title: "Adquirente" };

interface AuditRow { acquirer: string; method: string; installments: number; transactions: number; gross: number; charged: number; expected: number; variance: number }
const METHOD: Record<string, string> = { PIX: "Pix", DEBIT: "Débito", CREDIT: "Crédito" };

export default async function AdquirentePage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("fin.read");
  const sp = await searchParams;
  const canWrite = can(session, "fin.write");
  const supabase = await createClient();
  const today = todayIsoSP();
  const from = str(sp.de) ?? `${today.slice(0, 8)}01`;
  const to = str(sp.ate) ?? today;
  const [{ data: payouts }, { data: unmatched }, { data: audit }, { data: imports }, { data: banks }, { data: matchedCount }, { data: totalCount }] = await Promise.all([
    supabase.schema("fin").from("acquirer_payouts").select("id, acquirer, external_id, paid_on, amount, status, bank_account_id").order("paid_on", { ascending: false }).limit(50),
    supabase.schema("fin").from("acquirer_transactions").select("id, acquirer, external_id, nsu, captured_at, method, installments, gross, brand").eq("match_status", "UNMATCHED").order("captured_at", { ascending: false }).limit(50),
    supabase.schema("fin").rpc("acquirer_audit", { p_from: from, p_to: to }),
    supabase.schema("fin").from("acquirer_imports").select("id, acquirer, filename, transactions_total, transactions_new, created_at").order("created_at", { ascending: false }).limit(8),
    supabase.schema("fin").from("bank_accounts").select("id, name").eq("active", true).order("name"),
    supabase.schema("fin").from("acquirer_transactions").select("id", { count: "exact", head: true }).eq("match_status", "MATCHED").then((r) => ({ data: r.count ?? 0 })),
    supabase.schema("fin").from("acquirer_transactions").select("id", { count: "exact", head: true }).then((r) => ({ data: r.count ?? 0 })),
  ]);
  const rows = (audit as unknown as AuditRow[] | null) ?? [];
  const variance = rows.reduce((a, r) => a + Number(r.variance ?? 0), 0);
  const pending = (payouts ?? []).filter((p) => p.status === "PENDING");
  const bankName = new Map((banks ?? []).map((b) => [b.id, b.name]));

  return (
    <>
      <PageHeader title="Adquirente" description="Conciliação em 3 vias: venda do sistema ↔ transação da maquininha ↔ repasse ↔ extrato. A taxa cobrada é conferida com a contratada e o repasse baixa as parcelas com a taxa real."
        actions={<LinkButton href="/financeiro/adquirente/modelo">Baixar planilha-modelo</LinkButton>} />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      <div className="mb-4 grid gap-3 sm:grid-cols-4">
        <Stat label="Transações importadas" value={Number(totalCount)} />
        <Stat label="Casadas com vendas" value={Number(totalCount) > 0 ? `${Math.round((100 * Number(matchedCount)) / Number(totalCount))}%` : "—"} tone={Number(totalCount) > 0 && Number(matchedCount) < Number(totalCount) ? "warning" : undefined} />
        <Stat label="Repasses a baixar" value={pending.length} tone={pending.length > 0 ? "warning" : undefined} />
        <Stat label="Taxa cobrada a mais no período" value={formatBRL(variance)} tone={variance > 1 ? "danger" : "success"} />
      </div>

      {canWrite && (
        <Card title="Importar recebíveis" className="mb-4">
          <ImportForm banks={(banks ?? []).map((b) => ({ id: b.id, name: b.name }))} />
          <p className="mt-2 text-[11px] text-muted">Layout padrão (uma linha por parcela a receber). Exporte o relatório da adquirente, ajuste as colunas conforme o modelo e envie. Cada arquivo só entra uma vez, e transações repetidas não duplicam.</p>
        </Card>
      )}

      <h2 className="mb-2 text-sm font-semibold text-muted">Repasses</h2>
      {(payouts ?? []).length === 0 ? <Empty title="Nenhum repasse importado">Importe o arquivo com a coluna “repasse” preenchida.</Empty> : (
        <Table head={["Repasse", "Data", "Valor", "Situação", canWrite ? "Baixar" : ""]}>
          {(payouts ?? []).map((p) => (
            <tr key={p.id}>
              <td className="px-3 py-2 font-medium">{p.acquirer} · {p.external_id}</td>
              <td className="px-3 py-2 whitespace-nowrap">{fmtDate(p.paid_on)}</td>
              <td className="px-3 py-2">{formatBRL(Number(p.amount))}</td>
              <td className="px-3 py-2">{p.status === "SETTLED" ? <Badge tone="success">baixado{p.bank_account_id ? ` · ${bankName.get(p.bank_account_id) ?? ""}` : ""}</Badge> : <Badge tone="warning">a baixar</Badge>}</td>
              <td className="px-3 py-2">
                {canWrite && p.status === "PENDING" && (
                  <form action={settlePayoutAction} className="flex items-center gap-1">
                    <input type="hidden" name="id" value={p.id} />
                    {!p.bank_account_id && (
                      <select name="bank_account_id" required className={`${inputClass} w-44 py-1 text-xs`} aria-label="Conta que recebeu" defaultValue="">
                        <option value="" disabled>Conta que recebeu…</option>
                        {(banks ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                      </select>
                    )}
                    <Button variant="secondary" className="px-2 py-1 text-xs">Baixar repasse</Button>
                  </form>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}

      <div className="mt-6 mb-2 flex flex-wrap items-end justify-between gap-2">
        <h2 className="text-sm font-semibold text-muted">Auditoria de taxa (cobrado × contratado)</h2>
        <form className="flex items-end gap-2 text-xs" action="/financeiro/adquirente">
          <label className="text-muted">De<input type="date" name="de" defaultValue={from} className={`${inputClass} mt-1 py-1`} /></label>
          <label className="text-muted">Até<input type="date" name="ate" defaultValue={to} className={`${inputClass} mt-1 py-1`} /></label>
          <Button variant="secondary" className="px-2 py-1 text-xs">Filtrar</Button>
        </form>
      </div>
      {rows.length === 0 ? <Empty title="Sem transações casadas neste período" /> : (
        <Table head={["Adquirente", "Forma", "Parcelas", "Transações", "Bruto", "Cobrado", "Contratado", "Diferença"]}>
          {rows.map((r, i) => (
            <tr key={i}>
              <td className="px-3 py-2">{r.acquirer}</td><td className="px-3 py-2">{METHOD[r.method] ?? r.method}</td><td className="px-3 py-2">{r.installments}x</td>
              <td className="px-3 py-2 tabular-nums">{r.transactions}</td><td className="px-3 py-2">{formatBRL(Number(r.gross))}</td>
              <td className="px-3 py-2">{formatBRL(Number(r.charged))}</td><td className="px-3 py-2">{formatBRL(Number(r.expected))}</td>
              <td className={`px-3 py-2 font-medium ${Number(r.variance) > 1 ? "text-danger" : ""}`}>{formatBRL(Number(r.variance))}</td>
            </tr>
          ))}
        </Table>
      )}

      {(unmatched ?? []).length > 0 && (
        <>
          <h2 className="mt-6 mb-2 text-sm font-semibold text-muted">Transações sem venda no sistema ({(unmatched ?? []).length})</h2>
          <Table head={["Data", "Adquirente", "Código", "NSU", "Forma", "Valor"]}>
            {(unmatched ?? []).map((t) => (
              <tr key={t.id}>
                <td className="px-3 py-2 whitespace-nowrap">{fmtDate(t.captured_at.slice(0, 10))}</td><td className="px-3 py-2">{t.acquirer}</td><td className="px-3 py-2 font-mono text-xs">{t.external_id}</td>
                <td className="px-3 py-2 font-mono text-xs">{t.nsu ?? "—"}</td><td className="px-3 py-2">{METHOD[t.method] ?? t.method} {t.installments}x</td><td className="px-3 py-2">{formatBRL(Number(t.gross))}</td>
              </tr>
            ))}
          </Table>
          <p className="mt-1 text-xs text-muted">Venda feita fora do sistema ou com NSU diferente. Confira no PDV (o NSU da venda precisa ser o da maquininha) antes de baixar o repasse.</p>
        </>
      )}

      {(imports ?? []).length > 0 && (
        <>
          <h2 className="mt-6 mb-2 text-sm font-semibold text-muted">Últimas importações</h2>
          <ul className="space-y-1 text-xs text-muted">
            {(imports ?? []).map((i) => <li key={i.id}>{new Date(i.created_at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })} · {i.acquirer} · {i.filename ?? "arquivo"} · {i.transactions_new} de {i.transactions_total} transações novas</li>)}
          </ul>
        </>
      )}
    </>
  );
}
