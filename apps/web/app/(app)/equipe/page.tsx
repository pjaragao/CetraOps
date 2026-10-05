import Link from "next/link";
import { formatBRL } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { addDaysIsoSP, str, todayIsoSP, type SP } from "@/lib/context";
import { Badge, Card, Empty, inputClass, LinkButton, PageHeader, Stat, Table } from "@/components/ui";
import { fmtDate, Flash } from "@/components/form";

export const metadata = { title: "Colaboradores" };

const CONTRACT: Record<string, string> = { CLT: "CLT", ESTAGIO: "Estágio", APRENDIZ: "Aprendiz", INTERMITENTE: "Intermitente", TEMPORARIO: "Temporário", PRO_LABORE: "Sócio (pró-labore)", AUTONOMO: "Autônomo" };

function tenure(hire: string, today: string) {
  const a = new Date(`${hire}T12:00:00Z`);
  const b = new Date(`${today}T12:00:00Z`);
  let m = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth();
  if (b.getUTCDate() < a.getUTCDate()) m -= 1;
  return m >= 12 ? `${Math.floor(m / 12)}a ${m % 12}m` : `${Math.max(m, 0)}m`;
}

export default async function EquipePage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("hr.read");
  const sp = await searchParams;
  const supabase = await createClient();
  const today = todayIsoSP();
  const status = str(sp.situacao) ?? "ATIVOS";
  const q = (str(sp.q) ?? "").replace(/[%,()]/g, " ").trim();
  const salaries = can(session, "hr.payroll.read");

  let eq = supabase.schema("hr").from("employees").select("id, party_id, registration, contract_type, job_title, store_id, hire_date, status, termination_date, member_id").order("hire_date");
  if (status === "ATIVOS") eq = eq.eq("status", "ACTIVE");
  else if (status === "DESLIGADOS") eq = eq.eq("status", "TERMINATED");
  if (session.storeId) eq = eq.or(`store_id.eq.${session.storeId},store_id.is.null`);
  const { data: emps } = await eq;
  const partyIds = (emps ?? []).map((e) => e.party_id);

  const [{ data: parties }, { data: history }, { data: vac }, { data: leaves }, { data: exams }, { data: balances }] = await Promise.all([
    partyIds.length ? supabase.schema("crm").from("parties").select("id, display_name, birth_date").in("id", partyIds) : Promise.resolve({ data: [] as { id: string; display_name: string; birth_date: string | null }[] }),
    salaries ? supabase.schema("hr").from("salary_history").select("employee_id, amount, effective_from, unit").lte("effective_from", today).order("effective_from", { ascending: false }) : Promise.resolve({ data: [] as { employee_id: string; amount: number; effective_from: string; unit: string }[] }),
    supabase.schema("hr").from("vacations").select("employee_id, start_date, end_date").in("status", ["APPROVED", "PAID", "TAKEN"]).lte("start_date", today).gte("end_date", today),
    supabase.schema("hr").from("leaves").select("employee_id, kind").lte("start_date", today).gte("end_date", today),
    supabase.schema("hr").from("medical_exams").select("employee_id, kind, valid_until").lte("valid_until", addDaysIsoSP(45)).order("valid_until"),
    supabase.schema("hr").from("v_vacation_balance").select("employee_id, period_end, concessive_end, days_left, acquired, days_to_expire").eq("acquired", true).gt("days_left", 0).lte("days_to_expire", 120),
  ]);
  const name = new Map((parties ?? []).map((p) => [p.id, p]));
  const salary = new Map<string, { amount: number; unit: string }>();
  for (const h of history ?? []) if (!salary.has(h.employee_id)) salary.set(h.employee_id, { amount: Number(h.amount), unit: h.unit });
  const onVacation = new Set((vac ?? []).map((v) => v.employee_id));
  const onLeave = new Set((leaves ?? []).map((l) => l.employee_id));
  const empName = (id: string) => name.get((emps ?? []).find((e) => e.id === id)?.party_id ?? "")?.display_name ?? "—";

  const active = (emps ?? []).filter((e) => e.status === "ACTIVE");
  const payroll = active.reduce((a, e) => a + (salary.get(e.id)?.unit === "MONTH" ? salary.get(e.id)!.amount : 0), 0);
  const month = today.slice(5, 7);
  const birthdays = (parties ?? []).filter((p) => p.birth_date?.slice(5, 7) === month && (emps ?? []).some((e) => e.party_id === p.id && e.status === "ACTIVE"));
  const filtered = (emps ?? []).filter((e) => !q || (name.get(e.party_id)?.display_name ?? "").toLowerCase().includes(q.toLowerCase()));

  return (
    <>
      <PageHeader title="Colaboradores" description="Cadastro, escala, ponto, férias, folha e rescisão em um só lugar — integrados ao financeiro, ao contábil e ao fiscal."
        actions={can(session, "hr.write") && can(session, "hr.payroll.write") ? <LinkButton href="/equipe/novo" variant="primary">+ Admitir colaborador</LinkButton> : undefined} />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Colaboradores ativos" value={active.length} />
        <Stat label="De férias hoje" value={onVacation.size} />
        <Stat label="Afastados hoje" value={onLeave.size} />
        {salaries && <Stat label="Folha-base mensal" value={formatBRL(payroll)} hint="soma dos salários vigentes (sem encargos)" />}
      </div>

      {((balances ?? []).length > 0 || (exams ?? []).length > 0 || birthdays.length > 0) && (
        <div className="mt-4 grid gap-4 lg:grid-cols-3">
          {(balances ?? []).length > 0 && (
            <Card title="Férias a conceder">
              <ul className="space-y-1 text-sm">
                {(balances ?? []).slice(0, 6).map((b) => (
                  <li key={`${b.employee_id}${b.period_end}`} className="flex justify-between gap-2">
                    <Link className="text-brand" href={`/equipe/${b.employee_id}`}>{empName(b.employee_id!)}</Link>
                    <span className={Number(b.days_to_expire) < 60 ? "text-danger" : "text-warning"}>{b.days_left} d · vence em {b.days_to_expire} d</span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-muted">Depois do prazo concessivo, as férias são pagas em dobro (CLT art. 137).</p>
            </Card>
          )}
          {(exams ?? []).length > 0 && (
            <Card title="Exames (ASO) vencendo">
              <ul className="space-y-1 text-sm">
                {(exams ?? []).slice(0, 6).map((x, i) => (
                  <li key={i} className="flex justify-between gap-2"><Link className="text-brand" href={`/equipe/${x.employee_id}`}>{empName(x.employee_id)}</Link><span className="text-warning">{fmtDate(x.valid_until)}</span></li>
                ))}
              </ul>
            </Card>
          )}
          {birthdays.length > 0 && (
            <Card title="Aniversariantes do mês">
              <ul className="space-y-1 text-sm">{birthdays.map((p) => <li key={p.id} className="flex justify-between"><span>{p.display_name}</span><span className="text-muted">{fmtDate(p.birth_date).slice(0, 5)}</span></li>)}</ul>
            </Card>
          )}
        </div>
      )}

      <form className="my-4 flex flex-wrap gap-2">
        <input name="q" defaultValue={q} placeholder="Buscar por nome" className={`${inputClass} max-w-xs`} aria-label="Buscar" />
        <select name="situacao" defaultValue={status} className={`${inputClass} max-w-[180px]`} aria-label="Situação">
          <option value="ATIVOS">Ativos</option><option value="DESLIGADOS">Desligados</option><option value="TODOS">Todos</option>
        </select>
        <button className="rounded-lg border border-border px-3 text-sm">Filtrar</button>
      </form>

      {filtered.length === 0 ? <Empty title="Nenhum colaborador">Admita o primeiro colaborador para começar.</Empty> : (
        <Table head={["Nome", "Cargo", "Loja", "Vínculo", "Admissão", "Tempo", ...(salaries ? ["Salário"] : []), "Situação"]}>
          {filtered.map((e) => {
            const s = salary.get(e.id);
            return (
              <tr key={e.id}>
                <td className="px-3 py-2"><Link className="font-medium text-brand" href={`/equipe/${e.id}`}>{name.get(e.party_id)?.display_name ?? "—"}</Link><span className="block text-xs text-muted">{e.registration}</span></td>
                <td className="px-3 py-2">{e.job_title}</td>
                <td className="px-3 py-2">{session.stores.find((x) => x.id === e.store_id)?.name ?? "—"}</td>
                <td className="px-3 py-2">{CONTRACT[e.contract_type] ?? e.contract_type}</td>
                <td className="px-3 py-2 whitespace-nowrap">{fmtDate(e.hire_date)}</td>
                <td className="px-3 py-2 whitespace-nowrap">{tenure(e.hire_date, e.termination_date ?? today)}</td>
                {salaries && <td className="px-3 py-2 whitespace-nowrap">{s ? `${formatBRL(s.amount)}${s.unit === "HOUR" ? "/h" : ""}` : "—"}</td>}
                <td className="px-3 py-2">
                  {e.status === "TERMINATED" ? <Badge tone="neutral">desligado em {fmtDate(e.termination_date)}</Badge>
                    : onVacation.has(e.id) ? <Badge tone="info">de férias</Badge> : onLeave.has(e.id) ? <Badge tone="warning">afastado</Badge> : <Badge tone="success">ativo</Badge>}
                </td>
              </tr>
            );
          })}
        </Table>
      )}
    </>
  );
}
