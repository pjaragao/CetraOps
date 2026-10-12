import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { can, getSession } from "@/lib/session";
import { addDaysIsoSP, str, todayIsoSP, type SP } from "@/lib/context";
import { Badge, Button, Card, cn, Empty, inputClass, PageHeader } from "@/components/ui";
import { Field, Flash, fmtDate } from "@/components/form";
import { deleteExceptionAction, saveExceptionAction, saveStoreHoursAction } from "./actions";

export const metadata = { title: "Horário das lojas" };

const DAYS = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];
const SHORT = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const ORDER = [1, 2, 3, 4, 5, 6, 0];

interface CalDay { day: string; hours: [string, string][]; staff: { start: string; end: string }[]; exception: string | null; closed_exception: boolean }

/** Horário de funcionamento por loja (semana + datas especiais) e, ao lado, a escala dos próximos 14 dias contra esse horário. */
export default async function HorariosPage({ searchParams }: { searchParams: SP }) {
  // quem administra edita; quem cuida da escala ou vende consulta
  const session = await getSession();
  if (!["core.admin", "core.read", "hr.read", "sales.read"].some((p) => can(session, p))) redirect("/inicio?erro=sem-permissao");
  const sp = await searchParams;
  const supabase = await createClient();
  const isAdmin = can(session, "core.admin");
  const store = session.stores.find((s) => s.id === (str(sp.loja) ?? session.storeId)) ?? session.stores[0];
  if (!store) return (<><PageHeader title="Horário das lojas" /><Empty title="Cadastre uma loja primeiro" /></>);

  const from = todayIsoSP(), to = addDaysIsoSP(13);
  const [{ data: st }, { data: exceptions }, { data: cal }, { data: issues }] = await Promise.all([
    supabase.schema("core").from("stores").select("id, name, business_hours").eq("id", store.id).maybeSingle(),
    supabase.schema("core").from("store_hours_exceptions").select("id, day, closed, hours, note").eq("store_id", store.id).gte("day", from).order("day"),
    supabase.schema("core").rpc("store_calendar", { p_store: store.id, p_from: from, p_to: to }),
    can(session, "hr.read") ? supabase.schema("hr").rpc("validate_roster", { p_store: store.id, p_from: from, p_to: to }) : Promise.resolve({ data: [] as never[] }),
  ]);
  const days = ((st?.business_hours as { days?: Record<string, [string, string][]> } | null)?.days) ?? {};
  const configured = Object.keys(days).length > 0;
  const calendar = (cal ?? []) as unknown as CalDay[];
  const byDay = new Map<string, string[]>();
  for (const i of (issues ?? []) as { work_date: string; code: string; message: string }[]) {
    if (i.code === "STORE_UNCOVERED" || i.code === "OUTSIDE_STORE_HOURS" || i.code === "COVERAGE") byDay.set(i.work_date, [...(byDay.get(i.work_date) ?? []), i.message]);
  }

  return (
    <>
      <PageHeader title="Horário das lojas"
        description="O horário de funcionamento vale para a escala (avisa loja aberta sem ninguém e turno fora do horário), para o atendimento (canais sem horário próprio usam o da loja) e para a rotina de abertura e fechamento."
        actions={can(session, "hr.read") ? <Link href={`/equipe/escalas?loja=${store.id}`} className="rounded-lg border border-border px-3 py-2 text-sm hover:bg-surface-2">Abrir a escala</Link> : undefined} />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      {session.stores.length > 1 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {session.stores.map((s) => <Link key={s.id} href={`/configuracoes/horarios?loja=${s.id}`} className={cn("rounded-lg border px-3 py-1.5 text-sm", s.id === store.id ? "border-brand bg-brand/10 text-brand" : "border-border")}>{s.name}</Link>)}
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        <Card title={`Semana · ${st?.name ?? store.name}${configured ? "" : " (ainda sem horário)"}`}>
          <form action={saveStoreHoursAction} className="space-y-2">
            <input type="hidden" name="store_id" value={store.id} />
            {ORDER.map((d) => {
              const iv = days[String(d)] ?? [];
              return (
                <div key={d} className="grid items-center gap-2 sm:grid-cols-[6rem_auto_auto]">
                  <span className="text-sm font-medium">{DAYS[d]}</span>
                  <span className="flex items-center gap-1 text-xs text-muted">
                    <input type="time" name={`s1_${d}`} defaultValue={iv[0]?.[0] ?? ""} disabled={!isAdmin} aria-label={`${DAYS[d]}: abre`} className={`${inputClass} w-28`} />–
                    <input type="time" name={`e1_${d}`} defaultValue={iv[0]?.[1] ?? ""} disabled={!isAdmin} aria-label={`${DAYS[d]}: fecha`} className={`${inputClass} w-28`} />
                  </span>
                  <span className="flex items-center gap-1 text-xs text-muted">e
                    <input type="time" name={`s2_${d}`} defaultValue={iv[1]?.[0] ?? ""} disabled={!isAdmin} aria-label={`${DAYS[d]}: reabre`} className={`${inputClass} w-28`} />–
                    <input type="time" name={`e2_${d}`} defaultValue={iv[1]?.[1] ?? ""} disabled={!isAdmin} aria-label={`${DAYS[d]}: fecha de novo`} className={`${inputClass} w-28`} />
                    {configured && iv.length === 0 && <span className="ml-1">fechado</span>}
                  </span>
                </div>
              );
            })}
            <p className="text-xs text-muted">Dia em branco = fechado. A segunda faixa é opcional (fecha no almoço). A academia parceira manda o horário dela: use o mesmo ou um recorte dele.</p>
            {isAdmin && <Button>Salvar horário</Button>}
          </form>
        </Card>

        <Card title="Datas especiais (feriados, eventos, Black Friday)">
          {(exceptions ?? []).length === 0 ? <p className="mb-3 text-sm text-muted">Nenhuma data especial daqui para frente.</p> : (
            <ul className="mb-3 divide-y divide-border text-sm">
              {(exceptions ?? []).map((x) => (
                <li key={x.id} className="flex items-center justify-between gap-2 py-1.5">
                  <span>{fmtDate(x.day)} ({SHORT[new Date(`${x.day}T12:00:00Z`).getUTCDay()]}) · {x.closed ? <Badge tone="warning">fechada</Badge> : (x.hours as [string, string][]).map((h) => h.join("–")).join(", ")}{x.note ? <span className="text-muted"> · {x.note}</span> : null}</span>
                  {isAdmin && <form action={deleteExceptionAction}><input type="hidden" name="store_id" value={store.id} /><input type="hidden" name="id" value={x.id} /><Button variant="ghost" className="px-2 py-1 text-xs">remover</Button></form>}
                </li>
              ))}
            </ul>
          )}
          {isAdmin && (
            <form action={saveExceptionAction} className="grid gap-2 sm:grid-cols-2">
              <input type="hidden" name="store_id" value={store.id} />
              <Field label="Data"><input type="date" name="day" required min={from} className={inputClass} /></Field>
              <Field label="Nesse dia a loja"><select name="mode" className={inputClass}><option value="closed">fica fechada</option><option value="special">abre em horário especial</option></select></Field>
              <Field label="Abre (horário especial)"><input type="time" name="s" className={inputClass} /></Field>
              <Field label="Fecha (horário especial)"><input type="time" name="e" className={inputClass} /></Field>
              <Field label="Motivo" className="sm:col-span-2"><input name="note" maxLength={120} className={inputClass} placeholder="Ex.: Finados · Inauguração · Black Friday" /></Field>
              <div><Button variant="secondary">Adicionar data</Button></div>
            </form>
          )}
        </Card>
      </div>

      <Card className="mt-4" title="Próximos 14 dias: horário × escala">
        {!configured ? <p className="text-sm text-muted">Cadastre o horário da semana para conferir a escala contra ele.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-muted"><tr><th className="py-1 text-left">Dia</th><th className="py-1 text-left">Loja</th><th className="py-1 text-left">Escalados</th><th className="py-1 text-left">Avisos</th></tr></thead>
              <tbody className="divide-y divide-border">
                {calendar.map((c) => {
                  const warn = byDay.get(c.day) ?? [];
                  return (
                    <tr key={c.day}>
                      <td className="py-1.5 whitespace-nowrap">{fmtDate(c.day)} <span className="text-muted">{SHORT[new Date(`${c.day}T12:00:00Z`).getUTCDay()]}</span></td>
                      <td className="py-1.5">{c.hours.length ? c.hours.map((h) => h.join("–")).join(", ") : <span className="text-muted">fechada</span>}{c.exception && <span className="block text-xs text-muted">{c.exception}</span>}</td>
                      <td className="py-1.5">{c.staff.length ? c.staff.map((s) => `${s.start}–${s.end}`).join(", ") : <span className="text-muted">ninguém</span>}</td>
                      <td className="py-1.5">{warn.length ? <ul className="text-xs text-warning">{[...new Set(warn)].map((w) => <li key={w}>{w}</li>)}</ul> : <span className="text-xs text-success">ok</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
