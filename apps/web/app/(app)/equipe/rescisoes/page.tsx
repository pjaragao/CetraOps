import Link from "next/link";
import { formatBRL } from "@sie/domain";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { Badge, Empty, LinkButton, PageHeader, Table } from "@/components/ui";
import { Flash, fmtDate } from "@/components/form";
import { NOTICE_KIND, RUN_STATUS, TERMINATION_KIND } from "../labels";

export const metadata = { title: "Rescisões" };

export default async function RescisoesPage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("hr.payroll.read");
  const sp = await searchParams;
  const supabase = await createClient();
  const { data: list } = await supabase.schema("hr").from("terminations").select("id, employee_id, kind, notice_kind, termination_date, status, run_id").order("termination_date", { ascending: false });
  const empIds = (list ?? []).map((t) => t.employee_id);
  const runIds = (list ?? []).map((t) => t.run_id).filter(Boolean) as string[];
  const [{ data: emps }, { data: slips }] = await Promise.all([
    empIds.length ? supabase.schema("hr").from("employees").select("id, party_id, job_title").in("id", empIds) : Promise.resolve({ data: [] as { id: string; party_id: string; job_title: string }[] }),
    runIds.length ? supabase.schema("hr").from("payslips").select("run_id, net").in("run_id", runIds) : Promise.resolve({ data: [] as { run_id: string; net: number }[] }),
  ]);
  const partyIds = (emps ?? []).map((e) => e.party_id);
  const { data: parties } = partyIds.length ? await supabase.schema("crm").from("parties").select("id, display_name").in("id", partyIds) : { data: [] as { id: string; display_name: string }[] };
  const pname = new Map((parties ?? []).map((p) => [p.id, p.display_name]));
  const emp = new Map((emps ?? []).map((e) => [e.id, { name: pname.get(e.party_id) ?? "—", job: e.job_title }]));
  const net = new Map((slips ?? []).map((s) => [s.run_id, Number(s.net)]));

  return (
    <>
      <PageHeader title="Rescisões" description="Cálculo completo com memória: saldo de salário, aviso, 13º e férias (vencidas e proporcionais), multa do FGTS, INSS/IRRF, prazo de 10 dias e guias no financeiro."
        actions={can(session, "hr.payroll.write") ? <LinkButton href="/equipe/rescisoes/nova" variant="primary">+ Nova rescisão</LinkButton> : undefined} />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      {(list ?? []).length === 0 ? <Empty title="Nenhuma rescisão" /> : (
        <Table head={["Colaborador", "Tipo", "Aviso", "Desligamento", "Líquido", "Situação"]}>
          {(list ?? []).map((t) => {
            const [label, tone] = RUN_STATUS[t.status];
            return (
              <tr key={t.id}>
                <td className="px-3 py-2"><Link className="font-medium text-brand" href={`/equipe/rescisoes/${t.id}`}>{emp.get(t.employee_id)?.name}</Link><span className="block text-xs text-muted">{emp.get(t.employee_id)?.job}</span></td>
                <td className="px-3 py-2">{TERMINATION_KIND[t.kind]}</td><td className="px-3 py-2">{NOTICE_KIND[t.notice_kind] ?? t.notice_kind}</td>
                <td className="px-3 py-2 whitespace-nowrap">{fmtDate(t.termination_date)}</td>
                <td className="px-3 py-2 font-medium">{t.run_id && net.has(t.run_id) ? formatBRL(net.get(t.run_id)!) : "—"}</td>
                <td className="px-3 py-2"><Badge tone={tone}>{label}</Badge></td>
              </tr>
            );
          })}
        </Table>
      )}
    </>
  );
}
