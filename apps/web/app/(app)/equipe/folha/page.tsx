import Link from "next/link";
import { formatBRL } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, todayIsoSP, type SP } from "@/lib/context";
import { Badge, Button, Card, Empty, inputClass, PageHeader, Table } from "@/components/ui";
import { Field, Flash, fmtMonth } from "@/components/form";
import { accrueProvisionsAction, createRunAction } from "../actions";
import { RUN_KIND as KIND, RUN_STATUS } from "../labels";

export const metadata = { title: "Folha de pagamento" };

export default async function FolhaPage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("hr.payroll.read");
  const sp = await searchParams;
  const supabase = await createClient();
  const today = todayIsoSP();
  const canWrite = can(session, "hr.payroll.write");
  const canApprove = can(session, "hr.payroll.approve");

  const [{ data: runs }, { data: entities }, { data: prov }, { data: provRuns }, { data: emps }] = await Promise.all([
    supabase.schema("hr").from("payroll_runs").select("id, kind, competence, description, status, pay_date, totals, legal_entity_id").order("competence", { ascending: false }).order("created_at", { ascending: false }).limit(60),
    supabase.schema("core").from("legal_entities").select("id, razao_social, nome_fantasia").order("razao_social"),
    supabase.schema("hr").from("provisions").select("employee_id, kind, amount"),
    supabase.schema("hr").from("provision_runs").select("competence, totals, legal_entity_id").order("competence", { ascending: false }).limit(6),
    supabase.schema("hr").from("employees").select("id, party_id").eq("status", "ACTIVE"),
  ]);
  const balance = { VACATION: 0, THIRTEENTH: 0, FGTS: 0 } as Record<string, number>;
  for (const p of prov ?? []) balance[p.kind] = (balance[p.kind] ?? 0) + Number(p.amount);
  const total = balance.VACATION + balance.THIRTEENTH + balance.FGTS;
  const entOpts = (entities ?? []).map((e) => ({ id: e.id, label: e.nome_fantasia ?? e.razao_social }));

  return (
    <>
      <PageHeader title="Folha de pagamento" description="Calcula, aprova e gera os títulos a pagar, as guias (FGTS, INSS, IRRF), os lançamentos contábeis e os eventos do eSocial. O pagamento acontece no Financeiro, inclusive vários salários em um único Pix." />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />

      {canWrite && (
        <Card title="Nova folha" className="mb-4">
          <form action={createRunAction} className="grid gap-2 sm:grid-cols-5">
            <Field label="Empresa"><select name="entity" className={inputClass}>{entOpts.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}</select></Field>
            <Field label="Tipo">
              <select name="kind" className={inputClass} defaultValue="MONTHLY">
                <option value="MONTHLY">Folha mensal</option><option value="ADVANCE">Adiantamento (vale)</option><option value="THIRTEENTH_1">13º — 1ª parcela</option>
                <option value="THIRTEENTH_2">13º — 2ª parcela</option><option value="PROLABORE">Pró-labore</option>
              </select>
            </Field>
            <Field label="Competência"><input name="month" type="month" required defaultValue={today.slice(0, 7)} className={inputClass} /></Field>
            <div className="self-end"><Button>Criar folha</Button></div>
          </form>
          <p className="mt-2 text-xs text-muted">Férias e rescisão têm fluxo próprio (ficha do colaborador e Rescisões). Antes da folha mensal, feche o ponto do mês em Ponto e banco de horas.</p>
        </Card>
      )}

      {(runs ?? []).length === 0 ? <Empty title="Nenhuma folha ainda" /> : (
        <Table head={["Competência", "Folha", "Situação", "Colab.", "Bruto", "Líquido", "Encargos da empresa", "Pagamento"]}>
          {(runs ?? []).map((r) => {
            const t = (r.totals ?? {}) as Record<string, number>;
            const [label, tone] = RUN_STATUS[r.status];
            return (
              <tr key={r.id}>
                <td className="px-3 py-2 whitespace-nowrap">{fmtMonth(r.competence)}</td>
                <td className="px-3 py-2"><Link className="font-medium text-brand" href={`/equipe/folha/${r.id}`}>{r.description ?? KIND[r.kind]}</Link><span className="block text-xs text-muted">{KIND[r.kind]}</span></td>
                <td className="px-3 py-2"><Badge tone={tone}>{label}</Badge></td>
                <td className="px-3 py-2">{t.payslips ?? "—"}</td>
                <td className="px-3 py-2 whitespace-nowrap">{t.gross != null ? formatBRL(t.gross) : "—"}</td>
                <td className="px-3 py-2 whitespace-nowrap font-medium">{t.net != null ? formatBRL(t.net) : "—"}</td>
                <td className="px-3 py-2 whitespace-nowrap">{t.employer_cost != null ? formatBRL(t.employer_cost) : "—"}</td>
                <td className="px-3 py-2 whitespace-nowrap">{r.pay_date ? r.pay_date.split("-").reverse().join("/") : "—"}</td>
              </tr>
            );
          })}
        </Table>
      )}

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card title="Provisões de 13º, férias e FGTS">
          <p className="text-sm text-muted">Reconhece todo mês o custo que ainda será pago (13º, férias + 1/3 e FGTS sobre eles), para o DRE refletir o custo real da equipe. O pagamento de férias, 13º e rescisão consome a provisão.</p>
          <dl className="mt-3 grid grid-cols-3 gap-2 text-sm">
            <div><dt className="text-xs text-muted">13º</dt><dd className="font-semibold">{formatBRL(balance.THIRTEENTH)}</dd></div>
            <div><dt className="text-xs text-muted">Férias + 1/3</dt><dd className="font-semibold">{formatBRL(balance.VACATION)}</dd></div>
            <div><dt className="text-xs text-muted">FGTS s/ provisões</dt><dd className="font-semibold">{formatBRL(balance.FGTS)}</dd></div>
          </dl>
          <p className="mt-2 text-sm">Saldo total provisionado: <b>{formatBRL(total)}</b> · {(emps ?? []).length} colaboradores ativos</p>
          {canApprove && (
            <form action={accrueProvisionsAction} className="mt-3 flex flex-wrap items-end gap-2">
              <Field label="Empresa"><select name="entity" className={inputClass}>{entOpts.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}</select></Field>
              <Field label="Mês"><input name="month" type="month" required defaultValue={today.slice(0, 7)} className={inputClass} /></Field>
              <Button variant="secondary">Provisionar o mês</Button>
            </form>
          )}
          {(provRuns ?? []).length > 0 && (
            <ul className="mt-3 divide-y divide-border text-sm">
              {(provRuns ?? []).map((p) => {
                const t = (p.totals ?? {}) as Record<string, number>;
                return <li key={`${p.legal_entity_id}${p.competence}`} className="flex justify-between py-1"><span>{fmtMonth(p.competence)}</span><span className="text-muted">13º {formatBRL(t.thirteenth ?? 0)} · férias {formatBRL(t.vacation ?? 0)} · FGTS {formatBRL(t.fgts ?? 0)}</span></li>;
              })}
            </ul>
          )}
        </Card>
        <Card title="Como a folha fecha com o financeiro">
          <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
            <li><b>Ponto do mês</b> fechado (horas extras, adicional noturno, faltas, DSR).</li>
            <li><b>Criar → calcular</b>: salário proporcional, comissões, benefícios, INSS (acumulado), IRRF (Lei 15.270) e FGTS.</li>
            <li><b>Aprovar</b> (sócio): um título a pagar por colaborador + guias de FGTS, INSS e IRRF + lançamento contábil por centro de custo + obrigações e eSocial.</li>
            <li><b>Pagar</b> em Financeiro › Contas a pagar: marque vários salários e faça um único Pix; a baixa concilia com o extrato.</li>
          </ol>
        </Card>
      </div>
    </>
  );
}
