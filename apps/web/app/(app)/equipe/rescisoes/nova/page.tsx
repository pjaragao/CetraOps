import { createClient } from "@/lib/supabase/server";
import { requirePerm } from "@/lib/session";
import { str, todayIsoSP, type SP } from "@/lib/context";
import { LinkButton, Narrow, PageHeader } from "@/components/ui";
import { TerminationForm } from "./termination-form";

export const metadata = { title: "Nova rescisão" };

export default async function NovaRescisaoPage({ searchParams }: { searchParams: SP }) {
  await requirePerm("hr.payroll.write");
  const sp = await searchParams;
  const supabase = await createClient();
  const { data: emps } = await supabase.schema("hr").from("employees").select("id, party_id, job_title").eq("status", "ACTIVE").in("contract_type", ["CLT", "APRENDIZ", "INTERMITENTE", "TEMPORARIO"]).order("hire_date");
  const partyIds = (emps ?? []).map((e) => e.party_id);
  const { data: parties } = partyIds.length ? await supabase.schema("crm").from("parties").select("id, display_name").in("id", partyIds) : { data: [] as { id: string; display_name: string }[] };
  const pname = new Map((parties ?? []).map((p) => [p.id, p.display_name]));
  return (
    <Narrow>
      <PageHeader title="Nova rescisão" description="Escolha o colaborador e o tipo de desligamento. O sistema calcula todas as verbas e mostra a memória de cálculo antes da aprovação." actions={<LinkButton href="/equipe/rescisoes">Voltar</LinkButton>} />
      <TerminationForm today={todayIsoSP()} preselected={str(sp.colaborador)} employees={(emps ?? []).map((e) => ({ id: e.id, label: `${pname.get(e.party_id) ?? "—"} — ${e.job_title}` }))} />
    </Narrow>
  );
}
