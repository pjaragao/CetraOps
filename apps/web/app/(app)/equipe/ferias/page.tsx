import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, todayIsoSP, type SP } from "@/lib/context";
import { Badge, Button, Card, Empty, inputClass, PageHeader, Table } from "@/components/ui";
import { Field, Flash, fmtDate } from "@/components/form";
import { approveVacationAction, cancelVacationAction, payVacationAction, scheduleVacationAction } from "../actions";

export const metadata = { title: "Férias" };

const STATUS: Record<string, [string, "neutral" | "info" | "success" | "warning" | "danger"]> = {
  PLANNED: ["programada", "warning"], APPROVED: ["aprovada", "info"], PAID: ["paga", "success"], TAKEN: ["gozada", "neutral"], CANCELLED: ["cancelada", "danger"],
};

export default async function FeriasPage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("hr.read");
  const sp = await searchParams;
  const supabase = await createClient();
  const canWrite = can(session, "hr.write");
  const canPayroll = can(session, "hr.payroll.write");
  const today = todayIsoSP();

  const [{ data: emps }, { data: bal }, { data: vacs }] = await Promise.all([
    supabase.schema("hr").from("employees").select("id, party_id").eq("status", "ACTIVE").in("contract_type", ["CLT", "INTERMITENTE", "TEMPORARIO"]),
    supabase.schema("hr").from("v_vacation_balance").select("*").order("days_to_expire"),
    supabase.schema("hr").from("vacations").select("*").neq("status", "CANCELLED").gte("end_date", today).order("start_date"),
  ]);
  const partyIds = (emps ?? []).map((e) => e.party_id);
  const { data: parties } = partyIds.length ? await supabase.schema("crm").from("parties").select("id, display_name").in("id", partyIds) : { data: [] as { id: string; display_name: string }[] };
  const pname = new Map((parties ?? []).map((p) => [p.id, p.display_name]));
  const name = new Map((emps ?? []).map((e) => [e.id, pname.get(e.party_id) ?? "—"]));
  const active = new Set((emps ?? []).map((e) => e.id));
  const due = (bal ?? []).filter((b) => b.acquired && Number(b.days_left) > 0 && active.has(b.employee_id!));

  return (
    <>
      <PageHeader title="Férias" description="Períodos aquisitivos e concessivos, fracionamento em até 3 partes (uma de 14+ dias), abono de 1/3, vedação de início antes de feriado ou repouso e pagamento em dobro fora do prazo." />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Saldo a conceder">
          {due.length === 0 ? <p className="text-sm text-muted">Nenhum colaborador com férias vencidas ou a vencer.</p> : (
            <Table head={["Colaborador", "Direito", "Saldo", "Prazo concessivo"]}>
              {due.map((b) => (
                <tr key={b.period_id ?? ""}>
                  <td className="px-3 py-1.5"><Link className="text-brand" href={`/equipe/${b.employee_id}`}>{name.get(b.employee_id!)}</Link></td>
                  <td className="px-3 py-1.5">{b.days_entitled} d</td><td className="px-3 py-1.5 font-medium">{b.days_left} d</td>
                  <td className="px-3 py-1.5 whitespace-nowrap">{fmtDate(b.concessive_end)} <Badge tone={Number(b.days_to_expire) < 60 ? "danger" : "warning"}>{b.days_to_expire} d</Badge></td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
        {canWrite && (
          <Card title="Programar férias">
            <form action={scheduleVacationAction} className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <input type="hidden" name="back" value="/equipe/ferias" />
              <Field label="Colaborador" className="col-span-2"><select name="employee_id" className={inputClass}>{(emps ?? []).map((e) => <option key={e.id} value={e.id}>{name.get(e.id)}</option>)}</select></Field>
              <Field label="Início"><input name="start_date" type="date" required className={inputClass} /></Field>
              <Field label="Dias"><input name="days" type="number" min={5} max={30} defaultValue={30} className={inputClass} /></Field>
              <Field label="Vender (abono)"><input name="sell_days" type="number" min={0} max={10} defaultValue={0} className={inputClass} /></Field>
              <label className="col-span-2 flex items-end gap-1 pb-2 text-xs"><input type="checkbox" name="thirteenth_advance" /> Antecipar a 1ª parcela do 13º</label>
              <div className="col-span-2 sm:col-span-4"><Button variant="secondary">Programar</Button></div>
            </form>
            <p className="mt-2 text-xs text-muted">O sistema recusa: início nos 2 dias antes de feriado/domingo, parte com menos de 5 dias, mais de 3 partes, saldo insuficiente e sobreposição com afastamento.</p>
          </Card>
        )}
      </div>

      <h2 className="mt-6 mb-2 text-sm font-semibold text-muted">Próximas férias</h2>
      {(vacs ?? []).length === 0 ? <Empty title="Nenhuma férias programada" /> : (
        <Table head={["Colaborador", "Período", "Dias", "Pagamento até", "Situação", ""]}>
          {(vacs ?? []).map((v) => (
            <tr key={v.id}>
              <td className="px-3 py-2"><Link className="text-brand" href={`/equipe/${v.employee_id}`}>{name.get(v.employee_id) ?? "—"}</Link></td>
              <td className="px-3 py-2 whitespace-nowrap">{fmtDate(v.start_date)} a {fmtDate(v.end_date)}</td>
              <td className="px-3 py-2">{v.days}{v.sell_days > 0 ? ` + ${v.sell_days} vendidos` : ""}{v.double_pay && <Badge tone="danger">em dobro</Badge>}</td>
              <td className="px-3 py-2 whitespace-nowrap">{fmtDate(v.pay_date)}</td>
              <td className="px-3 py-2"><Badge tone={STATUS[v.status][1]}>{STATUS[v.status][0]}</Badge></td>
              <td className="px-3 py-2">
                <div className="flex gap-1">
                  {v.status === "PLANNED" && canWrite && <form action={approveVacationAction}><input type="hidden" name="vacation_id" value={v.id} /><Button variant="secondary" className="px-2 py-1 text-xs">Aprovar</Button></form>}
                  {v.status === "APPROVED" && canPayroll && <form action={payVacationAction}><input type="hidden" name="vacation_id" value={v.id} /><Button className="px-2 py-1 text-xs">Gerar recibo</Button></form>}
                  {["PLANNED", "APPROVED"].includes(v.status) && canWrite && <form action={cancelVacationAction}><input type="hidden" name="vacation_id" value={v.id} /><Button variant="ghost" className="px-2 py-1 text-xs text-danger">Cancelar</Button></form>}
                </div>
              </td>
            </tr>
          ))}
        </Table>
      )}
    </>
  );
}
