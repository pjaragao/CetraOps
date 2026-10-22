import Link from "next/link";
import { formatBRL } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { requirePerm } from "@/lib/session";
import { addDaysIsoSP, str, todayIsoSP, type SP } from "@/lib/context";
import { Badge, Card, Empty, inputClass, PageHeader, Stat, Table } from "@/components/ui";
import { Field, fmtDate } from "@/components/form";
import { CashChart, type FlowDay } from "./cash-chart";

export const metadata = { title: "Fluxo de caixa" };

/** Fluxo de caixa: realizado (extrato/caixa) + projetado (parcelas em aberto). O atrasado entra em "hoje". */
export default async function FluxoPage({ searchParams }: { searchParams: SP }) {
  await requirePerm("fin.read");
  const sp = await searchParams;
  const supabase = await createClient();
  const today = todayIsoSP();
  const horizon = [30, 60, 90].includes(Number(str(sp.dias))) ? Number(str(sp.dias)) : 30;
  const from = addDaysIsoSP(-7), to = addDaysIsoSP(horizon);
  const [{ data: entities }, { data: banks }] = await Promise.all([
    supabase.schema("core").from("legal_entities").select("id, razao_social, nome_fantasia").order("razao_social"),
    supabase.schema("fin").from("bank_accounts").select("id, name, legal_entity_id").eq("active", true).order("name"),
  ]);
  const entity = str(sp.empresa) || undefined;
  const bank = str(sp.conta) || undefined;
  const { data: rows, error } = await supabase.schema("fin").rpc("cash_flow", { p_from: from, p_to: to, ...(entity ? { p_entity: entity } : {}), ...(bank ? { p_bank: bank } : {}) });
  const days: FlowDay[] = (rows ?? []).map((r) => ({ day: r.day, inn: Number(r.realized_in) + Number(r.projected_in), out: Number(r.realized_out) + Number(r.projected_out), projected: r.day >= today, balance: Number(r.balance) }));

  const future = (rows ?? []).filter((r) => r.day >= today);
  const balToday = Number((rows ?? []).find((r) => r.day === today)?.balance ?? 0);
  const min = future.reduce<{ v: number; d: string } | null>((m, r) => (m === null || Number(r.balance) < m.v ? { v: Number(r.balance), d: r.day } : m), null);
  const projIn = future.reduce((s, r) => s + Number(r.projected_in), 0), projOut = future.reduce((s, r) => s + Number(r.projected_out), 0);
  const end = Number(rows?.[rows.length - 1]?.balance ?? 0);

  // por semana (a partir de hoje)
  const weeks: { label: string; inn: number; out: number; balance: number }[] = [];
  for (let i = 0; i < future.length; i += 7) {
    const chunk = future.slice(i, i + 7);
    weeks.push({ label: `${fmtDate(chunk[0].day)} a ${fmtDate(chunk[chunk.length - 1].day)}`, inn: chunk.reduce((s, r) => s + Number(r.realized_in) + Number(r.projected_in), 0),
      out: chunk.reduce((s, r) => s + Number(r.realized_out) + Number(r.projected_out), 0), balance: Number(chunk[chunk.length - 1].balance) });
  }

  const { data: upcoming } = await supabase.schema("fin").from("v_open_installments").select("installment_id, direction, description, party_name, due_date, expected_date, balance, title_number")
    .lte("due_date", addDaysIsoSP(14)).order("due_date").limit(12);

  return (
    <>
      <PageHeader title="Fluxo de caixa" description="Saldo real das contas até hoje e projeção pelas contas a pagar e a receber em aberto. Atrasados entram no dia de hoje." />
      <form className="mb-4 flex flex-wrap items-end gap-2">
        <Field label="Horizonte"><select name="dias" defaultValue={horizon} className={inputClass}>{[30, 60, 90].map((d) => <option key={d} value={d}>{d} dias</option>)}</select></Field>
        <Field label="Empresa"><select name="empresa" defaultValue={entity ?? ""} className={inputClass}><option value="">Todas</option>{(entities ?? []).map((e) => <option key={e.id} value={e.id}>{e.nome_fantasia ?? e.razao_social}</option>)}</select></Field>
        <Field label="Conta (só realizado)"><select name="conta" defaultValue={bank ?? ""} className={inputClass}><option value="">Consolidado</option>{(banks ?? []).filter((b) => !entity || b.legal_entity_id === entity).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
        <button className="rounded-lg border border-border px-3 py-2 text-sm hover:bg-surface-2">Aplicar</button>
      </form>
      {error && <p role="alert" className="mb-3 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{error.message}</p>}

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Saldo hoje" value={formatBRL(balToday)} />
        <Stat label="Entradas previstas" value={formatBRL(projIn)} tone="success" hint={`próximos ${horizon} dias`} />
        <Stat label="Saídas previstas" value={formatBRL(projOut)} hint={`próximos ${horizon} dias`} />
        <Stat label="Menor saldo" value={min ? formatBRL(min.v) : "—"} tone={min && min.v < 0 ? "danger" : undefined} hint={min ? `em ${fmtDate(min.d)}` : undefined} />
        <Stat label={`Saldo em ${fmtDate(to)}`} value={formatBRL(end)} tone={end < 0 ? "danger" : undefined} />
      </div>
      {bank && <p className="mb-3 text-xs text-muted">Com uma conta específica só o realizado aparece: as parcelas em aberto não têm conta definida até a baixa.</p>}

      <Card title="Saldo e movimento diário"><CashChart days={days} today={today} /></Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div>
          <h2 className="mb-2 text-sm font-semibold text-muted">Por semana</h2>
          {weeks.length === 0 ? <Empty title="Sem dados" /> : (
            <Table head={["Semana", "Entradas", "Saídas", "Saldo final"]} noTotal={[3]}>
              {weeks.map((w) => (
                <tr key={w.label}>
                  <td className="px-3 py-2 whitespace-nowrap">{w.label}</td><td className="px-3 py-2 text-success">{formatBRL(w.inn)}</td>
                  <td className="px-3 py-2">{formatBRL(w.out)}</td><td className={`px-3 py-2 font-medium ${w.balance < 0 ? "text-danger" : ""}`}>{formatBRL(w.balance)}</td>
                </tr>
              ))}
            </Table>
          )}
        </div>
        <div>
          <h2 className="mb-2 text-sm font-semibold text-muted">Próximos 14 dias</h2>
          {(upcoming ?? []).length === 0 ? <Empty title="Nada vence nos próximos 14 dias" /> : (
            <Table head={["Vence", "Descrição", "Valor", ""]}>
              {(upcoming ?? []).map((u) => (
                <tr key={u.installment_id}>
                  <td className={`px-3 py-2 whitespace-nowrap ${u.due_date && u.due_date < today ? "font-medium text-danger" : ""}`}>{fmtDate(u.due_date)}</td>
                  <td className="px-3 py-2">{u.description}<span className="block text-xs text-muted">{u.party_name}</span></td>
                  <td className={`px-3 py-2 font-medium ${u.direction === "RECEIVABLE" ? "text-success" : ""}`}>{u.direction === "RECEIVABLE" ? "+" : "−"} {formatBRL(u.balance)}</td>
                  <td className="px-3 py-2"><Link className="rounded-lg border border-border px-2 py-1 text-xs hover:bg-surface-2" href={`/financeiro/baixar?dir=${u.direction}&ids=${u.installment_id}`}>{u.direction === "RECEIVABLE" ? "Receber" : "Pagar"}</Link></td>
                </tr>
              ))}
            </Table>
          )}
          <p className="mt-2 text-xs text-muted"><Badge>dica</Badge> Cartão a receber cai na data prevista da adquirente; boletos B2B, no vencimento.</p>
        </div>
      </div>
    </>
  );
}
