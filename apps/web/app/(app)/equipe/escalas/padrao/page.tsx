import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, todayIsoSP, type SP } from "@/lib/context";
import { Button, Card, Empty, PageHeader } from "@/components/ui";
import { Flash } from "@/components/form";
import { applyPatternsAction } from "../../actions";
import { PatternRow } from "./pattern-row";

export const metadata = { title: "Escala semanal padrão" };

export default async function PadraoPage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("hr.read");
  const sp = await searchParams;
  const canEdit = can(session, "hr.write");
  const store = str(sp.loja) ?? session.storeId ?? session.stores[0]?.id;
  if (!store) return (<><PageHeader title="Escala semanal padrão" /><Empty title="Cadastre uma loja primeiro" /></>);
  const supabase = await createClient();
  const [{ data: emps }, { data: shifts }, { data: patterns }] = await Promise.all([
    supabase.schema("hr").from("employees").select("id, party_id, job_title, weekly_hours").eq("store_id", store).eq("status", "ACTIVE").neq("contract_type", "PRO_LABORE").order("hire_date"),
    supabase.schema("hr").from("shift_templates").select("id, code, start_time, end_time, break_minutes").eq("active", true).or(`store_id.is.null,store_id.eq.${store}`).order("start_time"),
    supabase.schema("hr").from("weekly_patterns").select("employee_id, weekday, kind, shift_id"),
  ]);
  const ids = (emps ?? []).map((e) => e.party_id);
  const { data: parties } = ids.length ? await supabase.schema("crm").from("parties").select("id, display_name").in("id", ids) : { data: [] as { id: string; display_name: string }[] };
  const name = new Map((parties ?? []).map((p) => [p.id, p.display_name]));
  const init = new Map<string, Record<string, string>>();
  for (const p of patterns ?? []) { const m = init.get(p.employee_id) ?? {}; m[String(p.weekday)] = p.kind === "DAY_OFF" ? "OFF" : p.shift_id ?? ""; init.set(p.employee_id, m); }
  const today = todayIsoSP();
  const monthStart = `${today.slice(0, 7)}-01`;
  const back = `/equipe/escalas/padrao?loja=${store}`;
  const end = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) + 2, 0)).toISOString().slice(0, 10);   // fim do 3º mês

  return (
    <>
      <PageHeader title="Escala semanal padrão" description="Defina uma vez a semana de cada pessoa. O sistema preenche todos os meses sozinho, em rascunho e só nos dias vazios (nunca mexe no que já foi publicado), e confere tudo pelas regras da escala antes de publicar."
        actions={<div className="flex gap-2"><Link href={`/equipe/escalas/turnos?loja=${store}`} className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-surface-2">Turnos, picos e regras</Link><Link href={`/equipe/escalas?loja=${store}`} className="rounded-lg px-3 py-1.5 text-sm hover:bg-surface-2">← Escala</Link></div>} />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      {session.stores.length > 1 && (
        <form className="mb-3 flex items-center gap-2"><select name="loja" defaultValue={store} className="rounded-lg border border-border bg-surface px-2 py-1 text-sm" aria-label="Loja">{session.stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select><Button variant="secondary" className="px-2 py-1 text-xs">Ver</Button></form>
      )}
      {(emps ?? []).length === 0 ? <Empty title="Nenhum colaborador nesta loja" /> : (shifts ?? []).length === 0 ? <Empty title="Crie turnos primeiro">Em Turnos, picos e regras.</Empty> : (
        <div className="overflow-x-auto rounded-xl border border-border bg-surface">
          <table className="w-full min-w-[56rem] border-collapse text-sm">
            <thead className="bg-surface-2 text-left text-xs text-muted">
              <tr><th className="px-3 py-2 font-medium">Colaborador</th>{["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"].map((d) => <th key={d} className="px-1 py-2 font-medium">{d}</th>)}<th className="px-3 py-2 font-medium">Total na semana</th><th /></tr>
            </thead>
            <tbody className="divide-y divide-border">
              {(emps ?? []).map((e) => (
                <PatternRow key={e.id} employeeId={e.id} name={name.get(e.party_id) ?? "—"} job={e.job_title} weeklyHours={Number(e.weekly_hours)} canEdit={canEdit} back={back}
                  shifts={(shifts ?? []).map((s) => ({ id: s.id, code: s.code, start: s.start_time.slice(0, 5), end: s.end_time.slice(0, 5), breakMin: s.break_minutes }))} initial={init.get(e.id) ?? {}} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-2 text-xs text-muted">Total = horas trabalhadas na semana (presença menos o intervalo). Ao salvar, o padrão é aplicado do dia de hoje até o fim do 3º mês, nos dias ainda vazios.</p>

      {canEdit && (emps ?? []).length > 0 && (
        <Card className="mt-4" title="Aplicar o padrão a todos da loja">
          <form action={applyPatternsAction} className="flex flex-wrap items-end gap-3 text-sm">
            <input type="hidden" name="store" value={store} /><input type="hidden" name="back" value={back} /><input type="hidden" name="from" value={monthStart} /><input type="hidden" name="to" value={end} />
            <label className="flex items-center gap-2"><input type="checkbox" name="overwrite" /> Trocar também os rascunhos já lançados (o publicado nunca muda)</label>
            <Button variant="secondary">Aplicar de {monthStart.split("-").reverse().join("/")} até {end.split("-").reverse().join("/")}</Button>
          </form>
        </Card>
      )}
    </>
  );
}
