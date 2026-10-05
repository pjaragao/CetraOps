import Link from "next/link";
import { notFound } from "next/navigation";
import { formatBRL } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, todayIsoSP, type SP } from "@/lib/context";
import { Badge, Button, Card, inputClass, LinkButton, PageHeader, Stat } from "@/components/ui";
import { Field, Flash, fmtDate } from "@/components/form";
import { approveTerminationAction, cancelTerminationAction, recalcTerminationAction } from "../../actions";
import { NOTICE_KIND, RUN_STATUS, TERMINATION_KIND } from "../../labels";

export const metadata = { title: "Rescisão" };

export default async function RescisaoPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SP }) {
  const session = await requirePerm("hr.payroll.read");
  const { id } = await params;
  const sp = await searchParams;
  const supabase = await createClient();
  const canWrite = can(session, "hr.payroll.write");
  const canApprove = can(session, "hr.payroll.approve");

  const { data: t } = await supabase.schema("hr").from("terminations").select("*").eq("id", id).maybeSingle();
  if (!t) notFound();
  const [{ data: emp }, { data: run }, { data: slip }] = await Promise.all([
    supabase.schema("hr").from("employees").select("party_id, job_title, hire_date, registration").eq("id", t.employee_id).maybeSingle(),
    t.run_id ? supabase.schema("hr").from("payroll_runs").select("id, status, pay_date").eq("id", t.run_id).maybeSingle() : Promise.resolve({ data: null }),
    t.run_id ? supabase.schema("hr").from("payslips").select("*").eq("run_id", t.run_id).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const { data: party } = emp ? await supabase.schema("crm").from("parties").select("display_name").eq("id", emp.party_id).maybeSingle() : { data: null };
  const { data: lines } = slip ? await supabase.schema("hr").from("payslip_lines").select("*").eq("payslip_id", slip.id).order("kind").order("created_at") : { data: [] as never[] };
  const c = (t.computed ?? {}) as Record<string, number | boolean | string | null>;
  const [label, tone] = RUN_STATUS[t.status];
  const editable = ["DRAFT", "CALCULATED"].includes(t.status);
  const earnings = (lines ?? []).filter((l) => l.kind === "EARNING");
  const deductions = (lines ?? []).filter((l) => l.kind === "DEDUCTION");
  const employer = (lines ?? []).filter((l) => l.kind === "EMPLOYER");

  return (
    <>
      <PageHeader title={`Rescisão — ${party?.display_name ?? ""}`} description={`${TERMINATION_KIND[t.kind]} · desligamento em ${fmtDate(t.termination_date)} · ${emp?.job_title} (admitido em ${fmtDate(emp?.hire_date)})`}
        actions={<><LinkButton href="/equipe/rescisoes">Voltar</LinkButton>{slip && <LinkButton href={`/equipe/holerite/${slip.id}`}>Recibo para impressão</LinkButton>}</>} />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      <p className="mb-3"><Badge tone={tone}>{label}</Badge></p>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Bruto" value={formatBRL(slip?.gross ?? 0)} />
        <Stat label="Descontos" value={formatBRL(slip?.deductions ?? 0)} hint={`INSS ${formatBRL(slip?.inss ?? 0)} · IRRF ${formatBRL(slip?.irrf ?? 0)}`} />
        <Stat label="Líquido a pagar" value={formatBRL(slip?.net ?? 0)} tone="success" hint={`até ${fmtDate(run?.pay_date)}`} />
        <Stat label="Encargos da empresa" value={formatBRL(slip?.employer_cost ?? 0)} hint="FGTS rescisório + multa" />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card title="Verbas rescisórias" className="lg:col-span-2">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted"><tr><th>Verba</th><th className="w-16 text-right">Ref.</th><th className="w-28 text-right">Valor</th></tr></thead>
            <tbody className="divide-y divide-border">
              {earnings.map((l) => <tr key={l.id}><td className="py-1">{l.description}</td><td className="text-right text-xs">{l.reference != null ? String(Number(l.reference)).replace(".", ",") : ""}</td><td className="text-right">{formatBRL(l.amount)}</td></tr>)}
              {deductions.map((l) => <tr key={l.id} className="text-danger"><td className="py-1">(−) {l.description}</td><td /><td className="text-right">{formatBRL(l.amount)}</td></tr>)}
              {employer.map((l) => <tr key={l.id} className="text-muted"><td className="py-1">{l.description} <span className="text-xs">(encargo da empresa)</span></td><td /><td className="text-right">{formatBRL(l.amount)}</td></tr>)}
            </tbody>
          </table>
        </Card>
        <Card title="Memória de cálculo">
          <dl className="space-y-1 text-sm">
            {([
              ["Salário-base", c.salary != null ? formatBRL(Number(c.salary)) : "—"], ["Média de variáveis (12 meses)", formatBRL(Number(c.variable_avg ?? 0))],
              ["Tempo de casa", `${c.tenure_years ?? 0} ano(s)`], ["Dias de saldo de salário", c.saldo_days], ["Aviso: dias totais / projeção", `${c.notice_days_total ?? 0} / ${c.notice_projection_days ?? 0}`],
              ["Avos de 13º", `${c.avos_13 ?? 0}/12`], ["Avos de férias proporcionais", `${c.avos_vacation ?? 0}/12`], ["Dias de férias vencidas", c.vacation_due_days ?? 0],
              ["Multa do FGTS", `${c.fgts_fine_pct ?? 0}%`], ["Saldo FGTS usado", c.fgts_balance_used != null ? `${formatBRL(Number(c.fgts_balance_used))}${c.fgts_balance_estimated ? " (estimado)" : ""}` : "—"],
            ] as [string, React.ReactNode][]).map(([k, v]) => <div key={k} className="flex justify-between gap-2"><dt className="text-muted">{k}</dt><dd className="text-right">{v}</dd></div>)}
          </dl>
          {c.vacation_expired && <p className="mt-2 rounded bg-danger/10 px-2 py-1 text-xs text-danger">Há férias vencidas fora do prazo concessivo: paga em dobro (art. 137).</p>}
          {c.fgts_balance_estimated && <p className="mt-2 rounded bg-warning/10 px-2 py-1 text-xs text-warning">A multa usa uma estimativa do saldo. Informe o saldo do extrato da Caixa e recalcule.</p>}
        </Card>
      </div>

      {editable && canWrite && (
        <Card className="mt-4" title="Ajustar e recalcular">
          <form action={recalcTerminationAction} className="grid gap-2 sm:grid-cols-6">
            <input type="hidden" name="termination_id" value={id} />
            <Field label="Tipo" className="sm:col-span-2"><select name="kind" defaultValue={t.kind} className={inputClass}>{Object.entries(TERMINATION_KIND).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
            <Field label="Aviso"><select name="notice_kind" defaultValue={t.notice_kind} className={inputClass}>{Object.entries(NOTICE_KIND).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
            <Field label="Desligamento"><input name="termination_date" type="date" defaultValue={t.termination_date} className={inputClass} /></Field>
            <Field label="Dias de aviso"><input name="notice_days" type="number" min={0} max={90} defaultValue={t.notice_days ?? ""} className={inputClass} /></Field>
            <Field label="Saldo FGTS (R$)"><input name="fgts_balance" inputMode="decimal" defaultValue={t.fgts_balance ?? ""} className={inputClass} /></Field>
            <div className="sm:col-span-6"><Button variant="secondary">Recalcular</Button></div>
          </form>
          <p className="mt-2 text-xs text-muted">Descontos avulsos (VT, empréstimos, danos) entram como verbas manuais no recibo da <Link className="text-brand underline" href={run ? `/equipe/folha/${run.id}` : "/equipe/folha"}>folha de rescisão</Link>.</p>
        </Card>
      )}

      {t.status === "CALCULATED" && t.termination_date > todayIsoSP() && (
        <p className="mt-4 rounded-lg bg-warning/10 px-3 py-2 text-sm text-warning" data-print-hide>
          O desligamento é em {fmtDate(t.termination_date)}. Ao aprovar, a pessoa sai da escala e da folha imediatamente — aprove no último dia de trabalho (no aviso trabalhado, o último dia do aviso).
        </p>
      )}
      <div className="mt-4 flex flex-wrap items-end gap-3" data-print-hide>
        {canApprove && t.status === "CALCULATED" && <form action={approveTerminationAction}><input type="hidden" name="termination_id" value={id} /><Button>Aprovar rescisão</Button></form>}
        {canApprove && ["DRAFT", "CALCULATED", "APPROVED"].includes(t.status) && (
          <form action={cancelTerminationAction} className="flex items-end gap-2"><input type="hidden" name="termination_id" value={id} />
            <Field label={t.status === "APPROVED" ? "Cancelar (estorna títulos e reativa o colaborador)" : "Descartar rescisão"}><input name="reason" className={`${inputClass} w-64`} placeholder="Motivo" /></Field>
            <Button variant="danger">Cancelar</Button></form>
        )}
        {["APPROVED", "PAID"].includes(t.status) && run && <LinkButton href={`/equipe/folha/${run.id}`}>Ver títulos e guias</LinkButton>}
      </div>
    </>
  );
}
