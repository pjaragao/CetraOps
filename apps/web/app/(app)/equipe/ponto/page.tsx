import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, todayIsoSP, type SP } from "@/lib/context";
import { Badge, Button, Card, Empty, inputClass, PageHeader, Table } from "@/components/ui";
import { Field, Flash, fmtDate, fmtMonth } from "@/components/form";
import { addTimeEntryAction, closeTimesheetsAction, reopenTimesheetAction } from "../actions";

export const metadata = { title: "Ponto e banco de horas" };

const hm = (min: number) => `${Math.floor(min / 60)}h${String(min % 60).padStart(2, "0")}`;

export default async function PontoPage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("hr.read");
  const sp = await searchParams;
  const supabase = await createClient();
  const canWrite = can(session, "hr.write");
  const ym = str(sp.mes) ?? todayIsoSP().slice(0, 7);
  const comp = `${ym}-01`;

  const [{ data: emps }, { data: sheets }, { data: bank }, { data: entities }, { data: entries }] = await Promise.all([
    supabase.schema("hr").from("employees").select("id, party_id, legal_entity_id, track_time, time_bank").eq("status", "ACTIVE").neq("contract_type", "PRO_LABORE").order("hire_date"),
    supabase.schema("hr").from("timesheets").select("*").eq("competence", comp),
    supabase.schema("hr").from("v_time_bank_balance").select("employee_id, balance_min"),
    supabase.schema("core").from("legal_entities").select("id, razao_social, nome_fantasia"),
    supabase.schema("hr").from("time_entries").select("employee_id, work_date, start_time, end_time, break_minutes").gte("work_date", comp).lte("work_date", `${ym}-31`).order("work_date", { ascending: false }).limit(40),
  ]);
  const partyIds = (emps ?? []).map((e) => e.party_id);
  const { data: parties } = partyIds.length ? await supabase.schema("crm").from("parties").select("id, display_name").in("id", partyIds) : { data: [] as { id: string; display_name: string }[] };
  const pname = new Map((parties ?? []).map((p) => [p.id, p.display_name]));
  const sheet = new Map((sheets ?? []).map((s) => [s.employee_id, s]));
  const bal = new Map((bank ?? []).map((b) => [b.employee_id, Number(b.balance_min)]));
  const nameOf = new Map((emps ?? []).map((e) => [e.id, pname.get(e.party_id) ?? "—"]));
  const closed = (sheets ?? []).filter((s) => s.status === "CLOSED").length;
  const entity = (emps ?? [])[0]?.legal_entity_id ?? (entities ?? [])[0]?.id;

  return (
    <>
      <PageHeader title="Ponto e banco de horas" description="O espelho do mês reúne horas extras (50% e 100%), adicional noturno com hora reduzida, faltas, atrasos e DSR perdido — e alimenta a folha. Sem ponto controlado, a escala publicada vale como ponto." />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />

      <div className="mb-4 flex flex-wrap items-end gap-2">
        <form className="flex items-end gap-2">
          <Field label="Competência"><input name="mes" type="month" defaultValue={ym} className={inputClass} /></Field>
          <Button variant="secondary">Ver</Button>
        </form>
        <span className="ml-auto text-sm text-muted">{fmtMonth(comp)}: {closed} de {(emps ?? []).length} espelhos fechados</span>
        {canWrite && entity && (
          <form action={closeTimesheetsAction} className="flex items-center gap-2">
            <input type="hidden" name="entity" value={entity} /><input type="hidden" name="competence" value={comp} /><input type="hidden" name="mes" value={ym} /><input type="hidden" name="force" value="1" />
            <Button>Fechar / recalcular todos</Button>
          </form>
        )}
      </div>

      {(emps ?? []).length === 0 ? <Empty title="Nenhum colaborador ativo" /> : (
        <Table head={["Colaborador", "Normais", "Extras 50%", "Extras 100%", "Noturno", "Faltas", "Atrasos", "DSR perdido", "Banco de horas", "Situação", ""]}>
          {(emps ?? []).map((e) => {
            const s = sheet.get(e.id);
            return (
              <tr key={e.id}>
                <td className="px-3 py-2"><Link className="font-medium text-brand" href={`/equipe/${e.id}`}>{nameOf.get(e.id)}</Link>{e.track_time && <Badge tone="brand">ponto</Badge>}</td>
                <td className="px-3 py-2">{s ? hm(s.regular_min) : "—"}</td><td className="px-3 py-2">{s ? hm(s.ot50_min) : "—"}</td><td className="px-3 py-2">{s ? hm(s.ot100_min) : "—"}</td>
                <td className="px-3 py-2">{s ? hm(s.night_min) : "—"}</td><td className={`px-3 py-2 ${s && s.absence_days > 0 ? "text-danger" : ""}`}>{s ? s.absence_days : "—"}</td>
                <td className="px-3 py-2">{s ? hm(s.late_min) : "—"}</td><td className="px-3 py-2">{s ? s.dsr_lost_days : "—"}</td>
                <td className="px-3 py-2">{e.time_bank ? hm(bal.get(e.id) ?? 0) : "—"}</td>
                <td className="px-3 py-2">{s?.status === "CLOSED" ? <Badge tone="success">fechado</Badge> : <Badge tone="warning">aberto</Badge>}</td>
                <td className="px-3 py-2">{canWrite && s?.status === "CLOSED" && <form action={reopenTimesheetAction}><input type="hidden" name="timesheet_id" value={s.id} /><input type="hidden" name="mes" value={ym} /><Button variant="ghost" className="px-2 py-1 text-xs">reabrir</Button></form>}</td>
              </tr>
            );
          })}
        </Table>
      )}

      {canWrite && (
        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          <Card title="Registrar marcação (colaboradores com ponto controlado)">
            <form action={addTimeEntryAction} className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              <Field label="Colaborador" className="col-span-2"><select name="employee_id" className={inputClass}>{(emps ?? []).filter((e) => e.track_time).map((e) => <option key={e.id} value={e.id}>{nameOf.get(e.id)}</option>)}</select></Field>
              <Field label="Dia"><input name="work_date" type="date" required defaultValue={todayIsoSP()} className={inputClass} /></Field>
              <Field label="Entrada"><input name="start_time" type="time" required className={inputClass} /></Field>
              <Field label="Saída"><input name="end_time" type="time" required className={inputClass} /></Field>
              <Field label="Intervalo (min)"><input name="break_minutes" type="number" min={0} defaultValue={60} className={inputClass} /></Field>
              <div className="self-end"><Button variant="secondary">Registrar</Button></div>
            </form>
            <p className="mt-2 text-xs text-muted">Para colaboradores sem ponto controlado, a escala publicada já conta como jornada cumprida. Faltas entram como “Falta injustificada” na ficha.</p>
          </Card>
          <Card title="Últimas marcações do mês">
            {(entries ?? []).length === 0 ? <p className="text-sm text-muted">Nenhuma marcação manual.</p> : (
              <ul className="divide-y divide-border text-sm">{(entries ?? []).map((t, i) => <li key={i} className="flex justify-between py-1"><span>{nameOf.get(t.employee_id)}</span><span className="text-muted">{fmtDate(t.work_date)} · {t.start_time.slice(0, 5)}–{t.end_time.slice(0, 5)} (int. {t.break_minutes} min)</span></li>)}</ul>
            )}
          </Card>
        </div>
      )}
    </>
  );
}
