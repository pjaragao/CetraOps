import Link from "next/link";
import { notFound } from "next/navigation";
import { formatBRL } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, todayIsoSP, type SP } from "@/lib/context";
import { Badge, Button, Card, Empty, inputClass, LinkButton, PageHeader, Table } from "@/components/ui";
import { Field, Flash, fmtDate, fmtMonth } from "@/components/form";
import {
  addBenefitAction, addDependentAction, addExamAction, addLeaveAction, approveVacationAction, cancelVacationAction, changeSalaryAction,
  endBenefitAction, payVacationAction, removeDependentAction, scheduleVacationAction,
} from "../actions";

export const metadata = { title: "Colaborador" };

const LEAVE_KINDS: [string, string][] = [
  ["SICK", "Atestado / doença"], ["ACCIDENT", "Acidente de trabalho"], ["MATERNITY", "Licença-maternidade"], ["PATERNITY", "Licença-paternidade"], ["MARRIAGE", "Casamento (3 dias)"],
  ["BEREAVEMENT", "Luto (2 dias)"], ["BLOOD_DONATION", "Doação de sangue"], ["JUSTIFIED_ABSENCE", "Falta justificada"], ["UNJUSTIFIED_ABSENCE", "Falta injustificada"],
  ["UNPAID", "Licença não remunerada"], ["SUSPENSION", "Suspensão"], ["OTHER", "Outro"],
];
const LEAVE_LABEL = Object.fromEntries(LEAVE_KINDS);
const VAC_STATUS: Record<string, [string, "neutral" | "info" | "success" | "warning" | "danger"]> = {
  PLANNED: ["programada", "warning"], APPROVED: ["aprovada", "info"], PAID: ["paga", "success"], TAKEN: ["gozada", "neutral"], CANCELLED: ["cancelada", "danger"],
};

