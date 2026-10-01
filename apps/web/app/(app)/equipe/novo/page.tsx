import { createClient } from "@/lib/supabase/server";
import { getSession, requirePerm } from "@/lib/session";
import { todayIsoSP } from "@/lib/context";
import Link from "next/link";
import { cn, LinkButton, PageHeader } from "@/components/ui";
import { str, type SP } from "@/lib/context";
import { AdmissionForm } from "./admission-form";
import { FreelancerForm } from "./freelancer-form";

export const metadata = { title: "Admitir colaborador" };

export default async function NovoColaboradorPage({ searchParams }: { searchParams: SP }) {
  const freelancer = str((await searchParams).tipo) === "freelancer";
  await requirePerm("hr.write");
  const session = await getSession();
  const supabase = await createClient();
  const { data: entities } = await supabase.schema("core").from("legal_entities").select("id, razao_social, nome_fantasia").order("razao_social");
  return (
    <>
      <PageHeader title={freelancer ? "Freelancer PJ/MEI" : "Admitir colaborador"}
        description={freelancer ? "Prestador sem vínculo para datas especiais: vira conta a pagar, sem folha nem encargos de CLT." : "Cria o cadastro único (pessoa), o vínculo, o salário inicial e os períodos de férias, e enfileira o evento S-2200 do eSocial."}
        actions={<LinkButton href="/equipe">Voltar</LinkButton>} />
      <div className="mb-4 flex gap-1.5" role="tablist" aria-label="Tipo de contratação">
        {[["", "Colaborador (CLT, intermitente, temporário, estágio, sócio)"], ["freelancer", "Freelancer PJ/MEI (sem vínculo)"]].map(([k, label]) => (
          <Link key={k} role="tab" aria-selected={(k === "freelancer") === freelancer} href={k ? `/equipe/novo?tipo=${k}` : "/equipe/novo"}
            className={cn("rounded-full border px-3 py-1 text-sm", (k === "freelancer") === freelancer ? "border-brand bg-brand/10 text-brand" : "border-border hover:bg-surface-2")}>{label}</Link>
        ))}
      </div>
      {freelancer
        ? <FreelancerForm entities={(entities ?? []).map((e) => ({ id: e.id, label: e.nome_fantasia ?? e.razao_social }))} stores={session.stores.map((s) => ({ id: s.id, label: s.name, legal_entity_id: s.legal_entity_id }))} />
        : <AdmissionForm today={todayIsoSP()}
            entities={(entities ?? []).map((e) => ({ id: e.id, label: e.nome_fantasia ?? e.razao_social }))}
            stores={session.stores.map((s) => ({ id: s.id, label: s.name, legal_entity_id: s.legal_entity_id }))} />}
    </>
  );
}
