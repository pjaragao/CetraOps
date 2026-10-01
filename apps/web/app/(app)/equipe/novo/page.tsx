import { createClient } from "@/lib/supabase/server";
import { getSession, requirePerm } from "@/lib/session";
import { todayIsoSP } from "@/lib/context";
import { LinkButton, PageHeader } from "@/components/ui";
import { AdmissionForm } from "./admission-form";

export const metadata = { title: "Admitir colaborador" };

export default async function NovoColaboradorPage() {
  await requirePerm("hr.write");
  const session = await getSession();
  const supabase = await createClient();
  const { data: entities } = await supabase.schema("core").from("legal_entities").select("id, razao_social, nome_fantasia").order("razao_social");
  return (
    <>
      <PageHeader title="Admitir colaborador" description="Cria o cadastro único (pessoa), o vínculo, o salário inicial e os períodos de férias, e enfileira o evento S-2200 do eSocial."
        actions={<LinkButton href="/equipe">Voltar</LinkButton>} />
      <AdmissionForm today={todayIsoSP()}
        entities={(entities ?? []).map((e) => ({ id: e.id, label: e.nome_fantasia ?? e.razao_social }))}
        stores={session.stores.map((s) => ({ id: s.id, label: s.name, legal_entity_id: s.legal_entity_id }))} />
    </>
  );
}
