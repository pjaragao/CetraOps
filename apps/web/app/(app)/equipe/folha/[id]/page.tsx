import Link from "next/link";
import { notFound } from "next/navigation";
import { formatBRL } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { Badge, Button, Card, inputClass, LinkButton, PageHeader, Stat, Table } from "@/components/ui";
import { Field, Flash, fmtDate, fmtMonth } from "@/components/form";
import { addManualLineAction, approveRunAction, calcRunAction, cancelRunAction, removeLineAction } from "../../actions";
import { RUN_KIND, RUN_STATUS } from "../../labels";

export const metadata = { title: "Folha" };

const NOT_MANUAL = new Set(["INSS", "IRRF", "FGTS_EMP", "INSS_PATRONAL", "RAT", "TERCEIROS", "MULTA_FGTS"]);

export default async function FolhaDetalhePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SP }) {
  const session = await requirePerm("hr.payroll.read");
  const { id } = await params;
  const sp = await searchParams;
  const supabase = await createClient();
  const canWrite = can(session, "hr.payroll.write");
  const canApprove = can(session, "hr.payroll.approve");

  const { data: run } = await supabase.schema("hr").from("payroll_runs").select("*").eq("id", id).maybeSingle();
  if (!run) notFound();
  const { data: slips } = await supabase.schema("hr").from("payslips").select("*").eq("run_id", id).neq("status", "CANCELLED");
  const slipIds = (slips ?? []).map((s) => s.id);
  const empIds = (slips ?? []).map((s) => s.employee_id);
  const [{ data: lines }, { data: emps }, { data: events }, { data: entity }] = await Promise.all([
    slipIds.length ? supabase.schema("hr").from("payslip_lines").select("*").in("payslip_id", slipIds).order("kind").order("created_at") : Promise.resolve({ data: [] as never[] }),
    empIds.length ? supabase.schema("hr").from("employees").select("id, party_id, registration, job_title").in("id", empIds) : Promise.resolve({ data: [] as never[] }),
    supabase.schema("hr").from("payroll_events").select("code, name, kind").in("kind", ["EARNING", "DEDUCTION"]).eq("active", true).order("kind").order("name"),
    supabase.schema("core").from("legal_entities").select("razao_social, nome_fantasia").eq("id", run.legal_entity_id).maybeSingle(),
  ]);
  const partyIds = (emps ?? []).map((e) => e.party_id);
  const { data: parties } = partyIds.length ? await supabase.schema("crm").from("parties").select("id, display_name").in("id", partyIds) : { data: [] as { id: string; display_name: string }[] };
  const pname = new Map((parties ?? []).map((p) => [p.id, p.display_name]));
  const emp = new Map((emps ?? []).map((e) => [e.id, { name: pname.get(e.party_id) ?? "—", reg: e.registration, job: e.job_title }]));
  const editable = ["DRAFT", "CALCULATED"].includes(run.status);
  const t = (run.totals ?? {}) as Record<string, number | string[]>;
  const [label, tone] = RUN_STATUS[run.status];

  // títulos gerados na aprovação
  const { data: titles } = ["APPROVED", "PAID"].includes(run.status)
    ? await supabase.schema("fin").from("titles").select("id, number, description, document_kind, total_amount, status, party_id, origin_id").eq("origin_type", "PAYROLL").in("origin_id", [id, ...slipIds]).neq("status", "CANCELLED").order("document_kind")
    : { data: [] as { id: string; number: string; description: string; document_kind: string | null; total_amount: number; status: string; party_id: string | null; origin_id: string | null }[] };
  const titleIds = (titles ?? []).map((x) => x.id);
  const { data: inst } = titleIds.length ? await supabase.schema("fin").from("v_open_installments").select("installment_id, title_id, due_date, balance").in("title_id", titleIds) : { data: [] as { installment_id: string | null; title_id: string | null; due_date: string | null; balance: number | null }[] };
  const salaryInst = (inst ?? []).filter((i) => (titles ?? []).find((x) => x.id === i.title_id)?.document_kind === "FOLHA").map((i) => i.installment_id);
  const dueOf = new Map((inst ?? []).map((i) => [i.title_id, i.due_date]));

  const missing = (t.without_timesheet as string[] | undefined) ?? [];

  return (
    <>
      <PageHeader title={run.description ?? RUN_KIND[run.kind]} description={`${RUN_KIND[run.kind]} · competência ${fmtMonth(run.competence)} · ${entity?.nome_fantasia ?? entity?.razao_social ?? ""} · pagamento em ${fmtDate(run.pay_date)}`}
        actions={<>
          <LinkButton href="/equipe/folha">Voltar</LinkButton>
          {canWrite && editable && <form action={calcRunAction}><input type="hidden" name="run_id" value={id} /><Button variant="secondary">{run.status === "DRAFT" ? "Calcular" : "Recalcular"}</Button></form>}
          {canApprove && run.status === "CALCULATED" && run.kind !== "TERMINATION" && <form action={approveRunAction}><input type="hidden" name="run_id" value={id} /><Button>Aprovar folha</Button></form>}
        </>} />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      <p className="mb-3"><Badge tone={tone}>{label}</Badge></p>

      {missing.length > 0 && run.kind === "MONTHLY" && (
        <p className="mb-3 rounded-lg bg-warning/10 px-3 py-2 text-sm text-warning">
          {missing.length} colaborador(es) sem espelho de ponto fechado ({missing.join(", ")}): horas extras, adicional noturno e faltas não entraram. <Link className="underline" href={`/equipe/ponto?mes=${run.competence.slice(0, 7)}`}>Fechar o ponto</Link> e recalcular.
        </p>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Recibos" value={(t.payslips as number) ?? (slips ?? []).length} />
        <Stat label="Bruto" value={formatBRL((t.gross as number) ?? 0)} />
        <Stat label="Descontos" value={formatBRL((t.deductions as number) ?? 0)} hint={`INSS ${formatBRL((t.inss as number) ?? 0)} · IRRF ${formatBRL((t.irrf as number) ?? 0)}`} />
        <Stat label="Líquido a pagar" value={formatBRL((t.net as number) ?? 0)} tone="success" />
        <Stat label="Encargos e benefícios (empresa)" value={formatBRL((t.employer_cost as number) ?? 0)} hint={`FGTS ${formatBRL((t.fgts as number) ?? 0)} · o restante é VR/VT e encargos`} />
      </div>

      <div className="mt-4 space-y-2">
        {(slips ?? []).map((s) => {
          const ls = (lines ?? []).filter((l) => l.payslip_id === s.id);
          const info = emp.get(s.employee_id);
          return (
            <details key={s.id} className="rounded-xl border border-border bg-surface">
              <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2 px-4 py-3">
                <span><Link className="font-medium text-brand" href={`/equipe/${s.employee_id}`}>{info?.name}</Link> <span className="text-xs text-muted">{info?.job} · {info?.reg}</span></span>
                <span className="flex items-center gap-4 text-sm">
                  <span className="text-muted">bruto {formatBRL(s.gross)}</span><span className="text-muted">descontos {formatBRL(s.deductions)}</span>
                  <b className={Number(s.net) < 0 ? "text-danger" : ""}>{formatBRL(s.net)}</b>
                  <Badge tone={s.status === "PAID" ? "success" : s.status === "APPROVED" ? "info" : "warning"}>{s.status === "PAID" ? "paga" : s.status === "APPROVED" ? "aprovada" : "rascunho"}</Badge>
                </span>
              </summary>
              <div className="border-t border-border px-4 py-3">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-muted"><tr><th>Verba</th><th className="w-20 text-right">Ref.</th><th className="w-28 text-right">Proventos</th><th className="w-28 text-right">Descontos</th><th className="w-20" /></tr></thead>
                  <tbody className="divide-y divide-border">
                    {ls.map((l) => (
                      <tr key={l.id} className={l.kind === "EMPLOYER" ? "text-muted" : ""}>
                        <td className="py-1">{l.description}{l.source !== "AUTO" && <Badge tone="brand">{l.source === "MANUAL" ? "manual" : "contador"}</Badge>}{l.kind === "EMPLOYER" && <span className="ml-1 text-xs">(encargo da empresa)</span>}</td>
                        <td className="py-1 text-right text-xs">{l.reference != null ? String(Number(l.reference)).replace(".", ",") : ""}</td>
                        <td className="py-1 text-right">{l.kind === "EARNING" ? formatBRL(l.amount) : ""}</td>
                        <td className="py-1 text-right">{l.kind === "DEDUCTION" ? formatBRL(l.amount) : l.kind === "EMPLOYER" ? <span className="text-xs">{formatBRL(l.amount)}</span> : ""}</td>
                        <td className="py-1 text-right">{editable && canWrite && l.source !== "AUTO" && <form action={removeLineAction}><input type="hidden" name="run_id" value={id} /><input type="hidden" name="line_id" value={l.id} /><button className="text-xs text-danger">remover</button></form>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-2 text-xs text-muted">Base INSS {formatBRL(s.inss_base)} · Base IRRF {formatBRL(s.irrf_base)} · Base FGTS {formatBRL(s.fgts_base)} · Dependentes IRRF {s.dependents}</p>
                <div className="mt-2 flex flex-wrap items-end gap-2">
                  <Link className="text-sm text-brand" href={`/equipe/holerite/${s.id}`}>Abrir holerite</Link>
                  {editable && canWrite && (
                    <form action={addManualLineAction} className="ml-auto flex flex-wrap items-end gap-2">
                      <input type="hidden" name="run_id" value={id} /><input type="hidden" name="payslip_id" value={s.id} />
                      <Field label="Incluir verba"><select name="code" className={inputClass}>{(events ?? []).filter((e) => !NOT_MANUAL.has(e.code)).map((e) => <option key={e.code} value={e.code}>{e.kind === "DEDUCTION" ? "(−) " : "(+) "}{e.name}</option>)}</select></Field>
                      <Field label="Valor (R$)"><input name="amount" required inputMode="decimal" className={`${inputClass} w-28`} /></Field>
                      <Field label="Descrição"><input name="desc" className={`${inputClass} w-44`} placeholder="opcional" /></Field>
                      <Button variant="secondary">Incluir</Button>
                    </form>
                  )}
                </div>
              </div>
            </details>
          );
        })}
      </div>

      {["APPROVED", "PAID"].includes(run.status) && (
        <Card className="mt-4" title="Financeiro gerado por esta folha"
          action={salaryInst.length > 0 ? <LinkButton href={`/financeiro/baixar?dir=PAYABLE&ids=${salaryInst.join(",")}`}>Pagar todos os líquidos (1 Pix)</LinkButton> : undefined}>
          <Table head={["Título", "Descrição", "Valor", "Vencimento", "Situação"]}>
            {(titles ?? []).map((x) => (
              <tr key={x.id}>
                <td className="px-3 py-1.5 text-xs">{x.number}</td><td className="px-3 py-1.5">{x.description}</td>
                <td className="px-3 py-1.5 font-medium">{formatBRL(x.total_amount)}</td><td className="px-3 py-1.5">{fmtDate(dueOf.get(x.id))}</td>
                <td className="px-3 py-1.5"><Badge tone={x.status === "SETTLED" ? "success" : "warning"}>{x.status === "SETTLED" ? "paga" : "a pagar"}</Badge></td>
              </tr>
            ))}
          </Table>
          <p className="mt-2 text-xs text-muted">Lançamento contábil por centro de custo em <Link className="text-brand" href="/financeiro/razao?aba=lancamentos">Razão contábil</Link> · guias no <Link className="text-brand" href="/fiscal/obrigacoes">calendário de obrigações</Link>.</p>
        </Card>
      )}

      {canApprove && ["APPROVED", "CALCULATED", "DRAFT"].includes(run.status) && run.kind !== "TERMINATION" && (
        <form action={cancelRunAction} className="mt-4 flex flex-wrap items-end gap-2" data-print-hide>
          <input type="hidden" name="run_id" value={id} />
          <Field label={run.status === "APPROVED" ? "Cancelar folha aprovada (estorna títulos e lançamentos)" : "Descartar esta folha"}><input name="reason" className={`${inputClass} w-72`} placeholder="Motivo" /></Field>
          <Button variant="danger">Cancelar folha</Button>
        </form>
      )}
    </>
  );
}
