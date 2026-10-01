import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, todayIsoSP, type SP } from "@/lib/context";
import { Badge, Button, Card, Empty, inputClass, PageHeader } from "@/components/ui";
import { Field, Flash, fmtDate, fmtMonth } from "@/components/form";
import { copyRosterAction, publishRosterAction } from "../actions";
import { RosterGrid, type Cell, type GridDay } from "./roster-grid";

export const metadata = { title: "Escalas" };

const addMonth = (ym: string, n: number) => {
  const d = new Date(`${ym}-01T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 7);
};

export default async function EscalasPage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("hr.read");
  const sp = await searchParams;
  const supabase = await createClient();
  const canEdit = can(session, "hr.write");
  const store = str(sp.loja) ?? session.storeId ?? session.stores[0]?.id;
  const ym = str(sp.mes) ?? todayIsoSP().slice(0, 7);
  if (!store) return (<><PageHeader title="Escalas" /><Empty title="Cadastre uma loja para montar a escala" /></>);

  const from = `${ym}-01`;
  const last = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate();
  const to = `${ym}-${String(last).padStart(2, "0")}`;

  const [{ data: emps }, { data: roster }, { data: shifts }, { data: holidays }, { data: vacs }, { data: leaves }, { data: issues }, { data: rules }] = await Promise.all([
    supabase.schema("hr").from("employees").select("id, party_id, job_title, hire_date").eq("store_id", store).eq("status", "ACTIVE").neq("contract_type", "PRO_LABORE").order("hire_date"),
    supabase.schema("hr").from("roster").select("employee_id, work_date, kind, shift_id, status, start_time, end_time, break_minutes, notes").eq("store_id", store).gte("work_date", from).lte("work_date", to),
    supabase.schema("hr").from("shift_templates").select("id, code, name, color, start_time, end_time, break_minutes").eq("active", true).or(`store_id.is.null,store_id.eq.${store}`).order("start_time"),
    supabase.schema("hr").from("holidays").select("holiday_date, name, optional").gte("holiday_date", from).lte("holiday_date", to),
    supabase.schema("hr").from("vacations").select("employee_id, start_date, end_date").in("status", ["APPROVED", "PAID", "TAKEN"]).lte("start_date", to).gte("end_date", from),
    supabase.schema("hr").from("leaves").select("employee_id, start_date, end_date").lte("start_date", to).gte("end_date", from),
    supabase.schema("hr").rpc("validate_roster", { p_store: store, p_from: from, p_to: to }),
    supabase.schema("hr").from("coverage_rules").select("weekday, label, start_time, end_time, min_staff").eq("store_id", store),
  ]);
  const partyIds = (emps ?? []).map((e) => e.party_id);
  const { data: parties } = partyIds.length ? await supabase.schema("crm").from("parties").select("id, display_name").in("id", partyIds) : { data: [] as { id: string; display_name: string }[] };
  const pname = new Map((parties ?? []).map((p) => [p.id, p.display_name]));
  const employees = (emps ?? []).map((e) => ({ id: e.id, name: pname.get(e.party_id) ?? "—", job: e.job_title }));

  const days: GridDay[] = Array.from({ length: last }, (_, i) => {
    const date = `${ym}-${String(i + 1).padStart(2, "0")}`;
    return { date, day: i + 1, dow: new Date(`${date}T12:00:00Z`).getUTCDay(), holiday: (holidays ?? []).find((h) => h.holiday_date === date)?.name ?? null };
  });
  const cells: Record<string, Record<string, Cell>> = {};
  for (const r of roster ?? []) (cells[r.employee_id] ??= {})[r.work_date] = { kind: r.kind as Cell["kind"], shiftId: r.shift_id, status: r.status as Cell["status"], start: r.start_time?.slice(0, 5) ?? null, end: r.end_time?.slice(0, 5) ?? null, breakMin: r.break_minutes, notes: r.notes };
  const blocks: Record<string, Record<string, string>> = {};
  for (const d of days) {
    for (const v of vacs ?? []) if (d.date >= v.start_date && d.date <= v.end_date) (blocks[v.employee_id] ??= {})[d.date] = "VAC";
    for (const l of leaves ?? []) if (d.date >= l.start_date && d.date <= l.end_date) (blocks[l.employee_id] ??= {})[d.date] = "LEAVE";
    for (const e of emps ?? []) if (d.date < e.hire_date) (blocks[e.id] ??= {})[d.date] = "PRE";
  }
  const name = new Map(employees.map((e) => [e.id, e.name]));
  const errors = (issues ?? []).filter((i) => i.severity === "ERROR");
  const warns = (issues ?? []).filter((i) => i.severity === "WARN");
  const draft = (roster ?? []).filter((r) => r.status === "DRAFT").length;
  const q = (extra: Record<string, string>) => `/equipe/escalas?${new URLSearchParams({ loja: store, mes: ym, ...extra })}`;
  const back = q({});

  return (
    <>
      <PageHeader title="Escalas" description="Monte a escala mensal por loja com turnos prontos ou qualquer horário num dia. O sistema confere descanso de 11h, sete dias seguidos, intervalo, jornada e a cobertura dos horários de pico antes de publicar."
        actions={<Link href={`/equipe/escalas/turnos?loja=${store}`} className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-surface-2">Turnos e picos</Link>} />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Link className="rounded-lg border border-border px-2 py-1 text-sm hover:bg-surface-2" href={q({ mes: addMonth(ym, -1) })}>← {fmtMonth(`${addMonth(ym, -1)}-01`)}</Link>
        <b className="px-2">{fmtMonth(from)}</b>
        <Link className="rounded-lg border border-border px-2 py-1 text-sm hover:bg-surface-2" href={q({ mes: addMonth(ym, 1) })}>{fmtMonth(`${addMonth(ym, 1)}-01`)} →</Link>
        {session.stores.length > 1 && (
          <form className="ml-auto flex items-center gap-1"><input type="hidden" name="mes" value={ym} />
            <select name="loja" defaultValue={store} className="rounded-lg border border-border bg-surface px-2 py-1 text-sm" aria-label="Loja">{session.stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
            <Button variant="secondary" className="px-2 py-1 text-xs">Ver</Button></form>
        )}
      </div>

      {employees.length === 0 ? <Empty title="Nenhum colaborador nesta loja">Admita colaboradores e vincule-os à loja.</Empty> : (
        <RosterGrid employees={employees} days={days} cells={cells} blocks={blocks} canEdit={canEdit}
          shifts={(shifts ?? []).map((s) => ({ id: s.id, code: s.code, name: `${s.name} ${s.start_time.slice(0, 5)}–${s.end_time.slice(0, 5)}`, color: s.color, start: s.start_time.slice(0, 5), end: s.end_time.slice(0, 5), breakMin: s.break_minutes }))} />
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card title={`Conformidade (${errors.length} erro(s), ${warns.length} alerta(s))`} className="lg:col-span-2">
          {(issues ?? []).length === 0 ? <p className="text-sm text-success">Escala em conformidade com as regras conferidas.</p> : (
            <ul className="max-h-72 space-y-1 overflow-y-auto text-sm">
              {[...errors, ...warns].map((i, k) => (
                <li key={k} className="flex gap-2">
                  <Badge tone={i.severity === "ERROR" ? "danger" : "warning"}>{i.severity === "ERROR" ? "erro" : "alerta"}</Badge>
                  <span><b>{fmtDate(i.work_date)}</b>{i.employee_id ? ` · ${name.get(i.employee_id) ?? ""}` : ""} — {i.message}</span>
                </li>
              ))}
            </ul>
          )}
          {(rules ?? []).length > 0 && <p className="mt-2 text-xs text-muted">Cobertura mínima: {(rules ?? []).filter((r, i, a) => a.findIndex((x) => x.label === r.label) === i).map((r) => `${r.label} ${r.start_time.slice(0, 5)}–${r.end_time.slice(0, 5)} (${r.min_staff} pessoas)`).join(" · ")}</p>}
        </Card>
        {canEdit && (
          <Card title="Ações">
            <form action={publishRosterAction} className="mb-3">
              <input type="hidden" name="store" value={store} /><input type="hidden" name="from" value={from} /><input type="hidden" name="to" value={to} /><input type="hidden" name="back" value={back} />
              <Button disabled={errors.length > 0 || draft === 0}>Publicar escala do mês ({draft} pendente(s))</Button>
              {errors.length > 0 && <p className="mt-1 text-xs text-danger">Corrija os erros para publicar.</p>}
            </form>
            <form action={copyRosterAction} className="space-y-2">
              <input type="hidden" name="store" value={store} /><input type="hidden" name="back" value={back} /><input type="hidden" name="days" value="7" />
              <Field label="Copiar a semana que começa em"><input name="source_from" type="date" required defaultValue={from} className={inputClass} /></Field>
              <Field label="para a semana que começa em"><input name="target_from" type="date" required className={inputClass} /></Field>
              <Button variant="secondary">Copiar 7 dias</Button>
            </form>
          </Card>
        )}
      </div>
    </>
  );
}