export default async function ColaboradorPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SP }) {
  const session = await requirePerm("hr.read");
  const { id } = await params;
  const sp = await searchParams;
  const supabase = await createClient();
  const today = todayIsoSP();
  const payroll = can(session, "hr.payroll.read");
  const sensitive = can(session, "hr.sensitive");
  const canWrite = can(session, "hr.write");
  const canPayroll = can(session, "hr.payroll.write");

  const { data: e } = await supabase.schema("hr").from("employees").select("*").eq("id", id).maybeSingle();
  if (!e) notFound();
  const [{ data: party }, { data: priv }, { data: hist }, { data: deps }, { data: bens }, { data: types }, { data: periods }, { data: vacs }, { data: leaves }, { data: exams }, { data: slips }, { data: bank }] = await Promise.all([
    supabase.schema("crm").from("parties").select("display_name, birth_date").eq("id", e.party_id).maybeSingle(),
    sensitive ? supabase.schema("hr").from("employee_private").select("*").eq("employee_id", id).maybeSingle() : Promise.resolve({ data: null }),
    payroll ? supabase.schema("hr").from("salary_history").select("effective_from, amount, unit, reason").eq("employee_id", id).order("effective_from", { ascending: false }) : Promise.resolve({ data: [] as { effective_from: string; amount: number; unit: string; reason: string | null }[] }),
    sensitive ? supabase.schema("hr").from("dependents").select("id, name, birth_date, relationship, irrf, family_allowance").eq("employee_id", id) : Promise.resolve({ data: [] as { id: string; name: string; birth_date: string | null; relationship: string; irrf: boolean; family_allowance: boolean }[] }),
    payroll ? supabase.schema("hr").from("employee_benefits").select("id, value, start_date, end_date, benefit_type_id").eq("employee_id", id).order("start_date", { ascending: false }) : Promise.resolve({ data: [] as { id: string; value: number; start_date: string; end_date: string | null; benefit_type_id: string }[] }),
    supabase.schema("hr").from("benefit_types").select("id, code, name, calc").eq("active", true).order("name"),
    supabase.schema("hr").from("v_vacation_balance").select("*").eq("employee_id", id).order("period_start", { ascending: false }),
    supabase.schema("hr").from("vacations").select("*").eq("employee_id", id).order("start_date", { ascending: false }),
    supabase.schema("hr").from("leaves").select("*").eq("employee_id", id).order("start_date", { ascending: false }).limit(20),
    supabase.schema("hr").from("medical_exams").select("*").eq("employee_id", id).order("exam_date", { ascending: false }).limit(10),
    payroll ? supabase.schema("hr").from("payslips").select("id, gross, net, status, run_id").eq("employee_id", id).neq("status", "CANCELLED") : Promise.resolve({ data: [] as { id: string; gross: number; net: number; status: string; run_id: string }[] }),
    supabase.schema("hr").from("v_time_bank_balance").select("balance_min").eq("employee_id", id).maybeSingle(),
  ]);
  const runIds = [...new Set((slips ?? []).map((s) => s.run_id))];
  const { data: runs } = runIds.length ? await supabase.schema("hr").from("payroll_runs").select("id, kind, competence, description, status").in("id", runIds).order("competence", { ascending: false }) : { data: [] as { id: string; kind: string; competence: string; description: string | null; status: string }[] };
  const slipByRun = new Map((slips ?? []).map((s) => [s.run_id, s]));
  const type = new Map((types ?? []).map((t) => [t.id, t]));
  const current = (hist ?? []).find((h) => h.effective_from <= today);
  const back = `/equipe/${id}`;
  const active = e.status === "ACTIVE";
  const openPeriods = (periods ?? []).filter((p) => p.acquired && Number(p.days_left) > 0);

  return (
    <>
      <PageHeader title={party?.display_name ?? "Colaborador"} description={`${e.job_title} · matrícula ${e.registration} · admitido em ${fmtDate(e.hire_date)}${e.termination_date ? ` · desligado em ${fmtDate(e.termination_date)}` : ""}`}
        actions={<>
          <LinkButton href="/equipe">Voltar</LinkButton>
          {active && canPayroll && <LinkButton href={`/equipe/rescisoes/nova?colaborador=${id}`}>Desligar</LinkButton>}
        </>} />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Contrato">
          <dl className="space-y-1 text-sm">
            <div className="flex justify-between"><dt className="text-muted">Situação</dt><dd>{active ? <Badge tone="success">ativo</Badge> : <Badge>desligado</Badge>}</dd></div>
            <div className="flex justify-between"><dt className="text-muted">Vínculo</dt><dd>{e.contract_type}</dd></div>
            <div className="flex justify-between"><dt className="text-muted">Loja</dt><dd>{session.stores.find((s) => s.id === e.store_id)?.name ?? "—"}</dd></div>
            <div className="flex justify-between"><dt className="text-muted">Jornada</dt><dd>{e.work_regime} · {e.weekly_hours} h/sem</dd></div>
            <div className="flex justify-between"><dt className="text-muted">Ponto</dt><dd>{e.track_time ? "controlado" : "pela escala"}{e.time_bank ? " · banco de horas" : ""}</dd></div>
            <div className="flex justify-between"><dt className="text-muted">CBO</dt><dd>{e.cbo ?? "—"}</dd></div>
            {bank && <div className="flex justify-between"><dt className="text-muted">Banco de horas</dt><dd>{(Number(bank.balance_min) / 60).toFixed(1).replace(".", ",")} h</dd></div>}
            {e.experience_days.length > 0 && <div className="flex justify-between"><dt className="text-muted">Experiência</dt><dd>{e.experience_days.join(" + ")} dias</dd></div>}
          </dl>
        </Card>
        {sensitive && priv && (
          <Card title="Dados pessoais (sensíveis)">
            <dl className="space-y-1 text-sm">
              <div className="flex justify-between"><dt className="text-muted">CPF</dt><dd>{priv.cpf?.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4")}</dd></div>
              <div className="flex justify-between"><dt className="text-muted">PIS</dt><dd>{priv.pis ?? "—"}</dd></div>
              <div className="flex justify-between"><dt className="text-muted">CTPS</dt><dd>{priv.ctps ?? "—"}</dd></div>
              <div className="flex justify-between"><dt className="text-muted">Nascimento</dt><dd>{fmtDate(party?.birth_date)}</dd></div>
              <div className="flex justify-between"><dt className="text-muted">Pix</dt><dd>{priv.pix_key ?? "—"}</dd></div>
              <div className="flex justify-between"><dt className="text-muted">Banco</dt><dd>{priv.bank_code ? `${priv.bank_code} · ag ${priv.bank_agency ?? "—"} · cc ${priv.bank_account ?? "—"}` : "—"}</dd></div>
            </dl>
          </Card>
        )}
        {payroll && (
          <Card title="Remuneração">
            <p className="text-2xl font-semibold">{current ? `${formatBRL(current.amount)}${current.unit === "HOUR" ? "/h" : ""}` : "—"}</p>
            {canPayroll && active && (
              <form action={changeSalaryAction} className="mt-3 grid grid-cols-2 gap-2">
                <input type="hidden" name="employee_id" value={id} />
                <Field label="Novo salário (R$)"><input name="amount" required inputMode="decimal" className={inputClass} /></Field>
                <Field label="Vigência"><input name="effective_from" type="date" required defaultValue={today} className={inputClass} /></Field>
                <Field label="Motivo" className="col-span-2"><input name="reason" className={inputClass} placeholder="Dissídio, mérito, promoção…" /></Field>
                <div className="col-span-2"><Button variant="secondary">Reajustar</Button></div>
              </form>
            )}
            {(hist ?? []).length > 0 && (
              <ul className="mt-3 divide-y divide-border text-sm">
                {(hist ?? []).map((h) => <li key={h.effective_from} className="flex justify-between py-1"><span className="text-muted">{fmtDate(h.effective_from)} · {h.reason ?? "—"}</span><span>{formatBRL(h.amount)}</span></li>)}
              </ul>
            )}
          </Card>
        )}
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="Férias">
          {openPeriods.length === 0 && (periods ?? []).length > 0 && <p className="mb-2 text-sm text-muted">Nenhum período aquisitivo completo com saldo.</p>}
          <Table head={["Período aquisitivo", "Concessivo até", "Direito", "Saldo"]}>
            {(periods ?? []).map((p) => (
              <tr key={p.period_id}>
                <td className="px-3 py-1.5 whitespace-nowrap">{fmtDate(p.period_start)} a {fmtDate(p.period_end)}</td>
                <td className="px-3 py-1.5 whitespace-nowrap">{fmtDate(p.concessive_end)}{p.acquired && Number(p.days_left) > 0 && Number(p.days_to_expire) < 90 && <Badge tone="danger">{p.days_to_expire} d</Badge>}</td>
                <td className="px-3 py-1.5">{p.days_entitled} d{Number(p.absences) > 0 && <span className="text-xs text-muted"> ({p.absences} faltas)</span>}</td>
                <td className="px-3 py-1.5 font-medium">{p.acquired ? `${p.days_left} d` : "em aquisição"}</td>
              </tr>
            ))}
          </Table>
          {canWrite && active && openPeriods.length > 0 && (
            <form action={scheduleVacationAction} className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <input type="hidden" name="employee_id" value={id} />
              <Field label="Início"><input name="start_date" type="date" required className={inputClass} /></Field>
              <Field label="Dias"><input name="days" type="number" min={5} max={30} required defaultValue={30} className={inputClass} /></Field>
              <Field label="Vender (abono)"><input name="sell_days" type="number" min={0} max={10} defaultValue={0} className={inputClass} /></Field>
              <label className="flex items-end gap-1 pb-2 text-xs"><input type="checkbox" name="thirteenth_advance" /> 1ª parcela do 13º</label>
              <div className="col-span-2 sm:col-span-4"><Button variant="secondary">Programar férias</Button></div>
            </form>
          )}
          {(vacs ?? []).length > 0 && (
            <ul className="mt-3 space-y-2 text-sm">
              {(vacs ?? []).map((v) => (
                <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
                  <span>{fmtDate(v.start_date)} a {fmtDate(v.end_date)} · {v.days} d{v.sell_days > 0 ? ` + ${v.sell_days} vendidos` : ""}{v.double_pay && <Badge tone="danger">em dobro</Badge>} <Badge tone={VAC_STATUS[v.status][1]}>{VAC_STATUS[v.status][0]}</Badge></span>
                  <span className="flex gap-1">
                    {v.status === "PLANNED" && canWrite && <form action={approveVacationAction}><input type="hidden" name="vacation_id" value={v.id} /><input type="hidden" name="back" value={back} /><Button variant="secondary" className="px-2 py-1 text-xs">Aprovar</Button></form>}
                    {v.status === "APPROVED" && canPayroll && <form action={payVacationAction}><input type="hidden" name="vacation_id" value={v.id} /><input type="hidden" name="back" value={back} /><Button className="px-2 py-1 text-xs">Gerar recibo</Button></form>}
                    {["PLANNED", "APPROVED"].includes(v.status) && canWrite && <form action={cancelVacationAction}><input type="hidden" name="vacation_id" value={v.id} /><input type="hidden" name="back" value={back} /><Button variant="ghost" className="px-2 py-1 text-xs text-danger">Cancelar</Button></form>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Afastamentos e faltas">
          {canWrite && active && (
            <form action={addLeaveAction} className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <input type="hidden" name="employee_id" value={id} />
              <Field label="Tipo" className="col-span-2"><select name="kind" className={inputClass}>{LEAVE_KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
              <Field label="De"><input name="start_date" type="date" required className={inputClass} /></Field>
              <Field label="Até"><input name="end_date" type="date" className={inputClass} /></Field>
              <Field label="CID (opcional)"><input name="cid" className={inputClass} maxLength={10} /></Field>
              <label className="col-span-2 flex items-end gap-1 pb-2 text-xs"><input type="checkbox" name="inss_leave" /> Benefício pago pelo INSS (a partir do 16º dia)</label>
              <div className="col-span-2 sm:col-span-4"><Button variant="secondary">Registrar</Button></div>
            </form>
          )}
          {(leaves ?? []).length === 0 ? <p className="text-sm text-muted">Nenhum registro.</p> : (
            <ul className="divide-y divide-border text-sm">
              {(leaves ?? []).map((l) => <li key={l.id} className="flex justify-between gap-2 py-1.5"><span>{LEAVE_LABEL[l.kind] ?? l.kind}{l.inss_leave && <Badge tone="info">INSS</Badge>}</span><span className="text-muted">{fmtDate(l.start_date)}{l.end_date !== l.start_date ? ` a ${fmtDate(l.end_date)}` : ""}</span></li>)}
            </ul>
          )}
          <h3 className="mt-4 text-xs font-semibold text-muted">Exames ocupacionais (ASO)</h3>
          {canWrite && (
            <form action={addExamAction} className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <input type="hidden" name="employee_id" value={id} />
              <Field label="Tipo"><select name="kind" className={inputClass}><option value="ADMISSION">Admissional</option><option value="PERIODIC">Periódico</option><option value="RETURN_TO_WORK">Retorno ao trabalho</option><option value="CHANGE_OF_ROLE">Mudança de função</option><option value="DISMISSAL">Demissional</option></select></Field>
              <Field label="Realizado em"><input name="exam_date" type="date" required defaultValue={today} className={inputClass} /></Field>
              <Field label="Válido até"><input name="valid_until" type="date" className={inputClass} /></Field>
              <div className="self-end"><Button variant="secondary">Registrar</Button></div>
            </form>
          )}
          <ul className="mt-2 divide-y divide-border text-sm">
            {(exams ?? []).map((x) => <li key={x.id} className="flex justify-between py-1"><span>{x.kind}</span><span className={x.valid_until && x.valid_until < today ? "text-danger" : "text-muted"}>{fmtDate(x.exam_date)}{x.valid_until ? ` · válido até ${fmtDate(x.valid_until)}` : ""}</span></li>)}
          </ul>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        {sensitive && (
          <Card title="Dependentes">
            {(deps ?? []).length === 0 ? <p className="text-sm text-muted">Sem dependentes cadastrados.</p> : (
              <ul className="divide-y divide-border text-sm">
                {(deps ?? []).map((d) => (
                  <li key={d.id} className="flex items-center justify-between gap-2 py-1.5">
                    <span>{d.name} <span className="text-xs text-muted">{fmtDate(d.birth_date)}</span> {d.irrf && <Badge tone="brand">IRRF</Badge>} {d.family_allowance && <Badge tone="info">sal.-família</Badge>}</span>
                    {canWrite && <form action={removeDependentAction}><input type="hidden" name="employee_id" value={id} /><input type="hidden" name="dependent_id" value={d.id} /><Button variant="ghost" className="px-2 py-1 text-xs text-danger">remover</Button></form>}
                  </li>
                ))}
              </ul>
            )}
            {canWrite && (
              <form action={addDependentAction} className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                <input type="hidden" name="employee_id" value={id} />
                <Field label="Nome" className="col-span-2"><input name="name" required className={inputClass} /></Field>
                <Field label="Nascimento"><input name="birth_date" type="date" className={inputClass} /></Field>
                <Field label="Parentesco"><select name="relationship" className={inputClass}><option>FILHO</option><option>CONJUGE</option><option>PAI/MAE</option><option>OUTRO</option></select></Field>
                <label className="flex items-center gap-1 text-xs"><input type="checkbox" name="irrf" defaultChecked /> Deduz no IRRF</label>
                <label className="flex items-center gap-1 text-xs"><input type="checkbox" name="family_allowance" /> Salário-família</label>
                <div className="col-span-2"><Button variant="secondary">Adicionar</Button></div>
              </form>
            )}
          </Card>
        )}
        {payroll && (
          <Card title="Benefícios">
            {(bens ?? []).length === 0 ? <p className="text-sm text-muted">Nenhum benefício.</p> : (
              <ul className="divide-y divide-border text-sm">
                {(bens ?? []).map((b) => (
                  <li key={b.id} className="flex items-center justify-between gap-2 py-1.5">
                    <span>{type.get(b.benefit_type_id)?.name} · {formatBRL(b.value)}{type.get(b.benefit_type_id)?.calc === "DAILY" ? "/dia" : type.get(b.benefit_type_id)?.calc === "PCT_SALARY" ? "%" : "/mês"} {b.end_date ? <Badge>até {fmtDate(b.end_date)}</Badge> : <Badge tone="success">vigente</Badge>}</span>
                    {canPayroll && !b.end_date && <form action={endBenefitAction}><input type="hidden" name="employee_id" value={id} /><input type="hidden" name="benefit_id" value={b.id} /><Button variant="ghost" className="px-2 py-1 text-xs">encerrar</Button></form>}
                  </li>
                ))}
              </ul>
            )}
            {canPayroll && active && (
              <form action={addBenefitAction} className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                <input type="hidden" name="employee_id" value={id} />
                <Field label="Benefício" className="col-span-2"><select name="benefit_type_id" className={inputClass}>{(types ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
                <Field label="Valor (R$)"><input name="value" required inputMode="decimal" className={inputClass} /></Field>
                <Field label="A partir de"><input name="start_date" type="date" defaultValue={today} className={inputClass} /></Field>
                <div className="col-span-2"><Button variant="secondary">Adicionar</Button></div>
              </form>
            )}
          </Card>
        )}
      </div>

      {payroll && (
        <div className="mt-4">
          <Card title="Holerites e pagamentos">
            {(runs ?? []).length === 0 ? <Empty title="Sem folhas" /> : (
              <Table head={["Competência", "Folha", "Bruto", "Líquido", "Situação", ""]}>
                {(runs ?? []).map((r) => {
                  const s = slipByRun.get(r.id)!;
                  return (
                    <tr key={r.id}>
                      <td className="px-3 py-1.5">{fmtMonth(r.competence)}</td>
                      <td className="px-3 py-1.5"><Link className="text-brand" href={`/equipe/folha/${r.id}`}>{r.description ?? r.kind}</Link></td>
                      <td className="px-3 py-1.5">{formatBRL(s.gross)}</td><td className="px-3 py-1.5 font-medium">{formatBRL(s.net)}</td>
                      <td className="px-3 py-1.5"><Badge tone={s.status === "PAID" ? "success" : s.status === "APPROVED" ? "info" : "warning"}>{s.status === "PAID" ? "paga" : s.status === "APPROVED" ? "aprovada" : "rascunho"}</Badge></td>
                      <td className="px-3 py-1.5"><Link className="text-brand" href={`/equipe/holerite/${s.id}`}>ver holerite</Link></td>
                    </tr>
                  );
                })}
              </Table>
            )}
          </Card>
        </div>
      )}
    </>
  );
}
