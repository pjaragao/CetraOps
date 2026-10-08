import Link from "next/link";
import { notFound } from "next/navigation";
import { formatBRL } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { Badge, Button, Card, inputClass, PageHeader, Stat, Table } from "@/components/ui";
import { Field, Flash, fmtDate } from "@/components/form";
import { updateBankAccountAction } from "../actions";

export const metadata = { title: "Conta bancária" };

const KIND_LABEL: Record<string, string> = { CHECKING: "Conta corrente", CASH_DRAWER: "Caixa (gaveta)", ACQUIRER_BALANCE: "Saldo na adquirente", INVESTMENT: "Aplicação" };

export default async function ContaBancariaPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SP }) {
  const session = await requirePerm("fin.read");
  const { id } = await params;
  const sp = await searchParams;
  const supabase = await createClient();
  const { data: b } = await supabase.schema("fin").from("bank_accounts").select("*").eq("id", id).maybeSingle();
  if (!b) notFound();
  const [{ data: bal }, { data: moves, count }, { data: entity }, { data: stores }, { data: accounts }] = await Promise.all([
    supabase.schema("fin").from("v_bank_balances").select("balance, unreconciled_count").eq("bank_account_id", id).maybeSingle(),
    supabase.schema("fin").from("cash_transactions").select("id, occurred_on, amount, description, reconciled, voided", { count: "exact" }).eq("bank_account_id", id).order("occurred_on", { ascending: false }).limit(10),
    supabase.schema("core").from("legal_entities").select("razao_social, nome_fantasia, cnpj").eq("id", b.legal_entity_id).maybeSingle(),
    supabase.schema("core").from("stores").select("id, name").order("name"),
    supabase.schema("fin").from("chart_accounts").select("id, code, name").eq("kind", "ANALYTIC").eq("group", "ASSET").like("code", "1.1.1.%").is("archived_at", null).order("code"),
  ]);
  const hasMoves = (count ?? 0) > 0;
  const canWrite = can(session, "fin.write") || can(session, "core.admin");
  const acc = (accounts ?? []).find((a) => a.id === b.chart_account_id);

  return (
    <>
      <PageHeader title={b.name} description={`${KIND_LABEL[b.kind] ?? b.kind} · ${entity?.nome_fantasia ?? entity?.razao_social ?? ""}`}
        actions={<Link href="/configuracoes/contas-bancarias" className="rounded-lg px-3 py-1.5 text-sm hover:bg-surface-2">← Contas bancárias</Link>} />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Saldo" value={formatBRL(bal?.balance ?? 0)} />
        <Stat label="Sem conciliar" value={String(bal?.unreconciled_count ?? 0)} tone={Number(bal?.unreconciled_count ?? 0) > 0 ? "warning" : undefined} />
        <Stat label="Saldo de abertura" value={formatBRL(b.opening_balance)} hint={b.opening_date ? `em ${fmtDate(b.opening_date)}` : undefined} />
        <Stat label="Situação" value={b.active ? "ativa" : "desativada"} />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Dados">
          <ul className="space-y-1.5 text-sm">
            <li className="flex justify-between gap-2"><span className="text-muted">Banco</span><span>{b.bank_code ?? "—"}</span></li>
            <li className="flex justify-between gap-2"><span className="text-muted">Agência / conta</span><span>{[b.agency, b.number].filter(Boolean).join(" / ") || "—"}</span></li>
            <li className="flex justify-between gap-2"><span className="text-muted">Chaves Pix</span><span className="text-right">{(b.pix_keys ?? []).join(", ") || "—"}</span></li>
            <li className="flex justify-between gap-2"><span className="text-muted">Conta do plano</span><span>{acc ? `${acc.code} · ${acc.name}` : "—"}</span></li>
            <li className="flex justify-between gap-2"><span className="text-muted">Empresa</span><span>{entity?.cnpj ?? "—"}</span></li>
          </ul>
          <p className="mt-3 text-xs text-muted">O saldo de abertura e o tipo não mudam depois de criados; a conta do plano só muda enquanto não houver movimento.</p>
        </Card>
        <div className="lg:col-span-2">
          <div className="mb-2 flex items-center justify-between"><h2 className="text-sm font-semibold">Últimos movimentos</h2><Link href={`/financeiro/movimentacoes?conta=${b.id}`} className="text-sm text-brand">Ver todos ({count ?? 0})</Link></div>
          <Table head={["Data", "Descrição", "Valor", ""]}>
            {(moves ?? []).map((m) => (
              <tr key={m.id} className={m.voided ? "text-muted line-through" : ""}>
                <td className="px-3 py-2 whitespace-nowrap">{fmtDate(m.occurred_on)}</td><td className="px-3 py-2">{m.description}</td>
                <td className={`px-3 py-2 font-medium ${Number(m.amount) > 0 ? "text-success" : "text-danger"}`}>{formatBRL(m.amount)}</td>
                <td className="px-3 py-2">{m.reconciled ? <Badge tone="success">conciliado</Badge> : <Badge tone="warning">pendente</Badge>}</td>
              </tr>
            ))}
          </Table>
        </div>
      </div>
      {canWrite && (
        <Card className="mt-4" title="Editar">
          <form action={updateBankAccountAction} className="grid gap-3 sm:grid-cols-6">
            <input type="hidden" name="id" value={b.id} />
            <Field label="Nome" className="sm:col-span-2"><input name="name" required minLength={2} maxLength={80} defaultValue={b.name} className={inputClass} /></Field>
            <Field label="Banco (código)"><input name="bank_code" defaultValue={b.bank_code ?? ""} maxLength={4} className={inputClass} /></Field>
            <Field label="Agência"><input name="agency" defaultValue={b.agency ?? ""} maxLength={10} className={inputClass} /></Field>
            <Field label="Conta" className="sm:col-span-2"><input name="number" defaultValue={b.number ?? ""} maxLength={20} className={inputClass} /></Field>
            <Field label="Chaves Pix" hint="Separe por vírgula" className="sm:col-span-3"><input name="pix_keys" defaultValue={(b.pix_keys ?? []).join(", ")} className={inputClass} /></Field>
            <Field label="Loja (caixa)" className="sm:col-span-1"><select name="store_id" defaultValue={b.store_id ?? ""} className={inputClass}><option value="">—</option>{(stores ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
            <Field label="Conta do plano" hint={hasMoves ? "Já tem movimentos: não muda" : undefined} className="sm:col-span-2">
              <select name="chart_account_id" defaultValue={b.chart_account_id ?? ""} disabled={hasMoves} className={inputClass}><option value="">—</option>{(accounts ?? []).map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</select>
            </Field>
            <label className="flex items-center gap-2 text-sm sm:col-span-3"><input type="checkbox" name="active" defaultChecked={b.active} /> Conta ativa (para desativar, o saldo precisa estar zerado)</label>
            <div className="sm:col-span-3 sm:text-right"><Button>Salvar conta</Button></div>
          </form>
        </Card>
      )}
    </>
  );
}
